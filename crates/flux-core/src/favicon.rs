//! Favicons (BACKLOG #21). Fetches each site's icon **directly from the site**
//! (never a third-party favicon service) and **without cookies** (a plain
//! `<img>` request would carry them), caching per host on disk as a `data:` URL.
//! Privacy-aligned: the site already knows you visited it, and nothing leaks to
//! anyone else. Falls back to the letter glyph when a site has no usable icon.

use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use tauri::State;

use crate::cache::TtlCache;

/// Hosts kept in memory. Each icon can be a ~350 KB data URL and a page can
/// mint hosts at will (navigating itself through fresh subdomains), so this is
/// bounded. The shell keeps its own copy per host; an evicted host falls back
/// to the disk cache.
const MEM_CAP: usize = 128;
/// How long a host stays in memory, so a known-missing icon is retried.
const MEM_TTL: Duration = Duration::from_secs(6 * 3600);
/// Icons kept on disk, oldest dropped first.
const DISK_CAP: usize = 2000;

/// host → Some(data-url) on success, None when known-missing.
pub struct FaviconCache {
    mem: TtlCache<String, Option<String>>,
    dir: Option<PathBuf>,
}

impl FaviconCache {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            mem: TtlCache::new(MEM_CAP, Some(MEM_TTL)),
            dir,
        }
    }
}

fn sanitize(host: &str) -> String {
    host.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
pub async fn favicon(
    cache: State<'_, FaviconCache>,
    host: String,
) -> Result<Option<String>, String> {
    let host = host.trim().trim_start_matches("www.").to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || !host.contains('.') {
        return Ok(None);
    }
    if let Some(v) = cache.mem.get(&host) {
        return Ok(v);
    }
    // Disk cache (successes only). Skip stale `data:image/x-icon` entries written
    // before the ICO→PNG transcode landed — they don't render on WebKitGTK, so
    // ignoring them forces a fresh fetch (which now transcodes + rewrites cache).
    if let Some(dir) = &cache.dir {
        if let Ok(data) = std::fs::read_to_string(dir.join(format!("{}.txt", sanitize(&host)))) {
            if !data.is_empty() && !data.starts_with("data:image/x-icon") {
                cache.mem.insert(host.clone(), Some(data.clone()));
                return Ok(Some(data));
            }
        }
    }

    let h = host.clone();
    let dir = cache.dir.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let data = try_fetch(&icon_agent(&h), &h)?;
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(format!("{}.txt", sanitize(&h))), &data);
            prune_disk(&dir, DISK_CAP);
        }
        Some(data)
    })
    .await
    .unwrap_or(None);
    cache.mem.insert(host, fetched.clone());
    Ok(fetched)
}

/// Keep at most `cap` icons on disk, dropping the oldest-written. Trims to 90%
/// so the next writes don't each re-stat the whole folder.
fn prune_disk(dir: &Path, cap: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    if paths.len() <= cap {
        return;
    }
    let mut dated: Vec<_> = paths
        .into_iter()
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    dated.sort_by_key(|(t, _)| *t);
    let excess = dated.len().saturating_sub(cap * 9 / 10);
    for (_, p) in dated.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

/// Agent for one host's icon fetch. The icon URL is page-chosen (`<link
/// rel=icon href>`) and redirects can go anywhere, so every connection, each
/// redirect hop included, is checked when it resolves: see [`icon_addrs`].
fn icon_agent(host: &str) -> ureq::Agent {
    // The browsed host may be an intranet site. Look it up once and pin it, so
    // a second (rebinding) answer can't move it inward mid-fetch.
    let pinned = (host, 443)
        .to_socket_addrs()
        .map(|it| pin(it.map(|a| a.ip())))
        .unwrap_or_default();
    let host = host.to_string();
    ureq::AgentBuilder::new()
        .resolver(move |netloc: &str| icon_addrs(netloc, &host, &pinned))
        .build()
}

/// The browsed host's addresses, as resolved once. A genuine intranet host
/// resolves only inward; one that mixes public and inward answers keeps only
/// the public ones, or a crafted answer could put a loopback address beside
/// the server that sends the redirect.
fn pin(addrs: impl Iterator<Item = IpAddr>) -> Vec<IpAddr> {
    let mut v: Vec<IpAddr> = addrs.collect();
    if v.iter().any(|ip| is_public(*ip)) {
        v.retain(|ip| is_public(*ip));
    }
    v
}

/// Where an icon request to `netloc` (`name:port`) may connect: the browsed
/// `host` goes to its `pinned` addresses (it may be on the LAN, like the tab
/// showing it); any other host only to public addresses. Otherwise a visited
/// site could point its icon, or a redirect, at the router or a local service.
fn icon_addrs(netloc: &str, host: &str, pinned: &[IpAddr]) -> std::io::Result<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = match netloc.rsplit_once(':') {
        Some((name, port)) if name.eq_ignore_ascii_case(host) => {
            let port = port
                .parse()
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            pinned.iter().map(|ip| SocketAddr::new(*ip, port)).collect()
        }
        _ => netloc
            .to_socket_addrs()?
            .filter(|a| is_public(a.ip()))
            .collect(),
    };
    if addrs.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "icon host has no public address",
        ));
    }
    Ok(addrs)
}

