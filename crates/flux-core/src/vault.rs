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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

use flux_vault::{Credential, HostMatch, KeyWrap, Vault};

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
    /// Credentials the sentinel captured on submit, awaiting the user's
    /// "Save"/"Never" answer in the chrome bar (#61 follow-up), one per tab: a
    /// single slot let any tab, a background one included, replace the capture
    /// another tab had just staged (audit S26). In memory only; a password
    /// lives here no longer than its prompt can be answered.
    pending_save: RwLock<HashMap<u64, PendingSave>>,
    /// How often each tab has raised a vault prompt lately (audit S25, S26).
    asks: AskLimiter,
    /// Hosts the user chose "Never save" for. Persisted to `never-save.json`.
    never_save: RwLock<HashSet<String>>,
}

/// A pending save awaiting the chrome-side prompt's answer.
struct PendingSave {
    host: String,
    /// The page origin's port, so an Update only ever touches the login saved
    /// for this very site.
    port: Option<u16>,
    /// The origin as a URL (`https://host`, `http://localhost:3000`): what a
    /// new entry is saved under.
    origin: String,
    username: String,
    password: Zeroizing<String>,
    staged_ms: u64,
}

/// What Save answers when the capture its bar showed is gone or was replaced.
/// The save bar closes itself on it.
const SAVE_GONE: &str = "that login is no longer waiting to be saved";

/// Captured logins waiting for an answer: one per tab, across at most this many
/// tabs, each for at most [`PENDING_SAVE_TTL_MS`].
const MAX_PENDING_SAVES: usize = 16;
const PENDING_SAVE_TTL_MS: u64 = 10 * 60_000;

/// Which prompt a page is asking the chrome to raise.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum AskKind {
    Fill,
    Save,
}

impl AskKind {
    /// The least time between two asks of this kind from one tab. A fill ask
    /// follows a click on the page's chip; a save ask follows a form submit,
    /// and a second submit can come quickly after a mistyped first.
    fn gap_ms(self) -> u64 {
        match self {
            AskKind::Fill => 1_500,
            AskKind::Save => 500,
        }
    }
}

/// At most this many asks of one kind from one tab in [`ASK_WINDOW_MS`].
const ASK_PER_WINDOW: u32 = 8;
const ASK_WINDOW_MS: u64 = 60_000;

struct AskLog {
    window_start: u64,
    count: u32,
    last: u64,
}

/// A page can call the vault's page commands as often as it likes, and each call
/// that gets through puts a bar in the chrome. Unlimited, that is a way to flash
/// a "Fill your password?" bar until a click lands on it. This allows a tab a
/// few asks, spaced out, and refuses the rest.
#[derive(Default)]
struct AskLimiter(parking_lot::Mutex<HashMap<(u64, AskKind), AskLog>>);

impl AskLimiter {
    fn admit(&self, tab: u64, kind: AskKind, now: u64) -> bool {
        let mut logs = self.0.lock();
        let Some(log) = logs.get_mut(&(tab, kind)) else {
            logs.insert(
                (tab, kind),
                AskLog {
                    window_start: now,
                    count: 1,
                    last: now,
                },
            );
            return true;
        };
        if now.saturating_sub(log.last) < kind.gap_ms() {
            return false;
        }
        if now.saturating_sub(log.window_start) >= ASK_WINDOW_MS {
            log.window_start = now;
            log.count = 0;
        }
        if log.count >= ASK_PER_WINDOW {
            return false;
        }
        log.count += 1;
        log.last = now;
        true
    }

    fn forget(&self, tab: u64) {
        self.0.lock().retain(|(t, _), _| *t != tab);
    }
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
        // keywrap.json is what makes a vault password-protected; only an explicit
        // "keychain" in meta (a disable that couldn't remove it) overrides it. A
        // missing or unreadable meta.json must not boot such a vault in keychain
        // mode, which has no key for it.
        let password_mode = dir.join("keywrap.json").is_file() && meta.protection != "keychain";
        let never_save = read_never_save(&dir);

