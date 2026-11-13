//! The phone link (ADR 0022): Flux on your iPhone reads this Mac's calendar and
//! inbox, and asks Fairy, for its notch island. Over Tailscale only.
//!
//! The Mac already has what the island shows: Google Calendar through its
//! secret ICS address (calendar.rs), Gmail over IMAP with an app password
//! (mail.rs), and Fairy on `flux.sock` (fairy.rs). The phone has none of it and
//! shouldn't need its own copy of those secrets, so it asks the Mac. The design
//! follows Fairy's own phone link (Lyra's `desktop/phone-link.mjs`):
//!
//! - **Tailscale only.** The server listens on this Mac's Tailscale address
//!   (100.64.0.0/10, on a `utun` interface), nowhere else, and drops any
//!   connection from outside that range. With Tailscale off it doesn't listen.
//! - **Its own certificate.** A self-signed P-256 certificate made with
//!   macOS's `openssl`, its key in the Keychain. The phone is handed the
//!   certificate's SHA-256 when it pairs and trusts nothing else, so there's no
//!   certificate authority to trust or fool.
//! - **Pairing.** "Copy pairing link" on the Mac makes a
//!   `flux-browser://pair?host=…&port=…&code=…&pin=…` link; it reaches the
//!   phone by Universal Clipboard or AirDrop. The code works once, for five
//!   minutes and five tries, and the phone trades it for a key of its own. Only
//!   a hash of that key is kept here; forgetting a phone deletes it.
//! - **Read-only.** A phone can read the week's events and the newest mail
//!   (envelopes: sender, subject, time; never bodies, and nothing is marked
//!   read), and ask Fairy a question with a page as material. It can't change
//!   anything on the Mac, and pairing a new phone happens only on the Mac.
//!
//! Plain `std` sockets and threads with rustls on top: one request per
//! connection, no keep-alive. It's a handful of requests a minute at most.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

/// Fairy's phone link is 47616; this is the next one up.
pub const PORT: u16 = 47617;
const PAIR_LIFETIME_MS: i64 = 5 * 60 * 1000;
const PAIR_TRIES: u32 = 5;
const MAX_HEAD: usize = 8 * 1024;
const MAX_BODY: usize = 96 * 1024;
const MAX_CONNS: usize = 16;
const CERT_DAYS: u32 = 800;
/// Make a new certificate this long before the old one runs out (and pair again).
const RENEW_BEFORE_MS: i64 = 30 * 86_400_000;
const KEYCHAIN_SERVICE: &str = "flux-phonelink";
const KEYCHAIN_ACCOUNT: &str = "tls-key";
/// How often Tailscale is looked at, to follow it coming, going or moving.
const CHECK_EVERY: Duration = Duration::from_secs(20);

