//! Shell-chrome IPC — tab lifecycle, groups, folders, workspaces, containers,
//! web panels, and semantic tab clustering. DOM ingestion lives in `dom.rs`;
//! the agent surface in `agent.rs` (Phase 2 refactor split).
//!
//! Hot-path rule (ADR 0001): anything that can be multi-KB travels as raw
//! bytes — `tauri::ipc::Request` (raw body in) / `tauri::ipc::Response`
//! (ArrayBuffer out). JSON is reserved for small control messages.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::cli::LaunchIntent;
use crate::state::{
    Container, FluxState, TabFolder, TabGroup, TabId, TabKind, TabMeta, WebPanel, Workspace,
};

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
/// Save the window's size/position (via the window-state plugin) **then** close it.
/// The titlebar ✕ calls this instead of a raw `destroy()`, which skips the plugin's
/// save-on-close and lost the restore-on-next-launch geometry.
#[tauri::command]
pub fn close_main_window(app: AppHandle, window: tauri::WebviewWindow) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::all());
    let _ = window.destroy();
}

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
pub fn tab_create(
    state: State<'_, FluxState>,
    kind: TabKind,
    url: Option<String>,
    private: Option<bool>,
    container: Option<u32>,
) -> TabMeta {
    let id = state.alloc_tab_id();
    let (url, title) = match kind {
        // No url → the Flux start page (the frontend renders the dashboard and
        // opens no webview for `flux://start`).
        TabKind::Browser => (url.unwrap_or_else(|| "flux://start".into()), String::new()),
        // Terminal tabs carry their cwd in `url`; title mirrors the shell.
        TabKind::Terminal => (crate::dom::dirs_download(), format!("term #{id}")),
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
    let meta = TabMeta {
        id,
        kind,
        url,
        title,
        pinned: false,
        cluster: None,
        group: None,
        folder: None,
        custom_title: None,
        workspace: state.active_workspace(),
        private: private.unwrap_or(false),
        container: container.unwrap_or(0),
    };
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
pub fn tab_close(app: AppHandle, state: State<'_, FluxState>, id: TabId) {
    state.tabs.remove(&id);
    state.dom_cache.remove(&id);
    state.order_remove(id);
    // Drop the tab's Trail pointer so its id can't seed a stale nav edge (#ADR-0011).
    if let Some(tr) = app.try_state::<crate::trace::TraceStore>() {
        tr.tab_closed(id);
    }
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
pub fn group_create(
    state: State<'_, FluxState>,
    name: String,
    color: u32,
    tab_ids: Vec<TabId>,
) -> u32 {
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
pub fn folder_update(
    state: State<'_, FluxState>,
    id: u32,
    name: Option<String>,
    collapsed: Option<bool>,
) {
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
pub fn workspace_update(
    state: State<'_, FluxState>,
    id: u32,
    name: Option<String>,
    color: Option<u32>,
) {
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
pub fn container_update(
    state: State<'_, FluxState>,
    id: u32,
    name: Option<String>,
    color: Option<u32>,
) {
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
pub fn panel_add(
    state: State<'_, FluxState>,
    url: String,
    title: String,
) -> crate::state::WebPanel {
    let p = state.panel_add(url, title);
    state.persist();
    p
}

#[tauri::command]
pub fn panel_remove(state: State<'_, FluxState>, id: u32) {
    state.panel_remove(id);
    state.persist();
}

/// Reorder pinned panels to match `ids` (drag-to-reorder in the app rail).
#[tauri::command]
pub fn panel_reorder(state: State<'_, FluxState>, ids: Vec<u32>) {
    state.panel_reorder(ids);
    state.persist();
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

    let assignments = tauri::async_runtime::spawn_blocking(move || flux_embed::cluster(&docs))
        .await
        .map_err(|e| e.to_string())?;

    for (tab, tag) in assignments {
        if let Some(mut meta) = state.tabs.get_mut(&tab) {
            meta.cluster = Some(crate::state::ClusterTag {
                id: tag.id,
                color: tag.color,
            });
        }
    }
    app.emit("flux://clusters-updated", ())
        .map_err(|e| e.to_string())
}
