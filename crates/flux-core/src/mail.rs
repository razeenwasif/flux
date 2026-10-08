//! Read-only IMAP inbox glance (the mail half of the dock column).
//!
//! **Deliberately not the Gmail API.** That needs an OAuth client, a Google Cloud
//! project, and consent for a *restricted* scope — a great deal of ceremony for a
//! personal tool, and unverified apps face periodic re-consent. IMAP with an app
//! password is a keychain entry and a socket.
//!
//! **Read-only except for one explicit action.** Listing mail issues
//! `SELECT`/`SEARCH`/`FETCH` and nothing else — no deletes, no `APPEND`, no moves
//! — and reads envelopes rather than bodies, so *looking* at the pane can never
//! mark anything seen in your real client.
//!
//! The single exception is [`mail_mark_all_read`], which the user asks for by
//! name: it issues `STORE +FLAGS (\Seen)`, and that change is real and visible
//! everywhere else the account is open. It is deliberately the only write this
//! module can perform, so "did Flux touch my mailbox?" has one possible answer
//! rather than an audit.
//!
//! A connection is made per fetch rather than held open. A long-lived IMAP session
//! needs `NOOP` keepalives, reconnect-on-drop and locking; for a pane that refreshes
//! on demand or on a slow timer, connecting each time is far simpler and the cost
//! is one TLS handshake.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

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
        // charset?enc?payload?= -- find the two inner '?' first and only then
        // the terminator: a Q payload that starts with "=XX" would otherwise
        // end the word at the "Q?=" right after the encoding letter.
        let bounds = after.find('?').and_then(|q1| {
            let q2 = q1 + 1 + after[q1 + 1..].find('?')?;
            let end = q2 + 1 + after[q2 + 1..].find("?=")?;
            Some((q1, q2, end))
        });
        let Some((q1, q2, end)) = bounds else {
            out.push_str(&rest[start..]);
            return out;
        };
        let charset = after[..q1].to_ascii_lowercase();
        let enc = after[q1 + 1..q2].to_ascii_uppercase();
        let payload = &after[q2 + 1..end];
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
                // Decode the bytes rather than slicing `s`: the two bytes after
                // '=' can sit inside a multi-byte char ("=a€"), and a str slice
                // there panics, which aborts Flux on a hostile subject line.
                let hex = |c: u8| (c as char).to_digit(16);
                match (hex(b[i + 1]), hex(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    // Not an escape: keep the '=' and rescan what follows rather
                    // than dropping two bytes of real text.
                    _ => {
                        out.push(b'=');
                        i += 1;
                    }
                }
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

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per read/write. Without it a server that stops answering (or a socket left
/// half-open by sleep) parked a blocking-pool thread forever, and the pane's
/// 2-minute poll added another each time.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// TCP to the server, bounded: `connect` per address, as `TcpStream::connect`
/// does, but with a timeout, and with read/write timeouts that rustls and imap
/// inherit.
fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let mut last_err = String::from("no address");
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(tcp) => {
                tcp.set_read_timeout(Some(IO_TIMEOUT))
                    .and_then(|()| tcp.set_write_timeout(Some(IO_TIMEOUT)))
                    .map_err(|e| format!("socket: {e}"))?;
                return Ok(tcp);
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("connect {host}:{port}: {last_err}"))
}

/// Connect, log in, and hand the session to `f`. Always logs out.
fn with_session<T>(
    cfg: &MailConfig,
    pass: &str,
    f: impl FnOnce(&mut imap::Session<Box<dyn ReadWrite>>) -> Result<T, String>,
) -> Result<T, String> {
    let tcp = connect(&cfg.host, cfg.port)?;
    let connector = rustls_connector::RustlsConnectorConfig::new_with_platform_verifier()
        .with_webpki_root_certs()
        .connector_with_no_client_auth()
        .or_else(|_| rustls_connector::RustlsConnector::new_with_webpki_root_certs())
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
    if !crate::vault::HAS_OS_KEYCHAIN {
        return Err("no OS keychain on this platform, so the app password can't be saved".into());
    }
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

/// Mark every unread message in INBOX as read.
///
/// The one write this module performs. Returns how many were marked, so the UI
/// can report what happened rather than silently succeeding — and returns 0
/// without touching anything when there is nothing unread, which is a common
/// case worth not turning into a needless round trip.
#[tauri::command]
pub async fn mail_mark_all_read(app: AppHandle) -> Result<u32, String> {
    let cfg = load_config(&app).ok_or("no mail account configured")?;
    let pass = password(&cfg.email)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&cfg, &pass, |s| {
            s.select("INBOX")
                .map_err(|e| format!("select INBOX: {e}"))?;
            let unseen = s
                .uid_search("UNSEEN")
                .map_err(|e| format!("search unseen: {e}"))?;
            if unseen.is_empty() {
                return Ok(0);
            }
            // As few STOREs as the server's line limit allows (usually one): a
            // request per message would be slow on a big inbox. Setting \Seen
            // is idempotent, so a run that stops partway is safe to repeat.
            // .SILENT: no per-message FETCH echo to parse.
            for set in uid_sets(unseen.iter().copied(), 500) {
                s.uid_store(&set, "+FLAGS.SILENT (\\Seen)")
                    .map_err(|e| format!("mark read: {e}"))?;
            }
            Ok(u32::try_from(unseen.len()).unwrap_or(u32::MAX))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// UID sets for `UID STORE`: runs collapsed to ranges ("4001:4900"), at most
/// `per_command` of them per set. A flat list of 10k+ UIDs overran server line
/// limits (Dovecot's is 64 KB) and the whole command was refused.
fn uid_sets(uids: impl IntoIterator<Item = u32>, per_command: usize) -> Vec<String> {
    let mut sorted: Vec<u32> = uids.into_iter().collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut ranges: Vec<String> = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        while i + 1 < sorted.len() && sorted[i].checked_add(1) == Some(sorted[i + 1]) {
            i += 1;
        }
        let end = sorted[i];
        ranges.push(if start == end {
            start.to_string()
        } else {
            format!("{start}:{end}")
        });
        i += 1;
    }
    ranges
        .chunks(per_command.max(1))
        .map(|c| c.join(","))
        .collect()
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
    fn q_words_that_start_with_an_escape_decode_whole() {
        // The "?=" of "Q?=C3" used to end the word before its text began.
        assert_eq!(decode_words("=?UTF-8?Q?=C3=89t=C3=A9?="), "Été");
        assert_eq!(
            decode_words("=?utf-8?Q?=F0=9F=8E=89_Party_on_Friday?="),
            "🎉 Party on Friday"
        );
        assert_eq!(
            format_from(Some("=?UTF-8?Q?=C3=89lodie?="), None, None),
            "Élodie"
        );
    }

    #[test]
    fn q_decoding_survives_multibyte_text_after_an_equals_sign() {
        // Raw 8-bit text inside a Q-word used to be sliced mid-character, which
        // panicked (and aborted Flux) on every mail refresh.
        assert_eq!(decode_q("x=€"), "x=€".as_bytes());
        assert_eq!(decode_q("=日x"), "=日x".as_bytes());
        // A non-hex escape keeps the text after it instead of dropping 2 bytes.
        assert_eq!(decode_q("a=zzb"), b"a=zzb");
        assert_eq!(decode_q("caf=C3=A9"), "café".as_bytes());
    }

    #[test]
    fn mark_all_read_sends_ranges_in_bounded_commands() {
        assert_eq!(uid_sets([7, 3, 4, 5, 9, 10, 4], 500), ["3:5,7,9:10"]);
        let top = uid_sets([u32::MAX - 1, u32::MAX], 500);
        assert_eq!(top, ["4294967294:4294967295"], "no overflow at the top");
        // A big unread backlog is usually one run, so one short command...
        assert_eq!(uid_sets(1..=12_000, 500), ["1:12000"]);
        // ...and a scattered one is split, rather than one 80 KB line.
        let every_other = uid_sets((1..=12_000).step_by(2), 500);
        assert_eq!(every_other.len(), 12);
        assert!(every_other.iter().all(|s| s.len() < 16 * 1024));
    }

    #[test]
    fn imap_sockets_time_out_rather_than_block_forever() {
        // Connects into the listener's backlog; nothing ever answers, which is
        // exactly the stalled server that used to pin a thread per poll.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let tcp = connect("127.0.0.1", port).unwrap();
        assert_eq!(tcp.read_timeout().unwrap(), Some(IO_TIMEOUT));
        assert_eq!(tcp.write_timeout().unwrap(), Some(IO_TIMEOUT));
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
