//! Password vault integration (BACKLOG #61, ADR 0009).
//!
//! Wires [`flux_vault`] into Flux: the 32-byte data key comes from the OS
//! keychain (`keyring`) — Windows Credential Manager, macOS Keychain, Linux
//! Secret Service — with a file-backed fallback when no store is available
//! (e.g. headless WSL dev). The decrypted vault is held in memory for autofill
//! lookups; every mutation re-seals it to `app_data/vault/vault.bin`.
//!
//! Secrets boundary: credential *metadata* (no passwords) flows to the chrome
//! UI; the password itself only leaves Rust either on an explicit `vault_reveal`
//! (manager UI) or via `vault_fill`, which injects straight into the page —
//! never through the chrome's JS.

use std::path::{Path, PathBuf};

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use flux_vault::{Credential, Vault};

const KEYRING_SERVICE: &str = "Flux";
const KEYRING_ACCOUNT: &str = "vault-key-v1";

/// autofill.js — defines `__fluxFill(u,p)`; we append the invocation per fill.
const AUTOFILL_JS: &str = include_str!("../assets/autofill.js");

#[derive(Clone, Copy, PartialEq)]
enum KeySource {
    Keychain,
    File,
    None,
}

impl KeySource {
    fn as_str(self) -> &'static str {
        match self {
            KeySource::Keychain => "keychain",
            KeySource::File => "file",
            KeySource::None => "none",
        }
    }
}

pub struct VaultState {
    inner: RwLock<Vault>,
    key: Option<[u8; 32]>,
    path: PathBuf,
    source: KeySource,
}

impl VaultState {
    /// Boot: obtain the data key, then load + decrypt the vault file (if any).
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("vault");
        let path = dir.join("vault.bin");
        let (key, source) = obtain_key(&dir);

        let vault = match (key, std::fs::read(&path)) {
            (Some(k), Ok(blob)) if !blob.is_empty() => Vault::decrypt(&k, &blob).unwrap_or_else(|e| {
                tracing::error!(target: "flux::vault", "vault decrypt failed: {e}");
                Vault::default()
            }),
            _ => Vault::default(),
        };
        if source == KeySource::File {
            tracing::warn!(target: "flux::vault", "no OS keychain; vault key is file-backed (less secure)");
        }
        Self { inner: RwLock::new(vault), key, path, source }
    }

    fn persist(&self) -> Result<(), String> {
        let key = self.key.as_ref().ok_or("vault unavailable (no data key)")?;
        let blob = self.inner.read().encrypt(key).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.path, blob).map_err(|e| e.to_string())
    }
}

/// Credential without the secret — safe to hand the chrome UI.
#[derive(Serialize)]
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

#[derive(Serialize)]
pub struct VaultStatus {
    pub available: bool,
    pub count: usize,
    pub source: &'static str,
}

// ─── key acquisition ─────────────────────────────────────────────────────────

fn obtain_key(dir: &Path) -> (Option<[u8; 32]>, KeySource) {
    match keychain_key() {
        Ok(k) => return (Some(k), KeySource::Keychain),
        Err(e) => tracing::warn!(target: "flux::vault", "OS keychain unavailable: {e}"),
    }
    match file_key(dir) {
        Ok(k) => (Some(k), KeySource::File),
        Err(e) => {
            tracing::error!(target: "flux::vault", "no vault key (keychain + file failed): {e}");
            (None, KeySource::None)
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(k)
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

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_status(state: State<'_, VaultState>) -> VaultStatus {
    VaultStatus {
        available: state.key.is_some(),
        count: state.inner.read().entries.len(),
        source: state.source.as_str(),
    }
}

#[tauri::command]
pub fn vault_list(state: State<'_, VaultState>) -> Vec<CredentialMeta> {
    state.inner.read().entries.iter().map(CredentialMeta::from).collect()
}

/// Autofill candidates for a host (metadata only — no passwords).
#[tauri::command]
pub fn vault_for_host(state: State<'_, VaultState>, host: String) -> Vec<CredentialMeta> {
    state.inner.read().matches(&host).into_iter().map(CredentialMeta::from).collect()
}

/// Reveal one password (explicit user action in the manager UI).
#[tauri::command]
pub fn vault_reveal(state: State<'_, VaultState>, id: String) -> Option<String> {
    state.inner.read().entries.iter().find(|c| c.id == id).map(|c| c.password.clone())
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
    state.inner.write().upsert(cred);
    state.persist()
}

#[tauri::command]
pub fn vault_remove(state: State<'_, VaultState>, id: String) -> Result<(), String> {
    state.inner.write().remove(&id);
    state.persist()
}

/// Import a Proton Pass JSON export from a file path. Returns the count imported.
#[tauri::command]
pub fn vault_import_proton(state: State<'_, VaultState>, path: String) -> Result<usize, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let n = state.inner.write().import_proton(&json).map_err(|e| e.to_string())?;
    state.persist()?;
    Ok(n)
}

/// Fill the active tab's login form with credential `id`. Enforces same-origin
/// (the credential must match the tab's host) and injects straight into the
/// page — the password never passes through the chrome's JS.
#[tauri::command]
pub fn vault_fill(app: AppHandle, state: State<'_, VaultState>, tab_id: u64, id: String) -> Result<(), String> {
    let host = app
        .try_state::<crate::state::FluxState>()
        .and_then(|s| s.tabs.get(&tab_id).map(|t| host_of(&t.url)))
        .ok_or("no such tab")?;

    let (user, pass) = {
        let v = state.inner.read();
        let c = v.entries.iter().find(|c| c.id == id).ok_or("no such credential")?;
        if !c.matches_host(&host) {
            return Err(format!("credential does not match {host}"));
        }
        (c.username.clone(), c.password.clone())
    };

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
