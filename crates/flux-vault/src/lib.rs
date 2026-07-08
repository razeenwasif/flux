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
    #[error("import error: {0}")]
    Import(String),
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

    /// Import a Proton Pass export in whatever format it actually arrives as —
    /// **CSV**, a **ZIP** (JSON/CSV inside), a **PGP-encrypted** blob (decrypted
    /// with `passphrase`), or raw JSON. Detected by magic bytes + filename.
    pub fn import(&mut self, data: &[u8], filename: &str, passphrase: Option<&str>) -> Result<usize, VaultError> {
        let lower = filename.to_ascii_lowercase();

        // ZIP (PK\x03\x04) — Proton's full export.
        if data.starts_with(b"PK\x03\x04") || lower.ends_with(".zip") {
            return self.import_zip(data);
        }
        // PGP-encrypted export (ASCII-armored or binary).
        if lower.ends_with(".pgp") || lower.ends_with(".gpg") || data.starts_with(b"-----BEGIN PGP") {
            let plain = Zeroizing::new(decrypt_pgp(data, passphrase.unwrap_or(""))?);
            return self.import(&plain, "decrypted", None);
        }
        // Text: JSON vs CSV.
        let text = std::str::from_utf8(data)
            .map_err(|_| VaultError::Import("file isn't text — if it's a PGP export, provide the passphrase".into()))?;
        let trimmed = text.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            self.import_json(text)
        } else {
            self.import_csv(text)
        }
    }

    /// Dispatch a JSON export to the right vendor parser by peeking at its
    /// shape: Proton nests logins under `vaults`, Bitwarden under a flat
    /// `items` array. Unknown shapes fall through to the Proton parser (a
    /// no-op that returns 0 rather than erroring on an empty/foreign file).
    pub fn import_json(&mut self, json: &str) -> Result<usize, VaultError> {
        let probe: serde_json::Value = serde_json::from_str(json)?;
        if probe.get("vaults").is_some() {
            self.import_proton(json)
        } else if probe.get("items").is_some() {
            self.import_bitwarden(json)
        } else {
            self.import_proton(json)
        }
    }

    /// Import a **Bitwarden** JSON export (unencrypted account or org export).
    /// Keeps only login items (`type == 1`), skips items in the trash, and is
    /// tolerant of the `login.uris[].uri` vs older `login.uri` shapes. Returns
    /// a clear error for an *encrypted* export (needs the Bitwarden account
    /// key, which we don't have).
    pub fn import_bitwarden(&mut self, json: &str) -> Result<usize, VaultError> {
        let export: bitwarden::Export = serde_json::from_str(json)?;
        if export.encrypted {
            return Err(VaultError::Import(
                "this Bitwarden export is encrypted — re-export as an *unencrypted* .json".into(),
            ));
        }
        let mut n = 0;
        for item in &export.items {
            // type 1 = login; skip trashed items (deletedDate set).
            if item.item_type != 1 || item.deleted_date.is_some() {
                continue;
            }
            let Some(login) = &item.login else { continue };
            let urls: Vec<String> = login
                .uris
                .iter()
                .filter_map(|u| u.uri.as_deref())
                .chain(login.uri.as_deref())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if login.password.trim().is_empty() && login.username.trim().is_empty() {
                continue; // not a real login
            }
            let name = if item.name.trim().is_empty() {
                urls.first().map(|u| host_of(u)).unwrap_or_default()
            } else {
                item.name.clone()
            };
            let first = urls.first().cloned().unwrap_or_default();
            self.upsert(Credential {
                id: Credential::stable_id(&name, &login.username, &first),
                name,
                urls,
                username: login.username.clone(),
                password: login.password.clone(),
                totp: login.totp.clone().unwrap_or_default(),
                notes: item.notes.clone().unwrap_or_default(),
                created_ms: 0,
            });
            n += 1;
        }
        Ok(n)
    }

    /// Import a Proton Pass **CSV** export. Maps columns by header name (so order
    /// + extra columns don't matter), skips non-login rows.
    pub fn import_csv(&mut self, data: &str) -> Result<usize, VaultError> {
        let mut rdr = csv::ReaderBuilder::new().flexible(true).has_headers(true).from_reader(data.as_bytes());
        let headers = rdr.headers().map_err(|e| VaultError::Import(e.to_string()))?.clone();
        let col = |names: &[&str]| -> Option<usize> {
            headers.iter().position(|h| names.iter().any(|n| h.trim().eq_ignore_ascii_case(n)))
        };
        // Header aliases span Proton, Chrome (`name,url,username,password,note`),
        // and Bitwarden CSV (`login_uri,login_username,login_password,login_totp`).
        let (i_name, i_url, i_user, i_email, i_pass, i_note, i_totp, i_type) = (
            col(&["name", "title"]),
            col(&["url", "urls", "website", "login_uri", "login_uris"]),
            col(&["username", "login", "user", "login_username"]),
            col(&["email"]),
            col(&["password", "pass", "login_password"]),
            col(&["note", "notes"]),
            col(&["totp", "otp", "otpauth", "totpuri", "login_totp"]),
            col(&["type"]),
        );

        let mut n = 0;
        for rec in rdr.records() {
            let rec = rec.map_err(|e| VaultError::Import(e.to_string()))?;
            let get = |i: Option<usize>| i.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
            // If there's a type column, only import logins.
            if let Some(ti) = i_type {
                let t = rec.get(ti).unwrap_or("").trim().to_ascii_lowercase();
                if !t.is_empty() && t != "login" {
                    continue;
                }
            }
            let password = get(i_pass);
            let username = {
                let u = get(i_user);
                if u.is_empty() { get(i_email) } else { u }
            };
            if password.is_empty() && username.is_empty() {
                continue; // not a login row
            }
            let urls: Vec<String> = get(i_url)
                .split([',', ' ', '\n', '\t'])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            let name = {
                let nm = get(i_name);
                if !nm.is_empty() {
                    nm
                } else {
                    urls.first().map(|u| host_of(u)).unwrap_or_default()
                }
            };
            let first = urls.first().cloned().unwrap_or_default();
            self.upsert(Credential {
                id: Credential::stable_id(&name, &username, &first),
                name,
                urls,
                username,
                password,
                totp: get(i_totp),
                notes: get(i_note),
                created_ms: 0,
            });
            n += 1;
        }
        Ok(n)
    }

    /// Import from a **ZIP** archive — finds the first `.json` (preferred) or
    /// `.csv` entry and imports it.
    pub fn import_zip(&mut self, data: &[u8]) -> Result<usize, VaultError> {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| VaultError::Import(e.to_string()))?;
        let (mut json_idx, mut csv_idx) = (None, None);
        for i in 0..zip.len() {
            let name = zip.by_index(i).map_err(|e| VaultError::Import(e.to_string()))?.name().to_ascii_lowercase();
            if name.ends_with(".json") && json_idx.is_none() {
                json_idx = Some(i);
            } else if name.ends_with(".csv") && csv_idx.is_none() {
                csv_idx = Some(i);
            }
        }
        let pick = json_idx.or(csv_idx).ok_or_else(|| VaultError::Import("no .json or .csv in the archive".into()))?;
        let is_json = Some(pick) == json_idx;
        let mut s = String::new();
        zip.by_index(pick).map_err(|e| VaultError::Import(e.to_string()))?.read_to_string(&mut s).map_err(|e| VaultError::Import(e.to_string()))?;
        if is_json {
            self.import_json(&s)
        } else {
            self.import_csv(&s)
        }
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

