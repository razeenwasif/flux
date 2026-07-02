//! Password vault integration (BACKLOG #61, ADR 0009).
//!
//! Wires [`flux_vault`] into Flux. Two protection modes:
//!
//! - **keychain** (default): the 32-byte data key lives in the OS keychain
//!   (`keyring`) — or a file fallback where no store exists — and the vault is
//!   unlocked automatically at boot. Convenient; protected at the OS-user level.
//! - **password**: the data key is wrapped by an Argon2id key derived from a
//!   master password and stored on disk (`keywrap.json`) — never in the
//!   keychain. The vault boots **locked**; `vault_unlock` decrypts it into
//!   memory, and **auto-lock** clears it after idle. Sealed even from the
//!   logged-in OS user until the password is entered.
//!
//! Secrets boundary: only metadata reaches the chrome; passwords leave Rust only
//! via explicit `vault_reveal` or injected straight into the page by `vault_fill`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use flux_vault::{Credential, KeyWrap, Vault};

const KEYRING_SERVICE: &str = "Flux";
const KEYRING_ACCOUNT: &str = "vault-key-v1";

/// autofill.js — defines `__fluxFill(u,p)`; we append the invocation per fill.
const AUTOFILL_JS: &str = include_str!("../assets/autofill.js");

static BOOT: OnceLock<Instant> = OnceLock::new();
fn now_ms() -> u64 {
    BOOT.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Decrypted state — present only while unlocked.
struct Unlocked {
    vault: Vault,
    dk: Zeroizing<[u8; 32]>,
}

pub struct VaultState {
    /// `None` = locked (password mode, pre-unlock or auto-locked).
    open: RwLock<Option<Unlocked>>,
    dir: PathBuf,
    path: PathBuf, // vault.bin
    protection: RwLock<Protection>,
    /// Where the key lives, for status: "keychain" | "file" | "password" | "none".
    source: RwLock<&'static str>,
    autolock_min: AtomicU64,
    last_activity: AtomicU64,
}

#[derive(Clone, Copy, PartialEq)]
enum Protection {
    Keychain,
    Password,
}

#[derive(Serialize, Deserialize, Default)]
struct Meta {
    #[serde(default)]
    protection: String, // "keychain" | "password"
    #[serde(default)]
    autolock_minutes: u64,
}

impl VaultState {
    /// Boot-critical constructor: read only small metadata and defer keychain
    /// access/decryption. Windows Credential Manager can take noticeable time
    /// on cold start, so keychain-mode auto-unlock happens in `hydrate_keychain`
    /// after the shell is already launching.
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("vault");
        let path = dir.join("vault.bin");
        let meta = read_meta(&dir);
        let password_mode = meta.protection == "password" && dir.join("keywrap.json").is_file();

        Self {
            open: RwLock::new(None),
            dir,
            path,
            protection: RwLock::new(if password_mode { Protection::Password } else { Protection::Keychain }),
            source: RwLock::new(if password_mode { "password" } else { "loading" }),
            autolock_min: AtomicU64::new(meta.autolock_minutes),
            last_activity: AtomicU64::new(now_ms()),
        }
    }

    /// Finish keychain-mode auto-unlock off the Tauri setup path.
    pub fn hydrate_keychain(&self) {
        if *self.protection.read() == Protection::Password || self.open.read().is_some() {
            return;
        }
        let (open, source) = match obtain_key(&self.dir) {
            (Some(dk), src) => {
                let vault = match std::fs::read(&self.path) {
                    Ok(blob) if !blob.is_empty() => Vault::decrypt(&dk, &blob).unwrap_or_else(|e| {
                        tracing::error!(target: "flux::vault", "vault decrypt failed: {e}");
                        Vault::default()
                    }),
                    _ => Vault::default(),
                };
                (Some(Unlocked { vault, dk: Zeroizing::new(dk) }), src)
            }
            (None, _) => (None, "none"),
        };
        if source == "file" {
            tracing::warn!(target: "flux::vault", "no OS keychain; vault key is file-backed (less secure)");
        }
        *self.open.write() = open;
        *self.source.write() = source;
        self.touch();
    }

    fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }

    /// Auto-lock if password-protected, idle past the timeout, and unlocked.
    /// Returns whether it just locked (so the caller can notify the UI).
    pub fn maybe_autolock(&self) -> bool {
        if *self.protection.read() != Protection::Password {
            return false;
        }
        let mins = self.autolock_min.load(Ordering::Relaxed);
        if mins == 0 || self.open.read().is_none() {
            return false;
        }
        let idle = now_ms().saturating_sub(self.last_activity.load(Ordering::Relaxed));
        if idle >= mins * 60_000 {
            *self.open.write() = None;
            tracing::info!(target: "flux::vault", "vault auto-locked after {mins}m idle");
            return true;
        }
        false
    }

    /// How often the background watchdog should wake. The common/default
    /// keychain mode has no auto-lock work, so avoid a permanent 20s idle wakeup.
    pub fn autolock_watch_interval(&self) -> Duration {
        if *self.protection.read() != Protection::Password
            || self.autolock_min.load(Ordering::Relaxed) == 0
            || self.open.read().is_none()
        {
            return Duration::from_secs(60);
        }
        Duration::from_secs(20)
    }

    /// Re-seal the decrypted vault to disk (must be unlocked).
    fn persist(&self) -> Result<(), String> {
        let guard = self.open.read();
        let u = guard.as_ref().ok_or("vault is locked")?;
        let blob = u.vault.encrypt(&u.dk).map_err(|e| e.to_string())?;
        // The vault blob is the one file whose loss is unrecoverable — atomic
        // replace means a crash mid-save can never truncate it.
        crate::persist::write_atomic(&self.path, &blob).map_err(|e| e.to_string())
    }

    /// Run `f` against the decrypted vault, or error if locked. Touches activity.
    fn read_open<R>(&self, f: impl FnOnce(&Vault) -> R) -> Result<R, String> {
        let guard = self.open.read();
        let u = guard.as_ref().ok_or("vault is locked")?;
        self.touch();
        Ok(f(&u.vault))
    }
    fn write_open<R>(&self, f: impl FnOnce(&mut Vault) -> R) -> Result<R, String> {
        let r = {
            let mut guard = self.open.write();
            let u = guard.as_mut().ok_or("vault is locked")?;
            f(&mut u.vault)
        };
        self.touch();
        self.persist()?;
        Ok(r)
    }
}

