//! The Trail's spine: Visits + Edges — capture, graph queries, forget.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use super::entities::extract_entities;
use super::now_ms;
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
    /// Papers / DOIs / repos / datasets this page is or mentions (payoff layer).
    /// URL-derived entities land at nav time; text-derived ones at dwell capture.
    #[serde(default)]
    pub entities: Vec<Entity>,
}

/// What a page *is or mentions* (payoff layer): a paper, a DOI, a code repo, a
/// dataset. Extracted deterministically (no LLM — precision over recall) from
/// the page URL and the dwell-snapshot text; shared entities between visits
/// derive `Cites`/`Implements`/`Same` edges — "this repo implements that paper".
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Arxiv,
    Doi,
    Repo,
    Dataset,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, specta::Type)]
pub struct Entity {
    pub kind: EntityKind,
    /// Normalized: arXiv id without version ("2511.19477"), lowercased DOI,
    /// lowercased "owner/name" repo, "hf:owner/name" / "kaggle:owner/name".
    pub value: String,
    /// True when derived from the page's own URL — the page *is* this thing
    /// (the paper's abstract page, the repo itself) rather than mentioning it.
    pub primary: bool,
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

/// Visit-density over time (the scrubber's activity backdrop): `counts[i]`
/// covers the i-th equal slice of `[min_ms, max_ms]`.
#[derive(Serialize, Default, specta::Type)]
pub struct TraceHistogram {
    pub min_ms: u64,
    pub max_ms: u64,
    pub counts: Vec<u32>,
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
    Range {
        after_ms: Option<u64>,
        before_ms: Option<u64>,
    },
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
    hydrated: AtomicBool,
}

impl TraceStore {
    /// Bind to `path` with no disk I/O (hydrate off the boot thread), mirroring
    /// `HistoryStore::empty`.
    pub fn empty(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            ..Default::default()
        }
    }

    /// Load visits/edges from disk, exactly once. Lazily invoked from every
    /// public entry point so a navigation that lands *before* the background
    /// hydrate thread runs can't start a fresh store and later overwrite the
    /// persisted Trail (the flag makes first-touch hydration win every race).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
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
    pub fn record(
        &self,
        tab: TabId,
        url: &str,
        title: &str,
        task: Option<String>,
    ) -> Option<VisitId> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        self.hydrate();
        let now = now_ms();
        let prev = self.by_tab.read().get(&tab).copied();

