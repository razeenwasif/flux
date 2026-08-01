//! Optical character recognition, by shelling out to `tesseract`.
//!
//! **Why a subprocess and not a crate.** The Rust bindings (`leptess`,
//! `tesseract-rs`) link libtesseract and libleptonica at build time, which turns
//! a pure-Rust cross-compile into a C toolchain problem on every platform Flux
//! targets — including the Android build (ADR 0012) and the WSL2 dev loop. A
//! subprocess costs one `spawn` per page and keeps OCR an *optional* capability:
//! if the binary isn't there, Flux is exactly as it was.
//!
//! **Degrading is the normal case, not the error case.** Most users won't have
//! tesseract installed, and a scanned PDF is uncommon. So nothing here is fatal:
//! [`available`] answers honestly, the UI only offers OCR when it's true, and a
//! failed recognition returns a message rather than poisoning the document.
//!
//! Recognised text is published to the KB under its own `pdf-ocr` source rather
//! than mixed into `pdf`, so a citation carries the fact that a machine read it
//! off an image and may be wrong — the same treatment `scribe-ocr` gets for
//! handwriting.

use parking_lot::Mutex;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long one page may take before we give up and kill the process.
///
/// Tesseract is normally 1-3s for a page. The cap exists because a subprocess
/// that never exits would otherwise hold a thread forever, and this session has
/// already lost an evening to one unbounded blocking call.
const PAGE_TIMEOUT: Duration = Duration::from_secs(45);

/// Cached availability, so the UI can ask freely.
static PROBE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
/// Short enough that installing tesseract works without restarting Flux.
const PROBE_TTL: Duration = Duration::from_secs(60);

/// The tesseract binary to run. `FLUX_TESSERACT` overrides, for an install that
/// isn't on PATH — the common case on Windows, where the installer doesn't add
/// itself.
fn binary() -> String {
    std::env::var("FLUX_TESSERACT").unwrap_or_else(|_| "tesseract".to_string())
}

/// Is a usable `tesseract` present? Cached for [`PROBE_TTL`].
pub fn available() -> bool {
    if let Some((at, ok)) = *PROBE.lock() {
        if at.elapsed() < PROBE_TTL {
            return ok;
        }
    }
    let ok = Command::new(binary())
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    *PROBE.lock() = Some((Instant::now(), ok));
    ok
}

/// Forget the cached probe — for after the user installs tesseract and wants it
/// picked up now rather than within the minute.
pub fn invalidate_probe() {
    *PROBE.lock() = None;
}

/// Language argument, sanitised.
///
/// This value reaches a command line, so it is restricted to what a tesseract
/// traineddata name can actually be (`eng`, `deu`, `chi_sim`, or `eng+deu` for
/// several). Anything else falls back to English rather than being passed
/// through — the argument is not a place to find out whether the caller was
/// honest.
fn lang_arg(requested: Option<&str>) -> String {
    let raw = requested.unwrap_or("eng").trim();
    let ok = !raw.is_empty()
        && raw.len() <= 32
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+');
    if ok {
        raw.to_string()
    } else {
        "eng".to_string()
    }
}

/// Recognise text in a PNG image.
///
/// Reads the image on stdin and takes text from stdout (`tesseract - -`), so no
/// temporary file is written: page images are the user's documents, and the
/// fewer copies of them on disk the better.
pub fn recognize(png: &[u8], lang: Option<&str>) -> Result<String, String> {
    let started = Instant::now();
    let mut child = Command::new(binary())
        .args(["-", "-", "-l", &lang_arg(lang)])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Tesseract writes progress chatter to stderr; it isn't wanted and a
        // full stderr pipe nobody drains would block the process.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't run tesseract: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin on tesseract")?;
    let mut stdout = child.stdout.take().ok_or("no stdout on tesseract")?;

    // Feed the image from its own thread: a page PNG is far larger than the pipe
    // buffer, so writing it inline would block until tesseract drains it, while
    // tesseract may be blocked writing output nobody is reading. Dropping the
    // handle closes stdin, which is what tells tesseract the image is complete.
    let image = png.to_vec();
    let feeder = std::thread::spawn(move || stdin.write_all(&image));

    // Kill it if it stops making progress. `try_wait` polling rather than a
    // dependency on `wait-timeout` for one call site.
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            let deadline = Instant::now() + PAGE_TIMEOUT;
            while Instant::now() < deadline {
                if finished.load(Ordering::Acquire) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !finished.load(Ordering::Acquire) {
                let _ = child.lock().kill();
            }
        });
    }

    let mut text = String::new();
    let read = stdout.read_to_string(&mut text);
    finished.store(true, Ordering::Release);
    let _ = feeder.join();
    let status = child.lock().wait();
    read.map_err(|e| format!("couldn't read tesseract output: {e}"))?;

    match status {
        Ok(s) if s.success() => {
            tracing::info!(
                target: "flux::ocr",
                ms = started.elapsed().as_millis() as u64,
                chars = text.trim().len(),
                "recognized page"
            );
            Ok(text.trim().to_string())
        }
        // A killed process and a failed one are different problems: one is a
        // page too dense for the budget, the other a broken install.
        Ok(_) if started.elapsed() >= PAGE_TIMEOUT => Err(format!(
            "tesseract timed out after {}s",
            PAGE_TIMEOUT.as_secs()
        )),
        Ok(s) => Err(format!("tesseract failed ({s})")),
        Err(e) => Err(format!("tesseract didn't finish: {e}")),
    }
}