        Self {
            open: RwLock::new(None),
            dir,
            path,
            protection: RwLock::new(if password_mode {
                Protection::Password
            } else {
                Protection::Keychain
            }),
            source: RwLock::new(if password_mode { "password" } else { "loading" }),
            autolock_min: AtomicU64::new(meta.autolock_minutes),
            last_activity: AtomicU64::new(now_ms()),
            pending_save: RwLock::new(HashMap::new()),
            asks: AskLimiter::default(),
            never_save: RwLock::new(never_save),
        }
    }

    /// Hold a captured login for `tab` until its prompt is answered, replacing
    /// any earlier capture from that tab. Stale captures go, and when too many
    /// tabs have one waiting the oldest goes too.
    fn stage_save(&self, tab: u64, save: PendingSave) {
        let mut pending = self.pending_save.write();
        let now = save.staged_ms;
        pending.retain(|_, p| now.saturating_sub(p.staged_ms) < PENDING_SAVE_TTL_MS);
        if !pending.contains_key(&tab) && pending.len() >= MAX_PENDING_SAVES {
            let oldest = pending
                .iter()
                .min_by_key(|(_, p)| p.staged_ms)
                .map(|(t, _)| *t);
            if let Some(oldest) = oldest {
                pending.remove(&oldest);
            }
        }
        pending.insert(tab, save);
    }

    /// The tab closed: drop the capture it had waiting and its ask history.
    pub fn forget_tab(&self, tab: u64) {
        self.pending_save.write().remove(&tab);
        self.asks.forget(tab);
    }

    /// Finish keychain-mode auto-unlock off the Tauri setup path.
    pub fn hydrate_keychain(&self) {
        if *self.protection.read() == Protection::Password || self.open.read().is_some() {
            return;
        }
        let (open, source) = match obtain_key(&self.dir, keychain_key()) {
            (Some(dk), src) => {
                let vault_res = match std::fs::read(&self.path) {
                    Ok(blob) if !blob.is_empty() => {
                        Vault::decrypt(&dk, &blob).map_err(|e| format!("vault decrypt failed: {e}"))
                    }
                    Ok(_) => Ok(Vault::default()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vault::default()),
                    Err(e) => Err(format!("vault read error: {e}")),
                };
                match vault_res {
                    Ok(vault) => (
                        Some(Unlocked {
                            vault,
                            dk: Zeroizing::new(dk),
                        }),
                        src,
                    ),
                    Err(err) => {
                        tracing::error!(target: "flux::vault", "{err}");
                        // Keep vault locked on decryption/read failure so it is never
                        // overwritten with an empty default vault.
                        (None, "error")
                    }
                }
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
        crate::persist::write_atomic_with(&self.path, &blob, crate::persist::Durability::Full)
            .map_err(|e| e.to_string())
    }

    /// Run `f` against the decrypted vault, or error if locked. Touches activity.
    fn read_open<R>(&self, f: impl FnOnce(&Vault) -> R) -> Result<R, String> {
        let r = self.probe_open(f)?;
        self.touch();
        Ok(r)
    }
    /// [`read_open`](Self::read_open) that isn't user activity: chrome polls,
    /// page probes and the sentinel's per-navigation read would otherwise hold
    /// an idle vault open past its auto-lock indefinitely.
    fn probe_open<R>(&self, f: impl FnOnce(&Vault) -> R) -> Result<R, String> {
        let guard = self.open.read();
        let u = guard.as_ref().ok_or("vault is locked")?;
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

/// The data key: the keychain's (`keychain` is [`keychain_key`]'s answer), else
/// an existing key.bin, else, only when there is no vault yet, a new one.
fn obtain_key(
    dir: &Path,
    keychain: Result<Option<[u8; 32]>, String>,
) -> (Option<[u8; 32]>, &'static str) {
    match &keychain {
        Ok(Some(k)) => return (Some(*k), "keychain"),
        Ok(None) => {}
        Err(e) => tracing::warn!(target: "flux::vault", "OS keychain unavailable: {e}"),
    }
    // An empty keychain doesn't mean a first run: key.bin sealed the vault on
    // any boot when the keychain wasn't available.
    if let Some(k) = read_file_key(dir) {
        return (Some(k), "file");
    }
    // A new key can't open an existing vault, and once in the keychain it would
    // shadow the real key on every later boot.
    if vault_on_disk(dir) {
        tracing::error!(target: "flux::vault", "the vault's key is missing; not minting a new one");
        return (None, "none");
    }
    let k = flux_vault::new_key();
    // The keychain only if it answered above.
    let source = if keychain.is_ok() {
        store_key(dir, &k)
    } else {
        store_key_file(dir, &k)
    };
    if source == "none" {
        tracing::error!(target: "flux::vault", "no vault key (keychain + file failed)");
        return (None, "none");
    }
    (Some(k), source)
}

/// Is there already a vault a new key would orphan? An empty vault.bin holds
/// nothing; one we can't even stat is assumed to hold something.
fn vault_on_disk(dir: &Path) -> bool {
    let sealed = match std::fs::metadata(dir.join("vault.bin")) {
        Ok(m) => m.len() > 0,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    };
    sealed || dir.join("keywrap.json").is_file()
}

/// Whether `keyring` has a real OS secret store on this target. Everywhere else
/// (notably Android) keyring 3 silently uses its in-memory mock: every `Entry`
/// starts empty and `set_password` "succeeds" without storing anything, so a key
/// kept there is gone at exit and the data sealed with it can never be opened.
pub(crate) const HAS_OS_KEYCHAIN: bool = cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd"
));

/// The keychain's copy of the data key; `Ok(None)` when it has none.
fn keychain_key() -> Result<Option<[u8; 32]>, String> {
    if !HAS_OS_KEYCHAIN {
        return Err("no OS keychain on this platform".into());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(hex) => decode_key(&hex).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// key.bin's key, if there is a well-formed one.
fn read_file_key(dir: &Path) -> Option<[u8; 32]> {
    std::fs::read(dir.join("key.bin")).ok()?.try_into().ok()
}

/// Store the data key in the keychain (preferred) or a 0600 key file.
fn store_key(dir: &Path, dk: &[u8; 32]) -> &'static str {
    if HAS_OS_KEYCHAIN {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
            if entry.set_password(&encode_key(dk)).is_ok() {
                return "keychain";
            }
        }
    }
    store_key_file(dir, dk)
}

/// [`store_key`]'s 0600 key file on its own.
fn store_key_file(dir: &Path, dk: &[u8; 32]) -> &'static str {
    let p = dir.join("key.bin");
    // fsync + rename: this may be about to become the key's only copy.
    if crate::persist::write_secret_atomic(&p, dk, crate::persist::Durability::Full).is_ok() {
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
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| "bad key hex".to_string())?;
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
    // Full: it records where the data key lives (keychain, file or password wrap).
    crate::persist::write_atomic_with(
        &dir.join("meta.json"),
        s.as_bytes(),
        crate::persist::Durability::Full,
    )
    .map_err(|e| e.to_string())
}

fn read_never_save(dir: &Path) -> HashSet<String> {
    std::fs::read_to_string(dir.join("never-save.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn write_never_save(dir: &Path, set: &HashSet<String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let list: Vec<&String> = set.iter().collect();
    let s = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("never-save.json"), s).map_err(|e| e.to_string())
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
    /// For a login listed for a page (`vault_for_host`): the site it was saved
    /// for, and whether that is the page's own host. `None` in the full list.
    pub saved_host: Option<String>,
    pub exact: Option<bool>,
}

impl From<&Credential> for CredentialMeta {
    fn from(c: &Credential) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            urls: c.urls.clone(),
            username: c.username.clone(),
            has_totp: !c.totp.is_empty(),
            saved_host: None,
            exact: None,
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

/// Run vault work that derives a key (Argon2id, slow by design) on a worker
/// thread. These commands ran on the main thread, so unlocking, changing the
/// master password, importing a Proton or Flux export and writing an encrypted
/// export each froze the window for as long as the derivation took.
async fn off_main<R: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&VaultState) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<VaultState>()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn vault_status(state: State<'_, VaultState>) -> VaultStatus {
    let protection = if *state.protection.read() == Protection::Password {
        "password"
    } else {
        "keychain"
    };
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
pub async fn vault_unlock(app: AppHandle, password: String) -> Result<(), String> {
    off_main(app, move |state| unlock(state, password)).await
}

/// [`vault_unlock`]'s work. The key is derived before the vault's lock is
/// taken, so nothing waits on the lock while Argon2 runs.
fn unlock(state: &VaultState, password: String) -> Result<(), String> {
    if state.open.read().is_some() {
        return Ok(());
    }
    let wrap = read_keywrap(&state.dir)?;
    let dk = flux_vault::unwrap_key(&password, &wrap)
        .map_err(|_| "wrong master password".to_string())?;
    let vault = match std::fs::read(&state.path) {
        Ok(blob) if !blob.is_empty() => Vault::decrypt(&dk, &blob).map_err(|e| e.to_string())?,
        Ok(_) => Vault::default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vault::default(),
        // Same rule as `hydrate_keychain`: any other read failure (EMFILE late in
        // a long session, an antivirus or backup lock, EIO) keeps the vault
        // locked. Unlocking an empty vault here let the next save seal it over
        // vault.bin and destroy every stored credential.
        Err(e) => return Err(format!("couldn't read the vault: {e}")),
    };
    *state.open.write() = Some(Unlocked {
        vault,
        dk: Zeroizing::new(dk),
    });
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
pub async fn vault_set_master_password(app: AppHandle, password: String) -> Result<(), String> {
    off_main(app, move |state| set_master_password(state, password)).await
}

fn set_master_password(state: &VaultState, password: String) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("master password cannot be empty".into());
    }
    let dk = {
        let guard = state.open.read();
        *guard.as_ref().ok_or("unlock the vault first")?.dk
    };
    let wrap = flux_vault::wrap_key(&password, &dk).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&wrap).map_err(|e| e.to_string())?;
    // keywrap.json becomes (on a change, already is) the data key's only copy:
    // replace it atomically so a crash leaves the old wrap or the new one, never
    // a torn file, and record password mode before removing the other copies.
    let wrap_path = state.dir.join("keywrap.json");
    crate::persist::write_secret_atomic(
        &wrap_path,
        json.as_bytes(),
        crate::persist::Durability::Full,
    )
    .map_err(|e| e.to_string())?;
    set_owner_only(&wrap_path);
    write_meta(
        &state.dir,
        &Meta {
            protection: "password".into(),
            autolock_minutes: state.autolock_min.load(Ordering::Relaxed),
        },
    )?;
    purge_key(&state.dir); // DK now recoverable only via the password
    *state.protection.write() = Protection::Password;
    *state.source.write() = "password";
    Ok(())
}

