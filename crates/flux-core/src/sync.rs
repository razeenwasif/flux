//! E2E-encrypted sync (BACKLOG #62) — bookmarks + sessions across devices,
//! account-optional and local-first.
//!
//! No Flux server: sync goes through a **folder you already sync** (Dropbox,
//! Syncthing, iCloud Drive, a USB stick…). Flux writes one **end-to-end
//! encrypted** blob there (`flux-sync.enc`); other devices read + merge it. The
//! key is derived from a passphrase you set (Argon2id) — the salt lives in the
//! blob header so every device deriving from the same passphrase gets the same
//! key, and whatever syncs the folder only ever sees ciphertext.
//!
//! Merge is an additive union (bookmarks by url+folder, sessions by name) — no
//! deletion propagation in v1. Manual "Sync now".

use std::path::PathBuf;

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use argon2::Argon2;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const MAGIC: &[u8] = b"FLUXSYNC1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const BLOB_NAME: &str = "flux-sync.enc";

// ─── Crypto ──────────────────────────────────────────────────────────────────

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation: {e}"))?;
    Ok(key)
}

/// `nonce(12) || ciphertext+tag`.
fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let ct = cipher
        .encrypt(GenericArray::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("blob too short".into());
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    cipher
        .decrypt(GenericArray::from_slice(nonce), ct)
        .map_err(|_| "wrong passphrase or corrupt sync data".to_string())
}

// ─── Blob (magic || salt || sealed payload) ──────────────────────────────────

/// The salt is plaintext (you need it to derive the key); the payload is sealed.
fn read_salt(blob: &[u8]) -> Option<[u8; SALT_LEN]> {
    if blob.len() < MAGIC.len() + SALT_LEN || &blob[..MAGIC.len()] != MAGIC {
        return None;
    }
    blob[MAGIC.len()..MAGIC.len() + SALT_LEN].try_into().ok()
}
fn sealed_part(blob: &[u8]) -> &[u8] {
    &blob[MAGIC.len() + SALT_LEN..]
}

#[derive(Serialize, Deserialize, Default)]
struct Payload {
    #[serde(default)]
    bookmarks: Vec<crate::bookmarks::Bookmark>,
    #[serde(default)]
    sessions: Vec<crate::sessions::SavedSession>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    last_ms: u64,
}

pub struct SyncState {
    config_path: Option<PathBuf>,
    folder: RwLock<Option<PathBuf>>,
    key: RwLock<Option<[u8; 32]>>,
    salt: RwLock<Option<[u8; SALT_LEN]>>,
    last_ms: RwLock<u64>,
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub folder: Option<String>,
    pub unlocked: bool,
    pub last_ms: u64,
}

#[derive(Serialize)]
pub struct SyncReport {
    pub bookmarks_added: usize,
    pub sessions_added: usize,
}

