//! Flux shared state.
//!
//! Design constraints (see ADR 0001):
//!   * DOM snapshots are multi-MB and consumed by THREE subsystems (terminal
//!     env, agent context, embedder). They are stored exactly once as
//!     `Arc<DomSnapshot>` — consumers clone the Arc (8 bytes), never the data.
//!   * Tab metadata is read on every UI frame but written rarely → `DashMap`
//!     gives lock-free sharded reads; no global RwLock convoy on the tab strip.
//!   * The active-tab pointer is an `AtomicU64` — read on literally every IPC
//!     call, so it must never take a lock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// Monotonic tab identifier. Also used as the Tauri webview label suffix
/// (`tab-{id}`), which is how Rust addresses a tab's webview for `eval()`.
pub type TabId = u64;

/// What lives inside a tab. Flux tabs are first-class for BOTH web pages and
/// terminal sessions — a Terminal tab hosts a flux-term surface where a
/// Browser tab hosts a webview, and everything else (pinning, clustering,
/// focus) treats them identically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TabKind {
    Browser,
    Terminal,
    /// Read-only filesystem explorer (ADR 0006). Its `url` holds the cwd.
    Files,
}

/// Metadata for one open tab. Small (~100 B) and `Clone` — cheap to hand to
/// the frontend wholesale on every mutation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TabMeta {
    pub id: TabId,
    pub kind: TabKind,
    /// Page URL for Browser tabs; working directory for Terminal tabs.
    pub url: String,
    pub title: String,
    /// Arc-style pinned tabs: rendered as squares in the left rail, survive
    /// session restore, and are excluded from semantic clustering.
    pub pinned: bool,
    /// Semantic cluster assigned by `flux-embed`. `None` until first embed.
    pub cluster: Option<ClusterTag>,
    /// Manual tab group (BACKLOG #56). `None` = ungrouped.
    #[serde(default)]
    pub group: Option<u32>,
    /// Tab folder. Members are kept **hibernated** (≈0 RAM) and rendered in a
    /// collapsible section above the footer, not in the strip. `None` = loose.
    #[serde(default)]
    pub folder: Option<u32>,
    /// User-set tab name that overrides the page title in the UI (`None` = use
    /// the page title). Survives page-title updates from `dom_publish`.
    #[serde(default)]
    pub custom_title: Option<String>,
    /// Workspace this tab belongs to (BACKLOG #44). Defaults to workspace 1.
    #[serde(default = "default_workspace")]
    pub workspace: u32,
    /// Private/incognito tab (BACKLOG #59): its webview uses an in-memory session
    /// (no persisted cookies/storage, wiped on close) and it's never recorded in
    /// history. Not persisted across restart (ephemeral by definition).
    #[serde(default)]
    pub private: bool,
    /// Multi-account container (BACKLOG #59). 0 = Default (shared jar).
    #[serde(default)]
    pub container: u32,
}

fn default_workspace() -> u32 {
    1
}

/// An Arc-style workspace (BACKLOG #44): a named, colored set of tabs. Only the
/// active workspace's tabs hold live webviews — inactive ones are pure metadata
/// (kilobytes), so switching is cheap.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Workspace {
    pub id: u32,
    pub name: String,
    /// 0xRRGGBB accent.
    pub color: u32,
}

/// A multi-account container (BACKLOG #59): tabs in a container share an isolated
/// cookie/storage jar (a per-webview `data_directory`), so you can be logged into
/// two accounts of the same site at once. Container 0 = "Default" (implicit, no
/// isolation) and is never stored here.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Container {
    pub id: u32,
    pub name: String,
    /// 0xRRGGBB accent.
    pub color: u32,
}

/// A pinned web panel (BACKLOG #48): a site (chat, docs, music, …) you can show
/// in a slim pane beside any tab. Persists across restart; only the *open* panel
/// holds a live webview (RAM-conscious — inactive pins are just metadata).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WebPanel {
    pub id: u32,
    pub url: String,
    pub title: String,
}

