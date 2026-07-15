//! Browsing provenance spine — "the Trail" (ADR 0011).
//!
//! The foundation of the Research OS: every navigation becomes a **Visit** — a
//! node carrying *why* you got there (the page you came from is a free `Nav`
//! edge, plus the active workspace as the task label). Graph, time-travel,
//! per-page chat, and context search are all read models over this one store;
//! this slice ships just the capture + the store + `forget`, so nothing here
//! depends on the later phases (snapshots, embeddings, entities).
//!
//! Recorded from `dom_publish` **inside its `if !private` guard**, so private
//! windows (#59) leave no Visit — same rule that already excludes them from
//! history. Local-only, persisted as JSON like `history`/`archive`; the spine is
//! never a network source.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::TabId;

/// A visit's stable id (monotonic within the store, persisted so it survives
/// restart — edges and, later, snapshots/chats reference it).
pub type VisitId = u64;

/// Re-publishing the same URL on a tab within this window is the same visit
/// (capture.js republishes on SPA mutations / dwell) — refresh, don't fork a
/// node. Mirrors `history::VISIT_DEDUP_MS`.
const VISIT_DEDUP_MS: u64 = 30_000;

/// Bound the store; evict the oldest visits (and their edges) beyond this. The
/// lightweight metadata is cheap, but not unbounded.
const MAX_VISITS: usize = 50_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Where a visit came from and why — the provenance that turns flat history into
/// a graph. All fields are best-effort; the slice fills `from_visit`/`referrer`
/// (from the tab's prior visit) and `task` (the active workspace). `query` is
/// wired in a later phase.
#[derive(Serialize, Deserialize, Clone, Default, specta::Type)]
pub struct Provenance {
    /// The visit we navigated from on this tab — the `Nav` edge's source.
    pub from_visit: Option<VisitId>,
    /// URL of that prior visit (denormalized for display without a lookup).
    pub referrer: Option<String>,
    /// The search/omnibox text that led here (later phase; `None` in the slice).
    pub query: Option<String>,
    /// The active workspace name when this was visited (the research "task").
    pub task: Option<String>,
}

/// One page visit. Kept minimal in the slice; snapshot/chat/marks/entities join
/// in later phases (ADR 0011) as additive fields.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Visit {
    pub id: VisitId,
    pub url: String,
    pub title: String,
    pub first_ms: u64,
    pub last_ms: u64,
    /// Times this node was (re)published within the dedup rules — engagement, not
    /// a raw click count.
    pub hits: u32,
    pub why: Provenance,
}

/// Edge kinds. `Nav` is captured for free on every navigation; the rest are
/// derived in later phases (semantic neighbours, citation/repo detection).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Nav,
    Semantic,
    Cites,
    Implements,
    Same,
}

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Edge {
    pub from: VisitId,
    pub to: VisitId,
    pub kind: EdgeKind,
}

/// The graph read model handed to the Trail view (visits + the edges among them,
/// optionally windowed by time).
#[derive(Serialize, Default, specta::Type)]
pub struct TraceGraph {
    pub visits: Vec<Visit>,
    pub edges: Vec<Edge>,
}

/// What `trace_forget` removes. Every scope also drops edges touching removed
/// visits and any `by_tab` pointers into them.
#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForgetScope {
    /// A single exact URL.
    Url { url: String },
    /// Every visit whose host matches (registrable-boundary, like the agent's).
    Host { host: String },
    /// A time window (either bound optional; `last_ms` in range).
    Range { after_ms: Option<u64>, before_ms: Option<u64> },
    /// The whole Trail.
    All,
}

#[derive(Default, Serialize, Deserialize)]
struct TraceData {
    visits: Vec<Visit>,
    edges: Vec<Edge>,
    next_id: VisitId,
}

/// The Trail store: visits + edges (persisted) and a runtime tab→current-visit
/// map (session-only, so nav edges are drawn within a run; a restart legitimately
/// starts fresh tab pointers).
#[derive(Default)]
pub struct TraceStore {
    inner: RwLock<TraceData>,
    by_tab: RwLock<HashMap<TabId, VisitId>>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
}

