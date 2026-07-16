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
    hydrated: AtomicBool,
}

impl TraceStore {
    /// Bind to `path` with no disk I/O (hydrate off the boot thread), mirroring
    /// `HistoryStore::empty`.
    pub fn empty(path: PathBuf) -> Self {
        Self { path: Some(path), ..Default::default() }
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
    pub fn record(&self, tab: TabId, url: &str, title: &str, task: Option<String>) -> Option<VisitId> {
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
        let referrer = prev_live.and_then(|p| d.visits.iter().find(|v| v.id == p).map(|v| v.url.clone()));
        let id = d.next_id;
        d.next_id += 1;
        d.visits.push(Visit {
            id,
            url: url.to_string(),
            title: title.to_string(),
            first_ms: now,
            last_ms: now,
            hits: 1,
            why: Provenance { from_visit: prev_live, referrer, query: None, task },
            snapshot_id: None,
            // URL-primary entities at nav time (a bare string scan — no text
            // yet), so even a bounced paper/repo page can be cited *into* later.
            entities: extract_entities(url, ""),
        });
        if let Some(p) = prev_live {
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
                x.kind == e.kind && ((x.from == e.from && x.to == e.to) || (x.from == e.to && x.to == e.from))
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
        let edges: Vec<Edge> = froms.iter().map(|&f| Edge { from: f, to, kind: EdgeKind::Semantic }).collect();
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
    /// One edge per visit pair, capped per derivation.
    pub fn derive_entity_edges(&self, id: VisitId) {
        const MAX_NEW: usize = 8;
        self.hydrate();
        let mut new_edges: Vec<Edge> = Vec::new();
        {
            let d = self.inner.read();
            let Some(me) = d.visits.iter().find(|v| v.id == id) else { return };
            if me.entities.is_empty() {
                return;
            }
            let me_repo = me.entities.iter().any(|e| e.primary && e.kind == EntityKind::Repo);
            for other in d.visits.iter().filter(|v| v.id != id && !v.entities.is_empty()) {
                let other_repo = other.entities.iter().any(|e| e.primary && e.kind == EntityKind::Repo);
                for em in &me.entities {
                    let Some(eo) = other.entities.iter().find(|e| e.kind == em.kind && e.value == em.value) else {
                        continue;
                    };
                    let edge = match (em.primary, eo.primary) {
                        // I mention what the other page IS → I cite (or implement) it.
                        (false, true) => Edge {
                            from: id,
                            to: other.id,
                            kind: if me_repo { EdgeKind::Implements } else { EdgeKind::Cites },
                        },
                        // The other page mentions what I am → it cites/implements me.
                        (true, false) => Edge {
                            from: other.id,
                            to: id,
                            kind: if other_repo { EdgeKind::Implements } else { EdgeKind::Cites },
                        },
                        // Shared mention → both are about the same thing.
                        (false, false) => Edge { from: other.id, to: id, kind: EdgeKind::Same },
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

    /// Most-recent visits (newest first).
    pub fn recent(&self, limit: usize) -> Vec<Visit> {
        self.hydrate();
        let d = self.inner.read();
        let mut v: Vec<Visit> = d.visits.clone();
        v.sort_unstable_by(|a, b| b.last_ms.cmp(&a.last_ms));
        v.truncate(limit);
        v
    }

    pub fn visit(&self, id: VisitId) -> Option<Visit> {
        self.hydrate();
        self.inner.read().visits.iter().find(|v| v.id == id).cloned()
    }

    /// Visits (optionally time-windowed by `last_ms`) plus the edges among them.
    pub fn graph(&self, after_ms: Option<u64>, before_ms: Option<u64>) -> TraceGraph {
        self.hydrate();
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

// ─── Entity extraction (payoff layer) ─────────────────────────────────────────
// Deterministic scanners — no regex crate, no LLM. False positives here become
// wrong "cites" edges in the graph, so each pattern is anchored and normalized.

/// Cap per visit so a references page can't spray hundreds of entities.
const MAX_ENTITIES: usize = 12;

/// Extract entities from a page. `url` matches are marked `primary` (the page
/// *is* the thing); `text` matches are mentions. Primaries win dedup and sort
/// first; the result is capped at [`MAX_ENTITIES`].
pub fn extract_entities(url: &str, text: &str) -> Vec<Entity> {
    let mut out: Vec<Entity> = Vec::new();
    scan_haystack(url, true, &mut out);
    scan_haystack(text, false, &mut out);
    // Primaries first (stable), then cap.
    out.sort_by_key(|e| !e.primary);
    out.truncate(MAX_ENTITIES);
    out
}

fn push_entity(out: &mut Vec<Entity>, kind: EntityKind, value: String, primary: bool) {
    if value.is_empty() {
        return;
    }
    if let Some(e) = out.iter_mut().find(|e| e.kind == kind && e.value == value) {
        e.primary |= primary; // primary wins on dedup
        return;
    }
    out.push(Entity { kind, value, primary });
}

fn scan_haystack(hay: &str, primary: bool, out: &mut Vec<Entity>) {
    let b = hay.as_bytes();
    let lower = hay.to_ascii_lowercase();

    // arXiv ids: after "arxiv.org/abs/", "arxiv.org/pdf/", or an "arxiv:" prefix.
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/", "arxiv:"] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(marker) {
            let at = from + p + marker.len();
            if let Some((id, _)) = scan_arxiv_id(b, at) {
                push_entity(out, EntityKind::Arxiv, id, primary);
            }
            from = at;
        }
    }

    // DOIs: "10.<4-9 digits>/<suffix>" — the registered-prefix shape.
    let mut from = 0;
    while let Some(p) = lower[from..].find("10.") {
        let at = from + p;
        // Word boundary on the left (start, or a non-alphanumeric).
        let bounded = at == 0 || !b[at - 1].is_ascii_alphanumeric();
        if bounded {
            if let Some((doi, end)) = scan_doi(&lower, at) {
                push_entity(out, EntityKind::Doi, doi, primary);
                from = end;
                continue;
            }
        }
        from = at + 3;
    }

    // GitHub repos: "github.com/<owner>/<name>".
    let mut from = 0;
    while let Some(p) = lower[from..].find("github.com/") {
        let at = from + p + "github.com/".len();
        if let Some((repo, end)) = scan_repo(&lower, at) {
            push_entity(out, EntityKind::Repo, repo, primary);
            from = end;
        } else {
            from = at;
        }
    }

    // Datasets: Hugging Face + Kaggle.
    for (marker, prefix) in [("huggingface.co/datasets/", "hf:"), ("kaggle.com/datasets/", "kaggle:")] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(marker) {
            let at = from + p + marker.len();
            if let Some((path, end)) = scan_owner_name(&lower, at) {
                push_entity(out, EntityKind::Dataset, format!("{prefix}{path}"), primary);
                from = end;
            } else {
                from = at;
            }
        }
    }
}

/// "dddd.dddd[d]" (+ optional "vN", stripped) starting at `i`.
fn scan_arxiv_id(b: &[u8], i: usize) -> Option<(String, usize)> {
    let n = b.len();
    let mut j = i;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j - i != 4 || j >= n || b[j] != b'.' {
        return None;
    }
    j += 1;
    let s2 = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if !(4..=5).contains(&(j - s2)) {
        return None;
    }
    let id = std::str::from_utf8(&b[i..j]).ok()?.to_string();
    let mut end = j;
    if end < n && (b[end] | 0x20) == b'v' {
        let mut m = end + 1;
        while m < n && b[m].is_ascii_digit() {
            m += 1;
        }
        if m > end + 1 {
            end = m;
        }
    }
    Some((id, end))
}

/// A DOI starting at `i` in lowercased `hay` ("10." already sighted there).
/// Suffix chars per the Crossref recommendation; trailing punctuation trimmed,
/// with `)` kept only when balanced inside the suffix (DOIs like
/// `10.1016/s0140-6736(20)30183-5` are real).
fn scan_doi(hay: &str, i: usize) -> Option<(String, usize)> {
    let b = hay.as_bytes();
    let n = b.len();
    let mut j = i + 3;
    let reg_start = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if !(4..=9).contains(&(j - reg_start)) || j >= n || b[j] != b'/' {
        return None;
    }
    j += 1;
    let suf_start = j;
    while j < n {
        let c = b[j];
        let ok = c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b';' | b'(' | b')' | b'/' | b':' | b'#');
        if !ok {
            break;
        }
        j += 1;
    }
    // Trim trailing punctuation that's almost certainly sentence/markup, not DOI.
    let mut end = j;
    loop {
        if end <= suf_start {
            break;
        }
        let c = b[end - 1];
        let trim = matches!(c, b'.' | b',' | b';' | b':')
            || (c == b')' && {
                let suffix = &hay[suf_start..end];
                suffix.matches('(').count() < suffix.matches(')').count()
            });
        if trim {
            end -= 1;
        } else {
            break;
        }
    }
    if end - suf_start < 2 {
        return None;
    }
    Some((hay[i..end].to_string(), end))
}

/// "<owner>/<name>" starting at `i` (both segments non-empty, url-ish charset),
/// skipping GitHub's non-repo first segments; strips a trailing ".git".
fn scan_repo(hay: &str, i: usize) -> Option<(String, usize)> {
    const NOT_REPOS: &[&str] = &[
        "about", "apps", "collections", "contact", "events", "explore", "features", "issues", "login",
        "marketplace", "new", "notifications", "orgs", "pricing", "pulls", "search", "security",
        "settings", "signup", "site", "sponsors", "topics", "trending",
    ];
    let (path, end) = scan_owner_name(hay, i)?;
    let owner = path.split('/').next().unwrap_or("");
    if NOT_REPOS.contains(&owner) {
        return None;
    }
    let path = path.strip_suffix(".git").unwrap_or(&path).to_string();
    Some((path, end))
}

/// Two url-path segments "<a>/<b>" starting at `i` in lowercased `hay`.
fn scan_owner_name(hay: &str, i: usize) -> Option<(String, usize)> {
    let b = hay.as_bytes();
    let n = b.len();
    let seg = |mut j: usize| {
        let s = j;
        while j < n && (b[j].is_ascii_alphanumeric() || matches!(b[j], b'-' | b'_' | b'.')) {
            j += 1;
        }
        (s, j)
    };
    let (s1, e1) = seg(i);
    if e1 == s1 || e1 >= n || b[e1] != b'/' {
        return None;
    }
    let (s2, e2) = seg(e1 + 1);
    if e2 == s2 {
        return None;
    }
    // Trim a trailing '.' (sentence period after a bare "owner/name" mention).
    let mut e2t = e2;
    while e2t > s2 && b[e2t - 1] == b'.' {
        e2t -= 1;
    }
    if e2t == s2 {
        return None;
    }
    Some((format!("{}/{}", &hay[s1..e1], &hay[s2..e2t]), e2))
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
    /// The visit's title at capture time — carried here so the KB `web` connector
    /// (and node detail) is self-contained without a visit lookup.
    #[serde(default)]
    pub title: String,
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
    pub title: String,
    pub saved_ms: u64,
    pub text: String,
}

/// A dwell snapshot flattened for the KB `web` connector (ADR 0011 step b): one
/// KB document per snapshotted visit. `doc_id` is the visit id (stable — a visit
/// holds one snapshot), so incremental reindex keeps unchanged pages.
pub struct WebDoc {
    pub doc_id: String,
    pub title: String,
    pub url: String,
    pub mtime: u64,
    pub body: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SnapshotData {
    snapshots: Vec<Snapshot>,
    next_id: u64,
}

/// The dwell-snapshot store — its own file + budget, per ADR 0011.
pub struct TraceSnapshots {
    inner: RwLock<SnapshotData>,
    /// One embedder for the whole corpus (cosine is only meaningful within one).
    /// Resolved **lazily at first capture** — `embedding::current()` probes the
    /// local Ollama server over HTTP, which must never run on the boot path
    /// (this store is constructed during setup) nor on the async runtime.
    embedder: std::sync::Arc<std::sync::OnceLock<crate::embedding::Embedder>>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
    /// Bumped on every `add`/`forget_visits` change — the KB auto-reindex
    /// debouncer watches this to fold settled browsing into the `web` source.
    generation: std::sync::atomic::AtomicU64,
}

impl TraceSnapshots {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            inner: RwLock::new(SnapshotData::default()),
            embedder: std::sync::Arc::new(std::sync::OnceLock::new()),
            path: Some(path),
            dirty: AtomicBool::new(false),
            hydrated: AtomicBool::new(false),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Monotonic change counter (see field docs). Not persisted — a restart
    /// starting at 0 just means one redundant (incremental, cheap) reindex.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Load from disk, exactly once (lazily invoked from every entry point, same
    /// race-proofing as [`TraceStore::hydrate`]).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
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

    /// Shared cell for resolving the corpus embedder OFF the async runtime: the
    /// caller clones this into `spawn_blocking`, resolves it there (first call
    /// probes Ollama), and later `add` reads the now-pinned value cheaply.
    pub fn embedder_cell(&self) -> std::sync::Arc<std::sync::OnceLock<crate::embedding::Embedder>> {
        std::sync::Arc::clone(&self.embedder)
    }

    /// The embedder this corpus uses. May probe Ollama on first call — keep off
    /// the boot path and the async runtime (use [`Self::embedder_cell`] there).
    pub fn embedder(&self) -> crate::embedding::Embedder {
        *self.embedder.get_or_init(crate::embedding::current)
    }

    /// Store a captured snapshot, evicting the oldest beyond the budget. Returns
    /// the new snapshot id. The caller has already resolved the embedder (via
    /// [`Self::embedder_cell`] off-thread), so the read here is cheap.
    pub fn add(&self, visit_id: VisitId, url: String, title: String, text: String, embedding: Vec<f32>) -> u64 {
        self.hydrate();
        let embedder = self.embedder();
        let mut d = self.inner.write();
        let id = d.next_id;
        d.next_id += 1;
        d.snapshots.push(Snapshot {
            id,
            visit_id,
            url,
            title,
            saved_ms: now_ms(),
            text,
            embedding,
            embedder,
        });
        if d.snapshots.len() > MAX_SNAPSHOTS {
            let over = d.snapshots.len() - MAX_SNAPSHOTS;
            // Oldest-first eviction (the vec is push-append, so oldest are at the front).
            d.snapshots.drain(0..over);
        }
        drop(d);
        self.dirty.store(true, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
        id
    }

    pub fn get(&self, id: u64) -> Option<SnapshotWire> {
        self.hydrate();
        self.inner.read().snapshots.iter().find(|s| s.id == id).map(|s| SnapshotWire {
            id: s.id,
            visit_id: s.visit_id,
            url: s.url.clone(),
            title: s.title.clone(),
            saved_ms: s.saved_ms,
            text: s.text.clone(),
        })
    }

    /// Visits whose snapshots are semantically nearest to `embedding` — cosine ≥
    /// `threshold`, best-first, at most `k`, excluding `exclude` (the visit being
    /// captured). Used at capture time to draw `Semantic` edges, so topic
    /// clusters emerge across navigation branches. Mismatched embedders compare
    /// as 0 (different dimensions), so a corpus mid-migration just yields fewer
    /// neighbours rather than nonsense.
    pub fn neighbours(&self, embedding: &[f32], exclude: VisitId, k: usize, threshold: f32) -> Vec<VisitId> {
        if embedding.is_empty() || k == 0 {
            return Vec::new();
        }
        self.hydrate();
        let d = self.inner.read();
        let mut scored: Vec<(VisitId, f32)> = d
            .snapshots
            .iter()
            .filter(|s| s.visit_id != exclude)
            .map(|s| (s.visit_id, crate::embedding::cosine(&s.embedding, embedding)))
            .filter(|(_, c)| *c >= threshold)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored.into_iter().map(|(v, _)| v).collect()
    }

    /// Flatten every stored snapshot into a KB `web` document (ADR 0011 step b).
    /// One doc per snapshotted visit; the KB chunks + embeds these itself, so its
    /// citations point back to the page URL.
    pub fn web_docs(&self) -> Vec<WebDoc> {
        self.hydrate();
        self.inner
            .read()
            .snapshots
            .iter()
            .map(|s| WebDoc {
                doc_id: s.visit_id.to_string(),
                title: if s.title.trim().is_empty() { s.url.clone() } else { s.title.clone() },
                url: s.url.clone(),
                mtime: s.saved_ms,
                body: s.text.clone(),
            })
            .collect()
    }

    /// Drop snapshots belonging to any of `visits` (cascade from `trace_forget`).
    pub fn forget_visits(&self, visits: &std::collections::HashSet<VisitId>) {
        if visits.is_empty() {
            return;
        }
        self.hydrate();
        let mut d = self.inner.write();
        let before = d.snapshots.len();
        d.snapshots.retain(|s| !visits.contains(&s.visit_id));
        if d.snapshots.len() != before {
            drop(d);
            self.dirty.store(true, Ordering::Relaxed);
            self.generation.fetch_add(1, Ordering::Relaxed);
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

// ─── Per-page chat (ADR 0011 step d) ─────────────────────────────────────────
// A Gemma conversation *attached to a Visit*: ask questions about a page and the
// thread is still there when you return months later. Grounded in the visit's
// dwell snapshot text. Own store/file (chats are user words — they must never
// ride along in graph payloads), same lifecycle as the other trace stores, and
// forgotten together with the visit (`trace_forget` cascades).

/// Keep a conversation bounded: the newest messages win.
const MAX_CHAT_MSGS: usize = 200;
/// How much prior conversation the model sees per turn.
const CHAT_CONTEXT_TURNS: usize = 12;
/// How much of the snapshot text grounds the chat (same budget as the agent's
/// page prompts — a 12B model degrades long before the window fills).
const CHAT_PAGE_BUDGET: usize = 6 * 1024;

/// One message in a visit's chat thread.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct ChatMsg {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    pub ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct ChatData {
    /// visit id → its thread (serde_json stringifies the integer keys).
    chats: HashMap<VisitId, Vec<ChatMsg>>,
}

/// Per-visit chat threads — persisted to `trace/chats.json`.
#[derive(Default)]
pub struct TraceChats {
    inner: RwLock<ChatData>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
}

impl TraceChats {
    pub fn empty(path: PathBuf) -> Self {
        Self { path: Some(path), ..Default::default() }
    }

    /// Load from disk, exactly once (lazy, race-proof — see [`TraceStore::hydrate`]).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        let Some(loaded) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<ChatData>(&s).ok())
        else {
            return;
        };
        let mut d = self.inner.write();
        if d.chats.is_empty() {
            d.chats = loaded.chats;
        }
    }

    /// A visit's thread (empty if none yet).
    pub fn get(&self, visit: VisitId) -> Vec<ChatMsg> {
        self.hydrate();
        self.inner.read().chats.get(&visit).cloned().unwrap_or_default()
    }

    /// Append one message, dropping the oldest beyond the per-visit cap.
    pub fn append(&self, visit: VisitId, role: &str, text: &str) {
        self.hydrate();
        {
            let mut d = self.inner.write();
            let thread = d.chats.entry(visit).or_default();
            thread.push(ChatMsg { role: role.into(), text: text.into(), ms: now_ms() });
            if thread.len() > MAX_CHAT_MSGS {
                let over = thread.len() - MAX_CHAT_MSGS;
                thread.drain(0..over);
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Drop the threads of forgotten visits (cascade from `trace_forget`).
    pub fn forget_visits(&self, visits: &std::collections::HashSet<VisitId>) {
        if visits.is_empty() {
            return;
        }
        self.hydrate();
        let mut d = self.inner.write();
        let before = d.chats.len();
        d.chats.retain(|vid, _| !visits.contains(vid));
        if d.chats.len() != before {
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

/// Build the grounded per-page prompt: page context (title/url + snapshot text if
/// captured), the recent thread, then the new message. Shared by the command and
/// its test so the shape can't drift silently.
fn chat_prompt(visit: &Visit, snapshot_text: Option<&str>, thread: &[ChatMsg], message: &str) -> String {
    let mut p = String::from(
        "You are Flux's research assistant. The user is asking about a specific web \
         page from their browsing trail. Ground your answer in the page's captured \
         text below; when the answer isn't in it, say so plainly instead of guessing.\n\n",
    );
    p.push_str(&format!("PAGE: {} ({})\n", if visit.title.trim().is_empty() { &visit.url } else { &visit.title }, visit.url));
    match snapshot_text {
        Some(t) if !t.trim().is_empty() => {
            let mut capped = t;
            if capped.len() > CHAT_PAGE_BUDGET {
                let mut end = CHAT_PAGE_BUDGET;
                while !capped.is_char_boundary(end) {
                    end -= 1;
                }
                capped = &capped[..end];
            }
            p.push_str(&format!("CAPTURED TEXT:\n{capped}\n\n"));
        }
        _ => p.push_str("CAPTURED TEXT: (none — the page wasn't captured; answer from the title/URL and say you don't have its content)\n\n"),
    }
    let recent = thread.iter().rev().take(CHAT_CONTEXT_TURNS).rev();
    let mut any = false;
    for m in recent {
        if !any {
            p.push_str("CONVERSATION SO FAR:\n");
            any = true;
        }
        p.push_str(&format!("{}: {}\n", m.role, m.text));
    }
    if any {
        p.push('\n');
    }
    p.push_str(&format!("USER: {message}"));
    p
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
    // The visit must still exist (not evicted/forgotten) — otherwise the snapshot
    // would be an orphan nothing references.
    let Some(visit) = trace.visit(visit_id) else { return Ok(None) };
    // Already captured for this visit → no re-embed (dwell can fire repeatedly).
    if let Some(existing) = visit.snapshot_id {
        return Ok(Some(existing));
    }
    let title = visit.title;
    // Read the cached DOM text ONCE (then drop the dashmap guard before the await),
    // so what we store is exactly what we embedded even if the tab navigates mid-embed.
    let (url, text) = {
        let Some(snap) = state.dom_cache.get(&tab_id) else { return Ok(None) };
        (snap.url.clone(), crate::dom::cap_utf8(snap.text.to_string(), SNAPSHOT_TEXT_CAP))
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    // Resolve the corpus embedder + embed INSIDE the blocking task: both can hit
    // Ollama over HTTP (the first resolution probes it) — never on the async runtime.
    let emb_cell = snaps.embedder_cell();
    let embed_text = text.clone();
    let embedding = tauri::async_runtime::spawn_blocking(move || {
        let embedder = *emb_cell.get_or_init(crate::embedding::current);
        crate::embedding::embed_with(&embed_text, embedder).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())?;
    // Semantic edges (payoff layer): link this page to its nearest already-
    // captured neighbours by snapshot embedding, so topic clusters surface in
    // the Trail across navigation branches. ~1.5k dot products — microseconds.
    const SEM_K: usize = 3;
    const SEM_THRESHOLD: f32 = 0.55;
    let neighbours = snaps.neighbours(&embedding, visit_id, SEM_K, SEM_THRESHOLD);
    // Entities + citation edges (payoff layer): upgrade the nav-time URL-only
    // pass with what the page text mentions, then link shared papers/repos.
    let entities = extract_entities(&url, &text);
    let id = snaps.add(visit_id, url, title, text, embedding);
    trace.attach_snapshot(visit_id, id);
    trace.add_semantic_edges(visit_id, &neighbours);
    trace.set_entities(visit_id, entities);
    trace.derive_entity_edges(visit_id);
    Ok(Some(id))
}

/// A visit's chat thread (ADR 0011 step d) — empty if none yet.
#[tauri::command]
pub fn trace_chat(chats: State<'_, TraceChats>, visit_id: VisitId) -> Vec<ChatMsg> {
    chats.get(visit_id)
}

/// Send a message to a visit's chat (ADR 0011 step d): grounded in the visit's
/// dwell-snapshot text, streamed token-by-token over `on_token` (JSON events
/// `{kind:"token",text}` / `{kind:"done"}`, like `kb_answer`). Both sides of the
/// exchange are appended to the thread, which persists — return to the page (or
/// its Trail node) months later and the conversation is still attached.
#[tauri::command]
pub async fn trace_chat_send(
    trace: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    chats: State<'_, TraceChats>,
    visit_id: VisitId,
    message: String,
    on_token: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("empty message".into());
    }
    let Some(visit) = trace.visit(visit_id) else { return Err("that page is no longer in the Trail".into()) };
    let snapshot_text = visit.snapshot_id.and_then(|sid| snaps.get(sid)).map(|s| s.text);
    let thread = chats.get(visit_id);
    let prompt = chat_prompt(&visit, snapshot_text.as_deref(), &thread, &message);
    // Record the user side before inference so a crash mid-stream can't lose it.
    chats.append(visit_id, "user", &message);

    // Inference on a blocking thread (CPU/GPU-bound), streaming frames out.
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let mut sink = |tok: &str| {
            let _ = on_token.send(serde_json::json!({ "kind": "token", "text": tok }).to_string());
        };
        let r = crate::agent_bridge::planner().chat_stream(&prompt, None, &mut sink);
        let _ = on_token.send(serde_json::json!({ "kind": "done" }).to_string());
        r
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    chats.append(visit_id, "assistant", &reply);
    Ok(())
}

/// Forget part (or all) of the Trail — the day-one privacy control (ADR 0011).
/// Cascades to the visits' dwell snapshots, their chat threads, AND the KB's
/// `web` corpus: a forgotten page must leave everything immediately, not linger
/// until the next manual reindex.
#[tauri::command]
pub async fn trace_forget(
    store: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    chats: State<'_, TraceChats>,
    kb: State<'_, crate::kb::KbStore>,
    scope: ForgetScope,
) -> Result<(), String> {
    let removed: std::collections::HashSet<VisitId> = store.forget(&scope).into_iter().collect();
    snaps.forget_visits(&removed);
    chats.forget_visits(&removed);
    if removed.is_empty() {
        return Ok(());
    }
    // KB doc_id for a web doc = the visit id. Purge on a blocking task — the KB
    // may hydrate from disk here, and the retain pass walks every chunk.
    let doc_ids: Vec<String> = removed.iter().map(|v| v.to_string()).collect();
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || kb.remove_docs("web", &doc_ids))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Path-less snapshot store pinned to the Hash embedder (no Ollama probe).
    fn test_snaps() -> TraceSnapshots {
        let cell = std::sync::OnceLock::new();
        let _ = cell.set(crate::embedding::Embedder::Hash);
        TraceSnapshots {
            inner: RwLock::new(SnapshotData::default()),
            embedder: std::sync::Arc::new(cell),
            path: None,
            dirty: AtomicBool::new(false),
            hydrated: AtomicBool::new(true),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

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
        let snaps = test_snaps();
        let id0 = snaps.add(10, "https://a.com/".into(), "Alpha".into(), "alpha".into(), vec![0.1, 0.2]);
        assert_eq!(snaps.get(id0).unwrap().text, "alpha");
        assert_eq!(snaps.get(id0).unwrap().title, "Alpha");
        assert_eq!(snaps.get(id0).unwrap().visit_id, 10);
        // web_docs flattens it for the KB, doc_id = visit id.
        let docs = snaps.web_docs();
        assert_eq!(docs.len(), 1);
        assert_eq!((docs[0].doc_id.as_str(), docs[0].title.as_str(), docs[0].url.as_str()), ("10", "Alpha", "https://a.com/"));

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
        let snaps = test_snaps();
        // Exceed the cap; the store never grows past MAX_SNAPSHOTS and drops oldest.
        let mut first = 0;
        for i in 0..(MAX_SNAPSHOTS + 5) {
            let id = snaps.add(i as u64, "https://x/".into(), "T".into(), "t".into(), vec![]);
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
        assert_eq!(s.visit(s.current_visit(1).unwrap()).unwrap().last_ms, before);
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
        s.forget(&ForgetScope::Url { url: "https://a.com/".into() });
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
    fn extracts_and_normalizes_entities() {
        // arXiv: URL is primary, version stripped; text mention is not primary.
        let e = extract_entities("https://arxiv.org/abs/2511.19477v2", "see arXiv:1706.03762 for the transformer");
        assert!(e.iter().any(|x| x.kind == EntityKind::Arxiv && x.value == "2511.19477" && x.primary));
        assert!(e.iter().any(|x| x.kind == EntityKind::Arxiv && x.value == "1706.03762" && !x.primary));

        // DOI: publisher-URL primary; text DOI with trailing period trimmed but
        // balanced parens kept (real Lancet-style DOI).
        let e = extract_entities(
            "https://link.springer.com/article/10.1007/s11229-023-04281-5",
            "as shown in 10.1016/s0140-6736(20)30183-5.",
        );
        assert!(e.iter().any(|x| x.kind == EntityKind::Doi && x.value == "10.1007/s11229-023-04281-5" && x.primary));
        assert!(e.iter().any(|x| x.kind == EntityKind::Doi && x.value == "10.1016/s0140-6736(20)30183-5" && !x.primary));

        // Repo: sub-page URL still yields owner/name, lowercased, .git stripped;
        // GitHub's non-repo sections are skipped.
        let e = extract_entities("https://GitHub.com/Razeen/Flux/issues/5", "clone github.com/foo/bar.git — not github.com/features/copilot");
        assert!(e.iter().any(|x| x.kind == EntityKind::Repo && x.value == "razeen/flux" && x.primary));
        assert!(e.iter().any(|x| x.kind == EntityKind::Repo && x.value == "foo/bar" && !x.primary));
        assert!(!e.iter().any(|x| x.value.starts_with("features/")));

        // Datasets + dedup (primary wins) + no junk from plain text.
        let e = extract_entities(
            "https://huggingface.co/datasets/allenai/c4",
            "the C4 corpus (huggingface.co/datasets/allenai/c4) at version 10.5",
        );
        let ds: Vec<_> = e.iter().filter(|x| x.kind == EntityKind::Dataset).collect();
        assert_eq!(ds.len(), 1, "same dataset deduped");
        assert!(ds[0].primary, "primary wins the dedup");
        assert!(!e.iter().any(|x| x.kind == EntityKind::Doi), "\"10.5\" is not a DOI");
        assert!(extract_entities("https://example.com/", "nothing to see").is_empty());
    }

    #[test]
    fn entity_edges_cites_implements_and_same() {
        let s = TraceStore::default();
        // The paper page (primary arXiv via URL, at nav time).
        let paper = s.record(1, "https://arxiv.org/abs/2511.19477", "Paper", None).unwrap();
        // A repo whose README mentions the paper → Implements repo→paper.
        let repo = s.record(2, "https://github.com/foo/bar", "Repo", None).unwrap();
        s.set_entities(repo, extract_entities("https://github.com/foo/bar", "implements arXiv:2511.19477"));
        s.derive_entity_edges(repo);
        // A blog post mentioning the paper → Cites blog→paper.
        let blog = s.record(3, "https://blog.example/post", "Blog", None).unwrap();
        s.set_entities(blog, extract_entities("https://blog.example/post", "great read: arxiv.org/abs/2511.19477"));
        s.derive_entity_edges(blog);

        let g = s.graph(None, None);
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Implements && e.from == repo && e.to == paper));
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Cites && e.from == blog && e.to == paper));
        // Blog and repo both *mention* the paper → Same between them.
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Same
            && ((e.from, e.to) == (repo, blog) || (e.from, e.to) == (blog, repo))));
        // Re-deriving is idempotent (both-direction dedup).
        let n = g.edges.len();
        s.derive_entity_edges(blog);
        assert_eq!(s.graph(None, None).edges.len(), n);
        // Forget the paper → its citation edges go with it.
        s.forget(&ForgetScope::Url { url: "https://arxiv.org/abs/2511.19477".into() });
        let g = s.graph(None, None);
        assert!(!g.edges.iter().any(|e| matches!(e.kind, EdgeKind::Cites | EdgeKind::Implements)));
    }

    #[test]
    fn neighbours_rank_threshold_and_exclude() {
        let snaps = test_snaps();
        // L2-normalized toy vectors: cosine == dot product.
        snaps.add(1, "https://a/".into(), "A".into(), "t".into(), vec![1.0, 0.0]);
        snaps.add(2, "https://b/".into(), "B".into(), "t".into(), vec![0.8, 0.6]); // cos 0.8 vs [1,0]
        snaps.add(3, "https://c/".into(), "C".into(), "t".into(), vec![0.0, 1.0]); // cos 0.0
        let n = snaps.neighbours(&[1.0, 0.0], 99, 5, 0.5);
        assert_eq!(n, vec![1, 2], "best-first, thresholded, c excluded by score");
        // The visit being captured never links to itself.
        assert_eq!(snaps.neighbours(&[1.0, 0.0], 1, 5, 0.5), vec![2]);
        // Mismatched dimensions (embedder migration) compare as 0 — no edges.
        assert!(snaps.neighbours(&[1.0, 0.0, 0.0], 99, 5, 0.5).is_empty());
        // Empty embedding (embed failed) yields nothing.
        assert!(snaps.neighbours(&[], 99, 5, 0.5).is_empty());
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
        assert_eq!(g.edges.iter().filter(|e| e.kind == EdgeKind::Semantic).count(), 1);
        // Self-edges and missing endpoints are skipped.
        s.add_semantic_edges(a, &[a, 999]);
        s.add_semantic_edges(999, &[a]);
        let g = s.graph(None, None);
        assert_eq!(g.edges.iter().filter(|e| e.kind == EdgeKind::Semantic).count(), 1);
        // Forget drops semantic edges with their visit, like nav edges.
        s.forget(&ForgetScope::Url { url: "https://a.com/".into() });
        assert!(s.graph(None, None).edges.is_empty());
    }

    #[test]
    fn chat_appends_caps_persists_and_forgets() {
        let dir = std::env::temp_dir().join(format!("flux-trace-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chats.json");
        let c = TraceChats::empty(path.clone());
        c.append(7, "user", "what's this page about?");
        c.append(7, "assistant", "it's about rust lifetimes");
        assert_eq!(c.get(7).len(), 2);
        assert_eq!(c.get(7)[0].role, "user");
        // Cap: the newest messages win.
        for i in 0..(MAX_CHAT_MSGS + 10) {
            c.append(9, "user", &format!("m{i}"));
        }
        assert_eq!(c.get(9).len(), MAX_CHAT_MSGS);
        assert_eq!(c.get(9).last().unwrap().text, format!("m{}", MAX_CHAT_MSGS + 9));
        // Persist + lazy re-hydrate round-trips (integer map keys included).
        c.persist_if_dirty();
        let c2 = TraceChats::empty(path);
        assert_eq!(c2.get(7).len(), 2, "thread survives restart");
        // Forget cascade drops the thread.
        c2.forget_visits(&std::collections::HashSet::from([7]));
        assert!(c2.get(7).is_empty());
        assert_eq!(c2.get(9).len(), MAX_CHAT_MSGS, "unrelated thread kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_prompt_grounds_in_snapshot_and_recent_turns() {
        let v = Visit {
            id: 1,
            url: "https://ex.com/paper".into(),
            title: "A Paper".into(),
            first_ms: 0,
            last_ms: 0,
            hits: 1,
            why: Provenance::default(),
            snapshot_id: Some(0),
            entities: Vec::new(),
        };
        let thread: Vec<ChatMsg> = (0..20)
            .map(|i| ChatMsg { role: if i % 2 == 0 { "user".into() } else { "assistant".into() }, text: format!("t{i}"), ms: 0 })
            .collect();
        let p = chat_prompt(&v, Some("the captured body text"), &thread, "and the newest question?");
        assert!(p.contains("PAGE: A Paper (https://ex.com/paper)"));
        assert!(p.contains("CAPTURED TEXT:\nthe captured body text"));
        // Only the newest CHAT_CONTEXT_TURNS turns are included.
        assert!(!p.contains("t0"), "oldest turns are dropped");
        assert!(p.contains("t19"));
        assert!(p.ends_with("USER: and the newest question?"));
        // No snapshot → the model is told so, instead of silently hallucinating.
        let p2 = chat_prompt(&v, None, &[], "q");
        assert!(p2.contains("CAPTURED TEXT: (none"));
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