/// A manual, user-controlled tab group (BACKLOG #56) — named, colored,
/// collapsible. Distinct from the auto semantic `cluster`, though "group by
/// topic" can seed groups from clusters.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TabGroup {
    pub id: u32,
    pub name: String,
    /// 0xRRGGBB.
    pub color: u32,
    #[serde(default)]
    pub collapsed: bool,
}

/// A tab folder — a named bucket whose tabs are kept hibernated to save RAM.
/// Distinct from [`TabGroup`] (inline, colored, strip-resident): folders live in
/// a collapsible section above the footer and exist to park tabs out of memory.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TabFolder {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
}

/// A semantic cluster: stable id + the display color the UI paints the tab.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct ClusterTag {
    pub id: u32,
    /// 0xRRGGBB, picked from the Flux palette by flux-embed.
    pub color: u32,
}

/// One captured DOM state of a tab. Immutable after construction — that
/// immutability is what makes the Arc-sharing safe and copy-free.
#[derive(Debug)]
pub struct DomSnapshot {
    pub tab: TabId,
    pub url: String,
    /// Serialized outerHTML, captured by the injected capture script.
    /// `Arc<str>` (not `String`) so even substring consumers share storage.
    pub html: Arc<str>,
    /// Visible-text extraction (what the agent and embedder actually read —
    /// feeding raw HTML to a 12B model wastes its entire context window).
    pub text: Arc<str>,
    /// Milliseconds since boot (monotonic), for staleness checks.
    pub captured_at_ms: u64,
}

/// What the Flux Agent is currently doing. The UI maps this 1:1 to the
/// magenta/violet "Liquid AI" visual states.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AgentStatus {
    #[default]
    Idle,
    /// Model is generating; UI shows the kinetic gradient.
    Thinking { prompt: String },
    /// Action compiled and injected; UI flash-highlights the selector.
    Acting { description: String, selector: String },
    Error { message: String },
}

/// Root application state, managed by Tauri (`app.manage(FluxState::new())`)
/// and injected into every `#[tauri::command]` as `State<'_, FluxState>`.
pub struct FluxState {
    /// Currently focused tab. 0 = no tab.
    active_tab: AtomicU64,
    /// Next tab id to hand out.
    next_tab_id: AtomicU64,
    /// All open tabs. DashMap → tab-strip reads never block tab mutations.
    pub tabs: DashMap<TabId, TabMeta>,
    /// Latest DOM snapshot per tab. Replacing an entry drops the old Arc
    /// only once every consumer has released it — no use-after-free, no copy.
    pub dom_cache: DashMap<TabId, Arc<DomSnapshot>>,
    /// Agent status — written by the agent task, read by UI/status commands.
    pub agent: RwLock<AgentStatus>,
    /// Explicit tab display order (BACKLOG #30) — the user can drag-reorder, so
    /// this is the source of truth for ordering rather than tab id.
    order: RwLock<Vec<TabId>>,
    /// Manual tab groups (BACKLOG #56).
    groups: RwLock<Vec<TabGroup>>,
    next_group_id: AtomicU64,
    /// Tab folders (hibernated parking buckets).
    folders: RwLock<Vec<TabFolder>>,
    next_folder_id: AtomicU64,
    /// Workspaces (BACKLOG #44) + the active one.
    workspaces: RwLock<Vec<Workspace>>,
    active_workspace: AtomicU64,
    next_workspace_id: AtomicU64,
    /// Pinned web panels (BACKLOG #48).
    panels: RwLock<Vec<WebPanel>>,
    next_panel_id: AtomicU64,
    /// Multi-account containers (BACKLOG #59).
    containers: RwLock<Vec<Container>>,
    next_container_id: AtomicU64,
    /// Where the session is persisted (BACKLOG #19). `None` → no persistence
    /// (tests / the `Default` impl).
    session_path: Option<std::path::PathBuf>,
}