/// A fresh random 256-bit data key — for the OS keychain / key file.
pub fn new_key() -> [u8; 32] {
    random_bytes::<32>()
}

// ─── Password generation (#61 follow-up: suggest-on-registration) ───────────

/// Character classes a generated password always draws from. Ambiguous glyphs
/// (`l/I/1`, `O/0`) are excluded — suggested passwords sometimes get typed by
/// hand (second device, TV keyboards).
const GEN_LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
const GEN_UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const GEN_DIGIT: &[u8] = b"23456789";
const GEN_SYMBOL: &[u8] = b"!@#$%^&*-_=+?";

/// Generate a strong random password: OS-CSPRNG, rejection-sampled (no modulo
/// bias), with at least one of each class mixed in at random positions.
/// `len` is clamped to 8..=128; the suggested default is 20 (~119 bits from a
/// 62+13-glyph pool).
pub fn generate_password(len: usize) -> String {
    let len = len.clamp(8, 128);
    let pool: Vec<u8> =
        [GEN_LOWER, GEN_UPPER, GEN_DIGIT, GEN_SYMBOL].concat();
    let mut rng = rand::rngs::OsRng;

    let mut out: Vec<u8> = (0..len).map(|_| draw(&mut rng, &pool)).collect();
    // Guarantee one of each class, splatted at distinct random positions.
    let mut positions: Vec<usize> = Vec::with_capacity(4);
    for set in [GEN_LOWER, GEN_UPPER, GEN_DIGIT, GEN_SYMBOL] {
        loop {
            let p = draw_uniform(&mut rng, len);
            if !positions.contains(&p) {
                positions.push(p);
                out[p] = draw(&mut rng, set);
                break;
            }
        }
    }
    String::from_utf8(out).expect("generator charset is ASCII")
}

