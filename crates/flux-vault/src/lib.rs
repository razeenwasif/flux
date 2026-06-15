//! Flux local password vault (BACKLOG #61, ADR 0009).
//!
//! Pure + testable core: the credential model, AES-256-GCM seal/open of the
//! serialized vault, host matching for autofill, and importers (Proton Pass
//! first). The 32-byte data key is supplied by the caller — the flux-core
//! integration layer fetches it from the OS keychain; this crate never touches
//! the keychain so it stays unit-testable and platform-independent.

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault crypto error (bad key or corrupt data)")]
    Crypto,
    #[error("vault serialization: {0}")]
    Serde(#[from] serde_json::Error),
}

/// One stored login. `Debug` is hand-written to keep secrets out of logs.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// `otpauth://` TOTP URI, if any.
    #[serde(default)]
    pub totp: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_ms: u64,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("urls", &self.urls)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("totp", &if self.totp.is_empty() { "" } else { "<redacted>" })
            .finish()
    }
}

impl Credential {
    /// A content-stable id so re-importing the same login dedupes instead of
    /// piling up duplicates.
    pub fn stable_id(name: &str, username: &str, url: &str) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        name.hash(&mut h);
        username.hash(&mut h);
        url.hash(&mut h);
        format!("{:016x}", h.finish())
    }

    /// Does any of this credential's URLs apply to `host`? Matches the exact
    /// host or a sub/parent-domain relationship (e.g. a `github.com` entry fills
    /// `gist.github.com`). Conservative — never a blanket substring match.
    pub fn matches_host(&self, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty() {
            return false;
        }
        self.urls.iter().any(|u| {
            let ph = host_of(u);
            !ph.is_empty()
                && (ph == host
                    || host.ends_with(&format!(".{ph}"))
                    || ph.ends_with(&format!(".{host}")))
        })
    }
}

/// Extract a bare lowercase host from a URL-ish string (no `url` dep needed).
fn host_of(url: &str) -> String {
    let s = url.trim();
    let s = s.split("://").nth(1).unwrap_or(s);
    let s = s.split(['/', '?', '#']).next().unwrap_or(s);
    let s = s.rsplit('@').next().unwrap_or(s); // strip userinfo
    let s = s.split(':').next().unwrap_or(s); // strip port
    s.trim_start_matches("www.").to_ascii_lowercase()
}

/// The decrypted vault: a flat list of credentials.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Vault {
    #[serde(default)]
    pub entries: Vec<Credential>,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serialize + seal to `nonce ‖ ciphertext`. The plaintext JSON is wiped
    /// from memory after sealing.
    pub fn encrypt(&self, key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
        let json = Zeroizing::new(serde_json::to_vec(self)?);
        seal(key, &json)
    }

    /// Open + deserialize. The decrypted plaintext is wiped after parsing.
    pub fn decrypt(key: &[u8; 32], blob: &[u8]) -> Result<Vault, VaultError> {
        let pt = Zeroizing::new(open(key, blob)?);
        Ok(serde_json::from_slice(&pt)?)
    }

    /// Insert or replace by id.
    pub fn upsert(&mut self, c: Credential) {
        match self.entries.iter_mut().find(|e| e.id == c.id) {
            Some(slot) => *slot = c,
            None => self.entries.push(c),
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|e| e.id != id);
    }

    /// Credentials whose URLs apply to `host` (autofill candidates).
    pub fn matches(&self, host: &str) -> Vec<&Credential> {
        self.entries.iter().filter(|c| c.matches_host(host)).collect()
    }

    /// Import a Proton Pass JSON export, upserting login items. Returns the
    /// number imported. Skips trashed + non-login items; tolerant of the
    /// `username` vs `itemUsername`/`itemEmail` schema split.
    pub fn import_proton(&mut self, json: &str) -> Result<usize, VaultError> {
        let export: proton::Export = serde_json::from_str(json)?;
        let mut n = 0;
        for vault in export.vaults.values() {
            for item in &vault.items {
                // state 2 = trashed (skip); only login items carry passwords.
                if item.state == 2 || item.data.item_type != "login" {
                    continue;
                }
                let c = &item.data.content;
                let username = first_nonempty(&[&c.item_username, &c.username, &c.item_email]);
                let first_url = c.urls.first().map(String::as_str).unwrap_or("");
                let cred = Credential {
                    id: Credential::stable_id(&item.data.metadata.name, username, first_url),
                    name: item.data.metadata.name.clone(),
                    urls: c.urls.iter().filter(|u| !u.trim().is_empty()).cloned().collect(),
                    username: username.to_string(),
                    password: c.password.clone(),
                    totp: c.totp_uri.clone(),
                    notes: item.data.metadata.note.clone(),
                    created_ms: 0,
                };
                self.upsert(cred);
                n += 1;
            }
        }
        Ok(n)
    }
}

fn first_nonempty<'a>(candidates: &[&'a String]) -> &'a str {
    candidates.iter().map(|s| s.as_str()).find(|s| !s.trim().is_empty()).unwrap_or("")
}

// ─── AES-256-GCM seal / open ─────────────────────────────────────────────────

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

/// Seal `plaintext` under `key` → `nonce(12) ‖ ciphertext+tag`.
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let nonce_bytes = random_bytes::<12>();
    let mut ct = cipher
        .encrypt(GenericArray::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| VaultError::Crypto)?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.append(&mut ct);
    Ok(out)
}