// ─── key acquisition (keychain mode) ─────────────────────────────────────────

fn obtain_key(dir: &Path) -> (Option<[u8; 32]>, &'static str) {
    match keychain_key() {
        Ok(k) => return (Some(k), "keychain"),
        Err(e) => tracing::warn!(target: "flux::vault", "OS keychain unavailable: {e}"),
    }
    match file_key(dir) {
        Ok(k) => (Some(k), "file"),
        Err(e) => {
            tracing::error!(target: "flux::vault", "no vault key (keychain + file failed): {e}");
            (None, "none")
        }
    }
}

fn keychain_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(hex) => decode_key(&hex),
        Err(keyring::Error::NoEntry) => {
            let k = flux_vault::new_key();
            entry.set_password(&encode_key(&k)).map_err(|e| e.to_string())?;
            Ok(k)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn file_key(dir: &Path) -> Result<[u8; 32], String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let p = dir.join("key.bin");
    if let Ok(b) = std::fs::read(&p) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return Ok(k);
        }
    }
    let k = flux_vault::new_key();
    std::fs::write(&p, k).map_err(|e| e.to_string())?;
    set_owner_only(&p);
    Ok(k)
}

/// Store the data key in the keychain (preferred) or a 0600 key file.
fn store_key(dir: &Path, dk: &[u8; 32]) -> &'static str {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        if entry.set_password(&encode_key(dk)).is_ok() {
            return "keychain";
        }
    }
    let p = dir.join("key.bin");
    if std::fs::write(&p, dk).is_ok() {
        set_owner_only(&p);
        return "file";
    }
    "none"
}

/// Remove every at-rest copy of the data key (when switching to password mode).
fn purge_key(dir: &Path) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    let _ = std::fs::remove_file(dir.join("key.bin"));
}

fn set_owner_only(_p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o600));
    }
}

