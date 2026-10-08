//! Encryption at rest for the trace stores (ADR 0011, draft-capture phase).
//!
//! The Trail records what you read — and, with draft capture, fragments of what
//! you *typed* — so its files are sealed with AES-256-GCM (reusing the vault's
//! audited `flux_vault::seal/open`). The data key lives in the OS keychain
//! (service "Flux" / account "trace-key-v1"), falling back to a 0600 key file
//! beside the stores when no keychain is available (headless WSL) — the same
//! ladder the password vault uses. If neither works, persistence falls back to
//! plaintext rather than losing data (warned once).
//!
//! Migration is transparent: `load_string` reads both sealed blobs (magic
//! `FLXTRACE1`) and legacy plaintext JSON; callers mark themselves dirty after
//! a plaintext hydrate so the next flush rewrites the file sealed.
//!
//! A store file that exists but can't be loaded is never treated as "no data":
//! the caller starts empty, and its next flush would replace the only copy. A
//! file that may only be unreadable *right now* (a read error, a locked keychain)
//! is held: left untouched and not saved this run. One that is corrupt is moved
//! aside to `<name>.unreadable-<ms>`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;

const MAGIC: &[u8] = b"FLXTRACE1";
const KEYRING_SERVICE: &str = "Flux";
const KEYRING_ACCOUNT: &str = "trace-key-v1";

/// Process-wide data key, resolved once (keychain → file fallback → None).
static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
/// Set when this run minted the data key. A fresh key can't be the one that
/// sealed an existing file, so failing to open one means the real key (in a
/// locked or unreachable keychain) is just out of reach for now.
static KEY_IS_NEW: AtomicBool = AtomicBool::new(false);
/// Store files this run must not overwrite (see the module docs).
static HELD: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn hex_encode(k: &[u8; 32]) -> String {
    k.iter().map(|b| format!("{b:02x}")).collect()
}
fn hex_decode(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut k = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        k[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(k)
}

fn keychain_key(dir: &Path) -> Option<[u8; 32]> {
    // keyring falls back to an in-memory mock where there's no OS store
    // (Android), so a "keychain" key there would be new every launch.
    if !crate::vault::HAS_OS_KEYCHAIN {
        return None;
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(hex) => hex_decode(&hex),
        Err(keyring::Error::NoEntry) => {
            // A key file from an earlier keychain-less run may be what sealed the
            // stores: adopt it rather than minting a key that can't open them.
            let k = match existing_file_key(dir) {
                Some(k) => k,
                None => {
                    KEY_IS_NEW.store(true, Ordering::Relaxed);
                    flux_vault::new_key()
                }
            };
            entry.set_password(&hex_encode(&k)).ok()?;
            Some(k)
        }
        Err(_) => None,
    }
}

/// The key file beside the stores, if one already exists (never minted here).
fn existing_file_key(dir: &Path) -> Option<[u8; 32]> {
    let b = std::fs::read(dir.join("trace.key")).ok()?;
    <[u8; 32]>::try_from(b.as_slice()).ok()
}

fn file_key(dir: &Path) -> Option<[u8; 32]> {
    std::fs::create_dir_all(dir).ok()?;
    if let Some(k) = existing_file_key(dir) {
        return Some(k);
    }
    let p = dir.join("trace.key");
    let k = flux_vault::new_key();
    // Atomic: a torn key file would be re-minted next launch.
    crate::persist::write_atomic(&p, &k).ok()?;
    KEY_IS_NEW.store(true, Ordering::Relaxed);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Some(k)
}

/// The trace data key: keychain first, key file beside the stores second.
/// `None` means "persist plaintext" (better than losing the Trail).
pub(super) fn data_key(dir: &Path) -> Option<[u8; 32]> {
    *KEY.get_or_init(|| {
        let k = keychain_key(dir).or_else(|| file_key(dir));
        if k.is_none() {
            tracing::warn!(
                target: "flux::trace",
                "no keychain and no writable key file — trace stores persist UNENCRYPTED"
            );
        }
        k
    })
}

/// Serialize + seal + atomically write. Falls back to plaintext when no key.
/// Returns false if it didn't land (logged): the caller stays dirty so its next
/// flush retries, rather than dropping the change until some other mutation.
pub(crate) fn save_json_sealed<T: serde::Serialize>(path: &Path, value: &T) -> bool {
    if HELD.lock().iter().any(|p| p == path) {
        return true; // couldn't be loaded this run; it may hold the only copy
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let res = serde_json::to_vec(value)
        .map_err(std::io::Error::other)
        .and_then(|json| match data_key(dir) {
            Some(key) => flux_vault::seal(&key, &json)
                .map_err(std::io::Error::other)
                .and_then(|ct| {
                    let mut blob = Vec::with_capacity(MAGIC.len() + ct.len());
                    blob.extend_from_slice(MAGIC);
                    blob.extend_from_slice(&ct);
                    crate::persist::write_atomic(path, &blob)
                }),
            None => crate::persist::write_atomic(path, &json),
        });
    if let Err(e) = &res {
        tracing::warn!(
            target: "flux::trace",
            path = %path.display(),
            "store save failed, will retry: {e}"
        );
    }
    res.is_ok()
}

/// Leave `path` untouched and skip saving it for the rest of this run.
fn hold(path: &Path, why: &str) {
    HELD.lock().push(path.to_path_buf());
    tracing::error!(
        target: "flux::trace",
        path = %path.display(),
        "{why}; left untouched and not saved this run"
    );
}

/// Move a corrupt store file aside so the fresh store can't overwrite it.
fn quarantine(path: &Path, why: &str) {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".unreadable-{}", super::now_ms()));
    let aside = path.with_file_name(name);
    match std::fs::rename(path, &aside) {
        Ok(()) => tracing::error!(
            target: "flux::trace",
            path = %path.display(),
            aside = %aside.display(),
            "{why}; moved aside instead of being overwritten"
        ),
        Err(e) => hold(path, &format!("{why}; couldn't move it aside ({e})")),
    }
}

