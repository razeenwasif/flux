//! PDF fetch for the built-in viewer (BACKLOG #35).
//!
//! The viewer is PDF.js running in a Flux internal page (`flux://pdf`). Rather
//! than let the page fetch the PDF itself — cross-origin PDFs almost never send
//! CORS headers, so the engine would block it — the Rust core fetches the bytes
//! (http(s)) or reads them from disk (local files) and hands them back as **raw
//! bytes** over the IPC binary channel. Still capped, so a pathological file
//! can't exhaust memory — but the cap can be generous now that a byte costs a
//! byte (see MAX_PDF_BYTES).

use std::io::Read;
use std::time::Duration;

use base64::Engine as _;

use crate::error::{FluxError, FluxResult};

/// Largest PDF we'll load into the viewer; bigger → the UI offers "download".
///
/// This was 32 MB because the bytes crossed IPC **base64-encoded**: a 32 MB file
/// meant a 43 MB base64 string, which `atob` then expanded into a ~64 MB binary
/// JS string before a byte-at-a-time copy into a `Uint8Array` — roughly 5× the
/// file in transient memory, which is exactly what Flux's low-RAM wedge can't
/// afford. Now the bytes travel raw over the IPC binary channel and become a
/// `Uint8Array` with one copy, so the honest limit is what PDF.js can hold, not
/// what the transport survives.
const MAX_PDF_BYTES: usize = 256 * 1024 * 1024;

/// Fetch a PDF and return its raw bytes. Accepts an http(s) URL, a `file://`
/// URL, or a bare filesystem path (e.g. a downloaded file).
///
/// Returns [`tauri::ipc::Response`] so the payload rides the IPC **binary**
/// channel and arrives in JS as an `ArrayBuffer` — no base64 inflation, no
/// intermediate binary string, one copy into a `Uint8Array`.
#[tauri::command]
pub async fn pdf_fetch(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || fetch(&url))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn fetch(url: &str) -> FluxResult<Vec<u8>> {
    let buf = if url.starts_with("http://") || url.starts_with("https://") {
        fetch_http(url)?
    } else {
        fetch_file(url)?
    };
    if buf.is_empty() {
        return Err(FluxError::Http("empty response".into()));
    }
    if buf.len() > MAX_PDF_BYTES {
        return Err(FluxError::Invalid(format!(
            "PDF too large (> {} MB)",
            MAX_PDF_BYTES / 1024 / 1024
        )));
    }
    Ok(buf)
}

/// Save edited PDF bytes (base64) to the Downloads folder (BACKLOG #112). The
/// editor burns annotations / page-ops in the page (pdf-lib) and hands us the
/// finished bytes; we just write them, de-duplicating the filename so we never
/// clobber an existing file. Returns the absolute path written.
#[tauri::command]
pub async fn pdf_save(
    app: tauri::AppHandle,
    data_b64: String,
    filename: String,
) -> Result<String, String> {
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
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
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
    resp.into_reader()
        .take((MAX_PDF_BYTES + 1) as u64)
        .read_to_end(&mut buf)?;
    Ok(buf)
}