impl FluxState {
    /// In-memory only (no session persistence) — used by tests and `Default`.
    pub fn new() -> Self {
        Self {
            active_tab: AtomicU64::new(0),
            next_tab_id: AtomicU64::new(1),
            tabs: DashMap::new(),
            dom_cache: DashMap::new(),
            agent: RwLock::new(AgentStatus::Idle),
            order: RwLock::new(Vec::new()),
            groups: RwLock::new(Vec::new()),
            next_group_id: AtomicU64::new(1),
            folders: RwLock::new(Vec::new()),
            next_folder_id: AtomicU64::new(1),
            workspaces: RwLock::new(vec![Workspace { id: 1, name: "Personal".into(), color: 0x9d8df1 }]),
            active_workspace: AtomicU64::new(1),
            next_workspace_id: AtomicU64::new(2),
            panels: RwLock::new(Vec::new()),
            next_panel_id: AtomicU64::new(1),
            containers: RwLock::new(Vec::new()),
            next_container_id: AtomicU64::new(1),
            session_path: None,
        }
    }

    /// Boot from a persisted session (BACKLOG #19): repopulate the tabs, the
    /// active tab, and the id counter (bumped past every restored id so new
    /// tabs never collide), then keep persisting to `session_path`.
    pub fn restore(session_path: std::path::PathBuf) -> Self {
        let session = crate::session::load(&session_path);
        let tabs = DashMap::new();
        let mut order = Vec::new();
        let mut max_id = 0;
        for t in session.tabs {
            max_id = max_id.max(t.id);
            order.push(t.id); // the saved sequence IS the display order
            tabs.insert(t.id, t);
        }
        let next = session.next_id.max(max_id + 1).max(1);
        // Only keep the active pointer if that tab actually came back.
        let active = if tabs.contains_key(&session.active) { session.active } else { 0 };
        let next_group = session.groups.iter().map(|g| g.id).max().unwrap_or(0) as u64 + 1;
        let next_folder = session.folders.iter().map(|f| f.id).max().unwrap_or(0) as u64 + 1;
        // Workspaces: seed a default if the session had none (older files).
        let mut workspaces = session.workspaces;
        if workspaces.is_empty() {
            workspaces.push(Workspace { id: 1, name: "Personal".into(), color: 0x9d8df1 });
        }
        let next_ws = workspaces.iter().map(|w| w.id).max().unwrap_or(1) as u64 + 1;
        let active_ws = if workspaces.iter().any(|w| w.id == session.active_workspace) {
            session.active_workspace
        } else {
            workspaces[0].id
        };
        let next_panel = session.panels.iter().map(|p| p.id).max().unwrap_or(0) as u64 + 1;
        let next_container = session.containers.iter().map(|c| c.id).max().unwrap_or(0) as u64 + 1;
        Self {
            active_tab: AtomicU64::new(active),
            next_tab_id: AtomicU64::new(next),
            tabs,
            dom_cache: DashMap::new(),
            agent: RwLock::new(AgentStatus::Idle),
            order: RwLock::new(order),
            groups: RwLock::new(session.groups),
            next_group_id: AtomicU64::new(next_group),
            folders: RwLock::new(session.folders),
            next_folder_id: AtomicU64::new(next_folder),
            workspaces: RwLock::new(workspaces),
            active_workspace: AtomicU64::new(active_ws as u64),
            next_workspace_id: AtomicU64::new(next_ws),
            panels: RwLock::new(session.panels),
            next_panel_id: AtomicU64::new(next_panel),
            containers: RwLock::new(session.containers),
            next_container_id: AtomicU64::new(next_container),
            session_path: Some(session_path),
        }
    }

    /// Tabs in display order (BACKLOG #30): the `order` sequence first, then any
    /// tabs not yet ordered (by id) — defensive against races / older sessions.
    pub fn ordered_tabs(&self) -> Vec<TabMeta> {
        let order = self.order.read();
        let mut out = Vec::with_capacity(self.tabs.len());
        let mut seen = std::collections::HashSet::new();
        for id in order.iter() {
            if let Some(t) = self.tabs.get(id) {
                out.push(t.value().clone());
                seen.insert(*id);
            }
        }
        let mut extra: Vec<TabMeta> =
            self.tabs.iter().filter(|e| !seen.contains(e.key())).map(|e| e.value().clone()).collect();
        extra.sort_by_key(|t| t.id);
        out.extend(extra);
        out
    }