/// Remove master-password protection: verify the password, then move the data
/// key back to the OS keychain. Requires the vault unlocked.
#[tauri::command]
pub async fn vault_disable_master_password(app: AppHandle, password: String) -> Result<(), String> {
    off_main(app, move |state| disable_master_password(state, password)).await
}

fn disable_master_password(state: &VaultState, password: String) -> Result<(), String> {
    let dk = {
        let guard = state.open.read();
        *guard.as_ref().ok_or("unlock the vault first")?.dk
    };
    // Confirm the caller knows the current password.
    let wrap = read_keywrap(&state.dir)?;
    let check = flux_vault::unwrap_key(&password, &wrap)
        .map_err(|_| "wrong master password".to_string())?;
    if check != dk {
        return Err("wrong master password".into());
    }
    let source = store_key(&state.dir, &dk);
    if source == "none" {
        // Neither the keychain nor key.bin took the key, so keywrap.json is still
        // its only durable copy: keep it, and keep password mode.
        return Err(
            "couldn't store the vault key in the OS keychain or a key file; the master password is still set"
                .into(),
        );
    }
    if let Err(e) = write_meta(
        &state.dir,
        &Meta {
            protection: "keychain".into(),
            autolock_minutes: state.autolock_min.load(Ordering::Relaxed),
        },
    ) {
        // Still password mode on disk: don't leave the data key at rest beside it.
        purge_key(&state.dir);
        return Err(e);
    }
    let _ = std::fs::remove_file(state.dir.join("keywrap.json"));
    *state.protection.write() = Protection::Keychain;
    *state.source.write() = source;
    Ok(())
}

/// Set the idle auto-lock timeout in minutes (0 = never). Only effective in
/// password mode.
#[tauri::command]
pub fn vault_set_autolock(state: State<'_, VaultState>, minutes: u64) -> Result<(), String> {
    state.autolock_min.store(minutes, Ordering::Relaxed);
    let protection = if *state.protection.read() == Protection::Password {
        "password"
    } else {
        "keychain"
    };
    write_meta(
        &state.dir,
        &Meta {
            protection: protection.into(),
            autolock_minutes: minutes,
        },
    )
}

/// Not activity: the Passwords page polls this every few seconds, and the
/// sentinel reads it on every navigation.
#[tauri::command]
pub fn vault_list(state: State<'_, VaultState>) -> Result<Vec<CredentialMeta>, String> {
    state.probe_open(|v| v.entries.iter().map(CredentialMeta::from).collect())
}

/// Not activity: the open Passwords popover polls this.
#[tauri::command]
pub fn vault_for_host(
    app: AppHandle,
    state: State<'_, VaultState>,
    host: String,
    tab: Option<u64>,
) -> Result<Vec<CredentialMeta>, String> {
    // The tab's port, so a login saved for another port on this host is listed
    // as what it is (and named with its port), not as this page's own.
    let port = tab
        .and_then(|id| app.get_webview(&format!("tab-{id}")))
        .and_then(|wv| crate::committed::url_of(&wv).ok())
        .and_then(|url| url.port_or_known_default());
    state.probe_open(|v| {
        let mut found: Vec<CredentialMeta> = v
            .entries
            .iter()
            .filter_map(|c| {
                let (kind, saved) = c.match_for(&host, port)?;
                let mut meta = CredentialMeta::from(c);
                meta.saved_host = Some(saved);
                meta.exact = Some(kind == HostMatch::Exact);
                Some(meta)
            })
            .collect();
        // The page's own logins first; the sort is stable within each group.
        found.sort_by_key(|m| m.exact != Some(true));
        found
    })
}

#[tauri::command]
pub fn vault_reveal(state: State<'_, VaultState>, id: String) -> Result<Option<String>, String> {
    state.read_open(|v| {
        v.entries
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.password.clone())
    })
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
        urls: if url.trim().is_empty() {
            vec![]
        } else {
            vec![url]
        },
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
///
/// The file is parsed, and decrypted when it's a Flux or PGP export, into a
/// scratch vault first, without the lock: the vault's lock is held only to
/// merge the result, so autofill and the Passwords page don't wait on the
/// decryption.
#[tauri::command]
pub async fn vault_import_proton(
    app: AppHandle,
    path: String,
    passphrase: Option<String>,
) -> Result<usize, String> {
    off_main(app, move |state| {
        state.probe_open(|_| ())?; // locked: say so before the slow part
        let data = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        let mut parsed = Vault::default();
        let count = parsed
            .import(&data, &path, passphrase.as_deref())
            .map_err(|e| e.to_string())?;
        state.write_open(|v| {
            for c in parsed.entries {
                v.upsert(c);
            }
        })?;
        Ok(count)
    })
    .await
}

/// Export the whole vault to `path` so it can be carried to another device
/// (BACKLOG #61 follow-up; the vault is deliberately outside sync, ADR 0017).
///
/// Two formats, and the difference matters:
///
/// - `"encrypted"` (default): a passphrase-sealed `.fluxvault` file
///   (Argon2id + AES-256-GCM, independent of this device's data key). Safe to
///   put on a USB stick or through a sync folder; useless without the
///   passphrase. The other device imports it on the same Import screen.
/// - `"csv"`: **every password in the clear**, for moving into another manager.
///   Only produced when the caller asks for it by name; the chrome confirms
///   first, and the count we return is what the UI tells the user to delete.
///
/// Returns the number of logins written. Requires the vault unlocked.
#[tauri::command]
pub async fn vault_export(
    app: AppHandle,
    path: String,
    format: Option<String>,
    passphrase: Option<String>,
) -> Result<usize, String> {
    off_main(app, move |state| export(state, path, format, passphrase)).await
}

fn export(
    state: &VaultState,
    path: String,
    format: Option<String>,
    passphrase: Option<String>,
) -> Result<usize, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("choose where to write the export".into());
    }
    if target.is_dir() {
        return Err(format!(
            "{} is a folder — give a file path",
            target.display()
        ));
    }
    // Never let an export land on the live vault: `vault.bin`/`keywrap.json`
    // are the one pair whose loss is unrecoverable.
    let in_vault_dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| same_dir(p, &state.dir))
        .unwrap_or(false);
    if in_vault_dir {
        return Err("refusing to write inside Flux's own vault folder".into());
    }
    if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("no such folder: {}", parent.display()));
        }
    }

    let fmt = format.as_deref().unwrap_or("encrypted");
    let pass = passphrase.unwrap_or_default();
    let (bytes, count) = match fmt {
        "encrypted" => {
            if pass.trim().is_empty() {
                return Err("an encrypted export needs a passphrase".into());
            }
            // Sealed from a copy, outside the lock: the passphrase's Argon2 run
            // would otherwise hold every save to the vault until it finished.
            let (copy, count) = state.read_open(|v| (v.clone(), v.entries.len()))?;
            let sealed = copy.export_encrypted(&pass).map_err(|e| e.to_string())?;
            (Zeroizing::new(sealed), count)
        }
        "csv" => state.read_open(|v| {
            v.export_csv()
                .map(|s| (Zeroizing::new(s.as_bytes().to_vec()), v.entries.len()))
                .map_err(|e| e.to_string())
        })??,
        other => return Err(format!("unknown export format: {other}")),
    };

    write_secret(&target, &bytes).map_err(|e| format!("write {}: {e}", target.display()))?;
    tracing::info!(
        target: "flux::vault",
        "exported {count} logins as {fmt} to {}",
        target.display()
    );
    Ok(count)
}

