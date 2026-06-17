//! PDF fetch for the built-in viewer (BACKLOG #35).
//!
//! The viewer is PDF.js running in a Flux internal page (`flux://pdf`). Rather
//! than let the page fetch the PDF itself — cross-origin PDFs almost never send
//! CORS headers, so the engine would block it — the Rust core fetches the bytes
//! (http(s)) or reads them from disk (local files) and hands them back
//! base64-encoded. Capped so a pathological file can't exhaust memory.

use std::io::Read;
use std::time::Duration;

use base64::Engine as _;

/// Largest PDF we'll load into the viewer; bigger → the UI offers "download" instead.
const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;

/// Fetch a PDF and return it base64-encoded. Accepts an http(s) URL, a `file://`
/// URL, or a bare filesystem path (e.g. a downloaded file).
#[tauri::command]
pub async fn pdf_fetch(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch(url: &str) -> Result<String, String> {
    let buf = if url.starts_with("http://") || url.starts_with("https://") {
        fetch_http(url)?
    } else {
        fetch_file(url)?
    };
    if buf.is_empty() {
        return Err("empty response".into());
    }
    if buf.len() > MAX_PDF_BYTES {
        return Err(format!("PDF too large (> {} MB)", MAX_PDF_BYTES / 1024 / 1024));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

fn fetch_http(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", "Mozilla/5.0")
        .call()
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take((MAX_PDF_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn fetch_file(url: &str) -> Result<Vec<u8>, String> {
    std::fs::read(file_url_to_path(url)).map_err(|e| e.to_string())
}

/// Best-effort `file://` URL (or bare path) → filesystem path. Handles
/// `file://localhost/…`, the Windows `file:///C:/…` leading-slash quirk, and
/// `%20` spaces. Not a full RFC-8089 parser — enough for opening local PDFs.
fn file_url_to_path(url: &str) -> String {
    let mut p = url.to_string();
    if let Some(rest) = p.strip_prefix("file://") {
        p = rest.strip_prefix("localhost").unwrap_or(rest).to_string();
    }
    // `/C:/…` → `C:/…` (Windows drive paths).
    let b = p.as_bytes();
    if b.len() > 2 && b[0] == b'/' && b[2] == b':' {
        p.remove(0);
    }
    p.replace("%20", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_parsing() {
        assert_eq!(file_url_to_path("file:///home/u/a.pdf"), "/home/u/a.pdf");
        assert_eq!(file_url_to_path("file://localhost/home/u/a.pdf"), "/home/u/a.pdf");
        assert_eq!(file_url_to_path("file:///C:/docs/a.pdf"), "C:/docs/a.pdf");
        assert_eq!(file_url_to_path("file:///home/u/my%20file.pdf"), "/home/u/my file.pdf");
        assert_eq!(file_url_to_path("/plain/path.pdf"), "/plain/path.pdf");
    }
}