/// One glyph, uniform over `set` — rejection-sampled (no modulo bias).
fn draw(rng: &mut rand::rngs::OsRng, set: &[u8]) -> u8 {
    set[draw_uniform(rng, set.len())]
}

/// Uniform index in `0..len`: draw bytes, keep those below the largest
/// multiple of `len`.
fn draw_uniform(rng: &mut rand::rngs::OsRng, len: usize) -> usize {
    let cap = 256 - (256 % len);
    loop {
        let mut b = [0u8; 1];
        rng.fill_bytes(&mut b);
        if (b[0] as usize) < cap {
            return b[0] as usize % len;
        }
    }
}

// ─── Master-password key wrapping (Argon2id) ─────────────────────────────────

/// The data key wrapped by a master-password-derived key — persisted to disk
/// instead of (not alongside) the OS keychain, so the vault is sealed even from
/// the logged-in OS user until the password is entered.
#[derive(Clone, Serialize, Deserialize)]
pub struct KeyWrap {
    pub kdf: String, // "argon2id"
    pub salt: Vec<u8>,
    pub m_cost: u32, // memory, KiB
    pub t_cost: u32, // iterations
    pub p_cost: u32, // parallelism
    /// `nonce(12) ‖ AES-256-GCM(KEK, data_key)`.
    pub wrapped: Vec<u8>,
}

// OWASP-recommended Argon2id baseline: 19 MiB, 2 iterations, 1 lane.
const ARGON_M: u32 = 19_456;
const ARGON_T: u32 = 2;
const ARGON_P: u32 = 1;

fn derive_kek(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|_| VaultError::Crypto)?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut kek = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, kek.as_mut())
        .map_err(|_| VaultError::Crypto)?;
    Ok(kek)
}

/// Wrap `data_key` under a master `password` (fresh salt + Argon2id KEK).
pub fn wrap_key(password: &str, data_key: &[u8; 32]) -> Result<KeyWrap, VaultError> {
    let salt = random_bytes::<16>();
    let kek = derive_kek(password, &salt, ARGON_M, ARGON_T, ARGON_P)?;
    let wrapped = seal(&kek, data_key)?;
    Ok(KeyWrap { kdf: "argon2id".into(), salt: salt.to_vec(), m_cost: ARGON_M, t_cost: ARGON_T, p_cost: ARGON_P, wrapped })
}