/// Are these the same directory? Compares canonical paths where possible (so
/// `.`, symlinks and drive-letter casing don't fool the guard), else the
/// paths as given.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Create `path` owner-only *before* writing secrets into it — a plain
/// `fs::write` would publish a world-readable file first and tighten it after.
fn write_secret(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    set_owner_only(path);
    Ok(())
}

#[cfg(test)]
mod export_tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-vault-export-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_secret_truncates_a_previous_export() {
        let dir = tmp("truncate");
        let p = dir.join("export.fluxvault");
        write_secret(&p, b"a much longer previous export").unwrap();
        // Re-exporting a smaller vault must not leave the old tail behind —
        // a Flux export is length-delimited, but a stale tail would still be
        // a chunk of the old ciphertext sitting on disk.
        write_secret(&p, b"short").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"short");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "export must be owner-only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_dir_sees_through_dot_segments() {
        let dir = tmp("samedir");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(same_dir(&sub, &dir.join("sub")));
        assert!(same_dir(&sub, &dir.join(".").join("sub")));
        assert!(!same_dir(&sub, &dir));
        // Non-existent paths can't canonicalize; fall back to comparing as given.
        let ghost = dir.join("nope");
        assert!(same_dir(&ghost, &ghost));
        assert!(!same_dir(&ghost, &dir.join("other")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Fill the active tab's login form with credential `id` (same-origin enforced;
/// password injected straight into the page, never via the chrome's JS).
///
/// A login saved for this very site (host and port) fills. One saved for a
/// related site, a sub- or parent domain or another port, fills only with
/// `confirm_related`, which the chrome sends after showing the user both names
/// (audit S25): `evil.tumblr.com` is not `tumblr.com`.
#[tauri::command]
pub fn vault_fill(
    app: AppHandle,
    state: State<'_, VaultState>,
    tab_id: u64,
    id: String,
    confirm_related: Option<bool>,
    expected_host: Option<String>,
) -> Result<(), String> {
    let webview = app
        .get_webview(&format!("tab-{tab_id}"))
        .ok_or("no such tab webview")?;
    // The document actually running, not where a pending navigation is
    // headed (audit S8).
    let current_url = crate::committed::url_of(&webview)?;
    require_secure_credential_origin(&current_url)?;
    let host = current_url
        .host_str()
        .ok_or("no host on current page")?
        .to_ascii_lowercase();
    // The fill bar asked about one page. If the tab has moved on since, what the
    // user agreed to (above all "use it on this related site") was about
    // another page: ask again there.
    if expected_host.is_some_and(|shown| shown != shown_host(&current_url)) {
        return Err("the page changed since the fill bar opened; ask again".into());
    }

    // Credential-entry firewall (ADR 0013, Pillar 2): never type a saved password
    // into a site that impersonates a brand the user values — even if a
    // credential nominally matches this host (it would, had the user been
    // phished here before). Refusing is safe: the user can still type manually.
    if let Some(v) = crate::sentinel::credential_origin_risk(&app, &host) {
        return Err(format!(
            "Flux blocked autofill: “{host}” looks like an impersonation of “{}”. \
             Check the address bar before entering your password.",
            v.resembles
        ));
    }

    let port = current_url.port_or_known_default();
    let found = state.read_open(|v| {
        v.entries.iter().find(|c| c.id == id).and_then(|c| {
            let (kind, saved) = c.match_for(&host, port)?;
            Some((kind, saved, c.username.clone(), c.password.clone()))
        })
    })?;
    let (kind, saved, user, pass) = found.ok_or_else(|| format!("no credential matches {host}"))?;
    if kind == HostMatch::Related && confirm_related != Some(true) {
        return Err(format!(
            "this login was saved for {saved}, not for {host}; confirm to use it here"
        ));
    }

    // Recheck URL right before injection:
    let rechecked = crate::committed::url_of(&webview)?;
    if rechecked != current_url {
        return Err("document navigated during autofill authorization".into());
    }

    let u = serde_json::to_string(&user).unwrap_or_else(|_| "\"\"".into());
    let p = serde_json::to_string(&pass).unwrap_or_else(|_| "\"\"".into());
    // And the script itself fills only on that origin: if the document changed
    // between the check and the eval, it does nothing.
    let origin = serde_json::to_string(&current_url.origin().ascii_serialization())
        .unwrap_or_else(|_| "\"\"".into());
    let js =
        format!("if (location.origin === {origin}) {{\n{AUTOFILL_JS}\n;__fluxFill({u},{p});\n}}");
    webview.eval(&js).map_err(|e| e.to_string())
}

// ─── Page sentinel (#61 follow-up) ───────────────────────────────────────────
// Commands the injected passwords.js may call (fluxtab plugin). The calling
// tab is identified from the webview's OWN label (`tab-{id}`) — page-supplied
// ids are never trusted, so a page can only ever act on itself. None of them is
// vault activity (`probe_open`): any page could keep an idle vault unlocked.

/// What the sentinel needs to decide which chip to show on a login form. No
/// usernames: every script on the page can read this, and the chrome's fill bar
/// is where the user sees which login will be used.
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct PageVaultInfo {
    pub unlocked: bool,
    /// Saved credentials matching the calling tab's host.
    pub count: u32,
}

/// One login the chrome's fill bar can offer. Metadata only: the password stays
/// in Rust until the user confirms and `vault_fill` injects it.
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct FillChoice {
    pub id: String,
    pub username: String,
    pub name: String,
    /// The site this login was saved for, which the bar names: the page's own
    /// host says nothing about whose login is about to be typed into it.
    pub saved_host: String,
    /// False for a login saved for a related site (a sub- or parent domain, or
    /// another port). The bar then shows both names and asks a second time.
    pub exact: bool,
}

/// The chrome's "Fill password?" bar payload: a page asked to autofill.
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct VaultFillRequest {
    /// The tab that asked. `vault_fill` fills only that tab, and only while it is
    /// still on a host the chosen login matches.
    pub tab: u64,
    pub host: String,
    /// Logins matching `host`, best first.
    pub choices: Vec<FillChoice>,
}

/// Why autofill did (or didn't) offer on a page — the answer to "the key icon
/// never appeared and I don't know why".
///
/// `vault_page_info` deliberately collapses every failure into "locked" so a
/// hostile page learns nothing from probing it. That's right for the page and
/// useless for the user: a locked vault, a phishing verdict, and simply having
/// no saved login all look identical. This type is the honest version, and it's
/// **chrome-only** — never in the fluxtab ACL, so a page can't ask it.
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct VaultDiag {
    /// Machine-readable stage that stopped the offer.
    pub stage: String,
    /// One sentence the user can act on.
    pub detail: String,
    pub host: String,
    /// Saved credentials matching this host (0 unless the vault is unlocked).
    pub matches: u32,
    /// The page script's own last reason for not showing a chip, if it reported
    /// one — covers the causes Rust can't see (no form on the page, the field
    /// already had a value, the chip was dismissed).
    pub page_reason: String,
}

/// Last reason `passwords.js` gave for not offering, per tab. Bounded by tab
/// count; cleared when a tab reports a new state.
static PAGE_REASONS: std::sync::LazyLock<parking_lot::RwLock<HashMap<u64, String>>> =
    std::sync::LazyLock::new(|| parking_lot::RwLock::new(HashMap::new()));

/// Page → chrome breadcrumb: why `passwords.js` didn't show a fill chip. Reported
/// fire-and-forget by the injected script so the chrome-side diagnostic can name
/// causes that only exist in the DOM. Carries no page content — a fixed
/// vocabulary of reason codes, capped, so it can't become an exfiltration path.
#[tauri::command]
pub fn vault_probe_report(webview: tauri::Webview, reason: String) {
    let Ok(tab) = caller_tab(&webview) else {
        return;
    };
    // Fixed vocabulary only: anything else is recorded as "unknown" rather than
    // stored verbatim.
    let known = [
        "alive",
        "login-in-frame",
        "no-password-field",
        "no-login-field",
        "field-prefilled",
        "dismissed",
        "already-handled",
        "registration",
        "probe-failed",
        "scan-error",
        "offered",
    ];
    let code = if known.contains(&reason.as_str()) {
        reason
    } else {
        "unknown".to_string()
    };
    PAGE_REASONS.write().insert(tab, code);
}

/// Diagnose why autofill didn't offer on `tab` — walks the same gates the page
/// probe walks, but reports which one actually stopped it.
#[tauri::command]
pub fn vault_why(app: AppHandle, state: State<'_, VaultState>, tab: u64) -> VaultDiag {
    let page_reason = PAGE_REASONS.read().get(&tab).cloned().unwrap_or_default();
    let mut diag = VaultDiag {
        stage: "unknown".into(),
        detail: "Couldn't determine why.".into(),
        host: String::new(),
        matches: 0,
        page_reason: page_reason.clone(),
    };
    let Ok(host) = tab_host(&app, tab) else {
        diag.stage = "no-host".into();
        diag.detail = "This tab has no page host (an internal page or a closed tab).".into();
        return diag;
    };
    diag.host = host.clone();
    // Same firewall the chip honours — but say so, instead of looking "locked".
    if let Some(v) = crate::sentinel::credential_origin_risk(&app, &host) {
        diag.stage = "blocked".into();
        diag.detail = format!(
            "Sentinel judged {host} to be impersonating {} — autofill is withheld on purpose. \
If that's wrong, this is a false positive worth reporting.",
            v.resembles
        );
        return diag;
    }
    match state.read_open(|v| v.matches(&host).len() as u32) {
        Err(_) => {
            diag.stage = "locked".into();
            diag.detail = "The vault is locked — unlock it and reload the page.".into();
        }
        Ok(0) => {
            diag.stage = "no-match".into();
            diag.detail =
                format!("No saved login matches {host}. Add one, or check the stored host.");
        }
        Ok(n) => {
            diag.matches = n;
            // Rust is happy — so if nothing appeared, the page side is why.
            diag.stage = match page_reason.as_str() {
                "no-password-field" | "no-login-field" => "no-form".into(),
                "login-in-frame" => "in-frame".into(),
                // Only the heartbeat arrived: the script is running, but no scan
                // ever reached a verdict.
                "alive" => "no-scan".into(),
                "field-prefilled" => "prefilled".into(),
                "dismissed" => "dismissed".into(),
                "registration" => "registration".into(),
                "scan-error" => "scan-error".into(),
                "offered" => "ok".into(),
                _ => "page-silent".into(),
            };
            const NO_FORM: &str = "Vault is fine, but no login field was found on the page \
(a form inside a cross-origin iframe can't be reached).";
            const PREFILLED: &str = "Vault is fine, but the field already had a value, so the \
offer was skipped.";
            const DISMISSED: &str = "You dismissed the chip on this page; reload to get it back.";
            const SILENT: &str = "Vault is unlocked and matching, but the page script never \
reported back — it isn't running here (not injected, or the page blocked it).";
            const IN_FRAME: &str = "Vault is fine, and the login is inside an iframe. Autofill only \
runs in the top document on purpose, so an embedded third party can never trigger a fill — open the \
sign-in page directly and it will offer.";
            const SCAN_ERROR: &str = "The page script threw while scanning this \
page. Its form markup hit an unhandled case, which is worth reporting.";
            const REGISTRATION: &str = "This looks like a sign-up form, so Flux offered a \
generated password instead of a fill.";
            const NO_SCAN: &str =
                "The page script is running but never finished a scan — the form \
may render after the check. Focus the login field to retrigger it.";
            diag.detail = match diag.stage.as_str() {
                "no-form" => NO_FORM.into(),
                "prefilled" => PREFILLED.into(),
                "dismissed" => DISMISSED.into(),
                "in-frame" => IN_FRAME.into(),
                "registration" => REGISTRATION.into(),
                "scan-error" => SCAN_ERROR.into(),
                "no-scan" => NO_SCAN.into(),
                "ok" => format!("Autofill offered {n} saved login(s) for {host}."),
                _ => SILENT.into(),
            };
        }
    }
    diag
}

/// The calling webview's tab id (`tab-{id}` label), or an error for any other
/// webview (panels, peeks, the chrome itself).
fn caller_tab(webview: &tauri::Webview) -> Result<u64, String> {
    webview
        .label()
        .strip_prefix("tab-")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "not a tab webview".into())
}

fn require_secure_credential_origin(url: &tauri::Url) -> Result<(), String> {
    if url.scheme() == "https" {
        return Ok(());
    }
    if url.scheme() == "http" {
        if let Some(h) = url.host_str() {
            if h == "localhost" || h == "127.0.0.1" || h == "::1" {
                return Ok(());
            }
        }
    }
    Err(format!(
        "credentials require a secure origin (https or localhost); refused for {}",
        url.as_str()
    ))
}

/// The origin of the document a webview is running, for a credential decision.
struct PageOrigin {
    host: String,
    /// The host as a prompt shows it ([`shown_host`]).
    shown: String,
    /// The origin's effective port (443 for https with none written).
    port: Option<u16>,
    /// `https://host`, or with its port when that isn't the scheme's own.
    origin: String,
}

fn page_origin(webview: &tauri::Webview) -> Result<PageOrigin, String> {
    let url = crate::committed::url_of(webview)?;
    require_secure_credential_origin(&url)?;
    let host = url
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .ok_or("no host on current page")?;
    Ok(PageOrigin {
        shown: shown_host(&url),
        host,
        port: url.port_or_known_default(),
        origin: url.origin().ascii_serialization(),
    })
}

fn webview_secure_host(webview: &tauri::Webview) -> Result<String, String> {
    page_origin(webview).map(|p| p.host)
}

/// A page's host as a prompt shows it: with its port when the URL writes one
/// (a port that isn't the scheme's own), since `localhost:3000` and
/// `localhost:8080` are different servers.
fn shown_host(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

/// Whether this exact login is already stored for the page (so there is nothing
/// to ask), and whether saving it would replace the password of the login saved
/// for this very site (an Update). A login saved for a related site is never
/// updated from here (audit S26): a page on `a.example.com` doesn't get to
/// change what is stored for `example.com`.
fn save_kind(
    v: &Vault,
    host: &str,
    port: Option<u16>,
    username: &str,
    password: &str,
) -> (bool, bool) {
    // This site's own entry decides when there is one: the same password is
    // "already", another is an Update. A related site's entry with this very
    // password only counts when this site has none of its own, so signing in on
    // a subdomain with the parent's login doesn't ask every time.
    let (mut exact_same, mut exact_other, mut related_same) = (false, false, false);
    for c in v.entries.iter().filter(|c| c.username == username) {
        match c.match_for(host, port) {
            Some((HostMatch::Exact, _)) if c.password == password => exact_same = true,
            Some((HostMatch::Exact, _)) => exact_other = true,
            Some((HostMatch::Related, _)) if c.password == password => related_same = true,
            _ => {}
        }
    }
    let already = exact_same || (related_same && !exact_other);
    (already, exact_other && !exact_same)
}

/// A tab's capture is no longer wanted (its login turned out to be stored
/// already, or a later submit couldn't be judged): drop it and take its prompt
/// down, so a stale "Update" can't be clicked after the fact.
fn withdraw_save(app: &AppHandle, state: &VaultState, tab: u64) {
    if state.pending_save.write().remove(&tab).is_some() {
        let _ = app.emit("flux://vault-save-clear", tab);
    }
}

fn tab_host(app: &AppHandle, tab_id: u64) -> Result<String, String> {
    if let Some(wv) = app.get_webview(&format!("tab-{tab_id}")) {
        if let Ok(h) = webview_secure_host(&wv) {
            return Ok(h);
        }
    }
    let s = app
        .try_state::<crate::state::FluxState>()
        .ok_or("state unavailable")?;
    let tab = s.tabs.get(&tab_id).ok_or("no such tab")?;
    let parsed = tauri::Url::parse(&tab.url).map_err(|e| e.to_string())?;
    require_secure_credential_origin(&parsed)?;
    parsed
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .ok_or_else(|| "no host in tab url".into())
}

/// Sentinel probe: is the vault unlocked, and do any credentials match the
/// calling tab's host? Leaks no secrets — count + username only (the same
/// metadata the chrome's Passwords popover shows).
#[tauri::command]
pub fn vault_page_info(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, VaultState>,
) -> PageVaultInfo {
    let locked_out = PageVaultInfo {
        unlocked: false,
        count: 0,
    };
    let Ok(_tab) = caller_tab(&webview) else {
        return locked_out;
    };
    let Ok(host) = webview_secure_host(&webview) else {
        return locked_out;
    };
    // Credential-entry firewall: on an impersonating host, show no fill chip at
    // all — the safest prompt is the one that never invites the fill.
    if crate::sentinel::credential_origin_risk(&app, &host).is_some() {
        return locked_out;
    }
    state
        .probe_open(|v| PageVaultInfo {
            unlocked: true,
            count: v.matches(&host).len() as u32,
        })
        .unwrap_or(locked_out)
}

/// The sentinel chip's click action: ask the user, in the chrome, to fill this
/// tab. The click proves nothing. The chip, `passwords.js` and the IPC bridge
/// share one JS world with every script the page loads, so any of them can call
/// this. A password therefore reaches the page only after the user confirms in
/// the chrome's fill bar, which calls the chrome-only `vault_fill` (it re-checks
/// the secure origin, the firewall, the host match and that the URL is stable).
/// Every refusal returns the same error, so probing it tells a page nothing.
#[tauri::command]
pub fn vault_fill_page(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let refused = || "autofill unavailable".to_string();
    let tab = caller_tab(&webview).map_err(|_| refused())?;
    // Before anything else, so a page that keeps asking learns nothing more
    // from the calls that are turned away.
    if !state.asks.admit(tab, AskKind::Fill, now_ms()) {
        return Err(refused());
    }
    let page = page_origin(&webview).map_err(|_| refused())?;
    if crate::sentinel::credential_origin_risk(&app, &page.host).is_some() {
        return Err(refused());
    }
    let mut choices: Vec<FillChoice> = state
        .probe_open(|v| {
            v.entries
                .iter()
                .filter_map(|c| {
                    let (kind, saved_host) = c.match_for(&page.host, page.port)?;
                    Some(FillChoice {
                        id: c.id.clone(),
                        username: c.username.clone(),
                        name: c.name.clone(),
                        saved_host,
                        exact: kind == HostMatch::Exact,
                    })
                })
                .collect()
        })
        .map_err(|_| refused())?;
    if choices.is_empty() {
        return Err(refused());
    }
    // This site's own logins first (stable within each group).
    choices.sort_by_key(|c| !c.exact);
    let _ = app.emit(
        "flux://vault-fill-request",
        VaultFillRequest {
            tab,
            host: page.shown,
            choices,
        },
    );
    Ok(())
}

/// A strong password for a registration form (#61 follow-up). Requires the
/// vault to be unlocked so the paired `vault_save_from_page` on submit can
/// actually keep the promise of remembering it.
#[tauri::command]
pub fn vault_suggest_password(state: State<'_, VaultState>) -> Result<String, String> {
    state.probe_open(|_| ())?; // unlocked check only: a page call isn't activity
    Ok(flux_vault::generate_password(20))
}

/// Stage a credential the sentinel captured on registration submit and ask the
/// user to keep it (the chrome's save bar, then `vault_save_confirm`). Host comes
/// from the calling tab (label-derived), never from the page. Any script on the
/// page can call this, so it never writes the vault itself: a direct upsert let a
/// page replace the saved password for this host (same `stable_id` as a confirmed
/// save) or flood the vault with re-seals and fsyncs on the main thread.
#[tauri::command]
pub fn vault_save_from_page(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, VaultState>,
    username: String,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("empty password".into());
    }
    let tab = caller_tab(&webview)?;
    if !state.asks.admit(tab, AskKind::Save, now_ms()) {
        // This submit can't be judged, so an earlier capture may be out of date.
        withdraw_save(&app, &state, tab);
        return Err("try again in a moment".into());
    }
    let page = page_origin(&webview)?;
    let host = page.host.clone();
    if host.is_empty() {
        return Err("no host".into());
    }
    // Same firewall as `vault_offer_save`: never stage (and so never whitewash)
    // a host that impersonates a brand the user values.
    if crate::sentinel::credential_origin_risk(&app, &host).is_some() {
        return Err("saving is blocked on this site".into());
    }
    // No never-save skip here: the user just accepted a generated password, and
    // dropping it silently would lock them out of the new account.
    let (already, update) =
        state.probe_open(|v| save_kind(v, &host, page.port, &username, &password))?;
    if already {
        // Identical credential already stored. An earlier capture from this tab
        // (a mistyped password, say) is now wrong: take it back.
        withdraw_save(&app, &state, tab);
        return Ok(());
    }
    let staged = now_ms();
    state.stage_save(
        tab,
        PendingSave {
            host: host.clone(),
            port: page.port,
            origin: page.origin,
            username: username.clone(),
            password: Zeroizing::new(password),
            staged_ms: staged,
        },
    );
    let _ = app.emit(
        "flux://vault-save-prompt",
        VaultSavePrompt {
            tab,
            staged,
            host,
            username,
            update,
            warning: None,
        },
    );
    Ok(())
}

// ─── Save prompt for manually-typed logins (#61 follow-up) ───────────────────

/// The chrome's "Save password?" bar payload — host + username only; the
/// captured password stays in Rust ([`PendingSave`]) until the user confirms.
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct VaultSavePrompt {
    /// The tab the login was typed in. Its capture is that tab's own, and the
    /// bar shows only while that tab is in front.
    pub tab: u64,
    /// Which capture this prompt is about (when it was staged). Save sends it
    /// back, and only that capture is saved: not one that replaced it since.
    pub staged: u64,
    pub host: String,
    pub username: String,
    /// True when the site already has this username stored with a *different*
    /// password (offer "Update" rather than "Save").
    pub update: bool,
    /// Set when the credential-entry firewall (ADR 0013, Pillar 2) judged this
    /// host to be impersonating a brand the user values. The bar then becomes a
    /// **warning** — "you just typed a password into a fake site" — and offers no
    /// save at all, because saving would also whitewash the host as known-good.
    pub warning: Option<crate::sentinel::phishing::Verdict>,
}

/// The sentinel captured a login submit whose password isn't (yet) in the vault.
/// Stash it and raise the chrome-side prompt. No-op — never an error the page
/// can observe — when the vault is locked, the host is opted out, or there's
/// nothing new to save; the user never sees a failed promise.
#[tauri::command]
pub fn vault_offer_save(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, VaultState>,
    username: String,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Ok(());
    }
    let Ok(tab) = caller_tab(&webview) else {
        return Ok(());
    };
    if !state.asks.admit(tab, AskKind::Save, now_ms()) {
        // This submit can't be judged, so an earlier capture may be out of date.
        withdraw_save(&app, &state, tab);
        return Ok(());
    }
    let Ok(page) = page_origin(&webview) else {
        return Ok(());
    };
    let host = page.host.clone();
    if host.is_empty() {
        return Ok(());
    }
    // Credential-entry firewall (ADR 0013, Pillar 2): the user just typed a
    // password into a site impersonating a brand they value. Warn instead of
    // offering to save — and warn *before* the never-save and vault-locked
    // early-outs below, because "don't ask to save here" and a locked vault are
    // no reason to stay silent about credential theft. Nothing is stashed, so
    // there is nothing to save (saving would also whitewash the host as
    // known-good, suppressing this very warning next time).
    if let Some(v) = crate::sentinel::credential_origin_risk(&app, &host) {
        let _ = app.emit(
            "flux://vault-save-prompt",
            VaultSavePrompt {
                tab,
                staged: 0,
                host,
                username,
                update: false,
                warning: Some(v),
            },
        );
        return Ok(());
    }
    if state.never_save.read().contains(&host) {
        return Ok(());
    }
    // Decide save vs update vs skip against the (unlocked) vault. Locked →
    // silently do nothing; we can't dedupe and the save would fail anyway.
    let Ok((already, update)) =
        state.probe_open(|v| save_kind(v, &host, page.port, &username, &password))
    else {
        return Ok(());
    };
    if already {
        // Identical credential already stored. An earlier capture from this tab
        // (a mistyped password, say) is now wrong: take it back.
        withdraw_save(&app, &state, tab);
        return Ok(());
    }
    let staged = now_ms();
    state.stage_save(
        tab,
        PendingSave {
            host: host.clone(),
            port: page.port,
            origin: page.origin,
            username: username.clone(),
            password: Zeroizing::new(password),
            staged_ms: staged,
        },
    );
    let _ = app.emit(
        "flux://vault-save-prompt",
        VaultSavePrompt {
            tab,
            staged,
            host,
            username,
            update,
            warning: None,
        },
    );
    Ok(())
}