fn fetch_file(url: &str) -> FluxResult<Vec<u8>> {
    // Through the shared reader, not `std::fs::read`: on the Windows build a
    // `/home/…` path is a WSL path, and reading it natively fails with "the
    // system cannot find the path specified". That mattered the moment the agent
    // could be handed a folder of PDFs to work through.
    crate::files::read_bytes_any(&file_url_to_path(url)).map_err(FluxError::Invalid)
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
    fn fetch_returns_raw_bytes_not_base64() {
        let dir = std::env::temp_dir().join(format!("flux-pdf-raw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("a.pdf");
        // Bytes that are NOT valid base64 output, so an accidental re-introduction
        // of encoding would fail this rather than quietly passing.
        let body: Vec<u8> = b"%PDF-1.7\n\xff\xfe\x00binary\x01\x02".to_vec();
        std::fs::write(&path, &body).unwrap();

        let got = fetch(path.to_str().unwrap()).expect("reads the file");
        assert_eq!(got, body, "bytes travel verbatim — no base64, no re-encoding");

        // An empty file is an error, not an empty render.
        let empty = dir.join("empty.pdf");
        std::fs::write(&empty, b"").unwrap();
        assert!(fetch(empty.to_str().unwrap()).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn size_cap_is_generous_now_that_bytes_are_raw() {
        // The old 32 MB cap existed because base64 + atob cost ~5x the file in
        // transient memory. Raw bytes cost ~1x, so the cap tracks what PDF.js can
        // hold rather than what the transport survives.
        // Const-asserted: regressing this silently re-breaks large PDFs.
        const { assert!(MAX_PDF_BYTES >= 256 * 1024 * 1024) };
    }

    #[test]
    fn file_url_parsing() {
        assert_eq!(file_url_to_path("file:///home/u/a.pdf"), "/home/u/a.pdf");
        assert_eq!(
            file_url_to_path("file://localhost/home/u/a.pdf"),
            "/home/u/a.pdf"
        );
        assert_eq!(file_url_to_path("file:///C:/docs/a.pdf"), "C:/docs/a.pdf");
        assert_eq!(
            file_url_to_path("file:///home/u/my%20file.pdf"),
            "/home/u/my file.pdf"
        );
        assert_eq!(file_url_to_path("/plain/path.pdf"), "/plain/path.pdf");
    }
}

// ─── Extracted text ──────────────────────────────────────────────────────────
//
// A PDF open in the viewer used to be invisible to the agent: the viewer is
// Flux's own DOM inside the chrome, so `capture.js` never runs and no snapshot
// exists — the same reason `flux://scribe` isn't visible. The text is extracted
// **in the viewer**, where PDF.js has already parsed the document for its text
// layer, rather than parsed a second time in Rust with another dependency.
//
// It's stored rather than only published, so a PDF stays answerable after the
// tab closes. That's what puts it in the knowledge base: the KB indexes this
// store, not the live snapshot.

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::Manager as _;

/// One PDF's extracted text, keyed by its source URL/path.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PdfDoc {
    pub src: String,
    pub title: String,
    pub text: String,
    pub ts: u64,
    /// True when the text was lifted off page images by OCR rather than read
    /// from a text layer. Defaulted so documents stored before OCR existed load
    /// unchanged.
    #[serde(default)]
    pub ocr: bool,
}

/// Most text kept per document. Long enough for a thesis chapter, bounded so one
/// enormous file can't dominate the store or the index.
const MAX_PDF_TEXT: usize = 400_000;

#[derive(Default)]
pub struct PdfStore {
    docs: RwLock<HashMap<String, PdfDoc>>,
    path: Option<PathBuf>,
    /// Bumped on every write, so the KB indexer can tell when to re-embed
    /// without re-reading the whole store.
    generation: std::sync::atomic::AtomicU64,
}

impl PdfStore {
    pub fn restore(path: PathBuf) -> Self {
        let docs = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<PdfDoc>>(&s).ok())
            .map(|v| v.into_iter().map(|d| (d.src.clone(), d)).collect())
            .unwrap_or_default();
        Self {
            docs: RwLock::new(docs),
            path: Some(path),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn list(&self) -> Vec<PdfDoc> {
        self.docs.read().values().cloned().collect()
    }

    fn put(&self, doc: PdfDoc) {
        self.docs.write().insert(doc.src.clone(), doc);
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(p) = &self.path {
            let all: Vec<PdfDoc> = self.docs.read().values().cloned().collect();
            crate::persist::save_json(p, &all);
        }
    }
}

/// Record a PDF's text and publish it as the tab's snapshot, so the agent sees
/// the open document exactly as it sees a web page.
#[tauri::command]
// Three of the eight are Tauri's own injections (app/state/tab id); the callable
// surface is the document and its two page counts.
#[allow(clippy::too_many_arguments)]
pub fn pdf_publish_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::FluxState>,
    tab_id: crate::state::TabId,
    src: String,
    title: String,
    text: String,
    // Total pages, and how many yielded any text. Logged rather than stored:
    // "the model only saw the first N slides" has two very different causes — a
    // cap somewhere, or later pages being images with no text layer — and they
    // are indistinguishable without this.
    pages: Option<u32>,
    pages_with_text: Option<u32>,
    // Set when the text came from OCR: stored the same way but indexed under
    // `pdf-ocr`, so a citation carries that a machine read it off an image.
    ocr: Option<bool>,
) -> Result<(), String> {
    let raw_len = text.len();
    let text = crate::dom::cap_utf8(text, MAX_PDF_TEXT);
    tracing::info!(
        target: "flux::pdf",
        src = %src,
        pages = pages.unwrap_or(0),
        pages_with_text = pages_with_text.unwrap_or(0),
        chars_extracted = raw_len,
        chars_stored = text.len(),
        ocr = ocr.unwrap_or(false),
        "extracted PDF text"
    );
    let title = if title.trim().is_empty() {
        src.rsplit(['/', '\\']).next().unwrap_or("PDF").to_string()
    } else {
        title
    };

    if text.trim().is_empty() {
        // No text layer — a scan, or slides exported as images.
        //
        // This still must not reach the KB: an empty doc would make the KB claim
        // to know a paper it can't quote a word of. But returning here published
        // *nothing at all*, and an absent snapshot is not a neutral state — it
        // is indistinguishable, from the model's side, from a page it simply
        // wasn't given. Asked about the open document it would then speculate
        // about Flux's own plumbing ("depends on whether the text is being
        // captured and sent to me") and ask the user to paste the slides in,
        // when the true and useful answer was one it had no way to reach.
        //
        // So: say it, in the one place the model actually reads.
        let note = format!(
            "[Flux] The PDF \"{title}\" is open in the viewer: {} page(s), NONE of which contain \
             selectable text. It is a scan or an image-only export, so there is genuinely no text \
             to read — this is a fact about the document, not about what you were given. Tell the \
             user that, and that Flux's PDF viewer offers \"Read with OCR\" to extract it. Do not \
             ask them to paste the contents in.",
            pages.unwrap_or(0)
        );
        state.dom_cache.insert(
            tab_id,
            std::sync::Arc::new(crate::state::DomSnapshot {
                tab: tab_id,
                url: src.clone(),
                html: std::sync::Arc::from(""),
                text: std::sync::Arc::from(note.as_str()),
                captured_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            }),
        );
        let _ = tauri::Emitter::emit(&app, "flux://dom-updated", tab_id);
        return Ok(());
    }

    if let Some(store) = app.try_state::<PdfStore>() {
        store.put(PdfDoc {
            src: src.clone(),
            title: title.clone(),
            text: text.clone(),
            ocr: ocr.unwrap_or(false),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }

    // A deck whose later slides are images extracts fine for the first few and
    // then yields nothing. That was logged and never told to the model, which
    // would answer about "the document" while holding two slides of a
    // thirty-five slide lecture — and had no way to know it. The KB doc stays
    // clean (a note there would pollute citations); the snapshot says it.
    let snapshot_text = match (pages, pages_with_text) {
        (Some(total), Some(with)) if total > with && total > 0 => format!(
            "[Flux] \"{title}\": only {with} of {total} pages contain selectable text — the rest \
             are images. What follows is everything readable in this document; if the user asks \
             about something that isn't here, say it's on a page with no text layer and point at \
             \"Read with OCR\" in the viewer.\n\n{text}"
        ),
        _ => text.clone(),
    };

    // The live snapshot is what `agent_chat` and chat-with-tabs read. Built here
    // rather than routed through `dom_publish`: that also writes history, the
    // Trail and Omni, none of which should record an internal viewer page.
    state.dom_cache.insert(
        tab_id,
        std::sync::Arc::new(crate::state::DomSnapshot {
            tab: tab_id,
            url: src.clone(),
            html: std::sync::Arc::from(""),
            text: std::sync::Arc::from(snapshot_text.as_str()),
            captured_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }),
    );
    let _ = tauri::Emitter::emit(&app, "flux://dom-updated", tab_id);
    Ok(())
}

/// Everything read so far, for the knowledge base.
#[tauri::command]
pub fn pdf_docs(store: tauri::State<'_, PdfStore>) -> Vec<PdfDoc> {
    store.list()
}
