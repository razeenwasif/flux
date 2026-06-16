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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TabKind {
    Browser,
    Terminal,
    /// Read-only filesystem explorer (ADR 0006). Its `url` holds the cwd.
    Files,
}

/// Metadata for one open tab. Small (~100 B) and `Clone` — cheap to hand to
/// the frontend wholesale on every mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// A semantic cluster: stable id + the display color the UI paints the tab.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
        Self {
            active_tab: AtomicU64::new(active),
            next_tab_id: AtomicU64::new(next),
            tabs,
            dom_cache: DashMap::new(),
            agent: RwLock::new(AgentStatus::Idle),
            order: RwLock::new(order),
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

    /// Write the current tabs to disk (no-op without a `session_path`). Cheap —
    /// the file is a few KB — and called after each tab mutation. Tabs are
    /// ordered by id (== creation order) so restore preserves the tab strip.
    pub fn persist(&self) {
        let Some(path) = &self.session_path else { return };
        let session = crate::session::Session {
            // Saved in display order, so a restart preserves the drag-reordered
            // strip (#30) — `restore` reads the sequence back as the order.
            tabs: self.ordered_tabs(),
            active: self.active_tab.load(Ordering::Acquire),
            next_id: self.next_tab_id.load(Ordering::Acquire),
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