/// Not loopback, private (RFC 1918 / unique-local), link-local, CGNAT,
/// unspecified or broadcast.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)) // CGNAT 100.64/10
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public(IpAddr::V4(v4)),
            None => {
                let s0 = v6.segments()[0];
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || (s0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
                    || (s0 & 0xffc0) == 0xfe80) // link-local fe80::/10
            }
        },
    }
}

/// `/favicon.ico`, then the root page's declared `<link rel="…icon">`.
fn try_fetch(agent: &ureq::Agent, host: &str) -> Option<String> {
    if let Some(d) = fetch_icon(agent, &format!("https://{host}/favicon.ico")) {
        return Some(d);
    }
    if let Some(href) = root_icon_href(agent, host) {
        if let Some(d) = fetch_icon(agent, &resolve(host, &href)) {
            return Some(d);
        }
    }
    None
}

/// A browser-ish UA — some sites (Cloudflare-fronted, etc.) serve a challenge
/// page or 403 to non-browser agents, which would fail icon detection.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

fn fetch_icon(agent: &ureq::Agent, url: &str) -> Option<String> {
    let resp = agent
        .get(url)
        .set("User-Agent", UA)
        .set(
            "Accept",
            "image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8",
        )
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?;
    if resp.status() != 200 {
        return None;
    }
    let ct = resp
        .header("content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut buf = Vec::new();
    resp.into_reader()
        .take(256 * 1024)
        .read_to_end(&mut buf)
        .ok()?;
    let mut mime = image_mime(&buf, &ct)?; // rejects soft-404 HTML served as 200
                                           // WebKitGTK (the Linux engine) doesn't render `data:image/x-icon` in <img>,
                                           // so transcode ICO → PNG; every engine renders PNG. Other formats pass through.
    if mime == "image/x-icon" {
        if let Some(png) = ico_to_png(&buf) {
            buf = png;
            mime = "image/png".into();
        }
    }
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/// Decode an ICO and re-encode the (largest) frame as PNG. `None` if the bytes
/// don't decode as an ICO — caller then falls back to the raw ICO bytes.
fn ico_to_png(buf: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(buf, image::ImageFormat::Ico).ok()?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// Identify the image type by magic bytes (falling back to a sane content-type),
/// or `None` if the bytes aren't a recognized image — which filters out HTML
/// error pages some sites return for `/favicon.ico` with a 200.
fn image_mime(buf: &[u8], ct: &str) -> Option<String> {
    if buf.len() < 4 {
        return None;
    }
    if buf.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon".into());
    }
    if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png".into());
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif".into());
    }
    if buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg".into());
    }
    if buf.starts_with(b"RIFF") && buf.len() > 12 && &buf[8..12] == b"WEBP" {
        return Some("image/webp".into());
    }
    let head = std::str::from_utf8(&buf[..buf.len().min(256)])
        .unwrap_or("")
        .trim_start()
        .to_ascii_lowercase();
    if head.starts_with("<svg") || head.starts_with("<?xml") {
        return Some("image/svg+xml".into());
    }
    if ct.starts_with("image/") && !head.starts_with("<!") && !head.starts_with("<html") {
        return Some(ct.to_string());
    }
    None
}

