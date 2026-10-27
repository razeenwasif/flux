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
    /// The new tab's tile icons ([`site_icon`]), kept apart: a host has both.
    tiles: TtlCache<String, Option<String>>,
    dir: Option<PathBuf>,
}

impl FaviconCache {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            mem: TtlCache::new(MEM_CAP, Some(MEM_TTL)),
            tiles: TtlCache::new(MEM_CAP, Some(MEM_TTL)),
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
    proxy: State<'_, crate::proxy::ProxyState>,
    host: String,
) -> Result<Option<String>, String> {
    Ok(lookup(&cache.mem, cache.dir.clone(), &proxy, host, try_fetch).await)
}

/// A site's icon for the new tab's shortcuts and top sites: the biggest one it
/// offers (its touch icon, or the largest it declares), which a tab's 16–32 px
/// favicon would blur at tile size. Same fetch rules as [`favicon`]: from the
/// site itself, without cookies, through the user's proxy.
#[tauri::command]
pub async fn site_icon(
    cache: State<'_, FaviconCache>,
    proxy: State<'_, crate::proxy::ProxyState>,
    host: String,
) -> Result<Option<String>, String> {
    let dir = cache.dir.as_ref().map(|d| d.join("tiles"));
    Ok(lookup(&cache.tiles, dir, &proxy, host, try_fetch_tile).await)
}

/// Memory, then disk, then the site.
async fn lookup(
    mem: &TtlCache<String, Option<String>>,
    dir: Option<PathBuf>,
    proxy: &crate::proxy::ProxyState,
    host: String,
    fetch: fn(&ureq::Agent, &str) -> Option<String>,
) -> Option<String> {
    let host = host.trim().trim_start_matches("www.").to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || !host.contains('.') {
        return None;
    }
    if let Some(v) = mem.get(&host) {
        return v;
    }
    // Disk cache (successes only). Skip stale `data:image/x-icon` entries written
    // before the ICO→PNG transcode landed — they don't render on WebKitGTK, so
    // ignoring them forces a fresh fetch (which now transcodes + rewrites cache).
    if let Some(dir) = &dir {
        if let Ok(data) = std::fs::read_to_string(dir.join(format!("{}.txt", sanitize(&host)))) {
            if !data.is_empty() && !data.starts_with("data:image/x-icon") {
                mem.insert(host.clone(), Some(data.clone()));
                return Some(data);
            }
        }
    }

    // The tabs' network path: through the user's proxy (#63) when one is set,
    // never direct, which would hand each site the address the proxy hides.
    let proxy = proxy.parsed();
    let builder = crate::proxy::agent_builder(proxy.as_ref())?;
    let proxied = proxy.is_some();
    let h = host.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let data = fetch(&icon_agent(builder, proxied, &h), &h)?;
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(format!("{}.txt", sanitize(&h))), &data);
            prune_disk(&dir, DISK_CAP);
        }
        Some(data)
    })
    .await
    .unwrap_or(None);
    mem.insert(host, fetched.clone());
    fetched
}

