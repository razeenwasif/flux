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

use std::path::{Path, PathBuf};

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use argon2::Argon2;
use parking_lot::{Mutex, RwLock};
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
    // A short or truncated file takes `open`'s "blob too short" error: slicing
    // past the end would panic, and release builds abort on panic.
    blob.get(MAGIC.len() + SALT_LEN..).unwrap_or(&[])
}

/// The blob, `None` only when there isn't one yet. Any other read failure (a
/// cloud placeholder that can't download offline, a file the sync client has
/// locked) is an error: read as "absent", it minted a fresh sync identity on
/// unlock and pushed over the remote blob without ever merging it.
fn read_blob(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

/// Most history to ship in the blob (bounded so a big local history doesn't bloat
/// the encrypted file). The most-frecent entries win the cap.
const HISTORY_SYNC_CAP: usize = 4000;

#[derive(Serialize, Deserialize, Default)]
struct Payload {
    #[serde(default)]
    bookmarks: Vec<crate::bookmarks::Bookmark>,
    #[serde(default)]
    bookmark_tombstones: crate::tombstone::Tombstones,
    #[serde(default)]
    sessions: Vec<crate::sessions::SavedSession>,
    #[serde(default)]
    session_tombstones: crate::tombstone::Tombstones,
    #[serde(default)]
    history: Vec<crate::history::HistoryEntry>,
    // Tasks and calendar (#62 follow-up). Both are small, user-authored and
    // device-independent — exactly the shape sync is for. Calendar *events* from
    // subscribed feeds are not here: each device fetches those from the URL, so
    // shipping them would be syncing a cache.
    #[serde(default)]
    todos: Vec<crate::todos::Todo>,
    #[serde(default)]
    todo_tombstones: crate::tombstone::Tombstones,
    #[serde(default)]
    cal_feeds: Vec<crate::calendar::CalFeed>,
    #[serde(default)]
    cal_tombstones: crate::tombstone::Tombstones,
    #[serde(default)]
    events: Vec<crate::calendar::LocalEvent>,
    #[serde(default)]
    event_tombstones: crate::tombstone::Tombstones,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    last_ms: u64,
    #[serde(default)]
    auto: bool,
}

pub struct SyncState {
    config_path: Option<PathBuf>,
    folder: RwLock<Option<PathBuf>>,
    /// The derived key and the blob salt it came from, under one lock: unlocks
    /// run off the main thread and can overlap, and a key paired with another
    /// unlock's salt would seal a blob no device can ever open again.
    key: RwLock<Option<([u8; 32], [u8; SALT_LEN])>>,
    last_ms: RwLock<u64>,
    auto: std::sync::atomic::AtomicBool,
    /// Hash of the last payload we wrote, so an idle auto-sync doesn't rewrite
    /// an identical blob. It matters more than it looks: `seal` draws a fresh
    /// nonce every time, so identical plaintext produces *entirely* different
    /// ciphertext — the file-sync tool underneath sees every block change and
    /// re-transfers the whole thing. At a 3-minute tick and a half-megabyte
    /// blob that's ~10 MB/hour of churn per device, plus a full copy in
    /// versioning history each time, all for no change at all.
    last_push: RwLock<Option<u64>>,
    /// One `run_sync` at a time: "Sync now", the 3-minute timer and the
    /// post-unlock / auto-on kicks all run it, and overlapping runs could
    /// interleave their pull-merge-push cycles and their writes of the blob.
    run_lock: Mutex<()>,
}

#[derive(Serialize, specta::Type)]
pub struct SyncStatus {
    pub folder: Option<String>,
    pub unlocked: bool,
    pub last_ms: u64,
    /// Periodic background sync is on (#62).
    pub auto: bool,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct SyncReport {
    pub bookmarks_added: usize,
    pub sessions_added: usize,
    pub history_added: usize,
    /// Was there a remote blob to merge from at all?
    ///
    /// Without this, three zeros is ambiguous between "first device, nothing to
    /// receive yet" and "already up to date" — and it reads as failure in both
    /// cases, which is how a working first sync looks broken.
    pub had_remote: bool,
    /// What this device published. The pull can legitimately be empty; the push
    /// never is, so the report always has something true to say.
    pub sent_bookmarks: usize,
    pub sent_sessions: usize,
    pub sent_history: usize,
    pub todos_added: usize,
    pub events_added: usize,
    pub calendars_added: usize,
    /// Whether this run actually wrote the blob. False when the payload was
    /// byte-identical to the last one we pushed.
    pub pushed: bool,
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
            last_ms: RwLock::new(cfg.last_ms),
            auto: std::sync::atomic::AtomicBool::new(cfg.auto),
            last_push: RwLock::new(None),
            run_lock: Mutex::new(()),
        }
    }

    fn blob_path(&self) -> Option<PathBuf> {
        self.folder.read().as_ref().map(|d| d.join(BLOB_NAME))
    }
    fn auto(&self) -> bool {
        self.auto.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// Ready to run unattended: a folder is set and the key is unlocked.
    fn ready(&self) -> bool {
        self.key.read().is_some() && self.folder.read().is_some()
    }
    fn persist_config(&self) {
        let Some(path) = &self.config_path else {
            return;
        };
        let cfg = Config {
            folder: self
                .folder
                .read()
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            last_ms: *self.last_ms.read(),
            auto: self.auto(),
        };
        crate::persist::save_json_pretty(path, &cfg);
    }

    fn status(&self) -> SyncStatus {
        SyncStatus {
            folder: self
                .folder
                .read()
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            unlocked: self.key.read().is_some(),
            last_ms: *self.last_ms.read(),
            auto: self.auto(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_status(state: State<'_, SyncState>) -> SyncStatus {
    state.status()
}

#[tauri::command]
pub fn sync_set_folder(state: State<'_, SyncState>, path: String) {
    *state.folder.write() = if path.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    };
    // Folder changed → must unlock again (salt may differ).
    *state.key.write() = None;
    state.persist_config();
}

#[tauri::command]
pub fn sync_lock(state: State<'_, SyncState>) {
    *state.key.write() = None;
}

/// Derive + verify the key from the passphrase, and say whether this created a
/// **new sync identity**.
///
/// Uses the existing blob's salt (so every device agrees) or a fresh one for a
/// first device, and verifies by decrypting when a blob exists — a wrong
/// passphrase fails here rather than silently.
///
/// The distinction matters more than it sounds. The key is derived from your
/// passphrase **and the salt in the blob header** — so a device that unlocks
/// while the folder is still empty mints a fresh random salt and derives a
/// different key from the same passphrase. It then publishes a blob the other
/// device cannot open, and neither can read the other's.
///
/// That's the exact failure of unlocking a second device before the file-sync
/// tool has delivered the first device's blob, and it is silent: same
/// passphrase, no error, two incompatible sync identities. So this reports it
/// and the UI warns, rather than leaving the user to work out why "0 merged"
/// never becomes anything else.
#[tauri::command]
pub async fn sync_unlock(app: AppHandle, passphrase: String) -> Result<bool, String> {
    // Reading (maybe first downloading) the blob from a cloud folder, Argon2id
    // and a full AEAD open: none of it on the main thread.
    tauri::async_runtime::spawn_blocking(move || unlock_blocking(&app, &passphrase))
        .await
        .map_err(|e| e.to_string())?
}

fn unlock_blocking(app: &AppHandle, passphrase: &str) -> Result<bool, String> {
    let state = app.state::<SyncState>();
    if passphrase.is_empty() {
        return Err("enter a passphrase".into());
    }
    let blob_path = state.blob_path().ok_or("set a sync folder first")?;
    let existing = read_blob(&blob_path)?;
    // Say what's wrong with a file that isn't a sync blob at all, rather than
    // "wrong passphrase" (an interrupted copy, a cloud placeholder, a stray).
    if existing.as_deref().is_some_and(|b| read_salt(b).is_none()) {
        return Err(format!(
            "{} isn't a Flux sync file (empty, truncated or foreign); move it aside and unlock again",
            blob_path.display()
        ));
    }
    let fresh_identity = existing.as_deref().and_then(read_salt).is_none();
    let salt: [u8; SALT_LEN] = match existing.as_deref().and_then(read_salt) {
        Some(s) => s,
        None => rand::random(), // first device into this folder
    };
    let key = derive_key(passphrase, &salt)?;
    // If there's an existing blob, the passphrase must open it.
    if let Some(blob) = &existing {
        open(&key, sealed_part(blob))
            .map_err(|_| "wrong passphrase for this sync folder".to_string())?;
    }
    *state.key.write() = Some((key, salt));
    // With auto on, pull right away so unlocking a device catches it up.
    if state.auto() {
        let app = app.clone();
        std::thread::spawn(move || emit_sync(&app, run_sync(&app)));
    }
    Ok(fresh_identity)
}

/// Pull (decrypt + merge) then push (collect + encrypt + write). Returns how many
/// items were newly merged in. Pure of Tauri command glue so the auto-sync timer
/// can call it too — both resolve the stores off the `app` handle.
fn run_sync(app: &AppHandle) -> Result<SyncReport, String> {
    let state = app.state::<SyncState>();
    let _one_at_a_time = state.run_lock.lock();
    let (key, salt) = state
        .key
        .read()
        .ok_or("unlock sync with your passphrase first")?;
    let blob_path = state.blob_path().ok_or("set a sync folder first")?;

    let bookmarks = app.state::<crate::bookmarks::BookmarkStore>();
    let sessions = app.state::<crate::sessions::SessionStore>();
    let history = app.state::<crate::history::HistoryStore>();
    let todos = app.state::<crate::todos::TodoStore>();
    let cal = app.state::<crate::calendar::CalStore>();
    let events = app.state::<crate::calendar::LocalEventStore>();

    // ── Pull: merge any remote payload into the local stores (tombstones first). ──
    let mut report = SyncReport {
        bookmarks_added: 0,
        sessions_added: 0,
        history_added: 0,
        had_remote: false,
        sent_bookmarks: 0,
        sent_sessions: 0,
        sent_history: 0,
        todos_added: 0,
        events_added: 0,
        calendars_added: 0,
        pushed: true,
    };
    if let Some(blob) = read_blob(&blob_path)? {
        report.had_remote = true;
        let plain = open(&key, sealed_part(&blob))?;
        let remote: Payload =
            serde_json::from_slice(&plain).map_err(|e| format!("bad sync payload: {e}"))?;
        report.bookmarks_added = bookmarks.merge(remote.bookmarks, &remote.bookmark_tombstones);
        report.sessions_added = sessions.merge(remote.sessions, &remote.session_tombstones);
        report.history_added = history.merge_remote(remote.history);
        report.todos_added = todos.merge(remote.todos, &remote.todo_tombstones);
        report.calendars_added = cal.merge(remote.cal_feeds, &remote.cal_tombstones);
        report.events_added = events.merge(remote.events, &remote.event_tombstones);
    }

    // ── Push: write the merged local state back (items + tombstones), sealed. ──
    let payload = Payload {
        bookmarks: bookmarks.list(),
        bookmark_tombstones: bookmarks.tombstones(),
        sessions: sessions.list(),
        session_tombstones: sessions.tombstones(),
        history: history.export_for_sync(HISTORY_SYNC_CAP),
        todos: todos.list(),
        todo_tombstones: todos.tombstones(),
        cal_feeds: cal.list(),
        cal_tombstones: cal.tombstones(),
        events: events.list(),
        event_tombstones: events.tombstones(),
    };
    report.sent_bookmarks = payload.bookmarks.len();
    report.sent_sessions = payload.sessions.len();
    report.sent_history = payload.history.len();
    let plain = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;

    // Nothing to say? Don't say it again. Compared on the *plaintext*, which is
    // stable across runs — the ciphertext never is, by design.
    let digest = fnv1a64(&plain);
    if *state.last_push.read() == Some(digest) && blob_path.exists() {
        report.pushed = false;
        *state.last_ms.write() = now_ms();
        state.persist_config();
        return Ok(report);
    }
    let sealed = seal(&key, &plain)?;
    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&sealed);
    // Unique staging name + fsync + rename (creating the folder if needed): a
    // published blob is always whole, never another writer's half-written file.
    crate::persist::write_atomic(&blob_path, &out).map_err(|e| format!("write: {e}"))?;

    *state.last_push.write() = Some(digest);
    *state.last_ms.write() = now_ms();
    state.persist_config();
    Ok(report)
}

/// Small, fast, non-cryptographic — this only answers "did the bytes change",
/// and a collision costs one skipped push that the next real change repairs.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    // Read (maybe first download), merge, re-seal and write the blob in a
    // synced folder: none of it on the main thread.
    tauri::async_runtime::spawn_blocking(move || run_sync(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Turn the periodic background sync on/off (#62). When on, Flux re-syncs every
/// few minutes while the folder is set + unlocked, and once right after unlock.
#[tauri::command]
pub fn sync_set_auto(app: AppHandle, state: State<'_, SyncState>, enabled: bool) {
    state
        .auto
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    state.persist_config();
    // Sync immediately so toggling on doesn't wait a full interval.
    if enabled && state.ready() {
        let app = app.clone();
        std::thread::spawn(move || emit_sync(&app, run_sync(&app)));
    }
}

/// How often the auto-sync timer fires (#62). The folder syncs the blob itself;
/// this just bounds how stale a device gets between manual syncs.
const AUTO_INTERVAL_SECS: u64 = 180;

/// Emit the outcome of a background sync so the UI can refresh `sync_status` and
/// any open page reflecting bookmarks/sessions/history.
fn emit_sync(app: &AppHandle, result: Result<SyncReport, String>) {
    use tauri::Emitter;
    match result {
        Ok(report) => {
            let _ = app.emit("flux://sync-done", report);
        }
        Err(e) => {
            let _ = app.emit("flux://sync-error", e);
        }
    }
}

/// Spawn the auto-sync timer (call once from setup). Sleeps, then syncs whenever
/// auto is on and the store is unlocked + has a folder — quietly skipping when not.
pub fn spawn_auto(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(AUTO_INTERVAL_SECS));
        let Some(state) = app.try_state::<SyncState>() else {
            continue;
        };
        if state.auto() && state.ready() {
            emit_sync(&app, run_sync(&app));
        }
    });
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
    fn a_short_blob_is_an_error_not_a_panic() {
        // An empty or truncated flux-sync.enc (an interrupted copy, a cloud
        // placeholder) used to slice past its end and abort the browser.
        let key = derive_key("pw", b"salt-salt-salt16").unwrap();
        for blob in [&b""[..], MAGIC, &[0u8; MAGIC.len() + SALT_LEN + 4][..]] {
            assert_eq!(read_salt(blob), None);
            assert!(open(&key, sealed_part(blob)).is_err());
        }
    }

    #[test]
    fn only_a_missing_blob_reads_as_absent() {
        let dir = std::env::temp_dir().join(format!("flux-sync-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(BLOB_NAME);
        assert_eq!(
            read_blob(&path),
            Ok(None),
            "first device: nothing there yet"
        );
        // There but unreadable (here a directory in its place) is not absent.
        std::fs::create_dir(&path).unwrap();
        assert!(read_blob(&path).is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"blob").unwrap();
        assert_eq!(read_blob(&path), Ok(Some(b"blob".to_vec())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_payloads_hash_identically() {
        // The whole basis of skipping a push: the *plaintext* is stable across
        // runs even though the ciphertext never is (fresh nonce per seal), so
        // the digest has to be taken before sealing.
        let a = serde_json::to_vec(&Payload::default()).unwrap();
        let b = serde_json::to_vec(&Payload::default()).unwrap();
        assert_eq!(fnv1a64(&a), fnv1a64(&b));

        let key = derive_key("pw", b"salt-salt-salt16").unwrap();
        assert_ne!(
            seal(&key, &a).unwrap(),
            seal(&key, &b).unwrap(),
            "same plaintext must still seal differently — that's why the file \
             re-transfers in full, and why the digest is taken on the plaintext"
        );
    }

    #[test]
    fn a_changed_payload_hashes_differently() {
        let mut p = Payload::default();
        let before = fnv1a64(&serde_json::to_vec(&p).unwrap());
        p.bookmark_tombstones
            .insert("https://example.com|".into(), 1);
        assert_ne!(before, fnv1a64(&serde_json::to_vec(&p).unwrap()));
    }

    #[test]
    fn a_fresh_salt_yields_a_different_key_from_the_same_passphrase() {
        // The trap this now warns about: unlock a second device before the
        // first device's blob has arrived, and it mints its own salt. Same
        // passphrase, different key, two sync identities that can never read
        // each other — and nothing errors at the time.
        let k1 = derive_key("same passphrase", &[1u8; SALT_LEN]).unwrap();
        let k2 = derive_key("same passphrase", &[2u8; SALT_LEN]).unwrap();
        assert_ne!(k1, k2);
        let sealed = seal(&k1, b"device A data").unwrap();
        assert!(
            open(&k2, &sealed).is_err(),
            "device B must not be able to read device A's blob"
        );
    }

    #[test]
    fn payload_serde_is_additive_tolerant() {
        // Missing fields default — a v1 reader tolerates an older/newer blob.
        let p: Payload = serde_json::from_str("{}").unwrap();
        assert!(p.bookmarks.is_empty() && p.sessions.is_empty());
    }
}