fn root_icon_href(agent: &ureq::Agent, host: &str) -> Option<String> {
    let html = agent
        .get(&format!("https://{host}/"))
        .set("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?
        .into_string()
        .ok()?;
    // Scan <link …> tags; take the first that mentions "icon" and has an href.
    for tag in html.split('<') {
        let lower = tag.to_ascii_lowercase();
        if !lower.trim_start().starts_with("link") || !lower.contains("icon") {
            continue;
        }
        if let Some(href) = attr(tag, "href") {
            if !href.trim().is_empty() {
                return Some(href);
            }
        }
    }
    None
}

/// Extract an HTML attribute value (quoted or bare). Best-effort for `<link>`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let i = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = tag.get(i..)?.trim_start();
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    if bytes[0] == b'"' || bytes[0] == b'\'' {
        let q = bytes[0] as char;
        let end = rest[1..].find(q)? + 1;
        Some(rest[1..end].trim().to_string())
    } else {
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(rest.len());
        Some(rest[..end].trim_end_matches('/').trim().to_string())
    }
}

fn resolve(host: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else if href.starts_with('/') {
        format!("https://{host}{href}")
    } else {
        format!("https://{host}/{href}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_detects_images_and_rejects_html() {
        assert_eq!(
            image_mime(&[0, 0, 1, 0, 5], "").as_deref(),
            Some("image/x-icon")
        );
        assert_eq!(
            image_mime(&[0x89, b'P', b'N', b'G', 1], "").as_deref(),
            Some("image/png")
        );
        assert_eq!(image_mime(b"<!doctype html><html>", "text/html"), None);
        assert_eq!(
            image_mime(b"<svg xmlns=...", ""),
            Some("image/svg+xml".into())
        );
    }

    #[test]
    fn attr_parses_quoted_and_bare() {
        assert_eq!(
            attr(r#"link rel="icon" href="/a.png""#, "href").as_deref(),
            Some("/a.png")
        );
        assert_eq!(
            attr("link rel=icon href=/b.ico>", "href").as_deref(),
            Some("/b.ico")
        );
        assert_eq!(
            attr(r#"link rel='shortcut icon' href='//cdn/x.png'"#, "href").as_deref(),
            Some("//cdn/x.png")
        );
    }

    #[test]
    fn only_public_addresses_count_as_public() {
        for ip in ["93.184.216.34", "2606:2800:220:1::1", "::ffff:93.184.216.34"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn page_chosen_icon_urls_cannot_reach_the_lan() {
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        // Another host (an icon href, a redirect hop) on loopback or the LAN.
        for netloc in ["127.0.0.1:8080", "192.168.1.1:80", "[::1]:443", "169.254.169.254:80"] {
            let err = icon_addrs(netloc, "example.com", &[public]).unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{netloc}");
        }
        assert!(icon_addrs("93.184.216.34:443", "example.com", &[public]).is_ok());
        // The browsed host keeps its pinned addresses, an intranet one too, on any port.
        let lan: IpAddr = "10.0.0.5".parse().unwrap();
        let got = icon_addrs("wiki.corp.example:8080", "wiki.corp.example", &[lan]).unwrap();
        assert_eq!(got, vec![SocketAddr::new(lan, 8080)]);
        // Pinned means no second lookup: a host that resolved to nothing stays unreachable.
        assert!(icon_addrs("example.com:443", "example.com", &[]).is_err());

        // A host answering both public and loopback keeps only the public address.
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(pin([loopback, public].into_iter()), vec![public]);
        assert_eq!(pin([lan].into_iter()), vec![lan]);
    }

    #[test]
    fn disk_cache_is_pruned_oldest_first() {
        let dir = std::env::temp_dir().join(format!("flux-favicon-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t0 = std::time::SystemTime::now() - Duration::from_secs(3600);
        for i in 0..12u64 {
            let f = std::fs::File::create(dir.join(format!("h{i}.txt"))).unwrap();
            f.set_modified(t0 + Duration::from_secs(i)).unwrap();
        }
        prune_disk(&dir, 20);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 12, "under the cap");

        prune_disk(&dir, 10);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 9);
        for gone in ["h0.txt", "h1.txt", "h2.txt"] {
            assert!(!dir.join(gone).exists(), "{gone} is among the oldest");
        }
        assert!(dir.join("h3.txt").exists() && dir.join("h11.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_forms_absolute_urls() {
        assert_eq!(resolve("x.com", "/a.png"), "https://x.com/a.png");
        assert_eq!(resolve("x.com", "//cdn/a.png"), "https://cdn/a.png");
        assert_eq!(resolve("x.com", "https://y/a.png"), "https://y/a.png");
        assert_eq!(resolve("x.com", "a.png"), "https://x.com/a.png");
    }
}