/// Recover the data key from a [`KeyWrap`] with the master `password`. A wrong
/// password fails (AES-GCM authentication) rather than returning garbage.
pub fn unwrap_key(password: &str, w: &KeyWrap) -> Result<[u8; 32], VaultError> {
    let kek = derive_kek(password, &w.salt, w.m_cost, w.t_cost, w.p_cost)?;
    let dk = open(&kek, &w.wrapped)?;
    if dk.len() != 32 {
        return Err(VaultError::Crypto);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&dk);
    Ok(out)
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

/// Decrypt a PGP-encrypted export with a passphrase (Proton's password-based
/// encryption). Returns the plaintext bytes (JSON or CSV).
fn decrypt_pgp(data: &[u8], passphrase: &str) -> Result<Vec<u8>, VaultError> {
    use pgp::composed::{Deserializable, Message};
    let perr = |e: String| VaultError::Import(format!("PGP decrypt: {e}"));

    let armored = data.starts_with(b"-----BEGIN PGP");
    let message = if armored {
        Message::from_armor_single(std::io::Cursor::new(data)).map_err(|e| perr(e.to_string()))?.0
    } else {
        Message::from_bytes(std::io::Cursor::new(data)).map_err(|e| perr(e.to_string()))?
    };
    let decrypted = message
        .decrypt_with_password(|| passphrase.to_string())
        .map_err(|e| perr(e.to_string()))?;
    decrypted
        .get_content()
        .map_err(|e| perr(e.to_string()))?
        .ok_or_else(|| perr("empty message".into()))
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

// ─── Bitwarden export schema (defensive subset) ──────────────────────────────

mod bitwarden {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Export {
        #[serde(default)]
        pub encrypted: bool,
        #[serde(default)]
        pub items: Vec<Item>,
    }
    #[derive(Deserialize)]
    pub struct Item {
        #[serde(rename = "type", default)]
        pub item_type: i32,
        #[serde(default)]
        pub name: String,
        #[serde(default)]
        pub notes: Option<String>,
        #[serde(rename = "deletedDate", default)]
        pub deleted_date: Option<String>,
        #[serde(default)]
        pub login: Option<Login>,
    }
    #[derive(Deserialize, Default)]
    pub struct Login {
        #[serde(default)]
        pub username: String,
        #[serde(default)]
        pub password: String,
        #[serde(default)]
        pub totp: Option<String>,
        /// Modern exports: a list of `{ uri, match }`.
        #[serde(default)]
        pub uris: Vec<Uri>,
        /// Older exports carried a single `uri`.
        #[serde(default)]
        pub uri: Option<String>,
    }
    #[derive(Deserialize)]
    pub struct Uri {
        #[serde(default)]
        pub uri: Option<String>,
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

    #[test]
    fn import_csv_maps_columns_by_name() {
        // Header order shuffled + an extra column; a note row + an email-only login.
        let csv = "type,name,note,password,url,username,email,extra\n\
            login,GitHub,work,p1,https://github.com,octocat,,zzz\n\
            note,A note,body,,,,,\n\
            login,EmailOnly,,p2,https://x.io,,me@x.io,\n";
        let mut v = Vault::new();
        let n = v.import_csv(csv).unwrap();
        assert_eq!(n, 2); // logins only
        let gh = v.entries.iter().find(|c| c.name == "GitHub").unwrap();
        assert_eq!(gh.username, "octocat");
        assert_eq!(gh.password, "p1");
        assert_eq!(gh.notes, "work");
        let eo = v.entries.iter().find(|c| c.name == "EmailOnly").unwrap();
        assert_eq!(eo.username, "me@x.io"); // email fallback
    }

    #[test]
    fn import_chrome_csv() {
        // Chrome's password export: name,url,username,password,note (no type col).
        let csv = "name,url,username,password,note\n\
            github.com,https://github.com/login,octocat,p1,\n\
            news.ycombinator.com,https://news.ycombinator.com/,hnuser,p2,my hn\n";
        let mut v = Vault::new();
        assert_eq!(v.import(csv.as_bytes(), "Chrome Passwords.csv", None).unwrap(), 2);
        let gh = v.entries.iter().find(|c| c.name == "github.com").unwrap();
        assert_eq!(gh.username, "octocat");
        assert_eq!(gh.password, "p1");
        assert!(gh.matches_host("github.com"));
    }

    #[test]
    fn import_bitwarden_csv() {
        // Bitwarden CSV headers use login_* field names + a type column.
        let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
            ,,login,GitHub,work note,,0,https://github.com,octocat,p1,otpauth://totp/x\n\
            ,,note,A secure note,body,,0,,,,\n\
            ,,card,My Visa,,,0,,,,\n\
            ,,login,GitLab,,,0,https://gitlab.com,glab,p2,\n";
        let mut v = Vault::new();
        let n = v.import(csv.as_bytes(), "bitwarden_export.csv", None).unwrap();
        assert_eq!(n, 2); // logins only (note + card skipped by the type column)
        let gh = v.entries.iter().find(|c| c.name == "GitHub").unwrap();
        assert_eq!(gh.username, "octocat");
        assert_eq!(gh.password, "p1");
        assert_eq!(gh.totp, "otpauth://totp/x");
        assert_eq!(gh.notes, "work note");
        assert!(v.entries.iter().any(|c| c.name == "GitLab"));
    }

    #[test]
    fn import_bitwarden_json() {
        let json = r#"{
          "encrypted": false,
          "folders": [],
          "items": [
            { "type": 1, "name": "GitHub", "notes": "work",
              "login": { "username": "octocat", "password": "p1", "totp": "otpauth://x",
                "uris": [{ "match": null, "uri": "https://github.com" }] } },
            { "type": 2, "name": "A note", "notes": "secret", "secureNote": { "type": 0 } },
            { "type": 1, "name": "Trashed", "deletedDate": "2026-01-01T00:00:00.000Z",
              "login": { "username": "old", "password": "nope", "uris": [] } },
            { "type": 1, "name": "Legacy", "login": { "username": "leg", "password": "p2", "uri": "https://legacy.io" } }
          ]
        }"#;
        let mut v = Vault::new();
        // Detected as Bitwarden (items, no vaults) even via the generic entry point.
        let n = v.import(json.as_bytes(), "bitwarden.json", None).unwrap();
        assert_eq!(n, 2); // GitHub + Legacy; note skipped (type 2), Trashed skipped (deletedDate)
        let gh = v.entries.iter().find(|c| c.name == "GitHub").unwrap();
        assert_eq!(gh.username, "octocat");
        assert_eq!(gh.password, "p1");
        assert_eq!(gh.totp, "otpauth://x");
        assert!(gh.matches_host("github.com"));
        let legacy = v.entries.iter().find(|c| c.name == "Legacy").unwrap();
        assert!(legacy.matches_host("legacy.io")); // older single `uri` shape
        // Re-import dedupes.
        v.import(json.as_bytes(), "bitwarden.json", None).unwrap();
        assert_eq!(v.entries.len(), 2);
    }

    #[test]
    fn import_bitwarden_encrypted_errors_clearly() {
        let json = r#"{ "encrypted": true, "items": [] }"#;
        let err = Vault::new().import(json.as_bytes(), "bw.json", None).unwrap_err();
        assert!(matches!(err, VaultError::Import(_)));
        assert!(err.to_string().contains("encrypted"));
    }

    #[test]
    fn import_zip_and_format_detection() {
        use std::io::Write;
        let json = r#"{"vaults":{"v":{"items":[{"state":1,"data":{"type":"login",
            "metadata":{"name":"Zipped"},"content":{"username":"zu","password":"zp",
            "urls":["https://z.com"]}}}]}}}"#;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            zw.start_file("Proton Pass/data.json", zip::write::SimpleFileOptions::default()).unwrap();
            zw.write_all(json.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let mut v = Vault::new();
        // ZIP detected by magic bytes.
        assert_eq!(v.import(&buf, "export.zip", None).unwrap(), 1);
        assert_eq!(v.entries[0].username, "zu");
        // CSV vs JSON detected by content.
        assert_eq!(v.import(b"name,url,username,password,type\nA,https://a.com,u,p,login\n", "x.csv", None).unwrap(), 1);
        assert_eq!(v.import(json.as_bytes(), "x.json", None).unwrap(), 1); // re-imports Zipped (dedup)
        assert!(v.entries.iter().any(|c| c.name == "A"));
    }

    // A password-encrypted (symmetric) PGP message made with:
    //   gpg --symmetric --armor --passphrase test123 --cipher-algo AES256
    // wrapping a one-login Proton JSON. Validates decrypt_pgp end-to-end.
    const PGP_FIXTURE: &str = "-----BEGIN PGP MESSAGE-----\n\n\
jA0ECQMKGobyRNaU0ij/0rQBkHri6QCMWiN43Ykhv9nD4tcYOQYWd3PErw+0wGhG\n\
stId2UebxS4ovcBQnVs2ewu4FJn7j2l7PMe1yddXDv4wN0tRToM37JosBKpfTOEn\n\
q4e4WwdEzdZAJlCGsMBVO681Df3h+WUfCCQ/4wcyVseCWIqL2XM3S4jS+BpuI71z\n\
6JwNXZiIqjsE8JdMfsRJv0bwuEJNVCI/DlJfvjA+YKK0lkgGHYhPLmMT6d80iRFL\n\
jRQjwtU=\n=+uGW\n-----END PGP MESSAGE-----\n";

    #[test]
    fn master_password_wrap_roundtrips() {
        let dk = key();
        let w = wrap_key("correct horse battery staple", &dk).unwrap();
        assert_eq!(w.kdf, "argon2id");
        // Right password recovers the data key.
        assert_eq!(unwrap_key("correct horse battery staple", &w).unwrap(), dk);
        // Wrong password fails (AEAD auth), doesn't return garbage.
        assert!(unwrap_key("wrong password", &w).is_err());
        // Fresh wrap of the same key uses a fresh salt → different blob.
        assert_ne!(wrap_key("correct horse battery staple", &dk).unwrap().wrapped, w.wrapped);
    }

    #[test]
    fn import_pgp_with_passphrase() {
        let mut v = Vault::new();
        let n = v.import(PGP_FIXTURE.as_bytes(), "export.pgp", Some("test123")).unwrap();
        assert_eq!(n, 1);
        let c = &v.entries[0];
        assert_eq!(c.name, "PgpSite");
        assert_eq!(c.username, "pu");
        assert_eq!(c.password, "pp");
        // Wrong passphrase fails (not a panic).
        assert!(Vault::new().import(PGP_FIXTURE.as_bytes(), "export.pgp", Some("wrong")).is_err());
    }

    #[test]
    fn generated_password_has_length_and_all_classes() {
        for len in [8, 20, 64, 128] {
            let p = generate_password(len);
            assert_eq!(p.len(), len);
            assert!(p.bytes().any(|b| GEN_LOWER.contains(&b)), "lower in {p}");
            assert!(p.bytes().any(|b| GEN_UPPER.contains(&b)), "upper in {p}");
            assert!(p.bytes().any(|b| GEN_DIGIT.contains(&b)), "digit in {p}");
            assert!(p.bytes().any(|b| GEN_SYMBOL.contains(&b)), "symbol in {p}");
        }
    }

    #[test]
    fn generated_password_clamps_and_varies() {
        assert_eq!(generate_password(1).len(), 8); // clamped up
        assert_eq!(generate_password(9999).len(), 128); // clamped down
        // Two draws colliding at 20 chars ≈ impossible; a collision means the
        // RNG plumbing is broken.
        assert_ne!(generate_password(20), generate_password(20));
    }

    #[test]
    fn generated_password_avoids_ambiguous_glyphs() {
        let p = generate_password(128);
        for bad in ['l', 'I', '1', 'O', '0'] {
            assert!(!p.contains(bad), "ambiguous {bad} in {p}");
        }
    }
}
