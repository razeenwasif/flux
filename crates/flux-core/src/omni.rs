//! `flux://omni` — the Omni index dashboard data source.
//!
//! The dashboard is a native Flux page (velvet/glass), but its numbers come from
//! the user's Omni search engine over HTTP (`/stats`). We fetch it from Rust,
//! not the webview: the shell's CSP only allows `'self'` + `https:`, so a direct
//! `fetch("http://localhost:8080/stats")` from the page would be blocked — the
//! Rust process has no such restriction. The raw JSON body is handed straight to
//! the frontend, which parses + renders it (no Rust-side schema to keep in sync).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::search::SearchState;
use crate::state::FluxState;

/// GET `url` and return the body, off the main thread. 5s timeout.
async fn fetch(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url)
            .timeout(Duration::from_secs(5))
            .call()
            .map_err(|e| format!("{url}: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The Omni engine's `/stats` JSON (live index health). The base URL follows the
/// configured default search engine, so it tracks wherever the user pointed
/// Omni; `FLUX_OMNI_URL` overrides; falls back to `localhost:8080`.
#[tauri::command]
pub async fn omni_stats(search: State<'_, SearchState>) -> Result<String, String> {
    fetch(format!("{}/stats", search.omni_base())).await
}

/// The Omni engine's curated essential-site shortcuts (`/sites`), so the
/// dashboard grid stays in sync with Omni's bang table.
#[tauri::command]
pub async fn omni_sites(search: State<'_, SearchState>) -> Result<String, String> {
    fetch(format!("{}/sites", search.omni_base())).await
}

/// The Omni engine's semantic graph (`/graph`) — top-`n` docs by PageRank as
/// nodes, edges to each node's top-`k` cosine neighbours — for the dashboard's
/// Obsidian-style graph view. Proxied through Rust like the other Omni calls.
#[tauri::command]
pub async fn omni_graph(
    search: State<'_, SearchState>,
    n: Option<u32>,
    k: Option<u32>,
) -> Result<String, String> {
    let n = n.unwrap_or(300).clamp(1, 1500);
    let k = k.unwrap_or(6).clamp(1, 16);
    fetch(format!("{}/graph?n={n}&k={k}", search.omni_base())).await
}

/// Stream a generative RAG answer for `query` from Omni's `/answer?stream=1`,
/// relaying each Server-Sent-Event `data:` payload to the frontend over `on_token`
/// as it arrives. Proxied through Rust (like the other Omni calls) so it dodges the
/// webview CSP that blocks a direct `http://localhost` fetch — and a Tauri `Channel`
/// is what carries the tokens live, so the omnibox renders the answer word-by-word.
/// Each payload is a JSON event: `{type:"sources",…}`, `{type:"token",text}`,
/// or `{type:"done"}` — the frontend parses them (no Rust-side schema to sync).
#[tauri::command]
pub async fn omni_answer(
    search: State<'_, SearchState>,
    query: String,
    model: Option<String>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let base = search.omni_base();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::BufRead;
        let mut req = ureq::get(&format!("{base}/answer"))
            .timeout(Duration::from_secs(180))
            .query("stream", "1")
            .query("q", &query);
        if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
            req = req.query("model", m);
        }
        let reader = req.call().map_err(|e| e.to_string())?.into_reader();
        let mut buf = std::io::BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) => break, // stream closed
                Ok(_) => {
                    // SSE frames are `data: <json>`; forward the JSON payload as-is.
                    if let Some(data) = line.trim().strip_prefix("data:") {
                        let payload = data.trim();
                        if !payload.is_empty() && on_token.send(payload.to_string()).is_err() {
                            break; // frontend dropped the channel — stop relaying
                        }
                    }
                }
                Err(_) => break,
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Live ingest: feed browsed pages into the Omni index ─────────────────────
//
// Flux already captures each page's visible text (`dom_publish`); live ingest
// POSTs that to Omni's `/ingest` (JSON `{url,title,text}`) so the index grows
// from what the user actually reads. Two paths:
//   * an explicit "save this page" command (always available), and
//   * an opt-in **auto** toggle that ingests every substantial page on load.
// Off by default — ingesting everything you browse is privacy-sensitive — and
// seeded from `FLUX_OMNI_INGEST=1`.

/// Minimum visible-text length to bother indexing (skips thin/non-article pages).
const MIN_INGEST_CHARS: usize = 500;

/// Runtime toggle for auto-ingest. Privacy-first: off unless enabled.
pub struct IngestState {
    auto: AtomicBool,
}

impl Default for IngestState {
    fn default() -> Self {
        Self::new()
    }
}

impl IngestState {
    pub fn new() -> Self {
        let on = std::env::var("FLUX_OMNI_INGEST")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Self {
            auto: AtomicBool::new(on),
        }
    }
    pub fn auto(&self) -> bool {
        self.auto.load(Ordering::Relaxed)
    }
}

/// Fire-and-forget POST of one page to Omni's `/ingest` (best-effort).
fn post_page(base: String, url: String, title: String, text: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let body = json!({ "url": url, "title": title, "text": text }).to_string();
        let _ = ureq::post(&format!("{base}/ingest"))
            .timeout(Duration::from_secs(8))
            .set("Content-Type", "application/json")
            .send_string(&body);
    });
}

/// Auto-ingest a freshly-captured page when the toggle is on and it looks worth
/// indexing. Called from `dom_publish`; never blocks.
pub fn maybe_auto_ingest(app: &AppHandle, url: &str, title: &str, text: &str) {
    let on = app
        .try_state::<IngestState>()
        .map(|s| s.auto())
        .unwrap_or(false);
    if !on {
        return;
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return; // skip flux://, file://, about:, etc.
    }
    if text.chars().count() < MIN_INGEST_CHARS {
        return; // thin page (login screen, app shell) — not worth indexing
    }
    let base = app.state::<SearchState>().omni_base();
    post_page(base, url.to_string(), title.to_string(), text.to_string());
}

/// Whether auto-ingest is currently on.
#[tauri::command]
pub fn omni_ingest_status(state: State<'_, IngestState>) -> bool {
    state.auto()
}

/// Turn auto-ingest on/off for this session.
#[tauri::command]
pub fn omni_ingest_set_auto(state: State<'_, IngestState>, enabled: bool) {
    state.auto.store(enabled, Ordering::Relaxed);
}

/// Explicitly ingest the active tab's captured page (the "Save to Omni" action),
/// regardless of the auto toggle. Returns Omni's JSON response (e.g. `{added:1}`).
#[tauri::command]
pub async fn omni_ingest_active(
    search: State<'_, SearchState>,
    flux: State<'_, FluxState>,
) -> Result<String, String> {
    let snap = flux
        .active_snapshot()
        .ok_or("no active tab page captured yet")?;
    let title = flux
        .tabs
        .get(&snap.tab)
        .map(|t| t.title.clone())
        .unwrap_or_default();
    let base = search.omni_base();
    let body = json!({ "url": snap.url, "title": title, "text": &*snap.text }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        ureq::post(&format!("{base}/ingest"))
            .timeout(Duration::from_secs(15))
            .set("Content-Type", "application/json")
            .send_string(&body)
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