impl SyncState {
    pub fn restore(config_path: PathBuf) -> Self {
        let cfg: Config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            config_path: Some(config_path),
            folder: RwLock::new(cfg.folder.map(PathBuf::from)),
            key: RwLock::new(None),
            salt: RwLock::new(None),
            last_ms: RwLock::new(cfg.last_ms),
        }
    }

    fn blob_path(&self) -> Option<PathBuf> {
        self.folder.read().as_ref().map(|d| d.join(BLOB_NAME))
    }
    fn persist_config(&self) {
        let Some(path) = &self.config_path else { return };
        let cfg = Config { folder: self.folder.read().as_ref().map(|p| p.to_string_lossy().into_owned()), last_ms: *self.last_ms.read() };
        if let Ok(json) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(path, json);
        }
    }

    fn status(&self) -> SyncStatus {
        SyncStatus {
            folder: self.folder.read().as_ref().map(|p| p.to_string_lossy().into_owned()),
            unlocked: self.key.read().is_some(),
            last_ms: *self.last_ms.read(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_status(state: State<'_, SyncState>) -> SyncStatus {
    state.status()
}

#[tauri::command]
pub fn sync_set_folder(state: State<'_, SyncState>, path: String) {
    *state.folder.write() = if path.trim().is_empty() { None } else { Some(PathBuf::from(path)) };
    // Folder changed → must unlock again (salt may differ).
    *state.key.write() = None;
    *state.salt.write() = None;
    state.persist_config();
}

#[tauri::command]
pub fn sync_lock(state: State<'_, SyncState>) {
    *state.key.write() = None;
    *state.salt.write() = None;
}

/// Derive + verify the key from the passphrase. Uses the existing blob's salt
/// (so every device agrees) or a fresh one for a first device. Verifies by
/// decrypting if a blob exists — a wrong passphrase fails here, not silently.
#[tauri::command]
pub fn sync_unlock(state: State<'_, SyncState>, passphrase: String) -> Result<(), String> {
    if passphrase.is_empty() {
        return Err("enter a passphrase".into());
    }
    let blob_path = state.blob_path().ok_or("set a sync folder first")?;
    let existing = std::fs::read(&blob_path).ok();
    let salt: [u8; SALT_LEN] = match existing.as_deref().and_then(read_salt) {
        Some(s) => s,
        None => rand::random(), // first device
    };
    let key = derive_key(&passphrase, &salt)?;
    // If there's an existing blob, the passphrase must open it.
    if let Some(blob) = &existing {
        open(&key, sealed_part(blob)).map_err(|_| "wrong passphrase for this sync folder".to_string())?;
    }
    *state.salt.write() = Some(salt);
    *state.key.write() = Some(key);
    Ok(())
}

/// Pull (decrypt + merge) then push (collect + encrypt + write). Returns how many
/// items were newly merged in.
#[tauri::command]
pub fn sync_now(app: AppHandle, state: State<'_, SyncState>) -> Result<SyncReport, String> {
    let key = state.key.read().ok_or("unlock sync with your passphrase first")?;
    let salt = state.salt.read().ok_or("unlock first")?;
    let blob_path = state.blob_path().ok_or("set a sync folder first")?;

    let bookmarks = app.state::<crate::bookmarks::BookmarkStore>();
    let sessions = app.state::<crate::sessions::SessionStore>();

    // ── Pull: merge any remote payload into the local stores. ──
    let mut report = SyncReport { bookmarks_added: 0, sessions_added: 0 };
    if let Ok(blob) = std::fs::read(&blob_path) {
        let plain = open(&key, sealed_part(&blob))?;
        let remote: Payload = serde_json::from_slice(&plain).map_err(|e| format!("bad sync payload: {e}"))?;
        report.bookmarks_added = bookmarks.merge(remote.bookmarks);
        report.sessions_added = sessions.merge(remote.sessions);
    }

    // ── Push: write the merged local state back, sealed. ──
    let payload = Payload { bookmarks: bookmarks.list(), sessions: sessions.list() };
    let plain = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let sealed = seal(&key, &plain)?;
    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&sealed);
    if let Some(dir) = blob_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("sync folder: {e}"))?;
    }
    let tmp = blob_path.with_extension("enc.tmp");
    std::fs::write(&tmp, &out).map_err(|e| format!("write: {e}"))?;
    std::fs::rename(&tmp, &blob_path).map_err(|e| format!("commit: {e}"))?;

    *state.last_ms.write() = now_ms();
    state.persist_config();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = derive_key("hunter2", b"some-salt-1234567").unwrap();
        let sealed = seal(&key, b"secret payload").unwrap();
        assert_ne!(&sealed[NONCE_LEN..], b"secret payload"); // actually encrypted
        assert_eq!(open(&key, &sealed).unwrap(), b"secret payload");
    }

    #[test]
    fn wrong_passphrase_fails_to_open() {
        let salt = b"salt-salt-salt16";
        let sealed = seal(&derive_key("right", salt).unwrap(), b"data").unwrap();
        let wrong = derive_key("wrong", salt).unwrap();
        assert!(open(&wrong, &sealed).is_err());
    }

    #[test]
    fn salt_roundtrips_through_blob_header() {
        let salt = [7u8; SALT_LEN];
        let mut blob = Vec::new();
        blob.extend_from_slice(MAGIC);
        blob.extend_from_slice(&salt);
        blob.extend_from_slice(b"sealed");
        assert_eq!(read_salt(&blob), Some(salt));
        assert_eq!(sealed_part(&blob), b"sealed");
        assert_eq!(read_salt(b"nope"), None);
    }

    #[test]
    fn payload_serde_is_additive_tolerant() {
        // Missing fields default — a v1 reader tolerates an older/newer blob.
        let p: Payload = serde_json::from_str("{}").unwrap();
        assert!(p.bookmarks.is_empty() && p.sessions.is_empty());
    }
}
