//! DOM snapshot ingestion + the context-aware terminal bridge.
//!
//! Split out of `commands.rs` (Phase 2 refactor): everything a tab's injected
//! JS publishes back to Rust (DOM snapshots, reader blocks, find results,
//! chrome key/url intents) and the env bridge that makes spawned shells born
//! knowing the browser's state. Hot-path rule (ADR 0001) still applies:
//! multi-KB payloads travel as raw bytes, JSON is for small control messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{DomSnapshot, FluxState, TabId};

/// Process-wide monotonic clock origin for snapshot staleness stamps.
static BOOT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
pub(crate) fn now_ms() -> u64 {
    BOOT.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// ─── DOM snapshot ingestion (tab webview → Rust) ────────────────────────────
//
// Plain JSON args, NOT a raw ArrayBuffer body. Real pages set restrictive CSPs
// (e.g. DuckDuckGo's `connect-src`), which block Tauri's fetch-based IPC and
// force the `postMessage` fallback — and that path does not carry a raw body.
// JSON args survive both paths. (The zero-copy raw-body idea from ADR 0001
// only worked from the local chrome origin; it can't work from arbitrary
// remote pages.)

/// Per-tab DOM snapshot caps (BACKLOG #79 — RAM). A page's outerHTML is often
/// several MB; cached for every open tab that dominates Flux's heap and is the
/// main memory cost we control (the rest is the native webviews themselves).
/// These bounds are generous for the actual consumers — the agent, the embedder
/// (which truncates anyway), and `flux extract-json` — so the cap is invisible
/// in practice but turns unbounded growth into O(tabs × cap).
const MAX_SNAPSHOT_HTML: usize = 1024 * 1024; // 1 MiB
const MAX_SNAPSHOT_TEXT: usize = 256 * 1024; //  256 KiB

/// Truncate to at most `max` bytes on a UTF-8 boundary (no realloc when short).
pub(crate) fn cap_utf8(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

#[tauri::command]
pub fn dom_publish(
    app: AppHandle,
    state: State<'_, FluxState>,
    tab_id: TabId,
    url: String,
    html: String,
    text: String,
    title: Option<String>,
) -> Result<(), String> {
    // Bound per-tab memory before anything holds onto these strings (#79).
    let html = cap_utf8(html, MAX_SNAPSHOT_HTML);
    let text = cap_utf8(text, MAX_SNAPSHOT_TEXT);

    // Prefer the page's own <title>; fall back to the tab's stored title.
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
        state.tabs.get(&tab_id).map(|t| t.title.clone()).unwrap_or_default()
    });

    // Private tabs (#59) leave no trace: keep the live snapshot in RAM (for the
    // agent on the active tab) but never record history or ingest into Omni.
    let private = state.tabs.get(&tab_id).map(|t| t.private).unwrap_or(false);

    // Keep the tab's stored title fresh (so omni_search + the session show the
    // live title, not the creation-time one). In-memory only — not worth a disk
    // write every capture.
    if let Some(mut t) = state.tabs.get_mut(&tab_id) {
        if !title.trim().is_empty() && t.title != title {
            t.title = title.clone();
        }
    }

    if !private {
        // Record the visit in browsing history (#39); skips non-http(s) internally.
        if let Some(h) = app.try_state::<crate::history::HistoryStore>() {
            h.record(&url, &title);
        }
        // Record the visit in the provenance spine — "the Trail" (ADR 0011).
        // Same non-private guard as history; the task label is the tab's active
        // workspace name, and the nav edge is drawn from the tab's prior visit.
        if let Some(tr) = app.try_state::<crate::trace::TraceStore>() {
            let task = state.tabs.get(&tab_id).map(|t| t.workspace).and_then(|ws| {
                state.workspaces_list().into_iter().find(|w| w.id == ws).map(|w| w.name)
            });
            tr.record(tab_id, &url, &title, task);
        }
        // Live ingest into Omni (no-op unless the user enabled auto-ingest). Done
        // before the snapshot is built so the page text is still owned here.
        crate::omni::maybe_auto_ingest(&app, &url, &title, &text);
    }

    let snapshot = Arc::new(DomSnapshot {
        tab: tab_id,
        url,
        html: Arc::from(html),
        text: Arc::from(text),
        captured_at_ms: now_ms(),
    });
    state.dom_cache.insert(tab_id, snapshot);

    // Refresh the terminal's page-context file if this is the active tab (#65/#4).
    if state.active_tab() == Some(tab_id) {
        crate::rpc::publish_active(&app);
    }

    // Capture navigations into an in-progress macro recording (#67).
    if let Some(m) = app.try_state::<crate::macros::MacroState>() {
        if m.is_recording() {
            if let Some(snap) = state.dom_cache.get(&tab_id) {
                if snap.url.starts_with("http") {
                    m.push(crate::macros::Step::Navigate { url: snap.url.clone() });
                }
            }
        }
    }

    // Nudge interested panes (terminal env bar, agent sidebar).
    app.emit("flux://dom-updated", tab_id).map_err(|e| e.to_string())
}