// ─── commands ───────────────────────────────────────────────────────────────

/// Whether OCR can be offered at all. The UI hides the option when false rather
/// than presenting a button that always fails.
#[tauri::command]
pub async fn ocr_available() -> bool {
    tauri::async_runtime::spawn_blocking(available)
        .await
        .unwrap_or(false)
}

/// Recognise one page image, given as base64 PNG.
///
/// One call per page rather than a whole document: pages are rendered by the
/// viewer that already has them, progress can be shown, and a single bad page
/// doesn't lose the rest.
#[tauri::command]
pub async fn ocr_image(png_b64: String, lang: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_b64.trim())
        .map_err(|e| format!("bad image data: {e}"))?;
    if png.is_empty() {
        return Err("empty image".into());
    }
    tauri::async_runtime::spawn_blocking(move || recognize(&png, lang.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_is_restricted_to_traineddata_names() {
        assert_eq!(lang_arg(Some("eng")), "eng");
        assert_eq!(lang_arg(Some("chi_sim")), "chi_sim");
        assert_eq!(lang_arg(Some("eng+deu")), "eng+deu");
        // This value reaches a command line; anything shell-ish falls back.
        assert_eq!(lang_arg(Some("eng; rm -rf /")), "eng");
        assert_eq!(lang_arg(Some("../../etc/passwd")), "eng");
        assert_eq!(lang_arg(Some("$(whoami)")), "eng");
        assert_eq!(lang_arg(Some("")), "eng");
        assert_eq!(lang_arg(None), "eng");
        assert_eq!(lang_arg(Some(&"a".repeat(64))), "eng");
    }

    #[test]
    fn availability_is_cached() {
        // The UI asks this per render; it must not spawn a process each time.
        invalidate_probe();
        let first = available();
        assert!(PROBE.lock().is_some());
        let stamp = PROBE.lock().map(|(at, _)| at);
        for _ in 0..5 {
            assert_eq!(available(), first);
        }
        assert_eq!(PROBE.lock().map(|(at, _)| at), stamp, "re-probed");
    }

    #[test]
    fn a_missing_binary_degrades_rather_than_panicking() {
        // The normal case for most users: no tesseract installed.
        std::env::set_var("FLUX_TESSERACT", "flux-definitely-not-a-real-binary");
        invalidate_probe();
        assert!(!available());
        let err = recognize(b"not really a png", None).unwrap_err();
        assert!(err.contains("couldn't run tesseract"), "got: {err}");
        std::env::remove_var("FLUX_TESSERACT");
        invalidate_probe();
    }

    /// End-to-end against a real tesseract, when one is present. Skipped
    /// otherwise so CI without the binary stays green — the point of the whole
    /// optional-capability design.
    #[test]
    fn recognizes_real_text_when_tesseract_is_installed() {
        let Ok(png) = std::env::var("FLUX_OCR_TEST_PNG") else {
            return;
        };
        invalidate_probe();
        if !available() {
            return;
        }
        let bytes = std::fs::read(png).expect("test image");
        let text = recognize(&bytes, Some("eng")).expect("recognition should succeed");
        assert!(
            text.to_lowercase().contains("convex"),
            "expected the page's words, got: {text:?}"
        );
    }
}