/// Commit `tab`'s pending save (the chrome bar's "Save"/"Update"). Chrome-only.
#[tauri::command]
pub fn vault_save_confirm(
    app: AppHandle,
    state: State<'_, VaultState>,
    tab: u64,
    staged: u64,
) -> Result<(), String> {
    let pending = {
        let mut all = state.pending_save.write();
        let current = all.get(&tab).ok_or(SAVE_GONE)?;
        // Only the capture the bar showed, and only while it is fresh.
        if current.staged_ms != staged {
            return Err(SAVE_GONE.into());
        }
        if now_ms().saturating_sub(current.staged_ms) >= PENDING_SAVE_TTL_MS {
            all.remove(&tab);
            return Err(SAVE_GONE.into());
        }
        all.remove(&tab).ok_or(SAVE_GONE)?
    };
    let saved = state.write_open(|v| apply_save(v, &pending));
    if let Err(e) = saved {
        // Locked (auto-lock fired while the bar was up) or the write failed: put
        // the capture back, unless a newer one replaced it, so the bar's Save can
        // be retried after unlocking instead of the password being dropped.
        state.pending_save.write().entry(tab).or_insert(pending);
        return Err(e);
    }
    let _ = app.emit("flux://vault-saved", pending.host);
    Ok(())
}