        // Fast path under a READ lock: the tab is still on the same URL within
        // the dedup window and nothing meaningful changed — take no write lock
        // and leave `dirty` alone. Same rationale as history: capture.js
        // republishes every ~400ms on a mutating page, which would otherwise
        // keep the store perpetually dirty and rewrite trace.json every 60s for
        // a page you're just sitting on.
        if let Some(pid) = prev {
            let d = self.inner.read();
            if let Some(v) = d.visits.iter().find(|v| v.id == pid) {
                if v.url == url
                    && now.saturating_sub(v.last_ms) < VISIT_DEDUP_MS
                    && (title.trim().is_empty() || title == v.title)
                {
                    return Some(pid);
                }
            }
        }

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
        // The prior visit may have been evicted/forgotten — treat that as no
        // provenance rather than leaving a pointer/edge to a node that's gone.
        let prev_live = prev.filter(|p| d.visits.iter().any(|v| v.id == *p));
        let referrer =
            prev_live.and_then(|p| d.visits.iter().find(|v| v.id == p).map(|v| v.url.clone()));
        let id = d.next_id;
        d.next_id += 1;
        d.visits.push(Visit {
            id,
            url: url.to_string(),
            title: title.to_string(),
            first_ms: now,
            last_ms: now,
            hits: 1,
            why: Provenance {
                from_visit: prev_live,
                referrer,
                query: None,
                task,
            },
            snapshot_id: None,
            // URL-primary entities at nav time (a bare string scan — no text
            // yet), so even a bounced paper/repo page can be cited *into* later.
            entities: extract_entities(url, ""),
        });
        if let Some(p) = prev_live {
            let edge = Edge {
                from: p,
                to: id,
                kind: EdgeKind::Nav,
            };
            if !d
                .edges
                .iter()
                .any(|e| e.from == edge.from && e.to == edge.to && e.kind == edge.kind)
            {
                d.edges.push(edge);
            }
        }
        // Evict oldest beyond the cap (and any edges referencing them).
        if d.visits.len() > MAX_VISITS {
            let over = d.visits.len() - MAX_VISITS;
            let mut ids: Vec<(VisitId, u64)> = d.visits.iter().map(|v| (v.id, v.last_ms)).collect();
            ids.sort_unstable_by_key(|(_, ms)| *ms);
            let doomed: std::collections::HashSet<VisitId> =
                ids.into_iter().take(over).map(|(id, _)| id).collect();
            d.visits.retain(|v| !doomed.contains(&v.id));
            d.edges
                .retain(|e| !doomed.contains(&e.from) && !doomed.contains(&e.to));
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
        self.hydrate();
        let mut d = self.inner.write();
        if let Some(v) = d.visits.iter_mut().find(|v| v.id == visit) {
            if v.snapshot_id.is_none() {
                v.snapshot_id = Some(snapshot_id);
                drop(d);
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Add derived (non-Nav) edges — semantic neighbours, citations, implements
    /// (payoff layer). Duplicates are checked in both directions per kind (the
    /// direction of a derived link is informative, not identity); self-edges and
    /// edges whose endpoints no longer exist are skipped.
    pub fn add_derived_edges(&self, new_edges: &[Edge]) {
        if new_edges.is_empty() {
            return;
        }
        self.hydrate();
        let mut d = self.inner.write();
        let mut added = false;
        for e in new_edges {
            if e.kind == EdgeKind::Nav || e.from == e.to {
                continue;
            }
            if !d.visits.iter().any(|v| v.id == e.from) || !d.visits.iter().any(|v| v.id == e.to) {
                continue;
            }
            let dup = d.edges.iter().any(|x| {
                x.kind == e.kind
                    && ((x.from == e.from && x.to == e.to) || (x.from == e.to && x.to == e.from))
            });
            if !dup {
                d.edges.push(e.clone());
                added = true;
            }
        }
        if added {
            drop(d);
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    /// Convenience: `Semantic` edges from each of `froms` to `to`.
    pub fn add_semantic_edges(&self, to: VisitId, froms: &[VisitId]) {
        let edges: Vec<Edge> = froms
            .iter()
            .map(|&f| Edge {
                from: f,
                to,
                kind: EdgeKind::Semantic,
            })
            .collect();
        self.add_derived_edges(&edges);
    }

    /// Replace a visit's entities with the full (URL + text) extraction — the
    /// dwell-capture upgrade over the nav-time URL-only pass.
    pub fn set_entities(&self, visit: VisitId, entities: Vec<Entity>) {
        self.hydrate();
        let mut d = self.inner.write();
        if let Some(v) = d.visits.iter_mut().find(|v| v.id == visit) {
            if v.entities != entities {
                v.entities = entities;
                drop(d);
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Derive citation edges for `id` from shared entities (payoff layer):
    /// - it mentions something another visit *is* → `Cites` (or `Implements`
    ///   when the mentioning page is itself a repo — "this repo implements
    ///   that paper"), pointing citer → cited;
    /// - both merely mention the same thing → `Same` (about the same topic).
    ///
    /// One edge per visit pair, capped per derivation.
    pub fn derive_entity_edges(&self, id: VisitId) {
        const MAX_NEW: usize = 8;
        self.hydrate();
        let mut new_edges: Vec<Edge> = Vec::new();
        {
            let d = self.inner.read();
            let Some(me) = d.visits.iter().find(|v| v.id == id) else {
                return;
            };
            if me.entities.is_empty() {
                return;
            }
            let me_repo = me
                .entities
                .iter()
                .any(|e| e.primary && e.kind == EntityKind::Repo);
            for other in d
                .visits
                .iter()
                .filter(|v| v.id != id && !v.entities.is_empty())
            {
                let other_repo = other
                    .entities
                    .iter()
                    .any(|e| e.primary && e.kind == EntityKind::Repo);
                for em in &me.entities {
                    let Some(eo) = other
                        .entities
                        .iter()
                        .find(|e| e.kind == em.kind && e.value == em.value)
                    else {
                        continue;
                    };
                    let edge = match (em.primary, eo.primary) {
                        // I mention what the other page IS → I cite (or implement) it.
                        (false, true) => Edge {
                            from: id,
                            to: other.id,
                            kind: if me_repo {
                                EdgeKind::Implements
                            } else {
                                EdgeKind::Cites
                            },
                        },
                        // The other page mentions what I am → it cites/implements me.
                        (true, false) => Edge {
                            from: other.id,
                            to: id,
                            kind: if other_repo {
                                EdgeKind::Implements
                            } else {
                                EdgeKind::Cites
                            },
                        },
                        // Shared mention → both are about the same thing.
                        (false, false) => Edge {
                            from: other.id,
                            to: id,
                            kind: EdgeKind::Same,
                        },
                        // Two visits of the same paper/repo — nav + semantic cover it.
                        (true, true) => continue,
                    };
                    new_edges.push(edge);
                    break; // one edge per pair
                }
                if new_edges.len() >= MAX_NEW {
                    break;
                }
            }
        }
        self.add_derived_edges(&new_edges);
    }

    /// Visit-density histogram over the whole Trail — the scrubber's backdrop
    /// ("where was I active"). One pass; `buckets` counts of visits by `last_ms`
    /// between the oldest and newest visit. All-zero span when the Trail is empty.
    pub fn histogram(&self, buckets: usize) -> TraceHistogram {
        self.hydrate();
        let d = self.inner.read();
        let buckets = buckets.clamp(10, 400);
        let mut counts = vec![0u32; buckets];
        let (mut min_ms, mut max_ms) = (u64::MAX, 0u64);
        for v in &d.visits {
            min_ms = min_ms.min(v.last_ms);
            max_ms = max_ms.max(v.last_ms);
        }
        if d.visits.is_empty() || max_ms <= min_ms {
            return TraceHistogram {
                min_ms: if d.visits.is_empty() { 0 } else { min_ms },
                max_ms,
                counts,
            };
        }
        let span = max_ms - min_ms;
        for v in &d.visits {
            let i =
                (((v.last_ms - min_ms) as u128 * buckets as u128) / (span as u128 + 1)) as usize;
            counts[i.min(buckets - 1)] += 1;
        }
        TraceHistogram {
            min_ms,
            max_ms,
            counts,
        }
    }

    /// Most-recent visits (newest first).
    pub fn recent(&self, limit: usize) -> Vec<Visit> {
        self.hydrate();
        let d = self.inner.read();
        let mut v: Vec<Visit> = d.visits.clone();
        v.sort_unstable_by_key(|e| std::cmp::Reverse(e.last_ms));
        v.truncate(limit);
        v
    }

    pub fn visit(&self, id: VisitId) -> Option<Visit> {
        self.hydrate();
        self.inner
            .read()
            .visits
            .iter()
            .find(|v| v.id == id)
            .cloned()
    }

    /// Visits (optionally time-windowed by `last_ms`) plus the edges among them.
    pub fn graph(&self, after_ms: Option<u64>, before_ms: Option<u64>) -> TraceGraph {
        self.hydrate();
        let d = self.inner.read();
        let visits: Vec<Visit> = d
            .visits
            .iter()
            .filter(|v| {
                after_ms.is_none_or(|a| v.last_ms >= a) && before_ms.is_none_or(|b| v.last_ms <= b)
            })
            .cloned()
            .collect();
        let keep: std::collections::HashSet<VisitId> = visits.iter().map(|v| v.id).collect();
        let edges: Vec<Edge> = d
            .edges
            .iter()
            .filter(|e| keep.contains(&e.from) && keep.contains(&e.to))
            .cloned()
            .collect();
        TraceGraph { visits, edges }
    }

    /// Drop visits (and their edges + tab pointers) matching `scope`. Returns the
    /// removed visit ids so the caller can cascade (e.g. drop their snapshots).
    pub fn forget(&self, scope: &ForgetScope) -> Vec<VisitId> {
        self.hydrate();
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
            ForgetScope::Url { url } => d
                .visits
                .iter()
                .filter(|v| &v.url == url)
                .map(|v| v.id)
                .collect(),
            ForgetScope::Host { host } => {
                let host = host.to_ascii_lowercase();
                d.visits
                    .iter()
                    .filter(|v| host_matches(&v.url, &host))
                    .map(|v| v.id)
                    .collect()
            }
            ForgetScope::Range {
                after_ms,
                before_ms,
            } => d
                .visits
                .iter()
                .filter(|v| {
                    after_ms.is_none_or(|a| v.last_ms >= a)
                        && before_ms.is_none_or(|b| v.last_ms <= b)
                })
                .map(|v| v.id)
                .collect(),
        };
        if doomed.is_empty() {
            return Vec::new();
        }
        d.visits.retain(|v| !doomed.contains(&v.id));
        d.edges
            .retain(|e| !doomed.contains(&e.from) && !doomed.contains(&e.to));
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
    let Some(after) = url.split_once("://").map(|(_, a)| a) else {
        return false;
    };
    let authority = after.split(['/', '?', '#']).next().unwrap_or(after);
    let h = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let h = h.split(':').next().unwrap_or(h).to_ascii_lowercase();
    h == host || h.ends_with(&format!(".{host}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_nodes_and_free_nav_edges() {
        let s = TraceStore::default();
        let a = s
            .record(1, "https://a.com/", "A", Some("Research".into()))
            .unwrap();
        let b = s
            .record(1, "https://b.com/", "B", Some("Research".into()))
            .unwrap();
        assert_ne!(a, b);
        let g = s.graph(None, None);
        assert_eq!(g.visits.len(), 2);
        // One free Nav edge A→B, with provenance pointing back.
        assert_eq!(g.edges.len(), 1);
        assert_eq!(
            (g.edges[0].from, g.edges[0].to, g.edges[0].kind),
            (a, b, EdgeKind::Nav)
        );
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
        s.forget(&ForgetScope::Host {
            host: "a.com".into(),
        });
        let g = s.graph(None, None);
        assert_eq!(g.visits.len(), 1);
        assert_eq!(g.visits[0].url, "https://b.com/");
        // The A→A2 and A2→B edges are gone; nothing dangles.
        assert!(g
            .edges
            .iter()
            .all(|e| g.visits.iter().any(|v| v.id == e.from)
                && g.visits.iter().any(|v| v.id == e.to)));
        // Lookalike host is untouched by a boundary match.
        assert!(!host_matches("https://nota.com/", "a.com"));
    }

    #[test]
    fn semantic_edges_dedup_both_directions_and_skip_missing() {
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", None).unwrap();
        let b = s.record(2, "https://b.com/", "B", None).unwrap();
        s.add_semantic_edges(b, &[a]);
        s.add_semantic_edges(b, &[a]); // same direction dup
        s.add_semantic_edges(a, &[b]); // reversed dup
        let g = s.graph(None, None);
        assert_eq!(
            g.edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Semantic)
                .count(),
            1
        );
        // Self-edges and missing endpoints are skipped.
        s.add_semantic_edges(a, &[a, 999]);
        s.add_semantic_edges(999, &[a]);
        let g = s.graph(None, None);
        assert_eq!(
            g.edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Semantic)
                .count(),
            1
        );
        // Forget drops semantic edges with their visit, like nav edges.
        s.forget(&ForgetScope::Url {
            url: "https://a.com/".into(),
        });
        assert!(s.graph(None, None).edges.is_empty());
    }

    #[test]
    fn forget_returns_removed_ids_for_cascade() {
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", None).unwrap();
        s.record(1, "https://b.com/", "B", None).unwrap();
        let removed = s.forget(&ForgetScope::Url {
            url: "https://a.com/".into(),
        });
        assert_eq!(removed, vec![a]);
    }

    #[test]
    fn spa_republish_within_window_takes_fast_path_no_dirty() {
        // The perpetual-dirty fix: a same-URL republish inside the dedup window
        // must not re-mark the store dirty (or trace.json rewrites every flush
        // while you sit on a mutating page — the bug history.rs documents).
        let s = TraceStore::default();
        s.record(1, "https://a.com/", "A", None).unwrap();
        s.dirty.store(false, Ordering::Relaxed); // simulate a flush
        let before = s.visit(s.current_visit(1).unwrap()).unwrap().last_ms;
        s.record(1, "https://a.com/", "A", None).unwrap(); // SPA republish
        assert!(!s.dirty.load(Ordering::Relaxed), "fast path must not dirty");
        assert_eq!(
            s.visit(s.current_visit(1).unwrap()).unwrap().last_ms,
            before
        );
        // A real change (title) still goes through the write path.
        s.record(1, "https://a.com/", "A v2", None).unwrap();
        assert!(s.dirty.load(Ordering::Relaxed));
        assert_eq!(s.visit(s.current_visit(1).unwrap()).unwrap().title, "A v2");
    }

    #[test]
    fn lazy_hydration_survives_record_before_background_hydrate() {
        // The data-loss fix: a navigation that lands before the background
        // hydrate thread runs must not start a fresh store (which would later
        // overwrite the persisted Trail and reuse visit ids).
        let dir = std::env::temp_dir().join(format!("flux-trace-lazy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trace.json");
        let s1 = TraceStore::empty(path.clone());
        let a = s1.record(1, "https://a.com/", "A", None).unwrap();
        s1.persist_if_dirty();

        // Fresh store; record fires BEFORE anyone called hydrate() explicitly.
        let s2 = TraceStore::empty(path);
        let c = s2.record(7, "https://c.com/", "C", None).unwrap();
        assert_ne!(c, a, "ids must continue from the persisted next_id");
        let g = s2.graph(None, None);
        assert_eq!(g.visits.len(), 2, "the persisted visit survives");
        assert!(g.visits.iter().any(|v| v.url == "https://a.com/"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_edge_or_provenance_to_a_forgotten_prev_visit() {
        // Dangling-pointer fix: navigating away from a page that was just
        // forgotten must not leave an edge/from_visit to the removed node.
        let s = TraceStore::default();
        let a = s.record(1, "https://a.com/", "A", None).unwrap();
        s.forget(&ForgetScope::Url {
            url: "https://a.com/".into(),
        });
        // by_tab was scrubbed by forget, but simulate a stale pointer surviving
        // (e.g. eviction, which does not touch by_tab).
        s.by_tab.write().insert(1, a);
        let b = s.record(1, "https://b.com/", "B", None).unwrap();
        let vb = s.visit(b).unwrap();
        assert_eq!(vb.why.from_visit, None);
        assert_eq!(vb.why.referrer, None);
        assert!(s.graph(None, None).edges.is_empty());
    }

    #[test]
    fn histogram_buckets_by_last_ms() {
        let s = TraceStore::default();
        // Empty Trail → an all-zero span the frontend can hide on.
        let h = s.histogram(10);
        assert_eq!((h.min_ms, h.max_ms), (0, 0));
        assert!(h.counts.iter().all(|&c| c == 0));

        // Three visits; rewrite last_ms to a known spread (record uses now()).
        s.record(1, "https://a/", "A", None).unwrap();
        s.record(1, "https://b/", "B", None).unwrap();
        s.record(1, "https://c/", "C", None).unwrap();
        {
            let mut d = s.inner.write();
            d.visits[0].last_ms = 1_000;
            d.visits[1].last_ms = 1_500; // same first half as A
            d.visits[2].last_ms = 2_000;
        }
        let h = s.histogram(10);
        assert_eq!((h.min_ms, h.max_ms), (1_000, 2_000));
        assert_eq!(
            h.counts.iter().sum::<u32>(),
            3,
            "every visit lands in a bucket"
        );
        assert_eq!(h.counts[0], 1);
        assert_eq!(
            *h.counts.last().unwrap(),
            1,
            "newest visit in the last bucket"
        );
        // Bucket count is clamped to something sane.
        assert_eq!(s.histogram(1).counts.len(), 10);
        assert_eq!(s.histogram(9999).counts.len(), 400);
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
