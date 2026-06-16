//! Favicons (BACKLOG #21). Fetches each site's icon **directly from the site**
//! (never a third-party favicon service) and **without cookies** (a plain
//! `<img>` request would carry them), caching per host on disk as a `data:` URL.
//! Privacy-aligned: the site already knows you visited it, and nothing leaks to
//! anyone else. Falls back to the letter glyph when a site has no usable icon.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use dashmap::DashMap;
use tauri::State;

/// host → Some(data-url) on success, None when known-missing (this session).
#[derive(Default)]
pub struct FaviconCache {
    mem: DashMap<String, Option<String>>,
    dir: Option<PathBuf>,
}

impl FaviconCache {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { mem: DashMap::new(), dir }
    }
}

fn sanitize(host: &str) -> String {
    host.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect()
}

#[tauri::command]
pub async fn favicon(cache: State<'_, FaviconCache>, host: String) -> Result<Option<String>, String> {
    let host = host.trim().trim_start_matches("www.").to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || !host.contains('.') {
        return Ok(None);
    }
    if let Some(v) = cache.mem.get(&host) {
        return Ok(v.clone());
    }
    // Disk cache (successes only).
    if let Some(dir) = &cache.dir {
        if let Ok(data) = std::fs::read_to_string(dir.join(format!("{}.txt", sanitize(&host)))) {
            if !data.is_empty() {
                cache.mem.insert(host.clone(), Some(data.clone()));
                return Ok(Some(data));
            }
        }
    }

    let h = host.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || try_fetch(&h)).await.unwrap_or(None);
    cache.mem.insert(host.clone(), fetched.clone());
    if let (Some(dir), Some(data)) = (&cache.dir, &fetched) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join(format!("{}.txt", sanitize(&host))), data);
    }
    Ok(fetched)
}

/// `/favicon.ico`, then the root page's declared `<link rel="…icon">`.
fn try_fetch(host: &str) -> Option<String> {
    if let Some(d) = fetch_icon(&format!("https://{host}/favicon.ico")) {
        return Some(d);
    }
    if let Some(href) = root_icon_href(host) {
        if let Some(d) = fetch_icon(&resolve(host, &href)) {
            return Some(d);
        }
    }
    None
}

fn fetch_icon(url: &str) -> Option<String> {
    let resp = ureq::get(url).timeout(Duration::from_secs(5)).call().ok()?;
    if resp.status() != 200 {
        return None;
    }
    let ct = resp.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let mut buf = Vec::new();
    resp.into_reader().take(256 * 1024).read_to_end(&mut buf).ok()?;
    let mime = image_mime(&buf, &ct)?; // rejects soft-404 HTML served as 200
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf)))
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
    let head = std::str::from_utf8(&buf[..buf.len().min(256)]).unwrap_or("").trim_start().to_ascii_lowercase();
    if head.starts_with("<svg") || head.starts_with("<?xml") {
        return Some("image/svg+xml".into());
    }
    if ct.starts_with("image/") && !head.starts_with("<!") && !head.starts_with("<html") {
        return Some(ct.to_string());
    }
    None
}

fn root_icon_href(host: &str) -> Option<String> {
    let html = ureq::get(&format!("https://{host}/")).timeout(Duration::from_secs(5)).call().ok()?.into_string().ok()?;
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
        let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
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
        assert_eq!(image_mime(&[0, 0, 1, 0, 5], "").as_deref(), Some("image/x-icon"));
        assert_eq!(image_mime(&[0x89, b'P', b'N', b'G', 1], "").as_deref(), Some("image/png"));
        assert_eq!(image_mime(b"<!doctype html><html>", "text/html"), None);
        assert_eq!(image_mime(b"<svg xmlns=...", ""), Some("image/svg+xml".into()));
    }

    #[test]
    fn attr_parses_quoted_and_bare() {
        assert_eq!(attr(r#"link rel="icon" href="/a.png""#, "href").as_deref(), Some("/a.png"));
        assert_eq!(attr("link rel=icon href=/b.ico>", "href").as_deref(), Some("/b.ico"));
        assert_eq!(attr(r#"link rel='shortcut icon' href='//cdn/x.png'"#, "href").as_deref(), Some("//cdn/x.png"));
    }

    #[test]
    fn resolve_forms_absolute_urls() {
        assert_eq!(resolve("x.com", "/a.png"), "https://x.com/a.png");
        assert_eq!(resolve("x.com", "//cdn/a.png"), "https://cdn/a.png");
        assert_eq!(resolve("x.com", "https://y/a.png"), "https://y/a.png");
        assert_eq!(resolve("x.com", "a.png"), "https://x.com/a.png");
    }
}