/// Write a confirmed capture into the vault: the new password for the login
/// already saved for this very site and username (so a password *change*
/// replaces rather than piling up a sibling), else a new entry for this site.
/// A login saved for a related site is left alone.
fn apply_save(v: &mut Vault, pending: &PendingSave) {
    let password = pending.password.to_string();
    if let Some(c) = v.entries.iter_mut().find(|c| {
        c.username == pending.username
            && matches!(
                c.match_for(&pending.host, pending.port),
                Some((HostMatch::Exact, _))
            )
    }) {
        c.password = password;
        return;
    }
    let url = pending.origin.clone();
    v.upsert(Credential {
        id: Credential::stable_id(&pending.host, &pending.username, &url),
        name: pending.host.clone(),
        urls: vec![url],
        username: pending.username.clone(),
        password,
        totp: String::new(),
        notes: String::new(),
        created_ms: 0,
    });
}

/// Dismiss `tab`'s pending save ("Not now"). Chrome-only.
#[tauri::command]
pub fn vault_save_dismiss(state: State<'_, VaultState>, tab: u64) {
    state.pending_save.write().remove(&tab);
}

/// The tab closed (`tab_close`): nothing it captured should outlive it.
pub fn forget_tab(app: &AppHandle, tab: u64) {
    if let Some(state) = app.try_state::<VaultState>() {
        state.forget_tab(tab);
    }
}

