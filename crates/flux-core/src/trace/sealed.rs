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

use std::path::Path;
use std::sync::OnceLock;

const MAGIC: &[u8] = b"FLXTRACE1";
const KEYRING_SERVICE: &str = "Flux";
const KEYRING_ACCOUNT: &str = "trace-key-v1";

/// Process-wide data key, resolved once (keychain → file fallback → None).
static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

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

fn keychain_key() -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(hex) => hex_decode(&hex),
        Err(keyring::Error::NoEntry) => {
            let k = flux_vault::new_key();
            entry.set_password(&hex_encode(&k)).ok()?;
            Some(k)
        }
        Err(_) => None,
    }
}

fn file_key(dir: &Path) -> Option<[u8; 32]> {
    std::fs::create_dir_all(dir).ok()?;
    let p = dir.join("trace.key");
    if let Ok(b) = std::fs::read(&p) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return Some(k);
        }
    }
    let k = flux_vault::new_key();
    std::fs::write(&p, k).ok()?;
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
        let k = keychain_key().or_else(|| file_key(dir));
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
pub(super) fn save_json_sealed<T: serde::Serialize>(path: &Path, value: &T) {
    let Ok(json) = serde_json::to_vec(value) else {
        return;
    };
    let dir = path.parent().unwrap_or(Path::new("."));
    match data_key(dir) {
        Some(key) => {
            if let Ok(ct) = flux_vault::seal(&key, &json) {
                let mut blob = Vec::with_capacity(MAGIC.len() + ct.len());
                blob.extend_from_slice(MAGIC);
                blob.extend_from_slice(&ct);
                let _ = crate::persist::write_atomic(path, &blob);
            }
        }
        None => {
            let _ = crate::persist::write_atomic(path, &json);
        }
    }
}

/// Read a store file: sealed blob (magic-prefixed) or legacy plaintext JSON.
/// Returns `(json_string, was_plaintext)` — a plaintext read means the caller
/// should mark itself dirty so the next flush upgrades the file to sealed.
pub(super) fn load_string(path: &Path) -> Option<(String, bool)> {
    let bytes = std::fs::read(path).ok()?;
    if let Some(ct) = bytes.strip_prefix(MAGIC) {
        let dir = path.parent().unwrap_or(Path::new("."));
        let key = data_key(dir)?;
        let pt = flux_vault::open(&key, ct).ok()?;
        return Some((String::from_utf8(pt).ok()?, false));
    }
    // Legacy plaintext (pre-encryption) — accept and flag for upgrade.
    Some((String::from_utf8(bytes).ok()?, true))
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
    fn hex_key_roundtrip() {
        let k = flux_vault::new_key();
        assert_eq!(hex_decode(&hex_encode(&k)), Some(k));
        assert_eq!(hex_decode("zz"), None);
    }
}