    /// Append a new tab to the end of the order.
    pub fn order_push(&self, id: TabId) {
        let mut o = self.order.write();
        if !o.contains(&id) {
            o.push(id);
        }
    }

    /// Drop a closed tab from the order.
    pub fn order_remove(&self, id: TabId) {
        self.order.write().retain(|x| *x != id);
    }

    /// Replace the order with `ids` (filtered to live tabs; any live tab missing
    /// from `ids` is appended so none is ever dropped from the strip).
    pub fn set_order(&self, ids: Vec<TabId>) {
        let mut next: Vec<TabId> = ids.into_iter().filter(|id| self.tabs.contains_key(id)).collect();
        for e in self.tabs.iter() {
            if !next.contains(e.key()) {
                next.push(*e.key());
            }
        }
        *self.order.write() = next;
    }

    // ── Tab groups (BACKLOG #56) ──────────────────────────────────────────────

    pub fn groups_list(&self) -> Vec<TabGroup> {
        self.groups.read().clone()
    }

    pub fn group_create(&self, name: String, color: u32) -> u32 {
        let id = self.next_group_id.fetch_add(1, Ordering::Relaxed) as u32;
        self.groups.write().push(TabGroup { id, name, color, collapsed: false });
        id
    }

    pub fn group_update(&self, id: u32, name: Option<String>, color: Option<u32>, collapsed: Option<bool>) {
        if let Some(g) = self.groups.write().iter_mut().find(|g| g.id == id) {
            if let Some(n) = name {
                g.name = n;
            }
            if let Some(c) = color {
                g.color = c;
            }
            if let Some(c) = collapsed {
                g.collapsed = c;
            }
        }
    }

    /// Delete a group and ungroup its tabs.
    pub fn group_delete(&self, id: u32) {
        self.groups.write().retain(|g| g.id != id);
        for mut t in self.tabs.iter_mut() {
            if t.group == Some(id) {
                t.group = None;
            }
        }
    }

    pub fn set_tab_group(&self, tab_id: TabId, group: Option<u32>) {
        if let Some(mut t) = self.tabs.get_mut(&tab_id) {
            t.group = group;
        }
    }

    /// Move a single tab to another workspace (send-to-workspace, #44). Detaches
    /// it from any group, since groups are rendered per-workspace — a lone member
    /// stranded in a different space would render as a one-tab group.
    pub fn set_tab_workspace(&self, tab_id: TabId, workspace: u32) {
        if let Some(mut t) = self.tabs.get_mut(&tab_id) {
            t.workspace = workspace;
            t.group = None;
        }
    }

    /// Move an entire group — all its member tabs — to another workspace, keeping
    /// the group intact (it simply renders in the target space now). Returns the
    /// moved tab ids.
    pub fn set_group_workspace(&self, group: u32, workspace: u32) -> Vec<TabId> {
        let mut moved = Vec::new();
        for mut t in self.tabs.iter_mut() {
            if t.group == Some(group) {
                t.workspace = workspace;
                moved.push(t.id);
            }
        }
        moved
    }

    // ── Tab folders (hibernated parking buckets) ─────────────────────────────

    pub fn folders_list(&self) -> Vec<TabFolder> {
        self.folders.read().clone()
    }

    pub fn folder_create(&self, name: String) -> u32 {
        let id = self.next_folder_id.fetch_add(1, Ordering::Relaxed) as u32;
        let name = if name.trim().is_empty() { format!("Folder {id}") } else { name };
        self.folders.write().push(TabFolder { id, name, collapsed: false });
        id
    }

    pub fn folder_update(&self, id: u32, name: Option<String>, collapsed: Option<bool>) {
        if let Some(f) = self.folders.write().iter_mut().find(|f| f.id == id) {
            if let Some(n) = name {
                f.name = n;
            }
            if let Some(c) = collapsed {
                f.collapsed = c;
            }
        }
    }

    /// Delete a folder and detach its tabs (they return to the strip).
    pub fn folder_delete(&self, id: u32) {
        self.folders.write().retain(|f| f.id != id);
        for mut t in self.tabs.iter_mut() {
            if t.folder == Some(id) {
                t.folder = None;
            }
        }
    }