impl TraceStore {
    /// Bind to `path` with no disk I/O (hydrate off the boot thread), mirroring
    /// `HistoryStore::empty`.
    pub fn empty(path: PathBuf) -> Self {
        Self { path: Some(path), ..Default::default() }
    }

    /// Load visits/edges from disk. Safe to run after the store is live (only
    /// fills an empty store — never clobbers visits recorded since boot).
    pub fn hydrate(&self) {
        let Some(path) = &self.path else { return };
        let Some(loaded) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<TraceData>(&s).ok())
        else {
            return;
        };
        let mut d = self.inner.write();
        if d.visits.is_empty() && d.edges.is_empty() {
            d.next_id = d.next_id.max(loaded.next_id);
            d.visits = loaded.visits;
            d.edges = loaded.edges;
        }
    }

    /// Record (or refresh) a visit for `tab` navigating to `url`. Returns the
    /// Visit id, or `None` for non-http(s) URLs (flux://, file://, …) — the same
    /// filter as history. `task` is the active workspace name, if any.
    ///
    /// The nav edge is drawn from the tab's *previous* visit to the new one, so
    /// A→B→A produces three nodes (the return to A is a distinct visit reached
    /// via B) and the edges B→A etc. — browsing as a graph, not a set.
    pub fn record(&self, tab: TabId, url: &str, title: &str, task: Option<String>) -> Option<VisitId> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        let now = now_ms();
        let prev = self.by_tab.read().get(&tab).copied();

        let mut d = self.inner.write();

        // Same tab still on the same URL → same page (SPA republish / dwell):
        // refresh, don't fork a node.
        if let Some(pid) = prev {
            if let Some(v) = d.visits.iter_mut().find(|v| v.id == pid) {
                if v.url == url {
                    if now.saturating_sub(v.last_ms) >= VISIT_DEDUP_MS {
                        v.hits += 1; // returned to the same page after a gap
                    }
                    v.last_ms = now;
                    if !title.trim().is_empty() && title != v.title {
                        v.title = title.to_string();
                    }
                    drop(d);
                    self.dirty.store(true, Ordering::Relaxed);
                    return Some(pid);
                }
            }
        }

        // New URL for this tab → a new Visit, plus a Nav edge from the prior one.
        let referrer = prev.and_then(|p| d.visits.iter().find(|v| v.id == p).map(|v| v.url.clone()));
        let id = d.next_id;
        d.next_id += 1;
        d.visits.push(Visit {
            id,
            url: url.to_string(),
            title: title.to_string(),
            first_ms: now,
            last_ms: now,
            hits: 1,
            why: Provenance { from_visit: prev, referrer, query: None, task },
        });
        if let Some(p) = prev {
            let edge = Edge { from: p, to: id, kind: EdgeKind::Nav };
            if !d.edges.iter().any(|e| e.from == edge.from && e.to == edge.to && e.kind == edge.kind) {
                d.edges.push(edge);
            }
        }
        // Evict oldest beyond the cap (and any edges referencing them).
        if d.visits.len() > MAX_VISITS {
            let over = d.visits.len() - MAX_VISITS;
            let mut ids: Vec<(VisitId, u64)> = d.visits.iter().map(|v| (v.id, v.last_ms)).collect();
            ids.sort_unstable_by_key(|(_, ms)| *ms);
            let doomed: std::collections::HashSet<VisitId> = ids.into_iter().take(over).map(|(id, _)| id).collect();
            d.visits.retain(|v| !doomed.contains(&v.id));
            d.edges.retain(|e| !doomed.contains(&e.from) && !doomed.contains(&e.to));
        }
        drop(d);
        self.by_tab.write().insert(tab, id);
        self.dirty.store(true, Ordering::Relaxed);
        Some(id)
    }

    /// A tab was closed — drop its current-visit pointer so a recycled `TabId`
    /// can't inherit a stale nav edge.
    pub fn tab_closed(&self, tab: TabId) {
        self.by_tab.write().remove(&tab);
    }

    /// Most-recent visits (newest first).
    pub fn recent(&self, limit: usize) -> Vec<Visit> {
        let d = self.inner.read();
        let mut v: Vec<Visit> = d.visits.clone();
        v.sort_unstable_by(|a, b| b.last_ms.cmp(&a.last_ms));
        v.truncate(limit);
        v
    }

    pub fn visit(&self, id: VisitId) -> Option<Visit> {
        self.inner.read().visits.iter().find(|v| v.id == id).cloned()
    }

    /// Visits (optionally time-windowed by `last_ms`) plus the edges among them.
    pub fn graph(&self, after_ms: Option<u64>, before_ms: Option<u64>) -> TraceGraph {
        let d = self.inner.read();
        let visits: Vec<Visit> = d
            .visits
            .iter()
            .filter(|v| after_ms.map_or(true, |a| v.last_ms >= a) && before_ms.map_or(true, |b| v.last_ms <= b))
            .cloned()
            .collect();
        let keep: std::collections::HashSet<VisitId> = visits.iter().map(|v| v.id).collect();
        let edges: Vec<Edge> = d.edges.iter().filter(|e| keep.contains(&e.from) && keep.contains(&e.to)).cloned().collect();
        TraceGraph { visits, edges }
    }

    /// Drop visits (and their edges + tab pointers) matching `scope`.
    pub fn forget(&self, scope: &ForgetScope) {
        let mut d = self.inner.write();
        let doomed: std::collections::HashSet<VisitId> = match scope {
            ForgetScope::All => {
                let all = d.visits.iter().map(|v| v.id).collect();
                d.visits.clear();
                d.edges.clear();
                self.by_tab.write().clear();
                self.dirty.store(true, Ordering::Relaxed);
                let _: std::collections::HashSet<VisitId> = all;
                return;
            }
            ForgetScope::Url { url } => d.visits.iter().filter(|v| &v.url == url).map(|v| v.id).collect(),
            ForgetScope::Host { host } => {
                let host = host.to_ascii_lowercase();
                d.visits
                    .iter()
                    .filter(|v| host_matches(&v.url, &host))
                    .map(|v| v.id)
                    .collect()
            }
            ForgetScope::Range { after_ms, before_ms } => d
                .visits
                .iter()
                .filter(|v| after_ms.map_or(true, |a| v.last_ms >= a) && before_ms.map_or(true, |b| v.last_ms <= b))
                .map(|v| v.id)
                .collect(),
        };
        if doomed.is_empty() {
            return;
        }
        d.visits.retain(|v| !doomed.contains(&v.id));
        d.edges.retain(|e| !doomed.contains(&e.from) && !doomed.contains(&e.to));
        drop(d);
        self.by_tab.write().retain(|_, vid| !doomed.contains(vid));
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Persist to disk only if something changed (the 60s flush loop calls this).
    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        let d = self.inner.read();
        crate::persist::save_json(path, &*d);
    }
}