/// "Never for this site": drop `tab`'s pending save and remember not to offer
/// for its host again. Chrome-only.
#[tauri::command]
pub fn vault_never_save(state: State<'_, VaultState>, tab: u64) -> Result<(), String> {
    let host = state.pending_save.write().remove(&tab).map(|p| p.host);
    if let Some(host) = host {
        state.never_save.write().insert(host);
        write_never_save(&state.dir, &state.never_save.read())?;
    }
    Ok(())
}

#[cfg(test)]
mod activity_tests {
    use super::*;

    #[test]
    fn probes_and_polls_dont_postpone_autolock() {
        let s = VaultState {
            open: RwLock::new(Some(Unlocked {
                vault: Vault::default(),
                dk: Zeroizing::new([7; 32]),
            })),
            dir: PathBuf::new(),
            path: PathBuf::new(),
            protection: RwLock::new(Protection::Password),
            source: RwLock::new("password"),
            autolock_min: AtomicU64::new(10),
            last_activity: AtomicU64::new(u64::MAX), // a value `touch` never writes
            pending_save: RwLock::new(HashMap::new()),
            asks: AskLimiter::default(),
            never_save: RwLock::new(HashSet::new()),
        };
        assert_eq!(s.probe_open(|v| v.entries.len()), Ok(0));
        assert_eq!(s.last_activity.load(Ordering::Relaxed), u64::MAX);
        s.read_open(|_| ()).unwrap();
        assert_ne!(s.last_activity.load(Ordering::Relaxed), u64::MAX);
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    fn login(url: &str, username: &str, password: &str) -> Credential {
        Credential {
            id: Credential::stable_id(url, username, url),
            name: url.into(),
            urls: vec![url.into()],
            username: username.into(),
            password: password.into(),
            totp: String::new(),
            notes: String::new(),
            created_ms: 0,
        }
    }

    fn capture(host: &str, origin: &str, username: &str, password: &str, at: u64) -> PendingSave {
        PendingSave {
            host: host.into(),
            port: Some(443),
            origin: origin.into(),
            username: username.into(),
            password: Zeroizing::new(password.into()),
            staged_ms: at,
        }
    }

    fn state() -> VaultState {
        VaultState {
            open: RwLock::new(None),
            dir: PathBuf::new(),
            path: PathBuf::new(),
            protection: RwLock::new(Protection::Password),
            source: RwLock::new("password"),
            autolock_min: AtomicU64::new(10),
            last_activity: AtomicU64::new(0),
            pending_save: RwLock::new(HashMap::new()),
            asks: AskLimiter::default(),
            never_save: RwLock::new(HashSet::new()),
        }
    }

    #[test]
    fn a_tab_gets_a_few_spaced_asks_and_no_more() {
        let asks = AskLimiter::default();
        assert!(asks.admit(1, AskKind::Fill, 10_000));
        // Straight away again: refused, and it doesn't use up the allowance.
        assert!(!asks.admit(1, AskKind::Fill, 10_100));
        // Another tab, and another kind of prompt, are counted on their own.
        assert!(asks.admit(2, AskKind::Fill, 10_100));
        assert!(asks.admit(1, AskKind::Save, 10_100));
        let mut now = 10_000;
        for _ in 1..ASK_PER_WINDOW {
            now += AskKind::Fill.gap_ms();
            assert!(asks.admit(1, AskKind::Fill, now));
        }
        now += AskKind::Fill.gap_ms();
        assert!(!asks.admit(1, AskKind::Fill, now), "the window is full");
        // A minute after the window opened, it starts over.
        assert!(asks.admit(1, AskKind::Fill, 10_000 + ASK_WINDOW_MS));
        asks.forget(1);
        assert!(asks.admit(1, AskKind::Fill, 10_000 + ASK_WINDOW_MS + 1));
    }

    #[test]
    fn one_tabs_capture_never_replaces_anothers() {
        let s = state();
        s.stage_save(
            1,
            capture("a.example", "https://a.example", "me", "one", 1_000),
        );
        s.stage_save(
            2,
            capture("b.example", "https://b.example", "me", "two", 1_100),
        );
        // The same tab again replaces only its own.
        s.stage_save(
            2,
            capture("b.example", "https://b.example", "me", "three", 1_200),
        );
        let pending = s.pending_save.read();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[&1].password.as_str(), "one");
        assert_eq!(pending[&2].password.as_str(), "three");
        drop(pending);
        s.forget_tab(1);
        assert!(!s.pending_save.read().contains_key(&1));
    }

