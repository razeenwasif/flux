//! Tauri IPC surface.
//!
//! Hot-path rule (ADR 0001): anything that can be multi-KB travels as raw
//! bytes — `tauri::ipc::Request` (raw body in) / `tauri::ipc::Response`
//! (ArrayBuffer out). JSON is reserved for small control messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::cli::LaunchIntent;
use crate::state::{
    AgentStatus, Container, DomSnapshot, FluxState, TabFolder, TabGroup, TabId, TabKind, TabMeta,
    WebPanel, Workspace,
};

/// Process-wide monotonic clock origin for snapshot staleness stamps.
static BOOT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
fn now_ms() -> u64 {
    BOOT.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, specta::Type)]
pub struct ShellSnapshot {
    pub tabs: Vec<TabMeta>,
    pub active_tab: Option<TabId>,
    pub groups: Vec<TabGroup>,
    pub folders: Vec<TabFolder>,
    pub workspaces: Vec<Workspace>,
    pub active_workspace: u32,
    pub panels: Vec<WebPanel>,
    pub containers: Vec<Container>,
}

/// One startup/refresh payload for the shell chrome. This replaces the previous
/// fanout of tab_list + tab_active + groups/folders/workspaces/panels/containers.
#[tauri::command]
pub fn shell_snapshot(state: State<'_, FluxState>) -> ShellSnapshot {
    ShellSnapshot {
        tabs: state.ordered_tabs(),
        active_tab: state.active_tab(),
        groups: state.groups_list(),
        folders: state.folders_list(),
        workspaces: state.workspaces_list(),
        active_workspace: state.active_workspace(),
        panels: state.panels_list(),
        containers: state.containers_list(),
    }
}

