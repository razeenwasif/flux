//! Dwell-captured content snapshots: text + embedding, budgeted, KB `web` feed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use super::now_ms;
use super::store::VisitId;

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
pub(crate) const SNAPSHOT_TEXT_CAP: usize = 20 * 1024;
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
    pub fn add(
        &self,
        visit_id: VisitId,
        url: String,
        title: String,
        text: String,
        embedding: Vec<f32>,
    ) -> u64 {
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
        self.inner
            .read()
            .snapshots
            .iter()
            .find(|s| s.id == id)
            .map(|s| SnapshotWire {
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
    pub fn neighbours(
        &self,
        embedding: &[f32],
        exclude: VisitId,
        k: usize,
        threshold: f32,
    ) -> Vec<VisitId> {
        if embedding.is_empty() || k == 0 {
            return Vec::new();
        }
        self.hydrate();
        let d = self.inner.read();
        let mut scored: Vec<(VisitId, f32)> = d
            .snapshots
            .iter()
            .filter(|s| s.visit_id != exclude)
            .map(|s| {
                (
                    s.visit_id,
                    crate::embedding::cosine(&s.embedding, embedding),
                )
            })
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
                title: if s.title.trim().is_empty() {
                    s.url.clone()
                } else {
                    s.title.clone()
                },
                url: s.url.clone(),
                mtime: s.saved_ms,
                body: s.text.clone(),
            })
            .collect()
    }

    /// Visit each stored snapshot's metadata + text without cloning the corpus —
    /// the ambient watcher's scan path (`f(visit_id, url, title, saved_ms, text)`).
    /// The read lock is held for the whole walk; callers keep `f` cheap.
    pub fn for_each_snapshot(&self, mut f: impl FnMut(VisitId, &str, &str, u64, &str)) {
        self.hydrate();
        for s in self.inner.read().snapshots.iter() {
            f(s.visit_id, &s.url, &s.title, s.saved_ms, &s.text);
        }
    }

    /// Path-less store pinned to the Hash embedder — for tests across the trace
    /// module (no disk, no Ollama probe).
    #[cfg(test)]
    pub(crate) fn empty_for_tests() -> Self {
        let cell = std::sync::OnceLock::new();
        let _ = cell.set(crate::embedding::Embedder::Hash);
        Self {
            inner: RwLock::new(SnapshotData::default()),
            embedder: std::sync::Arc::new(cell),
            path: None,
            dirty: AtomicBool::new(false),
            hydrated: AtomicBool::new(true),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
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

#[cfg(test)]
mod tests {
    use super::super::store::TraceStore;
    use super::*;
    /// Path-less snapshot store pinned to the Hash embedder (no Ollama probe).
    fn test_snaps() -> TraceSnapshots {
        TraceSnapshots::empty_for_tests()
    }

    #[test]
    fn neighbours_rank_threshold_and_exclude() {
        let snaps = test_snaps();
        // L2-normalized toy vectors: cosine == dot product.
        snaps.add(
            1,
            "https://a/".into(),
            "A".into(),
            "t".into(),
            vec![1.0, 0.0],
        );
        snaps.add(
            2,
            "https://b/".into(),
            "B".into(),
            "t".into(),
            vec![0.8, 0.6],
        ); // cos 0.8 vs [1,0]
        snaps.add(
            3,
            "https://c/".into(),
            "C".into(),
            "t".into(),
            vec![0.0, 1.0],
        ); // cos 0.0
        let n = snaps.neighbours(&[1.0, 0.0], 99, 5, 0.5);
        assert_eq!(
            n,
            vec![1, 2],
            "best-first, thresholded, c excluded by score"
        );
        // The visit being captured never links to itself.
        assert_eq!(snaps.neighbours(&[1.0, 0.0], 1, 5, 0.5), vec![2]);
        // Mismatched dimensions (embedder migration) compare as 0 — no edges.
        assert!(snaps.neighbours(&[1.0, 0.0, 0.0], 99, 5, 0.5).is_empty());
        // Empty embedding (embed failed) yields nothing.
        assert!(snaps.neighbours(&[], 99, 5, 0.5).is_empty());
    }

    #[test]
    fn snapshot_add_attach_get_and_budget_evicts_oldest() {
        let snaps = test_snaps();
        let id0 = snaps.add(
            10,
            "https://a.com/".into(),
            "Alpha".into(),
            "alpha".into(),
            vec![0.1, 0.2],
        );
        assert_eq!(snaps.get(id0).unwrap().text, "alpha");
        assert_eq!(snaps.get(id0).unwrap().title, "Alpha");
        assert_eq!(snaps.get(id0).unwrap().visit_id, 10);
        // web_docs flattens it for the KB, doc_id = visit id.
        let docs = snaps.web_docs();
        assert_eq!(docs.len(), 1);
        assert_eq!(
            (
                docs[0].doc_id.as_str(),
                docs[0].title.as_str(),
                docs[0].url.as_str()
            ),
            ("10", "Alpha", "https://a.com/")
        );

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
            let id = snaps.add(
                i as u64,
                "https://x/".into(),
                "T".into(),
                "t".into(),
                vec![],
            );
            if i == 0 {
                first = id;
            }
        }
        assert_eq!(snaps.inner.read().snapshots.len(), MAX_SNAPSHOTS);
        assert!(snaps.get(first).is_none(), "oldest snapshot was evicted");
    }
}