/// Open a `nonce(12) ‖ ciphertext` blob produced by [`seal`].
pub fn open(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, VaultError> {
    if blob.len() < 12 {
        return Err(VaultError::Crypto);
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    cipher
        .decrypt(GenericArray::from_slice(nonce), ct)
        .map_err(|_| VaultError::Crypto)
}

// ─── Proton Pass export schema (defensive subset) ────────────────────────────

mod proton {
    use serde::Deserialize;
    use std::collections::HashMap;

    #[derive(Deserialize)]
    pub struct Export {
        #[serde(default)]
        pub vaults: HashMap<String, Vault>,
    }
    #[derive(Deserialize)]
    pub struct Vault {
        #[serde(default)]
        pub items: Vec<Item>,
    }
    #[derive(Deserialize)]
    pub struct Item {
        #[serde(default)]
        pub data: Data,
        #[serde(default)]
        pub state: i32,
    }
    #[derive(Deserialize, Default)]
    pub struct Data {
        #[serde(default)]
        pub metadata: Meta,
        #[serde(rename = "type", default)]
        pub item_type: String,
        #[serde(default)]
        pub content: Content,
    }
    #[derive(Deserialize, Default)]
    pub struct Meta {
        #[serde(default)]
        pub name: String,
        #[serde(default)]
        pub note: String,
    }
    #[derive(Deserialize, Default)]
    pub struct Content {
        #[serde(default)]
        pub username: String,
        #[serde(default, rename = "itemUsername")]
        pub item_username: String,
        #[serde(default, rename = "itemEmail")]
        pub item_email: String,
        #[serde(default)]
        pub password: String,
        #[serde(default)]
        pub urls: Vec<String>,
        #[serde(default, rename = "totpUri")]
        pub totp_uri: String,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn crypto_roundtrips_and_rejects_wrong_key() {
        let k = key();
        let blob = seal(&k, b"hunter2").unwrap();
        assert_eq!(open(&k, &blob).unwrap(), b"hunter2");
        // Tampered key fails (AEAD auth).
        let mut wrong = k;
        wrong[0] ^= 0xFF;
        assert!(open(&wrong, &blob).is_err());
        // Two seals of the same data differ (random nonce).
        assert_ne!(seal(&k, b"hunter2").unwrap(), blob);
    }

    #[test]
    fn vault_encrypt_decrypt_roundtrip() {
        let mut v = Vault::new();
        v.upsert(Credential {
            id: "1".into(),
            name: "GitHub".into(),
            urls: vec!["https://github.com".into()],
            username: "octocat".into(),
            password: "s3cret".into(),
            totp: String::new(),
            notes: String::new(),
            created_ms: 0,
        });
        let blob = v.encrypt(&key()).unwrap();
        let back = Vault::decrypt(&key(), &blob).unwrap();
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries[0].password, "s3cret");
        assert!(Vault::decrypt(&key(), b"too short").is_err());
    }

    #[test]
    fn matches_host_is_conservative() {
        let c = Credential {
            id: "1".into(),
            name: "GH".into(),
            urls: vec!["https://github.com/login".into()],
            username: "me".into(),
            password: String::new(),
            totp: String::new(),
            notes: String::new(),
            created_ms: 0,
        };
        assert!(c.matches_host("github.com"));
        assert!(c.matches_host("gist.github.com")); // subdomain
        assert!(c.matches_host("www.github.com")); // www stripped
        assert!(!c.matches_host("github.com.evil.com"));
        assert!(!c.matches_host("notgithub.com"));
        assert!(!c.matches_host(""));
    }

    #[test]
    fn import_proton_login_items() {
        let json = r#"{
          "version": "1.0.0",
          "vaults": {
            "v1": {
              "name": "Personal",
              "items": [
                { "state": 1, "data": {
                  "type": "login",
                  "metadata": { "name": "GitHub", "note": "work" },
                  "content": { "itemUsername": "octocat", "itemEmail": "me@x.com",
                    "password": "p1", "urls": ["https://github.com"], "totpUri": "otpauth://x" } } },
                { "state": 2, "data": {
                  "type": "login",
                  "metadata": { "name": "Trashed" },
                  "content": { "username": "old", "password": "nope", "urls": ["https://old.com"] } } },
                { "state": 1, "data": {
                  "type": "note",
                  "metadata": { "name": "A note" },
                  "content": {} } },
                { "state": 1, "data": {
                  "type": "login",
                  "metadata": { "name": "Legacy" },
                  "content": { "username": "legacyuser", "password": "p2", "urls": ["https://legacy.io"] } } }
              ]
            }
          }
        }"#;
        let mut v = Vault::new();
        let n = v.import_proton(json).unwrap();
        assert_eq!(n, 2); // GitHub + Legacy; trashed + note skipped
        assert_eq!(v.entries.len(), 2);

        let gh = v.entries.iter().find(|c| c.name == "GitHub").unwrap();
        assert_eq!(gh.username, "octocat"); // itemUsername preferred over itemEmail
        assert_eq!(gh.password, "p1");
        assert_eq!(gh.totp, "otpauth://x");
        assert_eq!(gh.notes, "work");

        let legacy = v.entries.iter().find(|c| c.name == "Legacy").unwrap();
        assert_eq!(legacy.username, "legacyuser"); // falls back to `username`

        // Re-import dedupes (stable id), doesn't double.
        v.import_proton(json).unwrap();
        assert_eq!(v.entries.len(), 2);
    }
}
