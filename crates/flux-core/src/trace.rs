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
    /// The dwell-captured content snapshot for this visit (ADR 0011 step 1), set
    /// once the page was engaged past the dwell threshold. `None` until then (or
    /// after the snapshot is budget-evicted). Indexes `TraceSnapshots`.
    #[serde(default)]
    pub snapshot_id: Option<u64>,
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
            snapshot_id: None,
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

    /// The tab's current visit id, if any — the dwell-capture target.
    pub fn current_visit(&self, tab: TabId) -> Option<VisitId> {
        self.by_tab.read().get(&tab).copied()
    }

    /// Attach a dwell snapshot to a visit (idempotent — a second call is ignored
    /// so re-capture can't thrash the pointer).
    pub fn attach_snapshot(&self, visit: VisitId, snapshot_id: u64) {
        let mut d = self.inner.write();
        if let Some(v) = d.visits.iter_mut().find(|v| v.id == visit) {
            if v.snapshot_id.is_none() {
                v.snapshot_id = Some(snapshot_id);
                drop(d);
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
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

    /// Drop visits (and their edges + tab pointers) matching `scope`. Returns the
    /// removed visit ids so the caller can cascade (e.g. drop their snapshots).
    pub fn forget(&self, scope: &ForgetScope) -> Vec<VisitId> {
        let mut d = self.inner.write();
        let doomed: std::collections::HashSet<VisitId> = match scope {
            ForgetScope::All => {
                let all: Vec<VisitId> = d.visits.iter().map(|v| v.id).collect();
                d.visits.clear();
                d.edges.clear();
                drop(d);
                self.by_tab.write().clear();
                self.dirty.store(true, Ordering::Relaxed);
                return all;
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
            return Vec::new();
        }
        d.visits.retain(|v| !doomed.contains(&v.id));
        d.edges.retain(|e| !doomed.contains(&e.from) && !doomed.contains(&e.to));
        drop(d);
        self.by_tab.write().retain(|_, vid| !doomed.contains(vid));
        self.dirty.store(true, Ordering::Relaxed);
        doomed.into_iter().collect()
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

// ─── Dwell-captured content snapshots (ADR 0011 step 1) ──────────────────────
// The heavy tier: a visit's page text + embedding, captured only after the page
// was *engaged* past the dwell threshold (the frontend gates this). Kept in a
// separate store/file from the tiny visits+edges so the frequent trace.json
// flush stays cheap. Mirrors the archive vector-store pattern (embeddings are
// persisted + embedder-tagged — model embeddings are network calls, not
// recomputed per load). This is the corpus the KB `web` source (next step) and
// semantic edges will read.

/// Storage budget (v1 — revisit with a SQLite/ANN store past this, cf. KB's
/// 100k-chunk note). Text capped per snapshot (enough for embedding + ~200-word
/// KB chunks; not full-fidelity like the manual archive), count-capped with
/// oldest-evicted. ~1500 × (20 KiB text + ~3 KiB vector) ≈ 35–40 MB.
const SNAPSHOT_TEXT_CAP: usize = 20 * 1024;
const MAX_SNAPSHOTS: usize = 1_500;

fn default_embedder() -> crate::embedding::Embedder {
    crate::embedding::Embedder::Hash
}

/// A persisted dwell snapshot. `text`/`embedding`/`embedder` stay out of the wire
/// shape ([`SnapshotWire`]) — they're an on-disk/retrieval concern.
#[derive(Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub id: u64,
    pub visit_id: VisitId,
    pub url: String,
    pub saved_ms: u64,
    pub text: String,
    #[serde(default)]
    embedding: Vec<f32>,
    #[serde(default = "default_embedder")]
    embedder: crate::embedding::Embedder,
}

/// Reader-facing snapshot (node detail); omits the vector + embedder tag.
#[derive(Serialize, Clone, specta::Type)]
pub struct SnapshotWire {
    pub id: u64,
    pub visit_id: VisitId,
    pub url: String,
    pub saved_ms: u64,
    pub text: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SnapshotData {
    snapshots: Vec<Snapshot>,
    next_id: u64,
}

/// The dwell-snapshot store — its own file + budget, per ADR 0011.
pub struct TraceSnapshots {
    inner: RwLock<SnapshotData>,
    /// One embedder for the whole corpus (cosine is only meaningful within one),
    /// chosen at load like the archive store.
    embedder: crate::embedding::Embedder,
    path: Option<PathBuf>,
    dirty: AtomicBool,
}

impl TraceSnapshots {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            inner: RwLock::new(SnapshotData::default()),
            embedder: crate::embedding::current(),
            path: Some(path),
            dirty: AtomicBool::new(false),
        }
    }

    pub fn hydrate(&self) {
        let Some(path) = &self.path else { return };
        let Some(loaded) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<SnapshotData>(&s).ok())
        else {
            return;
        };
        let mut d = self.inner.write();
        if d.snapshots.is_empty() {
            d.next_id = d.next_id.max(loaded.next_id);
            d.snapshots = loaded.snapshots;
        }
    }

    /// The embedder this corpus uses — the caller embeds with it off-thread, then
    /// hands the vector to `add` (so the slow/network embed doesn't hold a lock).
    pub fn embedder(&self) -> crate::embedding::Embedder {
        self.embedder
    }

    /// Store a captured snapshot, evicting the oldest beyond the budget. Returns
    /// the new snapshot id.
    pub fn add(&self, visit_id: VisitId, url: String, text: String, embedding: Vec<f32>) -> u64 {
        let mut d = self.inner.write();
        let id = d.next_id;
        d.next_id += 1;
        d.snapshots.push(Snapshot {
            id,
            visit_id,
            url,
            saved_ms: now_ms(),
            text,
            embedding,
            embedder: self.embedder,
        });
        if d.snapshots.len() > MAX_SNAPSHOTS {
            let over = d.snapshots.len() - MAX_SNAPSHOTS;
            // Oldest-first eviction (the vec is push-append, so oldest are at the front).
            d.snapshots.drain(0..over);
        }
        drop(d);
        self.dirty.store(true, Ordering::Relaxed);
        id
    }

    pub fn get(&self, id: u64) -> Option<SnapshotWire> {
        self.inner.read().snapshots.iter().find(|s| s.id == id).map(|s| SnapshotWire {
            id: s.id,
            visit_id: s.visit_id,
            url: s.url.clone(),
            saved_ms: s.saved_ms,
            text: s.text.clone(),
        })
    }

    /// Drop snapshots belonging to any of `visits` (cascade from `trace_forget`).
    pub fn forget_visits(&self, visits: &std::collections::HashSet<VisitId>) {
        if visits.is_empty() {
            return;
        }
        let mut d = self.inner.write();
        let before = d.snapshots.len();
        d.snapshots.retain(|s| !visits.contains(&s.visit_id));
        if d.snapshots.len() != before {
            drop(d);
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        let d = self.inner.read();
        crate::persist::save_json(path, &*d);
    }
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

/// A dwell snapshot's content (node detail).
#[tauri::command]
pub fn trace_snapshot_get(snaps: State<'_, TraceSnapshots>, id: u64) -> Option<SnapshotWire> {
    snaps.get(id)
}

/// Capture the dwell snapshot for a tab's current visit (ADR 0011 step 1). Called
/// by the frontend once the page has been engaged past the dwell threshold. Reads
/// the already-cached DOM text (no new page capture), embeds it off-thread, stores
/// it, and attaches `snapshot_id` to the visit. Idempotent — a visit that already
/// has a snapshot returns it without re-embedding. Returns the snapshot id, or
/// `None` if there's no current visit / no cached text yet.
#[tauri::command]
pub async fn trace_snapshot(
    trace: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    state: State<'_, crate::state::FluxState>,
    tab_id: TabId,
) -> Result<Option<u64>, String> {
    let Some(visit_id) = trace.current_visit(tab_id) else { return Ok(None) };
    // Already captured for this visit → no re-embed (dwell can fire repeatedly).
    if let Some(existing) = trace.visit(visit_id).and_then(|v| v.snapshot_id) {
        return Ok(Some(existing));
    }
    // Read the cached DOM text ONCE (then drop the dashmap guard before the await),
    // so what we store is exactly what we embedded even if the tab navigates mid-embed.
    let (url, text) = {
        let Some(snap) = state.dom_cache.get(&tab_id) else { return Ok(None) };
        (snap.url.clone(), crate::dom::cap_utf8(snap.text.to_string(), SNAPSHOT_TEXT_CAP))
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let embedder = snaps.embedder();
    // Embedding may hit Ollama — never on the async runtime.
    let embed_text = text.clone();
    let embedding = tauri::async_runtime::spawn_blocking(move || {
        crate::embedding::embed_with(&embed_text, embedder).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())?;
    let id = snaps.add(visit_id, url, text, embedding);
    trace.attach_snapshot(visit_id, id);
    Ok(Some(id))
}

/// Forget part (or all) of the Trail — the day-one privacy control (ADR 0011).
/// Cascades to the visits' dwell snapshots.
#[tauri::command]
pub fn trace_forget(store: State<'_, TraceStore>, snaps: State<'_, TraceSnapshots>, scope: ForgetScope) {
    let removed: std::collections::HashSet<VisitId> = store.forget(&scope).into_iter().collect();
    snaps.forget_visits(&removed);
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
    fn snapshot_add_attach_get_and_budget_evicts_oldest() {
        let snaps = TraceSnapshots {
            inner: RwLock::new(SnapshotData::default()),
            embedder: crate::embedding::Embedder::Hash,
            path: None,
            dirty: AtomicBool::new(false),
        };
        let id0 = snaps.add(10, "https://a.com/".into(), "alpha".into(), vec![0.1, 0.2]);
        assert_eq!(snaps.get(id0).unwrap().text, "alpha");
        assert_eq!(snaps.get(id0).unwrap().visit_id, 10);

        // A visit accepts one snapshot; attach is idempotent.
        let s = TraceStore::default();
        let v = s.record(1, "https://a.com/", "A", None).unwrap();
        s.attach_snapshot(v, id0);
        assert_eq!(s.visit(v).unwrap().snapshot_id, Some(id0));
        s.attach_snapshot(v, 999); // ignored — already set
        assert_eq!(s.visit(v).unwrap().snapshot_id, Some(id0));

        // forget_visits cascades.
        snaps.forget_visits(&std::collections::HashSet::from([10]));
        assert!(snaps.get(id0).is_none());
    }

    #[test]
    fn snapshot_budget_caps_and_evicts() {
        let snaps = TraceSnapshots {
            inner: RwLock::new(SnapshotData::default()),
            embedder: crate::embedding::Embedder::Hash,
            path: None,
            dirty: AtomicBool::new(false),
        };
        // Exceed the cap; the store never grows past MAX_SNAPSHOTS and drops oldest.
        let mut first = 0;
        for i in 0..(MAX_SNAPSHOTS + 5) {
            let id = snaps.add(i as u64, "https://x/".into(), "t".into(), vec![]);
            if i == 0 {
                first = id;
            }
        }
        assert_eq!(snaps.inner.read().snapshots.len(), MAX_SNAPSHOTS);
        assert!(snaps.get(first).is_none(), "oldest snapshot was evicted");
    }

    #[test]
    fn forget_returns_removed_ids_for_cascade() {
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", None).unwrap();
        s.record(1, "https://b.com/", "B", None).unwrap();
        let removed = s.forget(&ForgetScope::Url { url: "https://a.com/".into() });
        assert_eq!(removed, vec![a]);
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