/// Read a store file: sealed blob (magic-prefixed) or legacy plaintext JSON.
/// Returns `(json_string, was_plaintext)` — a plaintext read means the caller
/// should mark itself dirty so the next flush upgrades the file to sealed.
/// `None` means there's nothing to load: the file is missing, or it couldn't be
/// loaded and has been held or moved aside.
pub(crate) fn load_string(path: &Path) -> Option<(String, bool)> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            hold(path, &format!("unreadable ({e})"));
            return None;
        }
    };
    let Some(ct) = bytes.strip_prefix(MAGIC) else {
        // Legacy plaintext (pre-encryption) — accept and flag for upgrade.
        return match String::from_utf8(bytes) {
            Ok(s) => Some((s, true)),
            Err(_) => {
                quarantine(path, "not a sealed store and not UTF-8");
                None
            }
        };
    };
    let dir = path.parent().unwrap_or(Path::new("."));
    let Some(key) = data_key(dir) else {
        hold(path, "sealed, but no data key is available");
        return None;
    };
    match flux_vault::open(&key, ct)
        .ok()
        .and_then(|pt| String::from_utf8(pt).ok())
    {
        Some(s) => Some((s, false)),
        None if KEY_IS_NEW.load(Ordering::Relaxed) => {
            hold(path, "sealed under a key this run can't reach");
            None
        }
        None => {
            quarantine(path, "can't be decrypted");
            None
        }
    }
}

/// [`load_string`] plus parsing. Unparseable content is corrupt: it's moved
/// aside rather than left for the empty store's next flush to overwrite.
pub(crate) fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<(T, bool)> {
    let (json, was_plaintext) = load_string(path)?;
    match serde_json::from_str(&json) {
        Ok(v) => Some((v, was_plaintext)),
        Err(e) => {
            quarantine(path, &format!("unparseable ({e})"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_roundtrip_and_plaintext_migration() {
        let dir = std::env::temp_dir().join(format!("flux-sealed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");

        // Legacy plaintext reads fine and is flagged for upgrade.
        std::fs::write(&path, br#"{"a":1}"#).unwrap();
        let (s, plain) = load_string(&path).unwrap();
        assert_eq!(s, r#"{"a":1}"#);
        assert!(plain);

        // Sealed write → on-disk bytes are magic + ciphertext, not JSON …
        save_json_sealed(&path, &serde_json::json!({ "secret": "typed text" }));
        let raw = std::fs::read(&path).unwrap();
        if data_key(&dir).is_some() {
            assert!(raw.starts_with(MAGIC));
            assert!(
                !raw.windows(5).any(|w| w == b"typed"),
                "plaintext must not appear on disk"
            );
            // … and round-trips through load_string un-flagged.
            let (s2, plain2) = load_string(&path).unwrap();
            assert!(s2.contains("typed text"));
            assert!(!plain2);
        } else {
            // Environment with neither keychain nor writable temp key — plaintext
            // fallback still round-trips (data is never lost).
            let (s2, _) = load_string(&path).unwrap();
            assert!(s2.contains("typed text"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unparseable_store_is_moved_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("flux-sealed-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        std::fs::write(&path, b"{ not json").unwrap();

        assert!(load_json::<serde_json::Value>(&path).is_none());
        assert!(
            !path.exists(),
            "a flush must not find the corrupt file to replace"
        );
        let aside: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("store.json.unreadable-")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"{ not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn held_store_is_never_saved_over() {
        let dir = std::env::temp_dir().join(format!("flux-sealed-held-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("held.json");
        std::fs::write(&path, b"only copy").unwrap();

        hold(&path, "test");
        save_json_sealed(&path, &serde_json::json!({ "fresh": true }));
        assert_eq!(std::fs::read(&path).unwrap(), b"only copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        // Non-string map keys can't be JSON, so this fails before any key or
        // disk work. The caller must hear about it to stay dirty and retry.
        let path = std::env::temp_dir()
            .join(format!("flux-sealed-fail-{}", std::process::id()))
            .join("store.json");
        let unserializable = std::collections::HashMap::from([((1u8, 2u8), 3u8)]);
        assert!(!save_json_sealed(&path, &unserializable));
        assert!(!path.exists());
    }

    #[test]
    fn hex_key_roundtrip() {
        let k = flux_vault::new_key();
        assert_eq!(hex_decode(&hex_encode(&k)), Some(k));
        assert_eq!(hex_decode("zz"), None);
    }
}