/// Host of `url` equals `host` or is a subdomain of it — a registrable-boundary
/// match so "example.com" forgets `www.example.com` but not `notexample.com`.
fn host_matches(url: &str, host: &str) -> bool {
    let Some(after) = url.split_once("://").map(|(_, a)| a) else { return false };
    let authority = after.split(['/', '?', '#']).next().unwrap_or(after);
    let h = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let h = h.split(':').next().unwrap_or(h).to_ascii_lowercase();
    h == host || h.ends_with(&format!(".{host}"))
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

/// Most-recent visits for the Trail timeline (newest first).
#[tauri::command]
pub fn trace_recent(store: State<'_, TraceStore>, limit: Option<usize>) -> Vec<Visit> {
    store.recent(limit.unwrap_or(200))
}

/// A single visit by id (node detail).
#[tauri::command]
pub fn trace_visit(store: State<'_, TraceStore>, id: VisitId) -> Option<Visit> {
    store.visit(id)
}

/// The provenance graph (optionally time-windowed) for the Trail view.
#[tauri::command]
pub fn trace_graph(store: State<'_, TraceStore>, after_ms: Option<u64>, before_ms: Option<u64>) -> TraceGraph {
    store.graph(after_ms, before_ms)
}

/// Forget part (or all) of the Trail — the day-one privacy control (ADR 0011).
#[tauri::command]
pub fn trace_forget(store: State<'_, TraceStore>, scope: ForgetScope) {
    store.forget(&scope);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_nodes_and_free_nav_edges() {
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", Some("Research".into())).unwrap();
        let b = s.record(1, "https://b.com/", "B", Some("Research".into())).unwrap();
        assert_ne!(a, b);
        let g = s.graph(None, None);
        assert_eq!(g.visits.len(), 2);
        // One free Nav edge A→B, with provenance pointing back.
        assert_eq!(g.edges.len(), 1);
        assert_eq!((g.edges[0].from, g.edges[0].to, g.edges[0].kind), (a, b, EdgeKind::Nav));
        let vb = s.visit(b).unwrap();
        assert_eq!(vb.why.from_visit, Some(a));
        assert_eq!(vb.why.referrer.as_deref(), Some("https://a.com/"));
        assert_eq!(vb.why.task.as_deref(), Some("Research"));
    }

    #[test]
    fn same_url_republish_refreshes_not_forks() {
        let s = TraceStore::default();
        let a1 = s.record(1, "https://a.com/", "A", None).unwrap();
        let a2 = s.record(1, "https://a.com/", "A (updated)", None).unwrap();
        assert_eq!(a1, a2, "same tab + same url = same node");
        assert_eq!(s.graph(None, None).visits.len(), 1);
        assert_eq!(s.visit(a1).unwrap().title, "A (updated)");
    }

    #[test]
    fn revisit_via_another_page_is_a_new_node() {
        // A → B → A: the return to A is a distinct visit reached via B.
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", None).unwrap();
        let _b = s.record(1, "https://b.com/", "B", None).unwrap();
        let a2 = s.record(1, "https://a.com/", "A", None).unwrap();
        assert_ne!(a, a2);
        assert_eq!(s.graph(None, None).visits.len(), 3);
    }

    #[test]
    fn non_http_and_private_paths_are_skipped() {
        let s = TraceStore::default();
        assert!(s.record(1, "flux://start", "Start", None).is_none());
        assert!(s.record(1, "file:///x", "X", None).is_none());
        assert!(s.graph(None, None).visits.is_empty());
    }

    #[test]
    fn forget_host_drops_visits_and_their_edges() {
        let s = TraceStore::default();
        s.record(1, "https://a.com/", "A", None);
        s.record(1, "https://sub.a.com/x", "A2", None);
        s.record(1, "https://b.com/", "B", None);
        s.forget(&ForgetScope::Host { host: "a.com".into() });
        let g = s.graph(None, None);
        assert_eq!(g.visits.len(), 1);
        assert_eq!(g.visits[0].url, "https://b.com/");
        // The A→A2 and A2→B edges are gone; nothing dangles.
        assert!(g.edges.iter().all(|e| g.visits.iter().any(|v| v.id == e.from) && g.visits.iter().any(|v| v.id == e.to)));
        // Lookalike host is untouched by a boundary match.
        assert!(!host_matches("https://nota.com/", "a.com"));
    }

    #[test]
    fn persistence_roundtrips() {
        let dir = std::env::temp_dir().join(format!("flux-trace-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trace.json");
        let s = TraceStore::empty(path.clone());
        s.record(1, "https://a.com/", "A", None);
        s.record(1, "https://b.com/", "B", None);
        s.persist_if_dirty();
        let s2 = TraceStore::empty(path);
        s2.hydrate();
        let g = s2.graph(None, None);
        assert_eq!(g.visits.len(), 2);
        assert_eq!(g.edges.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