    #[test]
    fn captures_are_bounded_in_number_and_in_time() {
        let s = state();
        for tab in 0..MAX_PENDING_SAVES as u64 + 3 {
            s.stage_save(
                tab,
                capture("x.example", "https://x.example", "me", "pw", 1_000 + tab),
            );
        }
        let pending = s.pending_save.read();
        assert_eq!(pending.len(), MAX_PENDING_SAVES);
        assert!(!pending.contains_key(&0), "the oldest went first");
        drop(pending);
        // Much later, one new capture clears out everything stale.
        s.stage_save(
            99,
            capture(
                "y.example",
                "https://y.example",
                "me",
                "pw",
                5_000 + PENDING_SAVE_TTL_MS,
            ),
        );
        assert_eq!(s.pending_save.read().len(), 1);
    }

    #[test]
    fn update_is_offered_only_for_the_login_saved_for_this_very_site() {
        let mut v = Vault::new();
        v.upsert(login("https://example.com", "me", "old"));
        // The same site, a new password: an Update.
        assert_eq!(
            save_kind(&v, "example.com", Some(443), "me", "new"),
            (false, true)
        );
        // Already stored exactly: nothing to ask.
        assert_eq!(
            save_kind(&v, "example.com", Some(443), "me", "old"),
            (true, false)
        );
        // A subdomain with a new password is a new login, never an Update.
        assert_eq!(
            save_kind(&v, "a.example.com", Some(443), "me", "new"),
            (false, false)
        );
        // Another user on the same site is a new login too.
        assert_eq!(
            save_kind(&v, "example.com", Some(443), "you", "new"),
            (false, false)
        );
        // The parent's login used on a subdomain is nothing new to ask about.
        assert_eq!(
            save_kind(&v, "a.example.com", Some(443), "me", "old"),
            (true, false)
        );
        // But this site's own entry decides when it has one: a related entry
        // that happens to hold the new password doesn't hide the Update.
        v.upsert(login("https://a.example.com", "me", "new"));
        assert_eq!(
            save_kind(&v, "example.com", Some(443), "me", "new"),
            (false, true)
        );
    }

    #[test]
    fn a_save_from_a_subdomain_leaves_the_parents_login_alone() {
        let mut v = Vault::new();
        v.upsert(login("https://example.com", "me", "parent-password"));
        apply_save(
            &mut v,
            &capture(
                "a.example.com",
                "https://a.example.com",
                "me",
                "sub-password",
                0,
            ),
        );
        assert_eq!(v.entries.len(), 2);
        let parent = v
            .entries
            .iter()
            .find(|c| c.urls[0] == "https://example.com")
            .unwrap();
        assert_eq!(parent.password, "parent-password");
        // On the site itself, the same username updates in place.
        apply_save(
            &mut v,
            &capture("example.com", "https://example.com", "me", "changed", 0),
        );
        assert_eq!(v.entries.len(), 2);
        let parent = v
            .entries
            .iter()
            .find(|c| c.urls[0] == "https://example.com")
            .unwrap();
        assert_eq!(parent.password, "changed");
    }
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn an_empty_keychain_never_shadows_an_existing_vault() {
        let dir = std::env::temp_dir().join(format!("flux-vault-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("vault.bin"), b"sealed").unwrap();
        // Sealed on a boot without a keychain: key.bin holds the real key.
        std::fs::write(dir.join("key.bin"), [9u8; 32]).unwrap();
        assert_eq!(obtain_key(&dir, Ok(None)), (Some([9u8; 32]), "file"));
        // No key anywhere for an existing vault: fail closed, mint nothing.
        std::fs::remove_file(dir.join("key.bin")).unwrap();
        assert_eq!(obtain_key(&dir, Ok(None)), (None, "none"));
        assert_eq!(obtain_key(&dir, Err("unavailable".into())), (None, "none"));
        assert!(!dir.join("key.bin").exists(), "nothing minted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