const TAILSCALE: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn random_b64(n: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// What's kept in `phonelink.json`. The TLS key is in the Keychain, and a
/// phone's key only as a hash.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Saved {
    enabled: bool,
    /// The certificate, DER in base64.
    cert: String,
    /// The Tailscale name it was made for.
    cert_name: String,
    expires_ms: i64,
    devices: Vec<Device>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Device {
    id: String,
    name: String,
    /// SHA-256 of the phone's key, hex.
    key_hash: String,
    paired_ms: i64,
    last_seen_ms: i64,
}

/// What Settings › Phone link shows.
#[derive(Serialize, Clone)]
pub struct PhoneLinkState {
    pub enabled: bool,
    pub listening: bool,
    /// Tailscale is up on this Mac.
    pub tailscale: bool,
    /// This Mac's Tailscale name (`mac.tailnet.ts.net`).
    pub name: String,
    pub problem: String,
    pub devices: Vec<PhoneDevice>,
}

#[derive(Serialize, Clone)]
pub struct PhoneDevice {
    pub id: String,
    pub name: String,
    pub paired_ms: i64,
    pub last_seen_ms: i64,
}

struct Pairing {
    code_hash: [u8; 32],
    expires_ms: i64,
    tries: u32,
}

struct Server {
    stop: Arc<AtomicBool>,
    ip: Ipv4Addr,
}

#[derive(Default)]
struct Inner {
    path: Option<PathBuf>,
    saved: Saved,
    server: Option<Server>,
    host: String,
    tailscale: bool,
    problem: String,
    pairing: Option<Pairing>,
    last_saved_seen: i64,
}

/// Managed state: the link's settings, server and pairing.
#[derive(Clone, Default)]
pub struct PhoneLink(Arc<Mutex<Inner>>);

impl PhoneLink {
    fn save(inner: &mut Inner) {
        let Some(path) = &inner.path else { return };
        if let Ok(json) = serde_json::to_string_pretty(&inner.saved) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    fn state(inner: &Inner) -> PhoneLinkState {
        PhoneLinkState {
            enabled: inner.saved.enabled,
            listening: inner.server.is_some(),
            tailscale: inner.tailscale,
            name: inner.host.clone(),
            problem: inner.problem.clone(),
            devices: inner
                .saved
                .devices
                .iter()
                .map(|d| PhoneDevice {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    paired_ms: d.paired_ms,
                    last_seen_ms: d.last_seen_ms,
                })
                .collect(),
        }
    }
}

/// Load the settings and start following Tailscale. macOS only: that's where
/// Fairy, the calendar feeds and the mail account live.
pub fn start(app: &AppHandle) {
    let link = PhoneLink::default();
    {
        let mut inner = link.0.lock();
        inner.path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("phonelink.json"));
        if let Some(saved) = inner
            .path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
        {
            inner.saved = saved;
        }
    }
    app.manage(link.clone());
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("phonelink".into())
            .spawn(move || loop {
                refresh(&app, &link);
                std::thread::sleep(CHECK_EVERY);
            })
            .ok();
    }
}

/// This Mac on Tailscale: its IPv4 address and MagicDNS name.
fn tailscale() -> Option<(Ipv4Addr, String)> {
    for bin in TAILSCALE {
        let Ok(out) = std::process::Command::new(bin)
            .args(["status", "--json"])
            .output()
        else {
            continue;
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
            continue;
        };
        if v.get("BackendState").and_then(|s| s.as_str()) != Some("Running") {
            return None;
        }
        let me = v.get("Self")?;
        let name = me
            .get("DNSName")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .trim_end_matches('.')
            .to_string();
        let ip = me
            .get("TailscaleIPs")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
            .filter_map(|ip| ip.as_str()?.parse::<Ipv4Addr>().ok())
            .find(|ip| is_tailscale(IpAddr::V4(*ip)))?;
        if name.is_empty() {
            return None;
        }
        return Some((ip, name));
    }
    None
}

/// Tailscale gives out addresses from 100.64.0.0/10.
pub fn is_tailscale(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return false,
        },
    };
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// Follow the setting and Tailscale: listen when both are on, on the address
/// Tailscale has now; stop otherwise.
fn refresh(app: &AppHandle, link: &PhoneLink) {
    let enabled = link.0.lock().saved.enabled;
    let ts = if enabled { tailscale() } else { None };
    let mut inner = link.0.lock();
    inner.tailscale = ts.is_some();
    let Some((ip, name)) = ts.filter(|_| inner.saved.enabled) else {
        stop(&mut inner);
        if !enabled {
            inner.problem.clear();
        }
        return;
    };
    if inner.server.as_ref().is_some_and(|s| s.ip == ip) && inner.host == name {
        return;
    }
    stop(&mut inner);
    match identity(&mut inner, &name).and_then(|(cert, key)| listen(app, link, ip, cert, key)) {
        Ok(stop_flag) => {
            inner.server = Some(Server { stop: stop_flag, ip });
            inner.host = name;
            inner.problem.clear();
        }
        Err(e) => inner.problem = e,
    }
}

fn stop(inner: &mut Inner) {
    if let Some(s) = inner.server.take() {
        s.stop.store(true, Ordering::SeqCst);
        // Wake the blocked accept so the thread sees the flag.
        let _ = TcpStream::connect_timeout(&SocketAddr::from((s.ip, PORT)), Duration::from_millis(300));
    }
    inner.pairing = None;
}