fn encode_key(k: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in k {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn decode_key(hex: &str) -> Result<[u8; 32], String> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return Err("stored key has wrong length".into());
    }
    let mut k = [0u8; 32];
    for (i, slot) in k.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| "bad key hex".to_string())?;
    }
    Ok(k)
}

// ─── meta / keywrap persistence ──────────────────────────────────────────────

fn read_meta(dir: &Path) -> Meta {
    std::fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("meta.json"), s).map_err(|e| e.to_string())
}

fn read_keywrap(dir: &Path) -> Result<KeyWrap, String> {
    let s = std::fs::read_to_string(dir.join("keywrap.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

// ─── serializable views ──────────────────────────────────────────────────────

#[derive(Serialize, specta::Type)]
pub struct CredentialMeta {
    pub id: String,
    pub name: String,
    pub urls: Vec<String>,
    pub username: String,
    pub has_totp: bool,
}

impl From<&Credential> for CredentialMeta {
    fn from(c: &Credential) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            urls: c.urls.clone(),
            username: c.username.clone(),
            has_totp: !c.totp.is_empty(),
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct VaultStatus {
    pub available: bool,
    pub locked: bool,
    /// "keychain" | "password"
    pub protection: &'static str,
    pub source: &'static str,
    pub count: usize,
    pub autolock_minutes: u64,
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_status(state: State<'_, VaultState>) -> VaultStatus {
    let protection = if *state.protection.read() == Protection::Password { "password" } else { "keychain" };
    let guard = state.open.read();
    VaultStatus {
        available: guard.is_some() || protection == "password",
        locked: guard.is_none(),
        protection,
        source: *state.source.read(),
        count: guard.as_ref().map(|u| u.vault.entries.len()).unwrap_or(0),
        autolock_minutes: state.autolock_min.load(Ordering::Relaxed),
    }
}

/// Unlock the vault with the master password (password mode).
#[tauri::command]
pub fn vault_unlock(state: State<'_, VaultState>, password: String) -> Result<(), String> {
    if state.open.read().is_some() {
        return Ok(());
    }
    let wrap = read_keywrap(&state.dir)?;
    let dk = flux_vault::unwrap_key(&password, &wrap).map_err(|_| "wrong master password".to_string())?;
    let vault = match std::fs::read(&state.path) {
        Ok(blob) if !blob.is_empty() => Vault::decrypt(&dk, &blob).map_err(|e| e.to_string())?,
        _ => Vault::default(),
    };
    *state.open.write() = Some(Unlocked { vault, dk: Zeroizing::new(dk) });
    state.touch();
    Ok(())
}

/// Lock the vault now (clears the decrypted copy + key from memory).
#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    *state.open.write() = None;
}

/// Set (or change) the master password — switches to password protection and
/// removes the data key from the keychain/file. Requires the vault unlocked.
#[tauri::command]
pub fn vault_set_master_password(state: State<'_, VaultState>, password: String) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("master password cannot be empty".into());
    }
    let dk = {
        let guard = state.open.read();
        *guard.as_ref().ok_or("unlock the vault first")?.dk
    };
    let wrap = flux_vault::wrap_key(&password, &dk).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&wrap).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&state.dir).map_err(|e| e.to_string())?;
    std::fs::write(state.dir.join("keywrap.json"), json).map_err(|e| e.to_string())?;
    purge_key(&state.dir); // DK now recoverable only via the password
    *state.protection.write() = Protection::Password;
    *state.source.write() = "password";
    write_meta(&state.dir, &Meta { protection: "password".into(), autolock_minutes: state.autolock_min.load(Ordering::Relaxed) })?;
    Ok(())
}

/// Remove master-password protection: verify the password, then move the data
/// key back to the OS keychain. Requires the vault unlocked.
#[tauri::command]
pub fn vault_disable_master_password(state: State<'_, VaultState>, password: String) -> Result<(), String> {
    let dk = {
        let guard = state.open.read();
        *guard.as_ref().ok_or("unlock the vault first")?.dk
    };
    // Confirm the caller knows the current password.
    let wrap = read_keywrap(&state.dir)?;
    let check = flux_vault::unwrap_key(&password, &wrap).map_err(|_| "wrong master password".to_string())?;
    if check != dk {
        return Err("wrong master password".into());
    }
    let source = store_key(&state.dir, &dk);
    let _ = std::fs::remove_file(state.dir.join("keywrap.json"));
    *state.protection.write() = Protection::Keychain;
    *state.source.write() = source;
    write_meta(&state.dir, &Meta { protection: "keychain".into(), autolock_minutes: state.autolock_min.load(Ordering::Relaxed) })?;
    Ok(())
}

/// Set the idle auto-lock timeout in minutes (0 = never). Only effective in
/// password mode.
#[tauri::command]
pub fn vault_set_autolock(state: State<'_, VaultState>, minutes: u64) -> Result<(), String> {
    state.autolock_min.store(minutes, Ordering::Relaxed);
    let protection = if *state.protection.read() == Protection::Password { "password" } else { "keychain" };
    write_meta(&state.dir, &Meta { protection: protection.into(), autolock_minutes: minutes })
}

#[tauri::command]
pub fn vault_list(state: State<'_, VaultState>) -> Result<Vec<CredentialMeta>, String> {
    state.read_open(|v| v.entries.iter().map(CredentialMeta::from).collect())
}

#[tauri::command]
pub fn vault_for_host(state: State<'_, VaultState>, host: String) -> Result<Vec<CredentialMeta>, String> {
    state.read_open(|v| v.matches(&host).into_iter().map(CredentialMeta::from).collect())
}

#[tauri::command]
pub fn vault_reveal(state: State<'_, VaultState>, id: String) -> Result<Option<String>, String> {
    state.read_open(|v| v.entries.iter().find(|c| c.id == id).map(|c| c.password.clone()))
}

#[tauri::command]
pub fn vault_add(
    state: State<'_, VaultState>,
    name: String,
    url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let cred = Credential {
        id: Credential::stable_id(&name, &username, &url),
        name,
        urls: if url.trim().is_empty() { vec![] } else { vec![url] },
        username,
        password,
        totp: String::new(),
        notes: String::new(),
        created_ms: 0,
    };
    state.write_open(|v| v.upsert(cred))
}

#[tauri::command]
pub fn vault_remove(state: State<'_, VaultState>, id: String) -> Result<(), String> {
    state.write_open(|v| v.remove(&id))
}

/// Import a Proton Pass export (CSV / ZIP / PGP / JSON; PGP needs `passphrase`).
#[tauri::command]
pub fn vault_import_proton(
    state: State<'_, VaultState>,
    path: String,
    passphrase: Option<String>,
) -> Result<usize, String> {
    let data = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    state.write_open(|v| v.import(&data, &path, passphrase.as_deref()).map_err(|e| e.to_string()))?
}

/// Fill the active tab's login form with credential `id` (same-origin enforced;
/// password injected straight into the page, never via the chrome's JS).
#[tauri::command]
pub fn vault_fill(app: AppHandle, state: State<'_, VaultState>, tab_id: u64, id: String) -> Result<(), String> {
    let host = app
        .try_state::<crate::state::FluxState>()
        .and_then(|s| s.tabs.get(&tab_id).map(|t| host_of(&t.url)))
        .ok_or("no such tab")?;

    let found = state.read_open(|v| {
        v.entries
            .iter()
            .find(|c| c.id == id)
            .filter(|c| c.matches_host(&host))
            .map(|c| (c.username.clone(), c.password.clone()))
    })?;
    let (user, pass) = found.ok_or_else(|| format!("no credential matches {host}"))?;

    let u = serde_json::to_string(&user).unwrap_or_else(|_| "\"\"".into());
    let p = serde_json::to_string(&pass).unwrap_or_else(|_| "\"\"".into());
    let js = format!("{AUTOFILL_JS}\n;__fluxFill({u},{p});");
    crate::webview::eval(&app, tab_id, &js)
}

fn host_of(url: &str) -> String {
    let s = url.split("://").nth(1).unwrap_or(url);
    let s = s.split(['/', '?', '#']).next().unwrap_or(s);
    let s = s.rsplit('@').next().unwrap_or(s);
    s.split(':').next().unwrap_or(s).to_ascii_lowercase()
}