/// App keyboard shortcuts forwarded from a focused tab webview (#18). A native
/// child webview eats key events when focused, so the injected `shortcuts.js`
/// detects Flux's chord set and calls this; we re-emit it to the chrome, which
/// dispatches the same action it would for a chrome-focused keypress. Like
/// `dom_publish`, this is a `fluxtab` plugin command so remote pages may call it.
#[tauri::command]
pub fn chrome_key(app: AppHandle, action: String) -> Result<(), String> {
    app.emit("flux://shortcut", action).map_err(|e| e.to_string())
}

/// A page-initiated new window (window.open / target="_blank" / modified click),
/// forwarded by the injected `newtab.js`. Native child webviews ignore these, so
/// the page asks the chrome to open a real Flux tab. `background` keeps focus on
/// the current tab (middle-click / Ctrl-click). Like `chrome_key`, this is a
/// `fluxtab` plugin command so remote pages may call it.
#[tauri::command]
pub fn chrome_open_url(app: AppHandle, url: String, background: bool) -> Result<(), String> {
    app.emit("flux://open-url", (url, background)).map_err(|e| e.to_string())
}

/// Pull OS keyboard focus back to the chrome window. A focused native tab
/// webview is a separate OS child window that holds the keyboard, so focusing a
/// chrome DOM element (e.g. the omnibox on Ctrl+T / Ctrl+L) does nothing until
/// the chrome window itself is focused. The frontend calls this first.
#[tauri::command]
pub fn chrome_focus(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

/// Find-in-page result reported by the page (#33): match count + whether the
/// current step landed on a match. Re-emitted to the chrome's find bar. A
/// `fluxtab` plugin command so the (remote) page may call it, like `dom_publish`.
#[tauri::command]
pub fn find_result(app: AppHandle, tab_id: TabId, count: usize, found: bool) -> Result<(), String> {
    app.emit("flux://find-result", (tab_id, count, found)).map_err(|e| e.to_string())
}

/// One structured block of a reader-mode extraction (#41): a heading, paragraph,
/// list item, quote, preformatted block, image caption, or image.
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
pub struct ReaderBlock {
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub src: String,
}

/// Reader-mode result posted by the injected extractor (#41). Re-emitted to the
/// chrome, which renders the blocks safely (text + img src, never raw HTML). A
/// `fluxtab` plugin command so the (remote) page may call it, like `dom_publish`.
#[tauri::command]
pub fn reader_publish(app: AppHandle, tab_id: TabId, title: String, blocks: Vec<ReaderBlock>) -> Result<(), String> {
    app.emit("flux://reader", (tab_id, title, blocks)).map_err(|e| e.to_string())
}

/// Per-tab captured-DOM payload size in bytes (BACKLOG #70) — html + text of the
/// cached snapshot, a proxy for page weight in the resource view. Tabs without a
/// snapshot (never loaded / hibernated) are omitted.
#[tauri::command]
pub fn tab_dom_sizes(state: State<'_, FluxState>) -> Vec<(TabId, usize)> {
    state.dom_cache.iter().map(|e| (*e.key(), e.html.len() + e.text.len())).collect()
}

/// Hand the active tab's DOM to the frontend (e.g. terminal running
/// `flux extract-json`) as an ArrayBuffer — `Response` skips JSON entirely.
#[tauri::command]
pub fn dom_active_bytes(state: State<'_, FluxState>) -> Result<Response, String> {
    let snap = state.active_snapshot().ok_or("no active tab snapshot")?;
    Ok(Response::new(snap.html.as_bytes().to_vec()))
}

// ─── Context-Aware Terminal bridge ───────────────────────────────────────────

/// Environment the embedded terminal injects into every spawned shell.
/// This is what makes `cd $FLUX_TAB_DIR` / `flux extract-json` work: the
/// shell session is *born* knowing the browser's state.
#[tauri::command]
pub fn terminal_env(state: State<'_, FluxState>) -> HashMap<String, String> {
    let mut env = HashMap::with_capacity(6);
    if let Some(id) = state.active_tab() {
        if let Some(tab) = state.tabs.get(&id) {
            env.insert("FLUX_TAB_ID".into(), id.to_string());
            env.insert("FLUX_TAB_URL".into(), tab.url.clone());
            env.insert("FLUX_TAB_TITLE".into(), tab.title.clone());
            // Per-site downloaded-assets dir, e.g. `cd $FLUX_TAB_DIR`.
            if let Some(host) = tab.url.split('/').nth(2) {
                env.insert(
                    "FLUX_TAB_DIR".into(),
                    format!("{}/flux/{}", dirs_download(), host),
                );
            }
        }
        if let Some(snap) = state.dom_cache.get(&id) {
            env.insert("FLUX_DOM_AGE_MS".into(), (now_ms() - snap.captured_at_ms).to_string());
        }
    }
    env
}

pub(crate) fn dirs_download() -> String {
    // Real impl: `dirs::download_dir()`. Kept dependency-free in the scaffold.
    std::env::var("HOME").map(|h| format!("{h}/Downloads")).unwrap_or_else(|_| ".".into())
}

