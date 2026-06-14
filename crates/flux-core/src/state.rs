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
}

impl FluxState {
    pub fn new() -> Self {
        Self {
            active_tab: AtomicU64::new(0),
            next_tab_id: AtomicU64::new(1),
            tabs: DashMap::new(),
            dom_cache: DashMap::new(),
            agent: RwLock::new(AgentStatus::Idle),
        }
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
