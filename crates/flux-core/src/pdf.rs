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

use crate::error::{FluxError, FluxResult};

/// Largest PDF we'll load into the viewer; bigger → the UI offers "download" instead.
const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;

/// Fetch a PDF and return it base64-encoded. Accepts an http(s) URL, a `file://`
/// URL, or a bare filesystem path (e.g. a downloaded file).
#[tauri::command]
pub async fn pdf_fetch(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&url))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)
}

fn fetch(url: &str) -> FluxResult<String> {
    let buf = if url.starts_with("http://") || url.starts_with("https://") {
        fetch_http(url)?
    } else {
        fetch_file(url)?
    };
    if buf.is_empty() {
        return Err(FluxError::Http("empty response".into()));
    }
    if buf.len() > MAX_PDF_BYTES {
        return Err(FluxError::Invalid(format!("PDF too large (> {} MB)", MAX_PDF_BYTES / 1024 / 1024)));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// Save edited PDF bytes (base64) to the Downloads folder (BACKLOG #112). The
/// editor burns annotations / page-ops in the page (pdf-lib) and hands us the
/// finished bytes; we just write them, de-duplicating the filename so we never
/// clobber an existing file. Returns the absolute path written.
#[tauri::command]
pub async fn pdf_save(app: tauri::AppHandle, data_b64: String, filename: String) -> Result<String, String> {
    use tauri::Manager;
    // Resolve a target directory on the async side (cheap), then write off-thread.
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || save_bytes(&dir, &data_b64, &filename))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)
}

fn save_bytes(dir: &std::path::Path, data_b64: &str, filename: &str) -> FluxResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| FluxError::Invalid(e.to_string()))?;
    if bytes.len() > MAX_PDF_BYTES {
        return Err(FluxError::Invalid("edited PDF too large to save".into()));
    }
    std::fs::create_dir_all(dir)?;
    let path = dedup_path(dir, &sanitize(filename));
    std::fs::write(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Keep a filename to a single safe path component ending in `.pdf`.
fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut s: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        s = "edited".into();
    }
    if !s.to_ascii_lowercase().ends_with(".pdf") {
        s.push_str(".pdf");
    }
    s
}

/// `name.pdf` → `name.pdf`, or `name (1).pdf`, `name (2).pdf`, … if taken.
fn dedup_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = name.strip_suffix(".pdf").unwrap_or(name);
    for n in 1..10_000 {
        let p = dir.join(format!("{stem} ({n}).pdf"));
        if !p.exists() {
            return p;
        }
    }
    candidate
}

fn fetch_http(url: &str) -> FluxResult<Vec<u8>> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent.get(url).set("User-Agent", "Mozilla/5.0").call()?;
    let mut buf = Vec::new();
    resp.into_reader().take((MAX_PDF_BYTES + 1) as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

fn fetch_file(url: &str) -> FluxResult<Vec<u8>> {
    Ok(std::fs::read(file_url_to_path(url))?)
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
    fn sanitize_filenames() {
        assert_eq!(sanitize("report.pdf"), "report.pdf");
        assert_eq!(sanitize("report"), "report.pdf");
        assert_eq!(sanitize("../../etc/passwd"), "passwd.pdf");
        assert_eq!(sanitize("a:b*c?.pdf"), "a_b_c_.pdf");
        assert_eq!(sanitize("   "), "edited.pdf");
        assert_eq!(sanitize("notes.PDF"), "notes.PDF");
    }

    #[test]
    fn dedup_avoids_clobber() {
        let dir = std::env::temp_dir().join(format!("flux-pdf-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p1 = dedup_path(&dir, "x.pdf");
        std::fs::write(&p1, b"a").unwrap();
        let p2 = dedup_path(&dir, "x.pdf");
        assert_eq!(p2.file_name().unwrap().to_str().unwrap(), "x (1).pdf");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_url_parsing() {
        assert_eq!(file_url_to_path("file:///home/u/a.pdf"), "/home/u/a.pdf");
        assert_eq!(file_url_to_path("file://localhost/home/u/a.pdf"), "/home/u/a.pdf");
        assert_eq!(file_url_to_path("file:///C:/docs/a.pdf"), "C:/docs/a.pdf");
        assert_eq!(file_url_to_path("file:///home/u/my%20file.pdf"), "/home/u/my file.pdf");
        assert_eq!(file_url_to_path("/plain/path.pdf"), "/plain/path.pdf");
    }
}