    /// Set (or clear, with `None`/empty) a tab's user-chosen name.
    pub fn set_tab_custom_title(&self, tab_id: TabId, name: Option<String>) {
        if let Some(mut t) = self.tabs.get_mut(&tab_id) {
            t.custom_title = name.filter(|n| !n.trim().is_empty());
        }
    }

    /// Move a tab into a folder (or out, with `None`). Leaving a folder also
    /// drops any group membership (a folder tab isn't part of a strip group).
    pub fn set_tab_folder(&self, tab_id: TabId, folder: Option<u32>) {
        if let Some(mut t) = self.tabs.get_mut(&tab_id) {
            t.folder = folder;
            if folder.is_some() {
                t.group = None;
            }
        }
    }

    /// "Group by topic": create a group per semantic cluster present on the
    /// unpinned tabs, and assign those tabs to it. Returns the count created.
    pub fn groups_from_clusters(&self) -> usize {
        use std::collections::HashMap;
        // cluster id → (color, tab ids)
        let mut by_cluster: HashMap<u32, (u32, Vec<TabId>)> = HashMap::new();
        for t in self.tabs.iter() {
            if t.pinned {
                continue;
            }
            if let Some(c) = t.cluster {
                by_cluster.entry(c.id).or_insert((c.color, Vec::new())).1.push(t.id);
            }
        }
        let mut created = 0;
        // Stable order by cluster id for deterministic naming.
        let mut clusters: Vec<_> = by_cluster.into_iter().collect();
        clusters.sort_by_key(|(cid, _)| *cid);
        for (_cid, (color, tab_ids)) in clusters {
            if tab_ids.len() < 2 {
                continue; // a group of one isn't useful
            }
            let gid = self.group_create(format!("Topic {}", created + 1), color);
            for id in tab_ids {
                self.set_tab_group(id, Some(gid));
            }
            created += 1;
        }
        created
    }

    // ── Workspaces (BACKLOG #44) ──────────────────────────────────────────────

    pub fn workspaces_list(&self) -> Vec<Workspace> {
        self.workspaces.read().clone()
    }

    pub fn active_workspace(&self) -> u32 {
        self.active_workspace.load(Ordering::Acquire) as u32
    }

    pub fn set_active_workspace(&self, id: u32) {
        if self.workspaces.read().iter().any(|w| w.id == id) {
            self.active_workspace.store(id as u64, Ordering::Release);
        }
    }

    pub fn workspace_create(&self, name: String, color: u32) -> u32 {
        let id = self.next_workspace_id.fetch_add(1, Ordering::Relaxed) as u32;
        self.workspaces.write().push(Workspace { id, name, color });
        id
    }

    pub fn workspace_update(&self, id: u32, name: Option<String>, color: Option<u32>) {
        if let Some(w) = self.workspaces.write().iter_mut().find(|w| w.id == id) {
            if let Some(n) = name {
                w.name = n;
            }
            if let Some(c) = color {
                w.color = c;
            }
        }
    }

    /// Delete a workspace and all its tabs. Refuses to remove the last one;
    /// returns the tab ids that were closed (so the shell can tear down their
    /// webviews). If the active workspace is deleted, the active pointer moves.
    pub fn workspace_delete(&self, id: u32) -> Vec<TabId> {
        if self.workspaces.read().len() <= 1 {
            return Vec::new();
        }
        let closed: Vec<TabId> =
            self.tabs.iter().filter(|t| t.workspace == id).map(|t| t.id).collect();
        for tid in &closed {
            self.tabs.remove(tid);
            self.dom_cache.remove(tid);
            self.order_remove(*tid);
        }
        self.workspaces.write().retain(|w| w.id != id);
        if self.active_workspace() == id {
            if let Some(first) = self.workspaces.read().first().map(|w| w.id) {
                self.active_workspace.store(first as u64, Ordering::Release);
            }
        }
        closed
    }

    // ── Web panels (BACKLOG #48) ──────────────────────────────────────────────

    pub fn panels_list(&self) -> Vec<WebPanel> {
        self.panels.read().clone()
    }