/// The certificate and key, made again when the name changes or it's near its
/// end. A new certificate means every phone pairs again: it's what they trust.
fn identity(inner: &mut Inner, name: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| format!("Keychain: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD;
    if !inner.saved.cert.is_empty()
        && inner.saved.cert_name == name
        && inner.saved.expires_ms - now_ms() > RENEW_BEFORE_MS
    {
        if let (Ok(cert), Ok(key)) = (
            b64.decode(&inner.saved.cert),
            entry.get_password().map_err(|_| ()).and_then(|k| b64.decode(k).map_err(|_| ())),
        ) {
            return Ok((cert, key));
        }
    }
    let (cert, key) = make_certificate(name)?;
    entry
        .set_password(&b64.encode(&key))
        .map_err(|e| format!("Couldn't keep the link's key in the Keychain: {e}"))?;
    let replacing = !inner.saved.cert.is_empty();
    inner.saved.cert = b64.encode(&cert);
    inner.saved.cert_name = name.to_string();
    inner.saved.expires_ms = now_ms() + CERT_DAYS as i64 * 86_400_000;
    if replacing {
        inner.saved.devices.clear();
    }
    PhoneLink::save(inner);
    Ok((cert, key))
}

/// A P-256 certificate for `name` and its PKCS#8 key, both DER, from macOS's
/// own openssl (LibreSSL), so this needs no certificate crate.
fn make_certificate(name: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = std::env::temp_dir().join(format!("flux-phonelink-{}", random_b64(9)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let run = |args: &[&str]| -> Result<(), String> {
        let ok = std::process::Command::new("/usr/bin/openssl")
            .args(args)
            .current_dir(&dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err("Flux couldn't make the phone link's certificate.".into())
        }
    };
    let result = (|| {
        let days = CERT_DAYS.to_string();
        let san = format!("subjectAltName=DNS:{name}");
        run(&[
            "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt",
            "ec_param_enc:named_curve", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", &days, "-subj",
            "/CN=Flux phone link", "-addext", &san, "-addext", "extendedKeyUsage=serverAuth",
        ])?;
        run(&["x509", "-in", "cert.pem", "-outform", "DER", "-out", "cert.der"])?;
        run(&["pkcs8", "-topk8", "-nocrypt", "-in", "key.pem", "-outform", "DER", "-out", "key.der"])?;
        let cert = std::fs::read(dir.join("cert.der")).map_err(|e| e.to_string())?;
        let key = std::fs::read(dir.join("key.der")).map_err(|e| e.to_string())?;
        Ok((cert, key))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn listen(
    app: &AppHandle,
    link: &PhoneLink,
    ip: Ipv4Addr,
    cert: Vec<u8>,
    key: Vec<u8>,
) -> Result<Arc<AtomicBool>, String> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
        )
        .map_err(|e| format!("The phone link's certificate didn't load: {e}"))?;
    let tls = Arc::new(tls);
    let listener = TcpListener::bind((ip, PORT)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("Another app is using port {PORT}, which the phone link needs.")
        } else {
            format!("The phone link couldn't start: {e}")
        }
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let app = app.clone();
    let link = link.clone();
    let live = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("phonelink-accept".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(tcp) = conn else { continue };
                // Nothing at all for anything outside Tailscale.
                if !tcp.peer_addr().map(|a| is_tailscale(a.ip())).unwrap_or(false) {
                    continue;
                }
                if live.load(Ordering::SeqCst) >= MAX_CONNS {
                    continue;
                }
                live.fetch_add(1, Ordering::SeqCst);
                let (app, link, tls, live) = (app.clone(), link.clone(), tls.clone(), live.clone());
                std::thread::spawn(move || {
                    let _ = serve(&app, &link, tls, tcp);
                    live.fetch_sub(1, Ordering::SeqCst);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(stop)
}

struct Request {
    method: String,
    path: String,
    query: String,
    host: String,
    auth: Option<String>,
    origin: bool,
    body: Vec<u8>,
}

fn read_request(stream: &mut impl Read) -> Result<Request, u16> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let n = stream.read(&mut chunk).map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return Err(431);
        }
    };
    let head = std::str::from_utf8(&buf[..head_end]).map_err(|_| 400u16)?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut req = Request {
        method,
        path: path.to_string(),
        query: query.to_string(),
        host: String::new(),
        auth: None,
        origin: false,
        body: Vec::new(),
    };
    let mut length = 0usize;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "host" => req.host = v.to_string(),
            "authorization" => req.auth = v.strip_prefix("Bearer ").map(str::to_string),
            "origin" => req.origin = true,
            "content-length" => length = v.parse().map_err(|_| 400u16)?,
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err(413);
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).map_err(|_| 400u16)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    req.body = body;
    Ok(req)
}

fn respond(stream: &mut impl Write, status: u16, body: &serde_json::Value) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        410 => "Gone",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let text = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.flush();
}

fn error(msg: &str) -> serde_json::Value {
    serde_json::json!({ "error": msg })
}

fn serve(
    app: &AppHandle,
    link: &PhoneLink,
    tls: Arc<rustls::ServerConfig>,
    tcp: TcpStream,
) -> Result<(), String> {
    tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(10))).ok();
    let conn = rustls::ServerConnection::new(tls).map_err(|e| e.to_string())?;
    let mut stream = rustls::StreamOwned::new(conn, tcp);
    let req = match read_request(&mut stream) {
        Ok(r) => r,
        Err(status) => {
            respond(&mut stream, status, &error("Not understood."));
            return Ok(());
        }
    };
    let (status, body) = route(app, link, req);
    respond(&mut stream, status, &body);
    stream.conn.send_close_notify();
    let _ = stream.flush();
    Ok(())
}

