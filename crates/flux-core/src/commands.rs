//! Tauri IPC surface.
//!
//! Hot-path rule (ADR 0001): anything that can be multi-KB travels as raw
//! bytes — `tauri::ipc::Request` (raw body in) / `tauri::ipc::Response`
//! (ArrayBuffer out). JSON is reserved for small control messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::cli::LaunchIntent;
use crate::state::{AgentStatus, DomSnapshot, FluxState, TabId, TabKind, TabMeta};

/// Process-wide monotonic clock origin for snapshot staleness stamps.
static BOOT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
fn now_ms() -> u64 {
    BOOT.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────

/// Register a new tab of either kind. For Browser tabs the frontend creates
/// the child webview (labelled `tab-{id}`) once this returns; for Terminal
/// tabs flux-core spawns a PTY session (BACKLOG #3) with `terminal_env`.
#[tauri::command]
pub fn tab_create(state: State<'_, FluxState>, kind: TabKind, url: Option<String>) -> TabMeta {
    let id = state.alloc_tab_id();
    let (url, title) = match kind {
        // No url → the Flux start page (the frontend renders the dashboard and
        // opens no webview for `flux://start`).
        TabKind::Browser => (url.unwrap_or_else(|| "flux://start".into()), String::new()),
        // Terminal tabs carry their cwd in `url`; title mirrors the shell.
        TabKind::Terminal => (dirs_download(), format!("term #{id}")),
        // Files tabs carry their cwd in `url`; start at home.
        TabKind::Files => {
            let start = url.unwrap_or_else(crate::files::home_dir);
            let title = std::path::Path::new(&start)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Files".into());
            (start, title)
        }
    };
    let meta = TabMeta { id, kind, url, title, pinned: false, cluster: None };
    state.tabs.insert(id, meta.clone());
    state.set_active_tab(id);
    state.persist();
    meta
}

/// Pin/unpin (Arc-style left rail). Pinned tabs drop their cluster — the
/// rail is the user's deliberate order, not the embedder's.
#[tauri::command]
pub fn tab_set_pinned(state: State<'_, FluxState>, id: TabId, pinned: bool) -> Result<(), String> {
    {
        // Scope the guard: `persist()` iterates the same DashMap.
        let mut meta = state.tabs.get_mut(&id).ok_or("no such tab")?;
        meta.pinned = pinned;
        if pinned {
            meta.cluster = None;
        }
    }
    state.persist();
    Ok(())
}

/// Sync a tab's live url/title from the frontend (in-webview navigation isn't
/// visible to Rust otherwise) so the persisted session reflects where each tab
/// actually is — not just where it was created. (BACKLOG #19.)
#[tauri::command]
pub fn tab_set_url(state: State<'_, FluxState>, id: TabId, url: String, title: Option<String>) {
    {
        if let Some(mut meta) = state.tabs.get_mut(&id) {
            meta.url = url;
            if let Some(t) = title {
                meta.title = t;
            }
        }
    }
    state.persist();
}

/// The currently-focused tab id (so the shell can restore focus on boot).
#[tauri::command]
pub fn tab_active(state: State<'_, FluxState>) -> Option<TabId> {
    state.active_tab()
}

/// One-shot launch intent (CLI args). The shell calls this on mount and
/// materializes the requested tabs.
#[tauri::command]
pub fn launch_intent(intent: State<'_, LaunchIntent>) -> LaunchIntent {
    intent.inner().clone()
}

/// Preview what a Chrome import would bring over (bookmark/extension counts
/// per profile). The actual import is `chrome_import_bookmarks`.
#[tauri::command]
pub fn chrome_import_preview() -> Result<Vec<flux_import::chrome::ProfilePreview>, String> {
    flux_import::chrome::discover_profiles().map_err(|e| e.to_string())
}

/// Import bookmarks from a Chrome profile. Returns the flattened list; the
/// shell persists them to the Flux bookmark store (BACKLOG #22).
#[tauri::command]
pub fn chrome_import_bookmarks(
    profile_dir: String,
) -> Result<Vec<flux_import::chrome::Bookmark>, String> {
    flux_import::chrome::read_bookmarks(std::path::Path::new(&profile_dir))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tab_focus(state: State<'_, FluxState>, id: TabId) {
    state.set_active_tab(id);
    state.persist();
}

#[tauri::command]
pub fn tab_close(state: State<'_, FluxState>, id: TabId) {
    state.tabs.remove(&id);
    state.dom_cache.remove(&id);
    state.persist();
}

#[tauri::command]
pub fn tab_list(state: State<'_, FluxState>) -> Vec<TabMeta> {
    // Ordered by id (== creation order) so the tab strip is stable across reads
    // and restores (DashMap iteration order is otherwise arbitrary).
    let mut tabs: Vec<TabMeta> = state.tabs.iter().map(|e| e.value().clone()).collect();
    tabs.sort_by_key(|t| t.id);
    tabs
}

// ─── DOM snapshot ingestion (tab webview → Rust) ────────────────────────────
//
// Plain JSON args, NOT a raw ArrayBuffer body. Real pages set restrictive CSPs
// (e.g. DuckDuckGo's `connect-src`), which block Tauri's fetch-based IPC and
// force the `postMessage` fallback — and that path does not carry a raw body.
// JSON args survive both paths. (The zero-copy raw-body idea from ADR 0001
// only worked from the local chrome origin; it can't work from arbitrary
// remote pages.)

#[tauri::command]
pub fn dom_publish(
    app: AppHandle,
    state: State<'_, FluxState>,
    tab_id: TabId,
    url: String,
    html: String,
    text: String,
) -> Result<(), String> {
    let snapshot = Arc::new(DomSnapshot {
        tab: tab_id,
        url,
        html: Arc::from(html),
        text: Arc::from(text),
        captured_at_ms: now_ms(),
    });
    state.dom_cache.insert(tab_id, snapshot);

    // Nudge interested panes (terminal env bar, agent sidebar).
    app.emit("flux://dom-updated", tab_id).map_err(|e| e.to_string())
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

fn dirs_download() -> String {
    // Real impl: `dirs::download_dir()`. Kept dependency-free in the scaffold.
    std::env::var("HOME").map(|h| format!("{h}/Downloads")).unwrap_or_else(|_| ".".into())
}

// ─── Flux Agent ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_status(state: State<'_, FluxState>) -> AgentStatus {
    state.agent.read().clone()
}

/// Free-form chat with the local model — no page required. If a page is open,
/// its visible text is passed as context so you can ask *about* the page.
/// Returns the model's text reply.
#[tauri::command]
pub async fn agent_chat(state: State<'_, FluxState>, prompt: String) -> Result<String, String> {
    // Clone the page text out (if any) so the blocking task owns it.
    let page = state.active_snapshot().map(|s| Arc::clone(&s.text));
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().chat(&prompt, page.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Natural language → planned DOM action → JS injected into the active tab's
/// webview. Async so a 12B model's planning latency never blocks the IPC pool.
#[tauri::command]
pub async fn agent_execute(
    app: AppHandle,
    state: State<'_, FluxState>,
    prompt: String,
) -> Result<flux_agent::AgentAction, String> {
    let snap = state.active_snapshot().ok_or("no page context — open a tab first")?;
    let tab = snap.tab;

    // 1. Flip to Thinking — frontend swaps the sidebar to the kinetic gradient.
    *state.agent.write() = AgentStatus::Thinking { prompt: prompt.clone() };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());

    // 2. Plan on a blocking thread: inference is CPU/GPU-bound and must not
    //    starve the async runtime. `Arc<str>` clone = pointer copy, not text.
    let page_text = Arc::clone(&snap.text);
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan(&prompt, &page_text)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        *state.agent.write() = AgentStatus::Error { message: e.to_string() };
        let _ = app.emit("flux://agent-status", state.agent.read().clone());
        e.to_string()
    })?;

    // 3. Compile to JS and inject into the tab's webview. The compiled script
    //    first paints the magenta highlight, then performs the action.
    *state.agent.write() = AgentStatus::Acting {
        description: action.describe(),
        selector: action.selector().unwrap_or_default().to_owned(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());

    let js = action.to_js();
    let webview = app
        .get_webview(&format!("tab-{tab}"))
        .ok_or_else(|| format!("webview tab-{tab} not found"))?;
    webview.eval(&js).map_err(|e| e.to_string())?;

    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

// ─── Semantic tab clustering ────────────────────────────────────────────────

/// Re-embed all tabs and broadcast new cluster assignments. Runs off-thread;
/// completes in <5 ms/tab (budget) so it's triggered on every dom_publish
/// debounced at 2 s by the frontend.
#[tauri::command]
pub async fn tabs_recluster(app: AppHandle, state: State<'_, FluxState>) -> Result<(), String> {
    // Pinned tabs keep their deliberate rail position and Terminal tabs have
    // no document — neither participates in clustering.
    let docs: Vec<(TabId, Arc<str>)> = state
        .dom_cache
        .iter()
        .filter(|e| {
            state
                .tabs
                .get(e.key())
                .is_some_and(|t| !t.pinned && t.kind == TabKind::Browser)
        })
        .map(|e| (*e.key(), Arc::clone(&e.value().text)))
        .collect();

    let assignments = tauri::async_runtime::spawn_blocking(move || {
        flux_embed::cluster(&docs)
    })
    .await
    .map_err(|e| e.to_string())?;

    for (tab, tag) in assignments {
        if let Some(mut meta) = state.tabs.get_mut(&tab) {
            meta.cluster = Some(crate::state::ClusterTag { id: tag.id, color: tag.color });
        }
    }
    app.emit("flux://clusters-updated", ()).map_err(|e| e.to_string())
}