    /// Pin a site as a panel (de-duped by url). Returns the new (or existing) one.
    pub fn panel_add(&self, url: String, title: String) -> WebPanel {
        let mut panels = self.panels.write();
        if let Some(p) = panels.iter().find(|p| p.url == url) {
            return p.clone();
        }
        let id = self.next_panel_id.fetch_add(1, Ordering::Relaxed) as u32;
        let p = WebPanel { id, url, title };
        panels.push(p.clone());
        p
    }

    pub fn panel_remove(&self, id: u32) {
        self.panels.write().retain(|p| p.id != id);
    }

    /// Update a panel's title from its loaded page (best-effort).
    pub fn panel_set_title(&self, id: u32, title: String) {
        if let Some(p) = self.panels.write().iter_mut().find(|p| p.id == id) {
            if !title.trim().is_empty() {
                p.title = title;
            }
        }
    }

    // ── Multi-account containers (BACKLOG #59) ────────────────────────────────

    pub fn containers_list(&self) -> Vec<Container> {
        self.containers.read().clone()
    }

    pub fn container_create(&self, name: String, color: u32) -> u32 {
        let id = self.next_container_id.fetch_add(1, Ordering::Relaxed) as u32;
        self.containers.write().push(Container { id, name, color });
        id
    }

    pub fn container_update(&self, id: u32, name: Option<String>, color: Option<u32>) {
        if let Some(c) = self.containers.write().iter_mut().find(|c| c.id == id) {
            if let Some(n) = name {
                c.name = n;
            }
            if let Some(col) = color {
                c.color = col;
            }
        }
    }

    /// Delete a container; its tabs fall back to the Default jar (container 0).
    pub fn container_delete(&self, id: u32) {
        self.containers.write().retain(|c| c.id != id);
        for mut t in self.tabs.iter_mut() {
            if t.container == id {
                t.container = 0;
            }
        }
    }

    /// The container of a tab (0 = Default).
    pub fn tab_container(&self, tab_id: TabId) -> u32 {
        self.tabs.get(&tab_id).map(|t| t.container).unwrap_or(0)
    }

    /// Write the current tabs to disk (no-op without a `session_path`). Cheap —
    /// the file is a few KB — and called after each tab mutation. Tabs are
    /// ordered by id (== creation order) so restore preserves the tab strip.
    pub fn persist(&self) {
        let Some(path) = &self.session_path else { return };
        let session = crate::session::Session {
            // Saved in display order, so a restart preserves the drag-reordered
            // strip (#30) — `restore` reads the sequence back as the order.
            // Private tabs (#59) are ephemeral — never written to disk.
            tabs: self.ordered_tabs().into_iter().filter(|t| !t.private).collect(),
            active: self.active_tab.load(Ordering::Acquire),
            next_id: self.next_tab_id.load(Ordering::Acquire),
            groups: self.groups.read().clone(),
            folders: self.folders.read().clone(),
            workspaces: self.workspaces.read().clone(),
            active_workspace: self.active_workspace.load(Ordering::Acquire) as u32,
            panels: self.panels.read().clone(),
            containers: self.containers.read().clone(),
        };
        crate::session::save(path, &session);
    }

    /// Allocate a fresh tab id. `Relaxed` is sufficient: ids only need to be
    /// unique, not ordered with respect to other memory.
    pub fn alloc_tab_id(&self) -> TabId {
        self.next_tab_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn active_tab(&self) -> Option<TabId> {
        match self.active_tab.load(Ordering::Acquire) {
            0 => None,
            id => Some(id),
        }
    }

    pub fn set_active_tab(&self, id: TabId) {
        self.active_tab.store(id, Ordering::Release);
    }

    /// Snapshot of the *active* tab — the single hot path shared by the
    /// terminal (`flux extract-json`), the agent, and the embedder.
    /// Cost: one atomic load + one sharded map read + one Arc clone.
    pub fn active_snapshot(&self) -> Option<Arc<DomSnapshot>> {
        let id = self.active_tab()?;
        self.dom_cache.get(&id).map(|e| Arc::clone(e.value()))
    }
}

impl Default for FluxState {
    fn default() -> Self {
        Self::new()
    }
}
