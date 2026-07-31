//! Read-only IMAP inbox glance (the mail half of the dock column).
//!
//! **Deliberately not the Gmail API.** That needs an OAuth client, a Google Cloud
//! project, and consent for a *restricted* scope — a great deal of ceremony for a
//! personal tool, and unverified apps face periodic re-consent. IMAP with an app
//! password is a keychain entry and a socket.
//!
//! **Read-only, structurally.** This module issues `SELECT`/`SEARCH`/`FETCH` and
//! nothing else: no `STORE`, no flag changes, no deletes, no `APPEND`. Mail is
//! opened with `BODY.PEEK` semantics via `ENVELOPE` only, so glancing here can't
//! mark anything read in Gmail proper. Nothing this pane does is visible from the
//! other end.
//!
//! A connection is made per fetch rather than held open. A long-lived IMAP session
//! needs `NOOP` keepalives, reconnect-on-drop and locking; for a pane that refreshes
//! on demand or on a slow timer, connecting each time is far simpler and the cost
//! is one TLS handshake.

use std::io::{Read, Write};
use std::net::TcpStream;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Where the account lives. The password is **not** here — it's in the OS
/// keychain, same as the vault's key.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub email: String,
}

/// One inbox message, as much as a glance needs.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MailMsg {
    pub uid: u32,
    pub from: String,
    pub subject: String,
    /// Server-side arrival time, epoch ms. 0 when the server omits it.
    pub date_ms: i64,
    pub unread: bool,
    /// RFC822 Message-ID, which is what makes a message findable in a real
    /// client: Gmail's `rfc822msgid:` search opens exactly this message.
    pub message_id: String,
}

const KEYCHAIN_SERVICE: &str = "flux-mail";

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("mail.json"))
}

fn load_config(app: &AppHandle) -> Option<MailConfig> {
    let raw = std::fs::read_to_string(config_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn password(email: &str) -> Result<String, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, email)
        .map_err(|e| format!("keychain: {e}"))?
        .get_password()
        .map_err(|_| "no app password saved for this account — reconnect".to_string())
}

// ─── RFC 2047 ────────────────────────────────────────────────────────────────