/// Register a new tab of either kind. For Browser tabs the frontend creates
/// the child webview (labelled `tab-{id}`) once this returns; for Terminal
/// tabs flux-core spawns a PTY session (BACKLOG #3) with `terminal_env`.
#[tauri::command]
pub fn tab_create(state: State<'_, FluxState>, kind: TabKind, url: Option<String>, private: Option<bool>, container: Option<u32>) -> TabMeta {
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
    let meta = TabMeta { id, kind, url, title, pinned: false, cluster: None, group: None, folder: None, custom_title: None, workspace: state.active_workspace(), private: private.unwrap_or(false), container: container.unwrap_or(0) };
    state.tabs.insert(id, meta.clone());
    state.order_push(id);
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
pub fn tab_focus(app: AppHandle, state: State<'_, FluxState>, id: TabId) {
    state.set_active_tab(id);
    state.persist();
    // Keep the terminal's page-context file pointed at what you're looking at (#65/#4).
    crate::rpc::publish_active(&app);
}

#[tauri::command]
pub fn tab_close(state: State<'_, FluxState>, id: TabId) {
    state.tabs.remove(&id);
    state.dom_cache.remove(&id);
    state.order_remove(id);
    state.persist();
}

#[tauri::command]
pub fn tab_list(state: State<'_, FluxState>) -> Vec<TabMeta> {
    // In explicit display order (#30) — the user can drag-reorder.
    state.ordered_tabs()
}

/// Reorder the tab strip (BACKLOG #30): `ids` is the new full order; any live
/// tab omitted is kept (appended) so nothing vanishes.
#[tauri::command]
pub fn tab_reorder(state: State<'_, FluxState>, ids: Vec<TabId>) {
    state.set_order(ids);
    state.persist();
}

// ─── Tab groups (BACKLOG #56) ────────────────────────────────────────────────

#[tauri::command]
pub fn groups_list(state: State<'_, FluxState>) -> Vec<crate::state::TabGroup> {
    state.groups_list()
}

/// Create a group (optionally seeded with `tab_ids`); returns its id.
#[tauri::command]
pub fn group_create(state: State<'_, FluxState>, name: String, color: u32, tab_ids: Vec<TabId>) -> u32 {
    let id = state.group_create(name, color);
    for t in tab_ids {
        state.set_tab_group(t, Some(id));
    }
    state.persist();
    id
}

#[tauri::command]
pub fn group_update(
    state: State<'_, FluxState>,
    id: u32,
    name: Option<String>,
    color: Option<u32>,
    collapsed: Option<bool>,
) {
    state.group_update(id, name, color, collapsed);
    state.persist();
}

#[tauri::command]
pub fn group_delete(state: State<'_, FluxState>, id: u32) {
    state.group_delete(id);
    state.persist();
}

/// Add a tab to a group (`group = None` removes it).
#[tauri::command]
pub fn tab_set_group(state: State<'_, FluxState>, tab_id: TabId, group: Option<u32>) {
    state.set_tab_group(tab_id, group);
    state.persist();
}

// ─── Tab folders (hibernated parking buckets) ────────────────────────────────

#[tauri::command]
pub fn folders_list(state: State<'_, FluxState>) -> Vec<crate::state::TabFolder> {
    state.folders_list()
}

#[tauri::command]
pub fn folder_create(state: State<'_, FluxState>, name: String) -> u32 {
    let id = state.folder_create(name);
    state.persist();
    id
}

#[tauri::command]
pub fn folder_update(state: State<'_, FluxState>, id: u32, name: Option<String>, collapsed: Option<bool>) {
    state.folder_update(id, name, collapsed);
    state.persist();
}

#[tauri::command]
pub fn folder_delete(state: State<'_, FluxState>, id: u32) {
    state.folder_delete(id);
    state.persist();
}

/// Move a tab into a folder (`folder = None` removes it). The shell hibernates
/// folder members so they cost ≈0 RAM.
#[tauri::command]
pub fn tab_set_folder(state: State<'_, FluxState>, tab_id: TabId, folder: Option<u32>) {
    state.set_tab_folder(tab_id, folder);
    state.persist();
}

/// Rename a tab (a user-chosen name that overrides the page title). Empty name
/// clears it (revert to the page title).
#[tauri::command]
pub fn tab_rename(state: State<'_, FluxState>, tab_id: TabId, name: Option<String>) {
    state.set_tab_custom_title(tab_id, name);
    state.persist();
}

/// Send a tab to another workspace (#44). Returns the tab's prior webview is the
/// shell's concern; here we just move the metadata + detach it from any group.
#[tauri::command]
pub fn tab_set_workspace(state: State<'_, FluxState>, tab_id: TabId, workspace: u32) {
    state.set_tab_workspace(tab_id, workspace);
    state.persist();
}

/// Send a whole group (all member tabs) to another workspace (#44). Returns the
/// moved tab ids so the shell can hibernate their webviews if they left the
/// active workspace.
#[tauri::command]
pub fn group_set_workspace(state: State<'_, FluxState>, group: u32, workspace: u32) -> Vec<TabId> {
    let moved = state.set_group_workspace(group, workspace);
    state.persist();
    moved
}

/// "Group by topic" — seed groups from the semantic clusters. Returns the count.
#[tauri::command]
pub fn groups_from_clusters(state: State<'_, FluxState>) -> usize {
    let n = state.groups_from_clusters();
    state.persist();
    n
}

// ─── Workspaces (BACKLOG #44) ────────────────────────────────────────────────

#[tauri::command]
pub fn workspaces_list(state: State<'_, FluxState>) -> Vec<crate::state::Workspace> {
    state.workspaces_list()
}

#[tauri::command]
pub fn workspace_active(state: State<'_, FluxState>) -> u32 {
    state.active_workspace()
}

#[tauri::command]
pub fn workspace_switch(state: State<'_, FluxState>, id: u32) {
    state.set_active_workspace(id);
    state.persist();
}

#[tauri::command]
pub fn workspace_create(state: State<'_, FluxState>, name: String, color: u32) -> u32 {
    let id = state.workspace_create(name, color);
    state.persist();
    id
}

#[tauri::command]
pub fn workspace_update(state: State<'_, FluxState>, id: u32, name: Option<String>, color: Option<u32>) {
    state.workspace_update(id, name, color);
    state.persist();
}

/// Delete a workspace + its tabs; returns the closed tab ids (so the shell tears
/// down their webviews).
#[tauri::command]
pub fn workspace_delete(state: State<'_, FluxState>, id: TabId) -> Vec<TabId> {
    let closed = state.workspace_delete(id as u32);
    state.persist();
    closed
}

// ─── Multi-account containers (BACKLOG #59) ──────────────────────────────────

#[tauri::command]
pub fn containers_list(state: State<'_, FluxState>) -> Vec<crate::state::Container> {
    state.containers_list()
}

#[tauri::command]
pub fn container_create(state: State<'_, FluxState>, name: String, color: u32) -> u32 {
    let id = state.container_create(name, color);
    state.persist();
    id
}

#[tauri::command]
pub fn container_update(state: State<'_, FluxState>, id: u32, name: Option<String>, color: Option<u32>) {
    state.container_update(id, name, color);
    state.persist();
}

#[tauri::command]
pub fn container_delete(state: State<'_, FluxState>, id: u32) {
    state.container_delete(id);
    state.persist();
}

// ─── Web panels (BACKLOG #48) ────────────────────────────────────────────────

#[tauri::command]
pub fn panels_list(state: State<'_, FluxState>) -> Vec<crate::state::WebPanel> {
    state.panels_list()
}

#[tauri::command]
pub fn panel_add(state: State<'_, FluxState>, url: String, title: String) -> crate::state::WebPanel {
    let p = state.panel_add(url, title);
    state.persist();
    p
}

#[tauri::command]
pub fn panel_remove(state: State<'_, FluxState>, id: u32) {
    state.panel_remove(id);
    state.persist();
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
fn cap_utf8(mut s: String, max: usize) -> String {
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

/// Ask the local model to turn a natural-language request into a shell command
/// (e.g. "list the files in my home directory" → `ls ~`), or `None` if it's a
/// conversational request. The frontend proposes the command with a Run/Cancel
/// approval card; nothing executes here.
#[tauri::command]
pub async fn agent_shell_plan(prompt: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan_shell(&prompt).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Plan a file edit (search/replace pairs) from a natural-language instruction. The
/// frontend applies the edits, shows a diff, and writes only after the user approves.
#[tauri::command]
pub async fn agent_edit_plan(path: String, content: String, instruction: String) -> Result<flux_agent::EditPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan_edit(&path, &content, &instruction).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streaming chat (BACKLOG #82): same as [`agent_chat`] but relays each token to
/// the frontend over `on_token` as the model generates it, so the sidebar renders
/// the reply live. Resolves when the completion ends.
#[tauri::command]
pub async fn agent_chat_stream(
    state: State<'_, FluxState>,
    prompt: String,
    on_token: Channel<String>,
) -> Result<(), String> {
    let page = state.active_snapshot().map(|s| Arc::clone(&s.text));
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut sink = |tok: &str| {
            let _ = on_token.send(tok.to_string()); // ignore if the frontend dropped it
        };
        crate::agent_bridge::planner()
            .chat_stream(&prompt, page.as_deref(), &mut sink)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Translate the active page's visible text to `target` with the local model
/// (BACKLOG #40). Private — no cloud translation service.
#[tauri::command]
pub async fn agent_translate(state: State<'_, FluxState>, target: String) -> Result<String, String> {
    let page = state.active_snapshot().ok_or("open a page to translate")?;
    if page.text.trim().is_empty() {
        return Err("this page has no readable text".into());
    }
    let text = Arc::clone(&page.text);
    tauri::async_runtime::spawn_blocking(move || crate::agent_bridge::planner().translate(&target, &text))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// List the models the local Ollama server has pulled (#81).
#[tauri::command]
pub async fn agent_models() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(flux_agent::ollama::list_models).await.unwrap_or_default()
}

/// The model the agent is currently using (#81).
#[tauri::command]
pub fn agent_model() -> String {
    flux_agent::ollama::active_model()
}

/// Switch the agent's model (#81); empty reverts to the env/default.
#[tauri::command]
pub fn agent_set_model(name: String) {
    flux_agent::ollama::set_model(&name);
}

/// Chat grounded in the captured text of several tabs (chat-with-tabs). Gathers
/// each tab's cached DOM text (capped per tab), labels it, and asks the local
/// model. Tabs without a snapshot yet are skipped.
#[tauri::command]
pub async fn agent_chat_tabs(state: State<'_, FluxState>, prompt: String, tab_ids: Vec<TabId>) -> Result<String, String> {
    const PER_TAB: usize = 4 * 1024;
    let mut combined = String::new();
    for id in tab_ids {
        let Some(snap) = state.dom_cache.get(&id) else { continue };
        let title = state.tabs.get(&id).map(|t| t.title.clone()).filter(|t| !t.trim().is_empty());
        let label = title.unwrap_or_else(|| snap.url.to_string());
        combined.push_str(&format!("--- TAB: {label} ({}) ---\n", snap.url));
        combined.push_str(&cap_utf8(snap.text.to_string(), PER_TAB));
        combined.push_str("\n\n");
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().chat_pages(&prompt, &combined)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Streaming counterpart of [`agent_chat_tabs`] (BACKLOG #82) — gathers the same
/// per-tab context, then relays the model's tokens live over `on_token`.
#[tauri::command]
pub async fn agent_chat_tabs_stream(
    state: State<'_, FluxState>,
    prompt: String,
    tab_ids: Vec<TabId>,
    on_token: Channel<String>,
) -> Result<(), String> {
    const PER_TAB: usize = 4 * 1024;
    let mut combined = String::new();
    for id in tab_ids {
        let Some(snap) = state.dom_cache.get(&id) else { continue };
        let title = state.tabs.get(&id).map(|t| t.title.clone()).filter(|t| !t.trim().is_empty());
        let label = title.unwrap_or_else(|| snap.url.to_string());
        combined.push_str(&format!("--- TAB: {label} ({}) ---\n", snap.url));
        combined.push_str(&cap_utf8(snap.text.to_string(), PER_TAB));
        combined.push_str("\n\n");
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut sink = |tok: &str| {
            let _ = on_token.send(tok.to_string());
        };
        crate::agent_bridge::planner()
            .chat_pages_stream(&prompt, &combined, &mut sink)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One unified search result (BACKLOG #66): an open tab, a bookmark, or a
/// history entry, ranked together by embedding similarity to the query.
#[derive(serde::Serialize, specta::Type)]
pub struct OmniHit {
    pub kind: String, // "tab" | "bookmark" | "history"
    pub tab_id: Option<TabId>,
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub score: f32,
}

/// Cosine of two L2-normalized embeddings (flux_embed vectors are unit length).
fn cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// A short context snippet around the first query token in `text`.
fn snippet(text: &str, toks: &[&str]) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lower = text.to_lowercase();
    match toks.iter().filter_map(|t| lower.find(t)).min() {
        Some(p) => {
            let start = text[..p].char_indices().rev().nth(40).map(|(i, _)| i).unwrap_or(0);
            let end = text[p..].char_indices().nth(120).map(|(i, _)| p + i).unwrap_or(text.len());
            format!("…{}…", text[start..end].split_whitespace().collect::<Vec<_>>().join(" "))
        }
        None => text.split_whitespace().take(18).collect::<Vec<_>>().join(" "),
    }
}

/// Semantic everything-search (BACKLOG #66): one query ranked across open tabs
/// (by title + captured page CONTENT), bookmarks, and history, using the local
/// embedder (#11 will swap in a stronger model). Large corpora (history,
/// bookmarks) are lexically pre-filtered before embedding so this stays cheap
/// per keystroke. NB: the hashing embedder ranks by lexical/topical overlap, not
/// true synonymy — that arrives with #11.
#[tauri::command]
pub fn omni_search(
    state: State<'_, FluxState>,
    history: State<'_, crate::history::HistoryStore>,
    bookmarks: State<'_, crate::bookmarks::BookmarkStore>,
    query: String,
    limit: Option<usize>,
) -> Vec<OmniHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let qe = flux_embed::embed(q);
    let ql = q.to_lowercase();
    let toks: Vec<&str> = ql.split(|c: char| !c.is_alphanumeric()).filter(|t| t.len() >= 2).collect();
    let lex = |s: &str| {
        let s = s.to_lowercase();
        toks.iter().any(|t| s.contains(t))
    };
    let mut hits: Vec<OmniHit> = Vec::new();

    // Open tabs — embed title + cached page text (this is the page-CONTENT search
    // that's weak in other browsers). A title/url lexical hit gets a boost.
    for t in state.tabs.iter() {
        if !matches!(t.kind, TabKind::Browser) {
            continue;
        }
        let text = state.dom_cache.get(&t.id).map(|s| s.text.to_string()).unwrap_or_default();
        let e = flux_embed::embed(&format!("{} {}", t.title, text));
        let mut score = cos(&qe, &e);
        if lex(&t.title) || lex(&t.url) {
            score += 0.3;
        }
        // Skip near-zero matches so the list isn't padded with every open tab.
        if score < 0.08 {
            continue;
        }
        hits.push(OmniHit {
            kind: "tab".into(),
            tab_id: Some(t.id),
            title: t.title.clone(),
            url: t.url.clone(),
            snippet: snippet(&text, &toks),
            score,
        });
    }

    // Bookmarks — lexical pre-filter, then embed (user-curated, lightly favored).
    for b in bookmarks.list() {
        if !lex(&b.title) && !lex(&b.url) && !lex(&b.folder) {
            continue;
        }
        let e = flux_embed::embed(&format!("{} {} {}", b.title, b.folder, b.url));
        let mut score = cos(&qe, &e) + 0.12;
        if lex(&b.title) {
            score += 0.2;
        }
        hits.push(OmniHit { kind: "bookmark".into(), tab_id: None, title: b.title, url: b.url, snippet: b.folder, score });
    }

    // History — `search` already lexical-filters + frecency-ranks; embed the top.
    for h in history.search(q, 60) {
        let e = flux_embed::embed(&format!("{} {}", h.title, h.url));
        hits.push(OmniHit { kind: "history".into(), tab_id: None, title: h.title, url: h.url, snippet: String::new(), score: cos(&qe, &e) });
    }

    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit.unwrap_or(14));
    hits
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

/// Plan a page action WITHOUT executing it (BACKLOG #8): the frontend previews
/// the proposed action and asks the user to approve before anything touches the
/// page. Returns the planned action; status returns to Idle (we're awaiting
/// confirmation, not acting).
#[tauri::command]
pub async fn agent_plan(app: AppHandle, state: State<'_, FluxState>, prompt: String) -> Result<flux_agent::AgentAction, String> {
    let snap = state.active_snapshot().ok_or("no page context — open a tab first")?;
    *state.agent.write() = AgentStatus::Thinking { prompt: prompt.clone() };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let page_text = Arc::clone(&snap.text);
    let action = tauri::async_runtime::spawn_blocking(move || crate::agent_bridge::planner().plan(&prompt, &page_text))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            *state.agent.write() = AgentStatus::Error { message: e.to_string() };
            let _ = app.emit("flux://agent-status", state.agent.read().clone());
            e.to_string()
        })?;
    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

/// Plan the **next step** of a multi-step task (BACKLOG #A). The frontend agent
/// loop drives this: it passes the high-level `goal` and the list of steps
/// already taken (`history`), and gets back the single next `AgentAction` —
/// `finish` when done, `refuse` if stuck. Like `agent_plan`, this does NOT touch
/// the page; the frontend previews the step and runs it via `agent_run_action`
/// only after the user approves (or in "run all" mode, after the destructive
/// guard clears). Reads the **live** active-tab snapshot every call, so cross-
/// page tasks work as navigation republishes the DOM.
#[tauri::command]
pub async fn agent_task_step(
    app: AppHandle,
    state: State<'_, FluxState>,
    goal: String,
    history: Vec<String>,
) -> Result<flux_agent::AgentAction, String> {
    let snap = state.active_snapshot().ok_or("no page context — open a tab first")?;
    *state.agent.write() = AgentStatus::Thinking { prompt: goal.clone() };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let page_text = Arc::clone(&snap.text);
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan_step(&goal, &page_text, &history)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        *state.agent.write() = AgentStatus::Error { message: e.to_string() };
        let _ = app.emit("flux://agent-status", state.agent.read().clone());
        e.to_string()
    })?;
    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

/// Execute a previously-planned action that the user approved (BACKLOG #8).
/// Compiles it to JS (the script paints the magenta highlight, then acts) and
/// injects it into the active tab's webview.
#[tauri::command]
pub async fn agent_run_action(app: AppHandle, state: State<'_, FluxState>, action: flux_agent::AgentAction) -> Result<flux_agent::AgentAction, String> {
    let tab = state.active_tab().ok_or("no active tab")?;
    // #104: flag destructive intent for the activity feed. The compiled click
    // JS independently re-checks the element's *live* label and aborts there —
    // this annotation is the user-facing heads-up, not the enforcement point.
    let description = match action.is_destructive() {
        Some(term) => {
            tracing::warn!(target: "flux::agent", term, "destructive action queued — guard will verify the live label");
            format!("⚠ {} (destructive: “{term}” — Flux will block it if the control confirms it)", action.describe())
        }
        None => action.describe(),
    };
    *state.agent.write() = AgentStatus::Acting {
        description,
        selector: action.selector().unwrap_or_default().to_owned(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let webview = app
        .get_webview(&format!("tab-{tab}"))
        .ok_or_else(|| format!("webview tab-{tab} not found"))?;
    webview.eval(&action.to_js()).map_err(|e| e.to_string())?;
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