/// Keep at most `cap` icons on disk, dropping the oldest-written. Trims to 90%
/// so the next writes don't each re-stat the whole folder.
fn prune_disk(dir: &Path, cap: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // Files only: the tile icons keep their own folder in here.
    let paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
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
/// rel=icon href>`) and redirects can go anywhere, so without a proxy every
/// connection, each redirect hop included, is checked when it resolves: see
/// [`icon_addrs`].
fn icon_agent(builder: ureq::AgentBuilder, proxied: bool, host: &str) -> ureq::Agent {
    // Through a proxy, every connection is to the proxy, which resolves names
    // itself: a lookup here would leak them.
    if proxied {
        return builder.build();
    }
    // The browsed host may be an intranet site. Look it up once and pin it, so
    // a second (rebinding) answer can't move it inward mid-fetch.
    let pinned = (host, 443)
        .to_socket_addrs()
        .map(|it| pin(it.map(|a| a.ip())))
        .unwrap_or_default();
    let host = host.to_string();
    builder
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

/// Tile icons: an icon whose shorter side reaches this is taken at once.
const TILE_GOOD: u32 = 120;
/// Bigger than this is scaled down: a tile shows it at 48 points at most.
const TILE_MAX: u32 = 128;
/// Icons tried per site before settling for the biggest seen.
const TILE_TRIES: usize = 6;

/// The biggest icon the site offers, by [`tile_candidates`]' order: the first
/// that's big enough, else the biggest of the ones tried.
fn try_fetch_tile(agent: &ureq::Agent, host: &str) -> Option<String> {
    let html = root_html(agent, host);
    let mut best: Option<(u32, Vec<u8>, String)> = None;
    for url in tile_candidates(host, html.as_deref().unwrap_or(""))
        .into_iter()
        .take(TILE_TRIES)
    {
        let Some((buf, mime)) = fetch_image(agent, &url) else {
            continue;
        };
        let side = side(&buf, &mime);
        let good = side >= TILE_GOOD;
        if best.as_ref().is_none_or(|b| side > b.0) {
            best = Some((side, buf, mime));
        }
        if good {
            break;
        }
    }
    let (side, buf, mime) = best?;
    let (buf, mime) = if mime == "image/png" && side != u32::MAX && side > TILE_MAX {
        shrink(&buf).map_or((buf, mime), |png| (png, "image/png".into()))
    } else {
        (buf, mime)
    };
    Some(data_url(&buf, &mime))
}

/// One `<link>` icon a page declares.
#[derive(Debug, PartialEq)]
struct IconLink {
    href: String,
    /// apple-touch-icon / fluid-icon: made for a home screen, square and opaque.
    touch: bool,
    svg: bool,
    /// Its declared `sizes` (the largest), 0 when it gives none.
    size: u32,
}

/// The icons a page's `<link>` tags declare, leaving out Safari's monochrome
/// `mask-icon`.
fn icon_links(html: &str) -> Vec<IconLink> {
    let mut out = Vec::new();
    for tag in html.split('<') {
        if !tag.get(..4).is_some_and(|t| t.eq_ignore_ascii_case("link")) {
            continue;
        }
        let (Some(rel), Some(href)) = (attr(tag, "rel"), attr(tag, "href")) else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let rels: Vec<&str> = rel.split_ascii_whitespace().collect();
        let touch = rels.iter().any(|r| {
            matches!(
                *r,
                "apple-touch-icon" | "apple-touch-icon-precomposed" | "fluid-icon"
            )
        });
        if href.trim().is_empty() || !(touch || rels.contains(&"icon")) {
            continue;
        }
        let size = attr(tag, "sizes")
            .unwrap_or_default()
            .split_ascii_whitespace()
            .filter_map(|s| {
                let (w, h) = s
                    .to_ascii_lowercase()
                    .split_once('x')
                    .map(|(w, h)| (w.to_string(), h.to_string()))?;
                Some(w.parse::<u32>().ok()?.min(h.parse().ok()?))
            })
            .max()
            .unwrap_or(0);
        let svg = attr(tag, "type").is_some_and(|t| t.eq_ignore_ascii_case("image/svg+xml"))
            || href
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .ends_with(".svg");
        out.push(IconLink {
            href,
            touch,
            svg,
            size,
        });
    }
    out
}

/// Where to look for a tile icon, best first: the touch icons a page declares,
/// the sized icons it declares (largest first), the conventional
/// `/apple-touch-icon.png`, an SVG icon, then whatever else is left.
fn tile_candidates(host: &str, html: &str) -> Vec<String> {
    let mut links = icon_links(html);
    // Stable: the page's own order breaks ties.
    links.sort_by_key(|l| std::cmp::Reverse(l.size));
    let mut out: Vec<String> = Vec::new();
    let mut add = |url: String| {
        if !out.contains(&url) {
            out.push(url);
        }
    };
    for l in links.iter().filter(|l| l.touch) {
        add(resolve(host, &l.href));
    }
    for l in links.iter().filter(|l| !l.touch && !l.svg && l.size >= 64) {
        add(resolve(host, &l.href));
    }
    add(format!("https://{host}/apple-touch-icon.png"));
    for l in links.iter().filter(|l| l.svg) {
        add(resolve(host, &l.href));
    }
    for l in links.iter().filter(|l| !l.touch && !l.svg && l.size < 64) {
        add(resolve(host, &l.href));
    }
    add(format!("https://{host}/favicon.ico"));
    out
}

/// An image's shorter side in pixels, read from its header; `u32::MAX` for SVG
/// (it scales), 0 when it can't be read.
fn side(buf: &[u8], mime: &str) -> u32 {
    let be16 = |i: usize| {
        buf.get(i..i + 2)
            .map_or(0, |b| u16::from_be_bytes([b[0], b[1]]) as u32)
    };
    let le16 = |i: usize| {
        buf.get(i..i + 2)
            .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]) as u32)
    };
    let be32 = |i: usize| {
        buf.get(i..i + 4)
            .map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let le24 = |i: usize| {
        buf.get(i..i + 3)
            .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], 0]))
    };
    match mime {
        "image/svg+xml" => u32::MAX,
        "image/png" => be32(16).min(be32(20)),
        "image/gif" => le16(6).min(le16(8)),
        // The largest of its images; a 0 byte means 256.
        "image/x-icon" => (0..le16(4) as usize)
            .filter_map(|i| {
                let e = buf.get(6 + 16 * i..8 + 16 * i)?;
                let px = |b: u8| if b == 0 { 256 } else { b as u32 };
                Some(px(e[0]).min(px(e[1])))
            })
            .max()
            .unwrap_or(0),
        // The frame header (SOF0–SOF15, less the non-frame markers among them).
        "image/jpeg" => {
            let mut i = 2;
            while i + 9 <= buf.len() && buf[i] == 0xFF {
                let m = buf[i + 1];
                if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
                    return be16(i + 5).min(be16(i + 7));
                }
                i += 2 + be16(i + 2) as usize;
            }
            0
        }
        "image/webp" => match buf.get(12..16) {
            Some(b"VP8 ") => (le16(26) & 0x3fff).min(le16(28) & 0x3fff),
            Some(b"VP8L") => {
                let Some(b) = buf.get(21..25) else { return 0 };
                let w = 1 + (b[0] as u32 | (b[1] as u32 & 0x3f) << 8);
                let h = 1 + (b[1] as u32 >> 6 | (b[2] as u32) << 2 | (b[3] as u32 & 0xf) << 10);
                w.min(h)
            }
            Some(b"VP8X") => (1 + le24(24)).min(1 + le24(27)),
            _ => 0,
        },
        _ => 0,
    }
}