fn route(app: &AppHandle, link: &PhoneLink, req: Request) -> (u16, serde_json::Value) {
    {
        let inner = link.0.lock();
        if req.host != format!("{}:{PORT}", inner.host) {
            return (421, error("Wrong address."));
        }
    }
    // Only the app talks to this; a web page would have to send an Origin.
    if req.origin {
        return (403, error("Refused."));
    }
    if req.method == "POST" && req.path == "/v1/pair" {
        return pair(link, &req.body);
    }
    let Some(device) = device(link, req.auth.as_deref()) else {
        return (401, error("This phone isn't paired."));
    };
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/glance") => {
            let tz = query_value(&req.query, "tz").and_then(|v| v.parse::<i32>().ok()).unwrap_or(0);
            (200, tauri::async_runtime::block_on(glance(app, tz)))
        }
        ("POST", "/v1/fairy") => ask_fairy(&req.body),
        ("GET", "/v1/hello") => (200, serde_json::json!({ "name": short_name(&link.0.lock().host), "device": device })),
        _ => (404, error("Not here.")),
    }
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

fn short_name(host: &str) -> String {
    host.split('.').next().unwrap_or(host).to_string()
}

/// The phone a key belongs to, by its hash; stamps when it was last seen
/// (written out at most every five minutes).
fn device(link: &PhoneLink, key: Option<&str>) -> Option<String> {
    let hash = hex(&sha256(key?.as_bytes()));
    let mut inner = link.0.lock();
    let now = now_ms();
    let d = inner.saved.devices.iter_mut().find(|d| d.key_hash == hash)?;
    d.last_seen_ms = now;
    let name = d.name.clone();
    if now - inner.last_saved_seen > 5 * 60_000 {
        inner.last_saved_seen = now;
        PhoneLink::save(&mut inner);
    }
    Some(name)
}

fn pair(link: &PhoneLink, body: &[u8]) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    struct Ask {
        code: String,
        name: String,
    }
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else {
        return (400, error("Not understood."));
    };
    let mut inner = link.0.lock();
    let Some(p) = inner.pairing.as_mut() else {
        return (410, error("That pairing link has been used or has run out. Copy a new one on your Mac."));
    };
    if p.expires_ms < now_ms() || p.tries >= PAIR_TRIES {
        inner.pairing = None;
        return (410, error("That pairing link has run out. Copy a new one on your Mac."));
    }
    p.tries += 1;
    if sha256(ask.code.as_bytes()) != p.code_hash {
        return (401, error("That pairing link isn't right. Copy a new one on your Mac."));
    }
    inner.pairing = None;
    let key = random_b64(32);
    let name: String = ask.name.chars().filter(|c| !c.is_control()).take(60).collect();
    inner.saved.devices.push(Device {
        id: random_b64(9),
        name: if name.is_empty() { "iPhone".into() } else { name },
        key_hash: hex(&sha256(key.as_bytes())),
        paired_ms: now_ms(),
        last_seen_ms: now_ms(),
    });
    PhoneLink::save(&mut inner);
    let mac = short_name(&inner.host);
    (200, serde_json::json!({ "key": key, "name": mac }))
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The dates (`YYYY-MM-DD`) of this week, Monday to Sunday, on a clock `tz`
/// minutes east of UTC.
pub fn week_dates(now_ms: i64, tz: i32) -> Vec<String> {
    let days = (now_ms + tz as i64 * 60_000).div_euclid(86_400_000);
    // 1970-01-01 was a Thursday; Monday is 0 here.
    let monday = days - (days + 3).rem_euclid(7);
    (0..7)
        .map(|i| {
            let (y, m, d) = civil(monday + i);
            format!("{y:04}-{m:02}-{d:02}")
        })
        .collect()
}