/// Decode `=?charset?B|Q?text?=` words in a header.
///
/// Subjects and display names arrive encoded whenever they leave ASCII, and an
/// undecoded one reads as line noise — which is most of what this pane shows.
/// Only UTF-8 and Latin-1 are handled; anything else is left as written rather
/// than mangled into replacement characters.
pub fn decode_words(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // charset?enc?payload?=
        let Some(end) = after.find("?=") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let word = &after[..end];
        let mut parts = word.splitn(3, '?');
        let charset = parts.next().unwrap_or("").to_ascii_lowercase();
        let enc = parts.next().unwrap_or("").to_ascii_uppercase();
        let payload = parts.next().unwrap_or("");
        let bytes = match enc.as_str() {
            "B" => {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .ok()
            }
            "Q" => Some(decode_q(payload)),
            _ => None,
        };
        match bytes {
            Some(b) if charset.starts_with("utf-8") || charset.starts_with("utf8") => {
                out.push_str(&String::from_utf8_lossy(&b))
            }
            Some(b) if charset.starts_with("iso-8859-1") || charset.starts_with("windows-1252") => {
                out.extend(b.iter().map(|&c| c as char))
            }
            // Unknown charset or broken payload: keep the raw word. Better an
            // ugly subject than a wrong one.
            _ => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// Quoted-printable as used in encoded words: `_` is a space, `=XX` is a byte.
fn decode_q(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < b.len() => {
                match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    Ok(v) => out.push(v),
                    Err(_) => out.push(b'='),
                }
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// A sender as a human reads it: the display name if there is one, else the
/// address. An empty result would render as a blank row, so it falls back.
pub fn format_from(name: Option<&str>, mailbox: Option<&str>, host: Option<&str>) -> String {
    let name = name.map(decode_words).unwrap_or_default();
    if !name.trim().is_empty() {
        return name;
    }
    match (mailbox, host) {
        (Some(m), Some(h)) => format!("{m}@{h}"),
        (Some(m), None) => m.to_string(),
        _ => "(unknown sender)".into(),
    }
}

// ─── IMAP ────────────────────────────────────────────────────────────────────

fn utf8(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

/// Connect, log in, and hand the session to `f`. Always logs out.
fn with_session<T>(
    cfg: &MailConfig,
    pass: &str,
    f: impl FnOnce(&mut imap::Session<Box<dyn ReadWrite>>) -> Result<T, String>,
) -> Result<T, String> {
    let tcp = TcpStream::connect((cfg.host.as_str(), cfg.port))
        .map_err(|e| format!("connect {}:{}: {e}", cfg.host, cfg.port))?;
    let connector = rustls_connector::RustlsConnector::new_with_webpki_root_certs()
        .map_err(|e| format!("TLS setup: {e}"))?;
    let tls = connector
        .connect(&cfg.host, tcp)
        .map_err(|e| format!("TLS: {e}"))?;
    let client = imap::Client::new(Box::new(tls) as Box<dyn ReadWrite>);
    let mut session = client
        .login(&cfg.email, pass)
        .map_err(|(e, _)| format!("login failed: {e}"))?;
    let out = f(&mut session);
    let _ = session.logout();
    out
}

/// `imap::Client` needs one concrete stream type; boxing keeps the TLS type out
/// of every signature.
pub trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

/// Verify an account and save it. The password only reaches the keychain once
/// the server has accepted it, so a typo can't be stored as if it worked.
#[tauri::command]
pub async fn mail_connect(
    app: AppHandle,
    host: String,
    port: u16,
    email: String,
    password: String,
) -> Result<(), String> {
    let cfg = MailConfig {
        host: host.trim().to_string(),
        port,
        email: email.trim().to_string(),
    };
    let probe = cfg.clone();
    let pass = password.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&probe, &pass, |s| {
            s.select("INBOX")
                .map_err(|e| format!("select INBOX: {e}"))?;
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    keyring::Entry::new(KEYCHAIN_SERVICE, &cfg.email)
        .map_err(|e| format!("keychain: {e}"))?
        .set_password(&password)
        .map_err(|e| format!("keychain: {e}"))?;
    let path = config_path(&app).ok_or("no app data directory")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    crate::persist::save_json(&path, &cfg);
    Ok(())
}

/// The saved account, if any. Never returns the password.
#[tauri::command]
pub fn mail_config(app: AppHandle) -> Option<MailConfig> {
    load_config(&app)
}

/// Forget the account: config file and keychain entry both.
#[tauri::command]
pub fn mail_disconnect(app: AppHandle) -> Result<(), String> {
    if let Some(cfg) = load_config(&app) {
        if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &cfg.email) {
            let _ = e.delete_credential();
        }
    }
    if let Some(p) = config_path(&app) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// The newest `limit` messages in INBOX, newest first, with unread flagged.
#[tauri::command]
pub async fn mail_fetch(app: AppHandle, limit: Option<u32>) -> Result<Vec<MailMsg>, String> {
    let cfg = load_config(&app).ok_or("no mail account configured")?;
    let pass = password(&cfg.email)?;
    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&cfg, &pass, |s| {
            let mbox = s
                .select("INBOX")
                .map_err(|e| format!("select INBOX: {e}"))?;
            let total = mbox.exists;
            if total == 0 {
                return Ok(Vec::new());
            }
            // The newest `limit` by sequence number. SEARCH would also work but
            // returns the whole mailbox, which is wasteful on a large inbox.
            let first = total.saturating_sub(limit as u32 - 1).max(1);
            let range = format!("{first}:{total}");
            let fetches = s
                .fetch(&range, "(UID FLAGS ENVELOPE)")
                .map_err(|e| format!("fetch: {e}"))?;
            let mut out: Vec<MailMsg> = fetches
                .iter()
                .map(|f| {
                    let env = f.envelope();
                    let addr = env.and_then(|e| e.from.as_ref()).and_then(|v| v.first());
                    MailMsg {
                        uid: f.uid.unwrap_or(0),
                        from: format_from(
                            addr.and_then(|a| a.name.as_ref())
                                .map(|b| utf8(b))
                                .as_deref(),
                            addr.and_then(|a| a.mailbox.as_ref())
                                .map(|b| utf8(b))
                                .as_deref(),
                            addr.and_then(|a| a.host.as_ref())
                                .map(|b| utf8(b))
                                .as_deref(),
                        ),
                        subject: env
                            .and_then(|e| e.subject.as_ref())
                            .map(|s| decode_words(&utf8(s)))
                            .unwrap_or_else(|| "(no subject)".into()),
                        date_ms: f.internal_date().map(|d| d.timestamp_millis()).unwrap_or(0),
                        unread: !f.flags().contains(&imap::types::Flag::Seen),
                        message_id: env
                            .and_then(|e| e.message_id.as_ref())
                            .map(|b| utf8(b))
                            .unwrap_or_default()
                            .trim_matches(['<', '>'])
                            .to_string(),
                    }
                })
                .collect();
            out.reverse(); // newest first
            Ok(out)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_encoded_words() {
        // Plain text is untouched.
        assert_eq!(decode_words("Re: lecture 4"), "Re: lecture 4");
        // Base64 UTF-8 — the common case from any non-English sender.
        assert_eq!(decode_words("=?UTF-8?B?SGVsbG8gd29ybGQ=?="), "Hello world");
        // Quoted-printable, where `_` is a space.
        assert_eq!(decode_words("=?utf-8?Q?Caf=C3=A9_time?="), "Café time");
        // Mixed with surrounding literal text, both sides.
        assert_eq!(
            decode_words("Fwd: =?UTF-8?B?dGVzdA==?= (urgent)"),
            "Fwd: test (urgent)"
        );
        // Several words in one header.
        assert_eq!(decode_words("=?UTF-8?B?QQ==?= =?UTF-8?B?Qg==?="), "A B");
        // An unknown charset is left as written rather than mangled — an ugly
        // subject beats a wrong one.
        let exotic = "=?Shift_JIS?B?gqCCogA=?=";
        assert_eq!(decode_words(exotic), exotic);
        // Malformed input must not panic or truncate the rest.
        assert_eq!(decode_words("=?UTF-8?B?broken"), "=?UTF-8?B?broken");
    }

    #[test]
    fn sender_always_renders_something() {
        assert_eq!(format_from(Some("Ada"), Some("ada"), Some("x.com")), "Ada");
        // No display name: fall back to the address, not a blank row.
        assert_eq!(format_from(None, Some("ada"), Some("x.com")), "ada@x.com");
        // A whitespace-only name is not a name.
        assert_eq!(
            format_from(Some("   "), Some("ada"), Some("x.com")),
            "ada@x.com"
        );
        // Encoded display names decode here too.
        assert_eq!(
            format_from(Some("=?UTF-8?B?QWRh?="), Some("ada"), Some("x.com")),
            "Ada"
        );
        // Nothing at all still renders a row rather than an empty cell.
        assert_eq!(format_from(None, None, None), "(unknown sender)");
    }
}