/// A big PNG scaled to fit [`TILE_MAX`]: a 512 px icon is a 20–50 KB data URL
/// held in memory per site, for a tile that shows it at 48 points.
fn shrink(buf: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(buf, image::ImageFormat::Png).ok()?;
    let img = img.resize(TILE_MAX, TILE_MAX, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

fn data_url(buf: &[u8], mime: &str) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf)
    )
}

fn fetch_icon(agent: &ureq::Agent, url: &str) -> Option<String> {
    let (buf, mime) = fetch_image(agent, url)?;
    Some(data_url(&buf, &mime))
}

/// An image's bytes and type, ICOs as PNG.
fn fetch_image(agent: &ureq::Agent, url: &str) -> Option<(Vec<u8>, String)> {
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
    // Rejects soft-404 HTML served as 200.
    let mut mime = image_mime(&buf, &ct)?;
    // WebKitGTK (the Linux engine) doesn't render `data:image/x-icon` in <img>,
    // so transcode ICO → PNG; every engine renders PNG. Other formats pass through.
    if mime == "image/x-icon" {
        if let Some(png) = ico_to_png(&buf) {
            buf = png;
            mime = "image/png".into();
        }
    }
    Some((buf, mime))
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

/// The first icon the site's front page declares.
fn root_icon_href(agent: &ureq::Agent, host: &str) -> Option<String> {
    icon_links(&root_html(agent, host)?)
        .into_iter()
        .next()
        .map(|l| l.href)
}

fn root_html(agent: &ureq::Agent, host: &str) -> Option<String> {
    agent
        .get(&format!("https://{host}/"))
        .set("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?
        .into_string()
        .ok()
}

/// Extract an HTML attribute value (quoted or bare). Best-effort for `<link>`:
/// the name has to start an attribute, so `href` isn't read from `data-href`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let i = lower
        .match_indices(&key)
        .map(|(i, _)| i)
        .find(|&i| i == 0 || lower.as_bytes()[i - 1].is_ascii_whitespace())?
        + key.len();
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
        for ip in [
            "93.184.216.34",
            "2606:2800:220:1::1",
            "::ffff:93.184.216.34",
        ] {
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
        for netloc in [
            "127.0.0.1:8080",
            "192.168.1.1:80",
            "[::1]:443",
            "169.254.169.254:80",
        ] {
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
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            12,
            "under the cap"
        );

        prune_disk(&dir, 10);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 9);
        for gone in ["h0.txt", "h1.txt", "h2.txt"] {
            assert!(!dir.join(gone).exists(), "{gone} is among the oldest");
        }
        assert!(dir.join("h3.txt").exists() && dir.join("h11.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attr_needs_a_whole_attribute_name() {
        let tag = r#"link data-href="/wrong.png" rel="icon" href="/right.png""#;
        assert_eq!(attr(tag, "href").as_deref(), Some("/right.png"));
        assert_eq!(attr(r#"link data-rel="x""#, "rel"), None);
    }

    /// The `<head>` of GitHub's front page, as it declares its icons.
    const GITHUB: &str = r##"<head>
      <link rel="fluid-icon" href="https://github.com/fluidicon.png" title="GitHub">
      <link rel="mask-icon" href="https://github.githubassets.com/assets/pinned-octocat.svg" color="#000000">
      <link rel="alternate icon" class="js-site-favicon" type="image/png" href="https://github.githubassets.com/favicons/favicon.png">
      <link rel="icon" class="js-site-favicon" type="image/svg+xml" href="https://github.githubassets.com/favicons/favicon.svg" data-base-href="x">
      <link rel="stylesheet" href="/a.css">"##;

    #[test]
    fn icon_links_skip_mask_icons_and_stylesheets() {
        let links = icon_links(GITHUB);
        let hrefs: Vec<&str> = links.iter().map(|l| l.href.as_str()).collect();
        assert_eq!(
            hrefs,
            [
                "https://github.com/fluidicon.png",
                "https://github.githubassets.com/favicons/favicon.png",
                "https://github.githubassets.com/favicons/favicon.svg",
            ]
        );
        assert!(links[0].touch && !links[1].touch && links[2].svg);

        let sized = icon_links(
            r#"<LINK REL="icon" sizes="16x16 32x32" href="a.png"><link rel=apple-touch-icon sizes=192x192 href=/t.png>"#,
        );
        assert_eq!((sized[0].size, sized[0].touch), (32, false));
        assert_eq!((sized[1].size, sized[1].touch), (192, true));
    }

    #[test]
    fn tile_candidates_go_biggest_and_squarest_first() {
        // YouTube: the sized icons largest first, then the unsized ICO.
        let yt = r#"<link rel="shortcut icon" href="/img/favicon.ico" type="image/x-icon">
            <link rel="icon" href="/img/favicon_32x32.png" sizes="32x32">
            <link rel="icon" href="/img/favicon_144x144.png" sizes="144x144">
            <link rel="icon" href="/img/favicon_96x96.png" sizes="96x96">"#;
        assert_eq!(
            tile_candidates("youtube.com", yt),
            [
                "https://youtube.com/img/favicon_144x144.png",
                "https://youtube.com/img/favicon_96x96.png",
                "https://youtube.com/apple-touch-icon.png",
                "https://youtube.com/img/favicon_32x32.png",
                "https://youtube.com/img/favicon.ico",
                "https://youtube.com/favicon.ico",
            ]
        );
        // GitHub: the home-screen icon, then the convention, then the SVG.
        assert_eq!(
            tile_candidates("github.com", GITHUB)[..3],
            [
                "https://github.com/fluidicon.png",
                "https://github.com/apple-touch-icon.png",
                "https://github.githubassets.com/favicons/favicon.svg",
            ]
        );
        // A page that couldn't be read still gets the two conventional paths.
        assert_eq!(
            tile_candidates("x.com", ""),
            [
                "https://x.com/apple-touch-icon.png",
                "https://x.com/favicon.ico"
            ]
        );
    }

    #[test]
    fn side_reads_each_format_header() {
        let mut png = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13];
        png.extend(b"IHDR");
        png.extend(180u32.to_be_bytes());
        png.extend(120u32.to_be_bytes());
        assert_eq!(side(&png, "image/png"), 120);

        let gif = [
            b"GIF89a".as_slice(),
            &64u16.to_le_bytes(),
            &48u16.to_le_bytes(),
        ]
        .concat();
        assert_eq!(side(&gif, "image/gif"), 48);

        // Two images, 32 px and 256 px (stored as 0).
        let mut ico = vec![0, 0, 1, 0, 2, 0];
        ico.extend([32, 32].iter().chain([0u8; 14].iter()));
        ico.extend([0, 0].iter().chain([0u8; 14].iter()));
        assert_eq!(side(&ico, "image/x-icon"), 256);

        // SOI, an APP0 segment to skip, then SOF0 with 100 × 150.
        let jpeg = [
            &[0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0][..],
            &[0xFF, 0xC0, 0, 17, 8, 0, 100, 0, 150, 3],
        ]
        .concat();
        assert_eq!(side(&jpeg, "image/jpeg"), 100);

        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        vp8x.extend([0u8; 8]);
        vp8x.extend([191, 0, 0, 143, 0, 0]); // 192 × 144, each stored less one
        assert_eq!(side(&vp8x, "image/webp"), 144);

        assert_eq!(side(b"<svg/>", "image/svg+xml"), u32::MAX);
        assert_eq!(side(&[0x89, b'P'], "image/png"), 0, "too short to say");
    }

    #[test]
    fn big_pngs_shrink_to_the_tile() {
        let img = image::RgbaImage::from_pixel(512, 512, image::Rgba([255, 0, 0, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert_eq!(side(&png, "image/png"), 512);
        assert_eq!(side(&shrink(&png).unwrap(), "image/png"), TILE_MAX);
    }

    #[test]
    fn resolve_forms_absolute_urls() {
        assert_eq!(resolve("x.com", "/a.png"), "https://x.com/a.png");
        assert_eq!(resolve("x.com", "//cdn/a.png"), "https://cdn/a.png");
        assert_eq!(resolve("x.com", "https://y/a.png"), "https://y/a.png");
        assert_eq!(resolve("x.com", "a.png"), "https://x.com/a.png");
    }
}