/// A meeting link in an event's location (calendar.rs puts Google's
/// conference link there when the event has no place of its own).
pub fn join_link(location: &str) -> String {
    location
        .split_whitespace()
        .find(|w| w.starts_with("https://"))
        .map(|w| w.trim_end_matches([',', ';', ')']).to_string())
        .unwrap_or_default()
}

fn gmail_link(message_id: &str) -> String {
    if message_id.is_empty() {
        return "https://mail.google.com/mail/u/0/#inbox".into();
    }
    let enc: String = message_id
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("https://mail.google.com/mail/u/0/#search/rfc822msgid%3A{enc}")
}

/// What the island shows: this week's events and the newest mail.
async fn glance(app: &AppHandle, tz: i32) -> serde_json::Value {
    let cal = app.state::<crate::calendar::CalStore>();
    let local = app.state::<crate::calendar::LocalEventStore>();
    let calendar_connected = !cal.list().is_empty() || !local.list().is_empty();
    let week = week_dates(now_ms(), tz);
    let events: Vec<serde_json::Value> = if calendar_connected {
        crate::calendar::cal_events(cal, local, Some(tz))
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|e| week.contains(&e.date))
            .take(200)
            .map(|e| {
                serde_json::json!({
                    "summary": e.summary, "date": e.date, "time": e.time, "end": e.end,
                    "location": e.location, "calendar": e.calendar, "join": join_link(&e.location),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let mail_connected = crate::mail::mail_config(app.clone()).is_some();
    let (unread, messages) = if mail_connected {
        match crate::mail::mail_glance(app.clone(), 10).await {
            Ok((unread, msgs)) => (
                unread,
                msgs.into_iter()
                    .map(|m| {
                        serde_json::json!({
                            "from": m.from, "subject": m.subject, "date_ms": m.date_ms,
                            "unread": m.unread, "link": gmail_link(&m.message_id),
                        })
                    })
                    .collect::<Vec<_>>(),
            ),
            Err(e) => {
                tracing::warn!(target: "flux::phonelink", "mail glance failed: {e}");
                (0, Vec::new())
            }
        }
    } else {
        (0, Vec::new())
    };
    let fairy = crate::fairy::fairy_status().await;
    serde_json::json!({
        "at": now_ms(),
        "calendar": { "connected": calendar_connected },
        "events": events,
        "mail": { "connected": mail_connected, "unread": unread, "messages": messages },
        "fairy": { "installed": fairy.installed, "name": fairy.name.unwrap_or_else(|| "Fairy".into()) },
    })
}

fn ask_fairy(body: &[u8]) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        url: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        text: String,
    }
    #[derive(Deserialize)]
    struct Ask {
        question: String,
        page: Page,
    }
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else {
        return (400, error("Not understood."));
    };
    let page = crate::fairy::page_context(false, false, &ask.page.title, &ask.page.url, Some((&ask.page.url, &ask.page.text)));
    match crate::fairy::ask_plain(&ask.question, page) {
        Ok(answer) => (200, serde_json::json!({ "answer": answer, "sources": [] })),
        Err(e) => (502, error(&e)),
    }
}

// ── Commands for Settings › Phone link ──────────────────────────────────────

#[tauri::command]
pub fn phonelink_state(link: State<'_, PhoneLink>) -> PhoneLinkState {
    PhoneLink::state(&link.0.lock())
}

#[tauri::command]
pub async fn phonelink_set_enabled(app: AppHandle, link: State<'_, PhoneLink>, on: bool) -> Result<PhoneLinkState, String> {
    {
        let mut inner = link.0.lock();
        inner.saved.enabled = on;
        PhoneLink::save(&mut inner);
    }
    let link = link.inner().clone();
    #[cfg(target_os = "macos")]
    {
        let l = link.clone();
        tauri::async_runtime::spawn_blocking(move || refresh(&app, &l)).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        link.0.lock().problem = "The phone link runs on macOS.".into();
    }
    let inner = link.0.lock();
    Ok(PhoneLink::state(&inner))
}

/// A one-time pairing link for a phone: five minutes, five tries.
#[tauri::command]
pub fn phonelink_pair(link: State<'_, PhoneLink>) -> Result<String, String> {
    let mut inner = link.0.lock();
    if inner.server.is_none() {
        return Err("Turn on the phone link first, with Tailscale on.".into());
    }
    let cert = base64::engine::general_purpose::STANDARD
        .decode(&inner.saved.cert)
        .map_err(|e| e.to_string())?;
    let code = random_b64(16);
    inner.pairing = Some(Pairing {
        code_hash: sha256(code.as_bytes()),
        expires_ms: now_ms() + PAIR_LIFETIME_MS,
        tries: 0,
    });
    Ok(format!(
        "flux-browser://pair?host={}&port={PORT}&code={code}&pin={}",
        inner.host,
        hex(&sha256(&cert))
    ))
}

#[tauri::command]
pub fn phonelink_forget(link: State<'_, PhoneLink>, id: String) -> PhoneLinkState {
    let mut inner = link.0.lock();
    inner.saved.devices.retain(|d| d.id != id);
    PhoneLink::save(&mut inner);
    PhoneLink::state(&inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tailscale_addresses_count() {
        assert!(is_tailscale("100.64.0.1".parse().unwrap()));
        assert!(is_tailscale("100.127.255.254".parse().unwrap()));
        assert!(!is_tailscale("100.63.0.1".parse().unwrap()));
        assert!(!is_tailscale("100.128.0.1".parse().unwrap()));
        assert!(!is_tailscale("192.168.1.10".parse().unwrap()));
        assert!(is_tailscale("::ffff:100.100.1.2".parse().unwrap()));
        assert!(!is_tailscale("fd7a:115c:a1e0::1".parse().unwrap()));
    }

    #[test]
    fn week_runs_monday_to_sunday() {
        // Saturday 14 November 2026, 09:30 UTC.
        let sat = 1_794_648_600_000;
        let w = week_dates(sat, 0);
        assert_eq!(w.first().unwrap(), "2026-11-09");
        assert_eq!(w.last().unwrap(), "2026-11-15");
        // Late Sunday in UTC is already Monday in Sydney: the next week.
        let sun_late = 1_794_779_000_000; // 2026-11-15 22:23 UTC
        assert_eq!(week_dates(sun_late, 11 * 60).first().unwrap(), "2026-11-16");
    }

    #[test]
    fn finds_a_meeting_link() {
        assert_eq!(join_link("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
        assert_eq!(join_link("Room 4, https://zoom.us/j/123;"), "https://zoom.us/j/123");
        assert_eq!(join_link("Room 4"), "");
    }

    #[test]
    fn gmail_links_find_the_message() {
        assert_eq!(
            gmail_link("CAF=x+y@mail.gmail.com"),
            "https://mail.google.com/mail/u/0/#search/rfc822msgid%3ACAF%3Dx%2By%40mail.gmail.com"
        );
    }

    #[test]
    fn reads_a_request() {
        let raw = b"POST /v1/pair?x=1 HTTP/1.1\r\nHost: mac.tail.ts.net:47617\r\nAuthorization: Bearer abc\r\nContent-Length: 5\r\n\r\nhello";
        let req = read_request(&mut &raw[..]).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/v1/pair");
        assert_eq!(req.query, "x=1");
        assert_eq!(req.host, "mac.tail.ts.net:47617");
        assert_eq!(req.auth.as_deref(), Some("abc"));
        assert!(!req.origin);
        assert_eq!(req.body, b"hello");
    }
}
