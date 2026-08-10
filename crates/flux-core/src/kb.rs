//! Knowledge Base — local RAG over the user's own corpora (ADR 0010).
//!
//! A "second brain": connectors pull documents from the user's other tools
//! (Onyx vault notes today; Scroll papers next), chunk + embed them with
//! `crate::embedding` (Ollama `embeddinggemma`, hashing fallback), and a
//! brute-force cosine search grounds the Gemma agent's answers *with citations*.
//! Fully local — no corpus leaves the machine. Mirrors `archive.rs`'s on-disk
//! embedded-vector-store pattern, persisted to `<app_data>/kb/kb-index.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::embedding::{self, Embedder};
use crate::vecstore::{self, VecStore};

fn default_embedder() -> Embedder {
    Embedder::Hash
}

/// One embedded chunk of a source document, tagged with the embedder that
/// produced it so the corpus re-embeds if the embedder changes.
///
/// The vector itself lives in [`KbData::vecs`] at the same index, not here —
/// see `vecstore.rs` for why (this field used to hold a `Vec<f32>` that was
/// persisted as JSON decimal floats, which cost more than all of retrieval).
#[derive(Serialize, Deserialize, Clone)]
pub struct KbChunk {
    pub source: String,
    pub doc_id: String,
    pub title: String,
    pub path: String,
    pub ord: usize,
    pub text: String,
    /// Deserialize-only, for one-time migration of an index written before the
    /// sidecar existed. Never written back, and dropped once migrated — an
    /// index that had to re-embed instead would mean re-running every Ollama
    /// call for the whole corpus.
    #[serde(default, skip_serializing, rename = "embedding")]
    legacy_embedding: Vec<f32>,
    #[serde(default = "default_embedder")]
    embedder: Embedder,
}

/// Per-document record — drives listing + incremental reindex (skip unchanged mtimes).
#[derive(Serialize, Deserialize, Clone)]
pub struct KbDoc {
    pub source: String,
    pub doc_id: String,
    pub title: String,
    pub path: String,
    pub mtime: u64,
    pub n_chunks: usize,
    /// Epoch-ms when Flux first indexed this doc (or last rebuilt it after a
    /// change). Unlike `mtime` (a connector-specific change key — e.g. Scroll
    /// hashes its `updated` field), this is a real clock time, so it powers the
    /// weekly digest's "what you added this week" (#125). `0` for pre-#125 docs.
    #[serde(default)]
    pub indexed_at: u64,
}

#[derive(Serialize, Deserialize)]
struct KbData {
    embedder: Embedder,
    docs: Vec<KbDoc>,
    chunks: Vec<KbChunk>,
    /// Quantized embeddings, one row per entry in `chunks` **at the same
    /// index**. Persisted separately (binary sidecar), so it is skipped here.
    /// Every mutation of `chunks` must go through the paired helpers below —
    /// the two falling out of step attributes each hit to the wrong document,
    /// and nothing about the results would look wrong.
    #[serde(skip)]
    vecs: VecStore,
    /// source → epoch-ms of its last reindex.
    last: HashMap<String, u64>,
    /// source → last reindex error (e.g. "vault not found"), so the UI can explain a 0.
    #[serde(default)]
    errors: HashMap<String, String>,
    /// source → user-set location override (Onyx vault path / Scroll base URL),
    /// persisted in Flux's own config so it survives without fragile env vars.
    #[serde(default)]
    config: HashMap<String, String>,
}

impl Default for KbData {
    fn default() -> Self {
        KbData {
            embedder: Embedder::Hash,
            docs: Vec::new(),
            chunks: Vec::new(),
            vecs: VecStore::default(),
            last: HashMap::new(),
            errors: HashMap::new(),
            config: HashMap::new(),
        }
    }
}

impl KbData {
    /// Are the chunks and their vectors still paired? Cheap enough to assert on
    /// every load and after every rebuild.
    fn paired(&self) -> bool {
        self.chunks.len() == self.vecs.len()
    }

    /// Drop the chunks that don't pass, and their vectors with them.
    ///
    /// The mask is materialised rather than calling `keep` twice: `Vec::retain`
    /// and `VecStore::retain` visit in the same order, but a predicate that
    /// answered differently on the second pass would desync them silently.
    fn retain_chunks(&mut self, keep: impl Fn(&KbChunk) -> bool) {
        let mask: Vec<bool> = self.chunks.iter().map(keep).collect();
        let mut i = 0;
        self.chunks.retain(|_| {
            let k = mask[i];
            i += 1;
            k
        });
        self.vecs.retain(|r| mask[r]);
    }

    /// Empty the corpus (embedder change — vectors of a different width and
    /// meaning can't be compared with the new ones).
    fn clear_corpus(&mut self) {
        self.docs.clear();
        self.chunks.clear();
        self.vecs.clear();
    }
}

/// A search hit (wire type) — metadata + a snippet, never the whole corpus.
#[derive(Serialize, Clone, specta::Type)]
pub struct KbHit {
    pub source: String,
    pub doc_id: String,
    pub title: String,
    pub path: String,
    pub snippet: String,
    /// Relevance 0–100.
    pub score: u32,
}

/// Per-source counts for the Notebook view's status strip.
#[derive(Serialize, Clone, specta::Type)]
pub struct KbSourceStat {
    pub source: String,
    pub docs: u32,
    pub chunks: u32,
    pub last_ms: u64,
    /// Why the last reindex of this source found nothing (vault missing, server
    /// down, …), or `None` if it succeeded.
    pub error: Option<String>,
    /// User-set location override (Onyx vault path / Scroll URL), if any — echoed
    /// back so the Notebook UI can show what it's pointed at.
    pub location: Option<String>,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct KbStatus {
    pub sources: Vec<KbSourceStat>,
    /// "model" or "hash" — which embedder the corpus is on.
    pub embedder: String,
    pub indexing: bool,
}

/// A recently-indexed document, for the weekly digest (#125).
#[derive(Serialize, Clone, specta::Type)]
pub struct KbRecentItem {
    pub source: String,
    pub title: String,
    pub path: String,
    /// Epoch-ms when Flux indexed it.
    pub indexed_at: u64,
    /// First-chunk excerpt (so the digest has substance, not just titles).
    pub snippet: String,
}

/// Relevance floor for the ambient Connections rail.
///
/// Deliberately lower than a search cutoff: the query here is ~2400 characters
/// of a *whole page* (navigation, boilerplate and all), which dilutes cosine
/// against a focused note far more than a typed query does. The original 45
/// was a search-shaped number and meant the rail almost never fired.
const RELATED_MIN_SCORE: u32 = 30;

/// Sources Flux knows how to pull (Onyx vault notes, Scroll papers, Council briefs).
pub const SOURCES: &[&str] = &[
    "onyx",
    "scroll",
    "council",
    "web",
    "scribe",
    "pdf",
    "scribe-ocr",
    "pdf-ocr",
];

/// The corpora that live in memory rather than on disk as files, handed to
/// `reindex` by the caller.
///
/// A struct rather than four positional arguments: a `None` source rebuilds
/// everything, so *all* of them must be supplied on every call or a rebuild
/// silently wipes whichever was omitted — and four bare `Vec`s in a row is
/// exactly the shape that invites passing them in the wrong order.
#[derive(Default)]
pub struct Corpora {
    pub web: Vec<crate::trace::WebDoc>,
    pub scribe: Vec<RawDoc>,
    pub pdf: Vec<RawDoc>,
    /// Handwriting transcribed by the local vision model. Its own source so the
    /// machine-read origin travels with every citation.
    pub scribe_ocr: Vec<RawDoc>,
    /// Scanned PDFs read by tesseract. Separate from `pdf` for the same reason:
    /// text a machine lifted off an image can be wrong in ways a text layer
    /// can't, and a citation should say which it was.
    pub pdf_ocr: Vec<RawDoc>,
}

/// The corpora the user **authored**, as opposed to `web` — pages they merely
/// visited, captured by the Trail. The connections rail draws from these only:
/// the Trail has its own graph in the sidebar, so surfacing visited pages here
/// too was showing the same browsing history twice.
pub const OWN_SOURCES: &[&str] = &[
    "onyx",
    "scroll",
    "council",
    "scribe",
    "pdf",
    // Transcribed handwriting is still your own writing — a machine only read
    // it. Leaving it out meant Scribe pages you'd transcribed were invisible to
    // anything scoped to "my knowledge", including the agent's "My notes".
    "scribe-ocr",
    "pdf-ocr",
];

/// A document yielded by a connector, before chunking/embedding.
#[derive(Clone)]
pub struct RawDoc {
    doc_id: String,
    title: String,
    path: String,
    mtime: u64,
    body: String,
}

/// Turn Scribe notebooks into KB documents — one per page, built from the page's
/// **typed** text blocks. Handwriting isn't readable without OCR (that's the
/// deferred transcription follow-up), so a page contributes what it actually has
/// as text; a page with only ink yields nothing rather than an empty stub.
/// PDFs read in the built-in viewer. The text was extracted once by PDF.js when
/// the document was opened; this makes it answerable long after the tab closed.
pub fn pdf_docs(store: &crate::pdf::PdfStore) -> Vec<RawDoc> {
    pdf_docs_where(store, false)
}

/// Scanned PDFs read by OCR, as their own corpus — see [`Corpora::pdf_ocr`].
pub fn pdf_ocr_docs(store: &crate::pdf::PdfStore) -> Vec<RawDoc> {
    pdf_docs_where(store, true)
}

/// Both corpora come from one store and one file; only the KB source differs,
/// which is where the provenance needs to be.
fn pdf_docs_where(store: &crate::pdf::PdfStore, ocr: bool) -> Vec<RawDoc> {
    store
        .list()
        .into_iter()
        .filter(|d| d.ocr == ocr)
        .filter(|d| !d.text.trim().is_empty())
        .map(|d| RawDoc {
            doc_id: d.src.clone(),
            title: d.title,
            path: d.src,
            mtime: d.ts,
            body: d.text,
        })
        .collect()
}

/// Transcribed handwriting, as its own corpus. Separate from `scribe_docs` on
/// purpose: the source name is what tells a citation this text was read by a
/// model rather than written by the user.
pub fn scribe_ocr_docs(store: &crate::scribe::TranscriptStore) -> Vec<RawDoc> {
    store
        .list()
        .into_iter()
        .filter(|t| !t.latex.trim().is_empty())
        .map(|t| RawDoc {
            doc_id: t.key.clone(),
            title: t.title,
            path: format!("flux://scribe#{}", t.notebook),
            mtime: t.ts,
            body: t.latex,
        })
        .collect()
}

pub fn scribe_docs(store: &crate::scribe::ScribeStore) -> Vec<RawDoc> {
    let mut out = Vec::new();
    for meta in store.list() {
        let Some(nb) = store.load(&meta.id) else {
            continue;
        };
        let mut handwritten: Vec<usize> = Vec::new();
        for (i, page) in nb.pages.iter().enumerate() {
            let body = crate::scribe::page_text(&page.strokes);
            if body.trim().is_empty() {
                // Ink, not prose. Recorded rather than skipped — see the
                // notebook card below.
                handwritten.push(i + 1);
                continue;
            }
            out.push(RawDoc {
                doc_id: format!("{}#{}", nb.id, page.id),
                title: format!("{} — p{}", nb.name, i + 1),
                // Openable target: the Scribe page itself.
                path: format!("flux://scribe#{}/{}", nb.id, i + 1),
                mtime: page.ts,
                body,
            });
        }

        // One card per notebook, always — even when every page is ink.
        //
        // Without this a fully handwritten notebook produced *zero* documents,
        // so asking about it got "the sources contain no information about a
        // Convex Analysis notebook". Which was true of the corpus and utterly
        // misleading about reality: the notebook was right there, its pages
        // just hadn't been transcribed. Now the notebook itself is findable and
        // says what state it's in, so the answer becomes "it exists, here's how
        // to make it readable" instead of "it doesn't exist".
        let mut body = format!("Scribe notebook: {}", nb.name);
        if let Some(c) = nb.course.as_deref().filter(|c| !c.trim().is_empty()) {
            body.push_str(&format!("\nCourse: {c}"));
        }
        body.push_str(&format!("\nPages: {}", nb.pages.len()));
        if !handwritten.is_empty() {
            body.push_str(&format!(
                "\n{} of these pages are HANDWRITTEN and have not been transcribed, so their \
                 contents are not searchable yet: page{} {}. To read them, open the page in \
                 Scribe and use Transcribe (the local vision model writes the handwriting out \
                 as text and LaTeX).",
                handwritten.len(),
                if handwritten.len() == 1 { "" } else { "s" },
                handwritten
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        out.push(RawDoc {
            doc_id: format!("{}#notebook", nb.id),
            title: nb.name.clone(),
            path: format!("flux://scribe#{}", nb.id),
            mtime: nb.ts,
            body,
        });
    }
    out
}

/// Cheap-to-clone handle (Arcs inside) so a command can move it into a blocking task.
#[derive(Clone)]
pub struct KbStore {
    path: Option<PathBuf>,
    data: Arc<RwLock<KbData>>,
    hydrated: Arc<AtomicBool>,
    indexing: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn snippet(text: &str, n: usize) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(n).collect()
}

fn embedder_name(e: Embedder) -> &'static str {
    match e {
        Embedder::Model => "model",
        Embedder::Hash => "hash",
    }
}

impl Default for KbStore {
    fn default() -> Self {
        KbStore {
            path: None,
            data: Arc::new(RwLock::new(KbData::default())),
            hydrated: Arc::new(AtomicBool::new(false)),
            indexing: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl KbStore {
    pub fn empty(path: PathBuf) -> Self {
        KbStore {
            path: Some(path),
            ..Default::default()
        }
    }

    /// Where the quantized vectors live, alongside the JSON index.
    fn vectors_path(index: &std::path::Path) -> PathBuf {
        index.with_extension("vec")
    }

    /// Load the persisted index from disk (idempotent).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        let Ok(json) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(mut data) = serde_json::from_str::<KbData>(&json) else {
            return;
        };

        let sidecar = std::fs::read(Self::vectors_path(path))
            .ok()
            .and_then(|b| VecStore::from_bytes(&b));
        let mut migrated = false;

        match sidecar {
            // Normal path. The count check is the guard on the pairing
            // invariant: a sidecar that doesn't line up is refused outright,
            // because using it would silently score each chunk with another
            // document's vector.
            Some(v) if v.len() == data.chunks.len() => data.vecs = v,
            other => {
                if other.is_some() {
                    tracing::warn!(
                        target: "flux::kb",
                        chunks = data.chunks.len(),
                        "vector sidecar doesn't match the index; rebuilding from the JSON"
                    );
                }
                migrated = Self::migrate_inline_vectors(&mut data);
            }
        }

        // Free the migration buffers either way — on the normal path they were
        // never populated, and after a migration they're duplicated in `vecs`.
        for c in &mut data.chunks {
            c.legacy_embedding = Vec::new();
        }
        data.chunks.shrink_to_fit();

        debug_assert!(data.paired());
        *self.data.write() = data;
        if migrated {
            self.persist();
        }
    }

    /// Rebuild the vector store from embeddings that were inlined in the JSON.
    ///
    /// Returns whether anything was written that should be persisted. If the
    /// vectors aren't there either, the corpus is dropped and every source is
    /// given an error the Notebook panel can show — a KB that silently answers
    /// nothing is the failure mode this project keeps paying for, so an index
    /// we can't score is reported rather than served.
    fn migrate_inline_vectors(data: &mut KbData) -> bool {
        if data.chunks.is_empty() {
            data.vecs.clear();
            return false;
        }
        let mut vecs = VecStore::default();
        let ok = data
            .chunks
            .iter()
            .all(|c| !c.legacy_embedding.is_empty() && vecs.push(&c.legacy_embedding));
        if ok && vecs.len() == data.chunks.len() {
            tracing::info!(
                target: "flux::kb",
                chunks = vecs.len(),
                dim = vecs.dim(),
                "migrated inline embeddings to the quantized sidecar"
            );
            data.vecs = vecs;
            return true;
        }
        tracing::warn!(
            target: "flux::kb",
            chunks = data.chunks.len(),
            "index has no usable embeddings; a reindex is needed"
        );
        let sources: Vec<String> = data.chunks.iter().map(|c| c.source.clone()).collect();
        data.clear_corpus();
        for s in sources {
            data.errors
                .entry(s)
                .or_insert_with(|| "index needs rebuilding — hit ↻ Reindex".to_string());
        }
        true
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let (json, vecs) = {
            let d = self.data.read();
            (serde_json::to_string(&*d).ok(), d.vecs.to_bytes())
        };
        if let Some(json) = json {
            let _ = std::fs::write(path, json);
            let _ = std::fs::write(Self::vectors_path(path), vecs);
        }
    }

    pub fn status(&self) -> KbStatus {
        let d = self.data.read();
        let mut by: HashMap<&str, (u32, u32)> = HashMap::new();
        for doc in &d.docs {
            by.entry(&doc.source).or_default().0 += 1;
        }
        for ch in &d.chunks {
            by.entry(&ch.source).or_default().1 += 1;
        }
        let sources = SOURCES
            .iter()
            .map(|&s| {
                let (docs, chunks) = by.get(s).copied().unwrap_or((0, 0));
                KbSourceStat {
                    source: s.to_string(),
                    docs,
                    chunks,
                    last_ms: d.last.get(s).copied().unwrap_or(0),
                    error: d.errors.get(s).cloned(),
                    location: d.config.get(s).cloned(),
                }
            })
            .collect();
        KbStatus {
            sources,
            embedder: embedder_name(d.embedder).to_string(),
            indexing: self.indexing.load(Ordering::Acquire),
        }
    }

    /// Documents indexed within the last `days`, newest first (for the weekly
    /// digest #125). Each carries a first-chunk excerpt so the summary has substance.
    pub fn recent(&self, days: u64, cap: usize) -> Vec<KbRecentItem> {
        let d = self.data.read();
        let cutoff = now_ms().saturating_sub(days.saturating_mul(86_400_000));
        let mut docs: Vec<&KbDoc> = d
            .docs
            .iter()
            .filter(|x| x.indexed_at > 0 && x.indexed_at >= cutoff)
            .collect();
        docs.sort_by_key(|e| std::cmp::Reverse(e.indexed_at));
        docs.truncate(cap);
        docs.into_iter()
            .map(|doc| {
                let snippet = d
                    .chunks
                    .iter()
                    .find(|c| c.source == doc.source && c.doc_id == doc.doc_id && c.ord == 0)
                    .map(|c| c.text.chars().take(240).collect::<String>())
                    .unwrap_or_default();
                KbRecentItem {
                    source: doc.source.clone(),
                    title: doc.title.clone(),
                    path: doc.path.clone(),
                    indexed_at: doc.indexed_at,
                    snippet,
                }
            })
            .collect()
    }

    /// Persist a source's location override (Onyx vault path / Scroll URL). Empty
    /// clears it (back to env/autodetect). Survives restarts in `kb-index.json` —
    /// no fragile OS env var needed.
    pub fn set_location(&self, source: &str, location: &str) {
        self.hydrate();
        {
            let mut d = self.data.write();
            let v = location.trim();
            if v.is_empty() {
                d.config.remove(source);
            } else {
                d.config.insert(source.to_string(), v.to_string());
            }
            d.errors.remove(source); // stale error; the next reindex repopulates
        }
        self.persist();
    }

    /// The user-set location override for `source` (vault path / Scroll URL), if any.
    pub fn source_location(&self, source: &str) -> Option<String> {
        self.hydrate();
        self.data.read().config.get(source).cloned()
    }

    /// The embedder the persisted corpus is on (drives the auto-reindex's
    /// "did Ollama appear since we indexed?" check without an HTTP probe).
    pub fn embedder(&self) -> Embedder {
        self.hydrate();
        self.data.read().embedder
    }

    /// Remove specific docs (and their chunks) from a source, persisting if
    /// anything went. The privacy cascade for `trace_forget` (ADR 0011): a
    /// forgotten page must leave the KB immediately, not at the next reindex.
    pub fn remove_docs(&self, source: &str, doc_ids: &[String]) {
        if doc_ids.is_empty() {
            return;
        }
        self.hydrate();
        let ids: std::collections::HashSet<&str> = doc_ids.iter().map(|s| s.as_str()).collect();
        let changed = {
            let mut d = self.data.write();
            let (nd, nc) = (d.docs.len(), d.chunks.len());
            d.docs
                .retain(|x| !(x.source == source && ids.contains(x.doc_id.as_str())));
            d.retain_chunks(|x| !(x.source == source && ids.contains(x.doc_id.as_str())));
            d.docs.len() != nd || d.chunks.len() != nc
        };
        if changed {
            self.persist();
        }
    }

    /// (Re)build the index for `source` (or every known source when `None`),
    /// incrementally — documents whose mtime is unchanged keep their chunks.
    /// `web` carries the browsing snapshots (ADR 0011 step b) for the `"web"`
    /// source — supplied by the caller (from the Trail store) since it's an
    /// in-process corpus, not a file/HTTP connector. Empty means "no snapshots
    /// yet" (the web source legitimately indexes to 0 docs).
    pub fn reindex(&self, source: Option<String>, c: Corpora) -> Result<KbStatus, String> {
        self.hydrate();
        if self.indexing.swap(true, Ordering::AcqRel) {
            return Err("an index build is already running".into());
        }
        let result = self.reindex_inner(source, c);
        self.indexing.store(false, Ordering::Release);
        result.map(|_| self.status())
    }

    fn reindex_inner(&self, source: Option<String>, c: Corpora) -> Result<(), String> {
        let targets: Vec<&str> = match &source {
            Some(s) => {
                if !SOURCES.contains(&s.as_str()) {
                    return Err(format!("unknown source: {s}"));
                }
                vec![s.as_str()]
            }
            None => SOURCES.to_vec(),
        };

        // Pick the embedder once. If it changed since the last build, the whole
        // corpus must re-embed (cosine is only meaningful within one embedder).
        let embedder = embedding::current();
        let embedder_changed = self.data.read().embedder != embedder;
        if embedder_changed {
            let mut d = self.data.write();
            d.clear_corpus();
            d.embedder = embedder;
        }

        for src in targets {
            // "web" is an in-process corpus (the Trail's dwell snapshots), supplied
            // by the caller; every other source is a file/HTTP connector.
            // Both "web" (Trail snapshots) and "scribe" (handwritten notebooks)
            // are in-process corpora supplied by the caller, which owns their
            // stores; the rest are file/HTTP connectors.
            let raw = if src == "pdf" {
                Ok(c.pdf.clone())
            } else if src == "scribe-ocr" {
                Ok(c.scribe_ocr.clone())
            } else if src == "pdf-ocr" {
                Ok(c.pdf_ocr.clone())
            } else if src == "scribe" {
                Ok(c.scribe.clone())
            } else if src == "web" {
                Ok(c.web
                    .iter()
                    .map(|w| RawDoc {
                        doc_id: w.doc_id.clone(),
                        title: w.title.clone(),
                        path: w.url.clone(),
                        mtime: w.mtime,
                        body: w.body.clone(),
                    })
                    .collect())
            } else {
                let ov = self.data.read().config.get(src).cloned();
                collect(src, ov.as_deref())
            };
            let res = raw.and_then(|raw| self.reindex_source(src, embedder, raw));
            match res {
                Ok(()) => {
                    let mut d = self.data.write();
                    d.last.insert(src.to_string(), now_ms());
                    d.errors.remove(src); // cleared on success
                }
                Err(e) => {
                    // Record the reason so the UI can explain a 0 (vault missing,
                    // Scroll server down, …). In "reindex all" mode a failed source
                    // doesn't abort the others.
                    self.data.write().errors.insert(src.to_string(), e.clone());
                    if source.is_some() {
                        return Err(e);
                    }
                    tracing::warn!(target: "flux::kb", source = src, "skipped: {e}");
                }
            }
        }
        self.persist();
        Ok(())
    }

    fn reindex_source(
        &self,
        src: &str,
        embedder: Embedder,
        raw: Vec<RawDoc>,
    ) -> Result<(), String> {
        // Which docs are unchanged (same mtime) → keep; which are new/changed → rebuild.
        let existing: HashMap<String, u64> = {
            let d = self.data.read();
            d.docs
                .iter()
                .filter(|x| x.source == src)
                .map(|x| (x.doc_id.clone(), x.mtime))
                .collect()
        };
        let present: std::collections::HashSet<String> =
            raw.iter().map(|r| r.doc_id.clone()).collect();

        // Chunk every changed document up front, in parallel — it's pure CPU
        // (paragraph splitting + allocation) over independent documents, and it
        // has to finish before we can batch the embeddings anyway. `collect`
        // preserves input order, so the index is byte-identical to the serial
        // build. No lock is held here, which is what keeps the rayon pool safe
        // to share with `query` (see the note there).
        let mut chunked: Vec<(&RawDoc, Vec<String>)> = {
            use rayon::prelude::*;
            raw.par_iter()
                .filter(|doc| existing.get(&doc.doc_id) != Some(&doc.mtime))
                .map(|doc| (doc, chunk_text(&doc.body)))
                .collect()
        };

        // Flatten into one embedding request stream. Previously this was one
        // call per document, which for the model embedder meant a full HTTP
        // round trip per note — a 500-note vault paid 500 sequential RTTs to
        // embed a few thousand short paragraphs. `embed_batch` now decides its
        // own batching (and fans out across cores for the hash embedder).
        let mut counts: Vec<usize> = Vec::with_capacity(chunked.len());
        let mut flat: Vec<String> = Vec::new();
        for (_, texts) in &mut chunked {
            counts.push(texts.len());
            flat.append(texts);
        }
        let vecs = embedding::embed_batch(&flat, embedder)
            .ok_or("embedding model unavailable (is Ollama running?)")?;

        let mut new_docs: Vec<KbDoc> = Vec::with_capacity(chunked.len());
        let mut new_chunks: Vec<KbChunk> = Vec::with_capacity(flat.len());
        // Quantized outside the lock, so the write guard is held only for the
        // splice below rather than for the whole conversion.
        let mut new_vecs = VecStore::default();
        let mut texts = flat.into_iter();
        let mut vecs = vecs.into_iter();
        let indexed_at = now_ms();
        for ((doc, _), n) in chunked.iter().zip(counts) {
            for ord in 0..n {
                // Both iterators were built from the same flattened list, and
                // `embed_batch` returns one vector per input or `None`.
                let (Some(text), Some(embedding)) = (texts.next(), vecs.next()) else {
                    return Err("embedder returned the wrong number of vectors".into());
                };
                // A refused row would shift every later chunk onto its
                // neighbour's vector, so this is an abort, not a skip.
                if !new_vecs.push(&embedding) {
                    return Err(format!(
                        "embedding width changed mid-build (expected {}, got {})",
                        new_vecs.dim(),
                        embedding.len()
                    ));
                }
                new_chunks.push(KbChunk {
                    source: src.into(),
                    doc_id: doc.doc_id.clone(),
                    title: doc.title.clone(),
                    path: doc.path.clone(),
                    ord,
                    text,
                    legacy_embedding: Vec::new(),
                    embedder,
                });
            }
            new_docs.push(KbDoc {
                source: src.into(),
                doc_id: doc.doc_id.clone(),
                title: doc.title.clone(),
                path: doc.path.clone(),
                mtime: doc.mtime,
                // Was a linear scan of everything accumulated so far, which made
                // a full reindex quadratic in chunk count. It's just this
                // document's chunk count.
                n_chunks: n,
                indexed_at,
            });
        }

        // Merge: drop this source's docs/chunks that were rebuilt or removed, keep
        // the unchanged ones, then append the freshly built set.
        let mut d = self.data.write();
        let rebuilt: std::collections::HashSet<String> =
            new_docs.iter().map(|x| x.doc_id.clone()).collect();
        d.docs.retain(|x| {
            x.source != src || (present.contains(&x.doc_id) && !rebuilt.contains(&x.doc_id))
        });
        d.retain_chunks(|x| {
            x.source != src || (present.contains(&x.doc_id) && !rebuilt.contains(&x.doc_id))
        });
        d.docs.extend(new_docs);
        d.chunks.extend(new_chunks);
        if !d.vecs.append(&new_vecs) {
            // Surviving chunks were embedded at a different width than the ones
            // just built. Rather than serve a half-valid corpus, drop it and say
            // so — the next reindex rebuilds cleanly.
            d.clear_corpus();
            return Err("embedding width changed; the index was reset — reindex to rebuild".into());
        }
        debug_assert!(d.paired());
        Ok(())
    }

    /// Cosine top-`k` over the corpus (optionally restricted to `sources`).
    ///
    /// This is the highest-frequency CPU loop in Flux — the connections rail
    /// re-runs it on every navigation — and it is a linear scan of the whole
    /// corpus, so it is parallel over chunks and keeps only the running top `k`
    /// rather than scoring everything and sorting. The old version allocated a
    /// `(f32, &KbChunk)` per chunk and paid an O(n log n) sort to return 8 rows.
    pub fn query(
        &self,
        query: &str,
        k: usize,
        sources: Option<Vec<String>>,
    ) -> Result<Vec<KbHit>, String> {
        self.hydrate();
        let embedder = self.data.read().embedder;
        let qv = embedding::embed_with(query, embedder).ok_or("embedding model unavailable")?;
        let d = self.data.read();
        let allow = sources.as_ref();
        let k = k.clamp(1, 50);
        let keep = |c: &KbChunk| {
            allow
                .map(|a| a.iter().any(|s| s == &c.source))
                .unwrap_or(true)
        };

        // A corpus embedded at a different width than the query can't be scored
        // — the old code reached the same outcome via `cosine`'s length check
        // returning 0.0 for every chunk, which read as "nothing matches".
        if d.vecs.is_empty() || d.vecs.dim() != qv.len() || !d.paired() {
            return Ok(Vec::new());
        }
        let (q, q_scale) = vecstore::quantize_query(&qv);

        // NOTE: a read guard is held across the parallel section. That is only
        // safe because nothing runnable in the rayon pool ever takes this lock —
        // reindex does its parallel work *before* acquiring the write guard.
        // Keep it that way, or this becomes a pool-starvation deadlock.
        let scored = if d.chunks.len() < PAR_MIN_CHUNKS {
            let mut top = TopK::new(k);
            for (i, (c, (row, scale))) in d.chunks.iter().zip(d.vecs.rows()).enumerate() {
                if keep(c) {
                    top.push(vecstore::score(row, scale, &q, q_scale), i, c);
                }
            }
            top.into_ranked()
        } else {
            use rayon::prelude::*;
            d.chunks
                .par_iter()
                .zip(d.vecs.par_rows())
                .enumerate()
                .fold(
                    || TopK::new(k),
                    |mut top, (i, (c, (row, scale)))| {
                        if keep(c) {
                            top.push(vecstore::score(row, scale, &q, q_scale), i, c);
                        }
                        top
                    },
                )
                .reduce(|| TopK::new(k), TopK::merge)
                .into_ranked()
        };

        Ok(scored
            .into_iter()
            .map(|(score, _, c)| KbHit {
                source: c.source.clone(),
                doc_id: c.doc_id.clone(),
                title: c.title.clone(),
                path: c.path.clone(),
                snippet: snippet(&c.text, 240),
                score: (score.clamp(0.0, 1.0) * 100.0).round() as u32,
            })
            .collect())
    }
}

// ─── Retrieval ──────────────────────────────────────────────────────────────

/// Corpus size below which [`KbStore::query`] scans serially. Splitting a few
/// hundred dot products across cores costs more in pool hand-off than it saves,
/// and a brand-new install shouldn't wake worker threads to rank 40 notes.
const PAR_MIN_CHUNKS: usize = 512;

/// The best `k` chunks seen so far, without materialising the rest.
///
/// `k` is at most 50, so a sorted `Vec` with binary-search insertion beats a
/// heap: the comparison that matters — "is this worse than the worst I'm
/// keeping?" — is one predictable branch that rejects nearly every chunk after
/// the first few hundred, and the memmove it avoids never exceeds 50 entries.
struct TopK<'a> {
    k: usize,
    /// Ascending by rank, so `best[0]` is the first to be evicted.
    best: Vec<(f32, usize, &'a KbChunk)>,
}

/// Rank order: higher score wins; equal scores break toward the earlier chunk.
///
/// The position tiebreak isn't cosmetic. The serial version got its tie
/// behaviour for free from a *stable* sort over corpus order; without an
/// explicit tiebreak, work stealing would let two identical queries return
/// equally-scored hits in different orders, and the rail would reshuffle itself
/// for no reason the user could see.
fn rank(a: (f32, usize), b: (f32, usize)) -> std::cmp::Ordering {
    a.0.total_cmp(&b.0).then(b.1.cmp(&a.1))
}

impl<'a> TopK<'a> {
    fn new(k: usize) -> Self {
        Self {
            k,
            best: Vec::with_capacity(k + 1),
        }
    }

    fn push(&mut self, score: f32, at: usize, c: &'a KbChunk) {
        // A non-positive score is "no match", not a weak one — excluded outright
        // so a query with three real hits returns three rows, not `k`.
        if score <= 0.0 {
            return;
        }
        if self.best.len() == self.k && rank((score, at), (self.best[0].0, self.best[0].1)).is_le()
        {
            return;
        }
        let idx = self
            .best
            .partition_point(|&(s, i, _)| rank((s, i), (score, at)).is_lt());
        self.best.insert(idx, (score, at, c));
        if self.best.len() > self.k {
            self.best.remove(0);
        }
    }

    fn merge(mut self, other: Self) -> Self {
        for (s, i, c) in other.best {
            self.push(s, i, c);
        }
        self
    }

    /// Best first.
    fn into_ranked(self) -> Vec<(f32, usize, &'a KbChunk)> {
        let mut v = self.best;
        v.reverse();
        v
    }
}

// ─── Chunking ───────────────────────────────────────────────────────────────

/// Split a document body into ~200-word chunks on paragraph boundaries (skipping
/// YAML frontmatter), capped so a pathological note can't explode the index.
fn chunk_text(body: &str) -> Vec<String> {
    const TARGET_WORDS: usize = 200;
    const MAX_CHUNKS: usize = 200;
    let body = strip_frontmatter(body);
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut words = 0usize;
    for para in body.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        let w = para.split_whitespace().count();
        if words + w > TARGET_WORDS && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
            words = 0;
            if chunks.len() >= MAX_CHUNKS {
                break;
            }
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
        words += w;
    }
    if !cur.trim().is_empty() && chunks.len() < MAX_CHUNKS {
        chunks.push(cur);
    }
    chunks
}

/// Drop a leading `---\n…\n---` YAML frontmatter block.
fn strip_frontmatter(text: &str) -> &str {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    if let Some(rest) = t.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.trim_start_matches(['\n', '\r']);
        }
    }
    t
}

// ─── Connectors ───────────────────────────────────────────────────────────────

fn collect(source: &str, location: Option<&str>) -> Result<Vec<RawDoc>, String> {
    match source {
        "onyx" => collect_onyx(location),
        "scroll" => collect_scroll(location),
        "council" => collect_council(location),
        other => Err(format!("no connector for source: {other}")),
    }
}

/// Onyx vault root: `$FLUX_ONYX_VAULT` (so Flux can index a vault that lives
/// elsewhere — e.g. a Windows build pointing at `\\wsl.localhost\…\OnyxVault`),
/// else `~/.config/onyx/config.toml` `last_vault`, else `~/OnyxVault`.
pub fn onyx_vault(location: Option<&str>) -> Option<PathBuf> {
    // In-app setting wins (the user just typed it), then the env var, then autodetect.
    let env_v = std::env::var("FLUX_ONYX_VAULT").ok();
    for cand in [location, env_v.as_deref()] {
        if let Some(v) = cand.map(str::trim).filter(|v| !v.is_empty()) {
            // A vault path is typed once and used on whichever build is running,
            // and the two speak different dialects: `C:\Users\me\OnyxVault` is a
            // real path on the Windows build and meaningless on the WSL one,
            // where the same directory is `/mnt/c/Users/me/OnyxVault`.
            //
            // Translating here matters more than it looks. `is_dir` on an
            // untranslated Windows path simply fails under Linux, and the loop
            // then falls through to autodetect — which happily finds a
            // *different* vault in $HOME and indexes it. The user gets a working
            // Flux pointed at the wrong notes, with nothing to indicate it.
            let v = crate::files::native_path(v);
            if is_dir(Path::new(&v)) {
                return Some(PathBuf::from(v));
            }
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let cfg = Path::new(&home).join(".config/onyx/config.toml");
    if let Ok(s) = std::fs::read_to_string(&cfg) {
        for line in s.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("last_vault") {
                if let Some((_, v)) = rest.split_once('=') {
                    let v = v.trim().trim_matches('"').trim();
                    if !v.is_empty() && is_dir(Path::new(v)) {
                        return Some(PathBuf::from(v));
                    }
                }
            }
        }
    }
    let def = Path::new(&home).join("OnyxVault");
    is_dir(&def).then_some(def)
}

/// Directory existence check that tolerates UNC / WSL `\\wsl.localhost\…` shares,
/// where `is_dir()` can spuriously return false — fall back to opening it.
fn is_dir(p: &Path) -> bool {
    p.is_dir() || std::fs::read_dir(p).is_ok()
}

/// Read all `*.md` notes under the Onyx vault (skipping the `.onyx/` app dir).
fn collect_onyx(location: Option<&str>) -> Result<Vec<RawDoc>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let set = location
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("FLUX_ONYX_VAULT")
                .ok()
                .filter(|v| !v.trim().is_empty())
        });
    let root = onyx_vault(location).ok_or_else(|| match set {
        // Set but unusable — the most actionable case (wrong path, or WSL not running).
        Some(v) => format!(
            "Vault path '{}' isn't an accessible directory. For a WSL vault from a Windows \
build, make sure WSL is running and the UNC path is exact (e.g. \
\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\OnyxVault).",
            v.trim()
        ),
        None => format!(
            "Onyx vault not found — set its path below (looked at {home}/.config/onyx/config.toml \
and {home}/OnyxVault)."
        ),
    })?;
    let mut out = Vec::new();
    walk_md(&root, &root, &mut out);
    Ok(out)
}

/// Vault-relative paths of every note, for the agent's write targets (#108) —
/// the listing the model appends against. Paths only: the bodies are what the
/// KB is for, and a whole vault will not fit in a prompt.
pub(crate) fn onyx_note_paths(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    collect_paths(root, root, &mut out);
    out.sort();
    out
}

fn collect_paths(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in read.flatten() {
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            collect_paths(root, &path, out);
        } else if name.to_ascii_lowercase().ends_with(".md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

fn walk_md(root: &Path, dir: &Path, out: &mut Vec<RawDoc>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in read.flatten() {
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // skip .onyx/, .git/, dotfiles
        }
        let ft = ent.file_type().ok();
        if ft.map(|t| t.is_dir()).unwrap_or(false) {
            walk_md(root, &path, out);
        } else if name.to_ascii_lowercase().ends_with(".md") {
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mtime = ent
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let doc_id = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            let title = note_title(&body, &name);
            out.push(RawDoc {
                doc_id,
                title,
                path: path.to_string_lossy().into_owned(),
                mtime,
                body,
            });
        }
    }
}

/// A frontmatter `title:`/`question:` (Council briefs lead with `question:`),
/// else the first `#` heading, else the filename without `.md`.
fn note_title(body: &str, filename: &str) -> String {
    if let Some(t) = frontmatter_value(body, &["title", "question"]) {
        return t;
    }
    for line in strip_frontmatter(body).lines() {
        let l = line.trim_start();
        if let Some(h) = l.strip_prefix('#') {
            let t = h.trim_start_matches('#').trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    filename
        .strip_suffix(".md")
        .or_else(|| filename.strip_suffix(".MD"))
        .unwrap_or(filename)
        .to_string()
}

/// First matching `key: value` in a leading YAML frontmatter block (capped length).
fn frontmatter_value(body: &str, keys: &[&str]) -> Option<String> {
    let t = body.strip_prefix('\u{feff}').unwrap_or(body);
    let rest = t.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            if keys.iter().any(|key| k.trim().eq_ignore_ascii_case(key)) {
                let v = v.trim().trim_matches('"').trim();
                if !v.is_empty() {
                    return Some(v.chars().take(120).collect());
                }
            }
        }
    }
    None
}

// ─── Council connector (co-scientist debate briefs) ──────────────────────────
//
// Council writes each /discover run as a Markdown brief in `~/Research/debates`
// (YAML frontmatter `question:` + the debate body) — so it indexes just like the
// Onyx vault. Override the dir with the in-app location or `$FLUX_COUNCIL_DIR`.

fn council_dir(location: Option<&str>) -> Option<PathBuf> {
    let env_v = std::env::var("FLUX_COUNCIL_DIR").ok();
    for cand in [location, env_v.as_deref()] {
        if let Some(v) = cand.map(str::trim).filter(|v| !v.is_empty()) {
            if is_dir(Path::new(v)) {
                return Some(PathBuf::from(v));
            }
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let def = Path::new(&home).join("Research/debates");
    is_dir(&def).then_some(def)
}

fn collect_council(location: Option<&str>) -> Result<Vec<RawDoc>, String> {
    let root = council_dir(location).ok_or_else(|| {
        match location.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string).or_else(|| std::env::var("FLUX_COUNCIL_DIR").ok().filter(|v| !v.trim().is_empty())) {
            Some(v) => format!("Council briefs path '{}' isn't an accessible directory (WSL running? UNC path exact?).", v.trim()),
            None => "Council briefs not found — set the path below (looked at $FLUX_COUNCIL_DIR and ~/Research/debates).".to_string(),
        }
    })?;
    let mut out = Vec::new();
    walk_md(&root, &root, &mut out);
    Ok(out)
}

// ─── Scroll connector (read-later / research papers) ──────────────────────────
//
// Scroll (a TUI) serves its library over HTTP (`localhost:3131/api/articles`),
// like Omni — so Flux talks to it the same way (no SQLite dep, no DB locking
// against the live app). Override the base with `FLUX_SCROLL_URL`. The server
// must be reachable (`scroll serve`, or the TUI is open); otherwise this source
// is skipped on a full reindex.

/// Scroll's base URL: in-app override → `$FLUX_SCROLL_URL` → `localhost:3131`.
fn scroll_base(location: Option<&str>) -> String {
    location
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("FLUX_SCROLL_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| "http://localhost:3131".into())
        .trim_end_matches('/')
        .to_string()
}

fn collect_scroll(location: Option<&str>) -> Result<Vec<RawDoc>, String> {
    let url = format!("{}/api/articles", scroll_base(location));
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| {
            format!("Scroll not reachable at {url} (run `scroll serve` or open the app): {e}")
        })?;
    // `into_string()` caps at 10 MB; Scroll returns the full text of every article
    // (incl. large PDFs), so read via the reader with a generous cap instead.
    const MAX_BODY: u64 = 256 * 1024 * 1024;
    let mut body = String::new();
    use std::io::Read;
    resp.into_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|e| format!("reading Scroll response: {e}"))?;
    parse_scroll(&body)
}

/// Parse Scroll's `/api/articles` JSON (a bare array, or `{articles:[…]}`) into
/// RawDocs. The article `url` becomes the citation link; `ai_summary` (if any) is
/// prepended to the body so a short summary is always embedded.
fn parse_scroll(body: &str) -> Result<Vec<RawDoc>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let arr = v
        .as_array()
        .or_else(|| v.get("articles").and_then(|a| a.as_array()))
        .ok_or("unexpected Scroll response shape (no article array)")?;
    let mut out = Vec::new();
    for a in arr {
        let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let title = a
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("Untitled")
            .to_string();
        let path = a
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        // mtime only needs to *change* when the article changes (used for equality,
        // not ordering) → a stable hash of updated_at is enough for incremental.
        let updated = a.get("updated_at").and_then(|x| x.as_str()).unwrap_or("");
        let mtime = djb2(updated);
        let summary = a.get("ai_summary").and_then(|x| x.as_str()).unwrap_or("");
        let content = a
            .get("content_markdown")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        // Some Scroll PDFs store escaped binary in content_markdown — useless to
        // embed and it pollutes retrieval. Keep the summary (if any) and drop the body.
        let content = if looks_binary(content) { "" } else { content };
        // Cap pathological-but-textual bodies.
        let content: String = content.chars().take(200_000).collect();
        let body = if summary.is_empty() {
            content
        } else {
            format!("{summary}\n\n{content}")
        };
        if body.trim().is_empty() {
            continue;
        }
        out.push(RawDoc {
            doc_id: id.to_string(),
            title,
            path,
            mtime,
            body,
        });
    }
    Ok(out)
}

/// Heuristic: does this look like binary/escaped-blob content rather than prose?
/// (>10% control/replacement chars in a leading sample.) Used to drop Scroll's
/// raw-PDF articles before embedding.
fn looks_binary(s: &str) -> bool {
    let sample: Vec<char> = s.chars().take(4000).collect();
    if sample.is_empty() {
        return false;
    }
    let bad = sample
        .iter()
        .filter(|c| !matches!(**c, '\n' | '\r' | '\t') && (c.is_control() || **c == '\u{fffd}'))
        .count();
    bad * 100 / sample.len() > 10
}

/// Tiny stable string hash (djb2) — a content-change sentinel for incremental sync.
fn djb2(s: &str) -> u64 {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = (h << 5).wrapping_add(h).wrapping_add(b as u64);
    }
    h
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn kb_status(kb: State<'_, KbStore>) -> Result<KbStatus, String> {
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || {
        kb.hydrate();
        kb.status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Documents added to the KB within the last `days` (default 7) — the weekly
/// research digest's raw material (#125).
#[tauri::command]
pub async fn kb_recent(
    kb: State<'_, KbStore>,
    days: Option<u64>,
) -> Result<Vec<KbRecentItem>, String> {
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || {
        kb.hydrate();
        kb.recent(days.unwrap_or(7), 80)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kb_reindex(
    kb: State<'_, KbStore>,
    snaps: State<'_, crate::trace::TraceSnapshots>,
    scribe: State<'_, crate::scribe::ScribeStore>,
    transcripts: State<'_, crate::scribe::TranscriptStore>,
    pdf: State<'_, crate::pdf::PdfStore>,
    source: Option<String>,
) -> Result<KbStatus, String> {
    let kb = (*kb).clone();
    // The Trail's dwell snapshots are the `web` corpus and Scribe's notebooks are
    // the `scribe` one — both live in-process, so they're pulled here and handed
    // over, then chunked/embedded/cited like any file-backed source.
    let corpora = Corpora {
        web: snaps.web_docs(),
        scribe: scribe_docs(&scribe),
        pdf: pdf_docs(&pdf),
        scribe_ocr: scribe_ocr_docs(&transcripts),
        // Was `Vec::new()`, which meant every OCR'd PDF reindexed to zero
        // documents — the text was extracted, published and stored, and then
        // silently dropped on the way to the index.
        pdf_ocr: pdf_ocr_docs(&pdf),
    };
    tauri::async_runtime::spawn_blocking(move || kb.reindex(source, corpora))
        .await
        .map_err(|e| e.to_string())?
}

/// Set a source's location (Onyx vault path / Scroll URL) — the robust, env-free
/// way to point Flux at a vault that lives elsewhere (e.g. a WSL UNC path from a
/// Windows build). Empty clears it.
#[tauri::command]
pub async fn kb_set_source(
    kb: State<'_, KbStore>,
    source: String,
    location: String,
) -> Result<KbStatus, String> {
    if !SOURCES.contains(&source.as_str()) {
        return Err(format!("unknown source: {source}"));
    }
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || {
        kb.set_location(&source, &location);
        kb.status()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kb_query(
    kb: State<'_, KbStore>,
    query: String,
    k: Option<usize>,
    sources: Option<Vec<String>>,
) -> Result<Vec<KbHit>, String> {
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || kb.query(&query, k.unwrap_or(8), sources))
        .await
        .map_err(|e| e.to_string())?
}

/// Ambient "connects to your knowledge" (#123): items from the KB related to the
/// currently-open page, queried with the page's captured text. Returns only
/// genuinely-related hits (score-thresholded) so the rail stays quiet on a page
/// nothing in your corpus touches.
///
/// Restricted to [`OWN_SOURCES`] — your notes, papers, debates and Scribe pages.
/// Visited pages live in the Trail, which has its own graph.
#[tauri::command]
pub async fn kb_related(
    kb: State<'_, KbStore>,
    state: State<'_, crate::state::FluxState>,
    limit: Option<usize>,
) -> Result<Vec<KbHit>, String> {
    // Pull the page text out before the blocking task (Arc-cheap, like agent_chat).
    let text = state
        .active_snapshot()
        .map(|s| std::sync::Arc::clone(&s.text));
    let Some(text) = text else {
        return Ok(Vec::new());
    };
    let query: String = text.chars().take(2400).collect();
    if query.trim().chars().count() < 40 {
        return Ok(Vec::new()); // too little context to match meaningfully
    }
    let kb = (*kb).clone();
    let limit = limit.unwrap_or(6).clamp(1, 20);
    tauri::async_runtime::spawn_blocking(move || {
        let own = OWN_SOURCES.iter().map(|s| s.to_string()).collect();
        let hits = kb.query(&query, limit, Some(own))?;
        Ok(hits
            .into_iter()
            .filter(|h| h.score >= RELATED_MIN_SCORE)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Grounded, streamed answer (NotebookLM-style): retrieve top-k, prompt the local
/// agent with the numbered sources, stream the reply over `on_token` as JSON
/// events — `{kind:"sources",hits}` first, then `{kind:"token",text}`, then
/// `{kind:"done"}` (like `omni_answer`). The frontend renders citations + tokens.
#[tauri::command]
pub async fn kb_answer(
    kb: State<'_, KbStore>,
    query: String,
    sources: Option<Vec<String>>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let hits = kb.query(&query, 8, sources)?;
        // Sources first, so the UI can show citations immediately.
        let _ = on_token.send(serde_json::json!({ "kind": "sources", "hits": hits }).to_string());
        if hits.is_empty() {
            let _ = on_token.send(serde_json::json!({ "kind": "token", "text": "I couldn't find anything in your knowledge base for that. Try reindexing your sources." }).to_string());
            let _ = on_token.send(serde_json::json!({ "kind": "done" }).to_string());
            return Ok(());
        }
        let prompt = build_prompt(&query, &hits);
        let mut sink = |tok: &str| {
            let _ = on_token.send(serde_json::json!({ "kind": "token", "text": tok }).to_string());
        };
        // Route an in-domain question to a fine-tuned specialist voice (#120), if
        // one is installed; surface which voice is answering, then force it for
        // just this completion. Otherwise the default Gemma answers.
        let voice = crate::specialists::route(&query);
        if let Some(s) = &voice {
            let _ = on_token.send(serde_json::json!({ "kind": "voice", "label": s.label, "model": s.model }).to_string());
        }
        let r = match &voice {
            Some(s) => flux_agent::ollama::with_model(&s.model, || {
                crate::agent_bridge::planner().chat_stream(&prompt, None, &mut sink)
            }),
            None => crate::agent_bridge::planner().chat_stream(&prompt, None, &mut sink),
        };
        let _ = on_token.send(serde_json::json!({ "kind": "done" }).to_string());
        r.map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Result of a save-time novelty/contradiction check (#124).
#[derive(Serialize, Clone, specta::Type)]
pub struct KbCheck {
    /// "novel" | "contradicts" | "overlaps" | "adds" | "none" — drives the badge.
    pub verdict: String,
    /// A one/two-sentence assessment from the agent (empty when novel/none).
    pub note: String,
    /// The related existing items the assessment is about.
    pub related: Vec<KbHit>,
}

/// Check a newly-saved item against the knowledge base (#124): is it new, does it
/// contradict / duplicate an existing note, or does it add to one? Research
/// integrity for the co-scientist. Returns a verdict, a short note, and the
/// related items (for citations).
#[tauri::command]
pub async fn kb_check(kb: State<'_, KbStore>, text: String) -> Result<KbCheck, String> {
    let kb = (*kb).clone();
    let query: String = text.chars().take(2000).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let related: Vec<KbHit> = kb
            .query(&query, 5, None)?
            .into_iter()
            .filter(|h| h.score >= 50)
            .collect();
        if related.is_empty() {
            return Ok(KbCheck {
                verdict: "novel".into(),
                note: "New to your knowledge base — nothing closely related found.".into(),
                related: Vec::new(),
            });
        }
        let mut ctx = String::new();
        for (i, h) in related.iter().enumerate() {
            ctx.push_str(&format!(
                "[{}] {} — {}\n{}\n\n",
                i + 1,
                h.title,
                h.source,
                snippet(&h.snippet, 500)
            ));
        }
        // Both the saved note and the related notes are page/document-derived —
        // fence them as untrusted (ADR 0013, Pillar 0: stored-injection defense).
        let prompt = format!(
            "I just saved a note to my knowledge base (fenced below), and here are the most \
related existing notes (also fenced). Reply with EXACTLY one word on the first line — \
CONTRADICTS, DUPLICATES, ADDS, or UNRELATED — then on the next line a single concise sentence \
explaining, referencing the related notes as [n]. {preamble}\n\n\
SAVED NOTE:\n{saved}\n\nRELATED NOTES:\n{sources}",
            preamble = flux_agent::UNTRUSTED_PREAMBLE,
            saved = flux_agent::wrap_untrusted(&query),
            sources = flux_agent::wrap_untrusted(&ctx),
        );
        let raw = crate::agent_bridge::planner()
            .chat(&prompt, None)
            .map_err(|e| e.to_string())?;
        let raw = raw.trim();
        let first = raw.lines().next().unwrap_or("").trim().to_ascii_lowercase();
        let verdict = if first.contains("contradict") {
            "contradicts"
        } else if first.contains("duplicat") {
            "overlaps"
        } else if first.contains("add") {
            "adds"
        } else {
            "none"
        };
        // The explanation is everything after the verdict word/line.
        let note = raw
            .split_once('\n')
            .map(|x| x.1)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| raw.to_string());
        Ok(KbCheck {
            verdict: verdict.into(),
            note,
            related,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Build the grounded prompt: instructions + numbered source excerpts + question.
fn build_prompt(query: &str, hits: &[KbHit]) -> String {
    let mut ctx = String::new();
    for (i, h) in hits.iter().enumerate() {
        ctx.push_str(&format!(
            "[{}] {} — {}\n{}\n\n",
            i + 1,
            h.title,
            h.source,
            snippet(&h.snippet, 600)
        ));
    }
    // Retrieved KB content is page/document-derived and may carry a prompt
    // injection stored at ingest time — fence it as untrusted so a note or paper
    // can't hijack the answer when it's fed back later (ADR 0013, Pillar 0: the
    // stored-injection defense). The sources stay usable as data (answer FROM
    // them); only instructions embedded inside them are inert.
    format!(
        "You are the user's research co-scientist. Answer the question using ONLY the numbered \
sources below, which come from the user's own notes and papers. Cite the sources you use inline \
as [n]. If the sources don't cover the question, say so plainly — do not invent facts. {preamble}\n\n\
Sources:\n{sources}\n\nQuestion: {query}\n\nGrounded answer (with [n] citations):",
        preamble = flux_agent::UNTRUSTED_PREAMBLE,
        sources = flux_agent::wrap_untrusted(&ctx),
    )
}

// ─── Write access — let the agent add to the user's corpora (#118) ────────────

/// Clip an article URL into Scroll (the agent's "clip this to Scroll"). POSTs the
/// `/clip` form Scroll already serves, so Scroll does the scraping/storing.
/// `tags` is a comma-separated list (optional).
#[tauri::command]
pub async fn scroll_clip(
    kb: State<'_, KbStore>,
    url: String,
    tags: Option<String>,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("'{url}' isn't a web URL"));
    }
    let base = scroll_base(kb.source_location("scroll").as_deref());
    let endpoint = format!("{base}/clip");
    let tags = tags.unwrap_or_default().trim().to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut form: Vec<(&str, &str)> = vec![("url", url.as_str())];
        if !tags.is_empty() {
            form.push(("tags", tags.as_str()));
        }
        ureq::post(&endpoint)
            .timeout(Duration::from_secs(40)) // Scroll scrapes the page synchronously
            .send_form(&form)
            .map_err(|e| {
                format!("Scroll clip failed at {endpoint} (is `scroll serve` running?): {e}")
            })?;
        Ok(format!("Clipped to Scroll: {url}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a new Markdown note in the Onyx vault (the agent's "save this to Onyx").
/// Returns the written path. Never overwrites — disambiguates with a numeric suffix.
#[tauri::command]
pub async fn onyx_new_note(
    kb: State<'_, KbStore>,
    fresh: State<'_, std::sync::Arc<crate::kbfresh::KbFreshness>>,
    title: String,
    content: String,
    folder: Option<String>,
    tags: Option<String>,
) -> Result<String, String> {
    let location = kb.source_location("onyx");
    let out = tauri::async_runtime::spawn_blocking(move || {
        write_onyx_note(
            location.as_deref(),
            &title,
            &content,
            folder.as_deref(),
            tags.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    // Flux just wrote into the vault: mark it rather than waiting for the
    // watcher, which needs a configured *and* watchable vault to fire.
    fresh.touch("onyx");
    out
}

/// Shortest captured page we'll accept as a lecture/article capture. Below this
/// the page almost certainly hadn't rendered its text yet (or the transcript
/// panel is closed), and writing the note anyway would file an empty stub.
const MIN_CAPTURE_CHARS: usize = 400;

/// Capture the **active page's visible text** straight into an Onyx note —
/// built for lecture transcripts (Echo360 & co.), where the text you want is
/// already on screen and re-typing it is absurd.
///
/// Runs entirely in Rust: the page text is already in the DOM cache, so nothing
/// is shipped to the frontend and back. Fails loud when there's nothing
/// substantial captured, rather than filing an empty note that looks like it
/// worked.
#[tauri::command]
pub async fn onyx_capture_page(
    kb: State<'_, KbStore>,
    fresh: State<'_, std::sync::Arc<crate::kbfresh::KbFreshness>>,
    state: State<'_, crate::state::FluxState>,
    title: String,
    folder: Option<String>,
    tags: Option<String>,
) -> Result<String, String> {
    let snap = state
        .active_snapshot()
        .ok_or("No page captured yet — open the page (and its transcript tab), give it a moment, then try again.")?;
    let text = snap.text.trim().to_string();
    if text.chars().count() < MIN_CAPTURE_CHARS {
        return Err(format!(
            "Only {} characters captured from this page — if it's a lecture, open its transcript tab \
and scroll it into view, then try again.",
            text.chars().count()
        ));
    }
    let url = snap.url.clone();
    let location = kb.source_location("onyx");
    let out = tauri::async_runtime::spawn_blocking(move || {
        // Keep the source URL in the note so the KB citation can lead back to
        // the lecture itself.
        let body = format!("[source]({url})\n\n{text}");
        write_onyx_note(
            location.as_deref(),
            &title,
            &body,
            folder.as_deref(),
            tags.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    fresh.touch("onyx");
    out
}

pub(crate) fn write_onyx_note(
    location: Option<&str>,
    title: &str,
    content: &str,
    folder: Option<&str>,
    tags: Option<&str>,
) -> Result<String, String> {
    let root = onyx_vault(location)
        .ok_or_else(|| "Onyx vault not found — set its path in the Notebook first.".to_string())?;
    let dir = match folder.map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => root.join(f),
        None => root,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let base = sanitize_note_name(title);
    let mut path = dir.join(format!("{base}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} {n}.md"));
        n += 1;
    }
    // Lead with an H1 title unless the content already opens with a heading.
    let body = if content.trim_start().starts_with('#') {
        content.trim_start().to_string()
    } else {
        format!("# {}\n\n{}\n", title.trim(), content.trim())
    };
    // Frontmatter so the note is machine-readable the same way Scribe's pages
    // are: Onyx's TUI reads the tags, and the KB strips the block before
    // chunking. Only written when there are tags to carry — a plain note stays
    // a plain note.
    let tag_list = tags.map(crate::scribe::parse_tags).unwrap_or_default();
    let body = if tag_list.is_empty() {
        body
    } else {
        let items = tag_list
            .iter()
            .map(|t| format!("  - {}\n", crate::scribe::yaml_quote(t)))
            .collect::<String>();
        format!(
            "---\ntitle: {}\ntags:\n{}source: flux-agent\ndate: {}\n---\n\n{}",
            crate::scribe::yaml_quote(title.trim()),
            items,
            crate::scribe::today_ymd(),
            body,
        )
    };
    std::fs::write(&path, body).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Filesystem-safe note base name from a title (no path separators / illegal chars).
pub(crate) fn sanitize_note_name(title: &str) -> String {
    let first = title.lines().next().unwrap_or("").trim();
    let cleaned: String = first
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == '-' || c.is_whitespace());
    if cleaned.is_empty() {
        "Untitled note".to_string()
    } else {
        cleaned
            .chars()
            .take(80)
            .collect::<String>()
            .trim_end_matches(['-', ' ', '.'])
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault path is typed once and used on whichever build is running. On the
    /// WSL build an untranslated `C:\…` fails `is_dir`, and `onyx_vault` then
    /// falls through to autodetect — quietly indexing a *different* vault out of
    /// $HOME. A working Flux pointed at the wrong notes is the worst shape this
    /// bug can take, so the translation is asserted rather than assumed.
    #[cfg(not(windows))]
    #[test]
    fn a_windows_vault_path_resolves_on_the_wsl_build() {
        if !crate::files::under_wsl() || !std::path::Path::new("/mnt/c").is_dir() {
            return; // nothing to translate onto
        }
        // Built from a directory that certainly exists on C:.
        assert_eq!(
            onyx_vault(Some("C:\\Users")).as_deref(),
            Some(std::path::Path::new("/mnt/c/Users")),
            "a Windows-dialect vault path must resolve, not fall through to autodetect"
        );
        // Forward slashes are just as likely out of a settings field.
        assert_eq!(
            onyx_vault(Some("C:/Users")).as_deref(),
            Some(std::path::Path::new("/mnt/c/Users"))
        );
    }

    #[test]
    fn strips_frontmatter_and_chunks_paragraphs() {
        let body = "---\ntags:\n  - x\n---\n\nFirst para about rust ownership.\n\nSecond para.";
        let stripped = strip_frontmatter(body);
        assert!(stripped.starts_with("First para"));
        let chunks = chunk_text(body);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| !c.contains("tags:")));
    }

    #[test]
    fn long_body_splits_into_multiple_chunks() {
        // ~250 single-word paragraphs → more than one ~200-word chunk.
        let body = (0..250)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let chunks = chunk_text(&body);
        assert!(
            chunks.len() >= 2,
            "expected multiple chunks, got {}",
            chunks.len()
        );
    }

    #[test]
    fn note_title_prefers_first_heading() {
        assert_eq!(
            note_title("---\na: b\n---\n\n# Real Title\nbody", "file.md"),
            "Real Title"
        );
        assert_eq!(note_title("no heading here", "My Note.md"), "My Note");
    }

    #[test]
    fn note_title_uses_frontmatter_question_for_council_briefs() {
        let brief = "---\nquestion: How does the threshold theorem work?\ngenerated: 2026-06-09\n---\n\n# Synthesis\nbody";
        assert_eq!(
            note_title(brief, "2026-06-09-x.md"),
            "How does the threshold theorem work?"
        );
        // `title:` also wins over a heading.
        assert_eq!(
            note_title("---\ntitle: My Title\n---\n\n# Heading\n", "f.md"),
            "My Title"
        );
    }

    #[test]
    fn writes_onyx_note_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("flux-onyxwrite-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vault = dir.to_string_lossy().into_owned();

        let p1 = write_onyx_note(Some(&vault), "My Idea: a/b?", "first body", None, None).unwrap();
        assert!(
            p1.ends_with("My Idea- a-b.md"),
            "illegal chars sanitized: {p1}"
        );
        assert!(std::fs::read_to_string(&p1)
            .unwrap()
            .starts_with("# My Idea"));
        // Same title again → disambiguated, original kept.
        let p2 = write_onyx_note(Some(&vault), "My Idea: a/b?", "second body", None, None).unwrap();
        assert_ne!(p1, p2);
        assert!(p2.contains("My Idea- a-b 2.md"));
        // Folder is created.
        let p3 = write_onyx_note(
            Some(&vault),
            "Note",
            "x",
            Some("Inbox"),
            Some("#kkt, duality"),
        )
        .unwrap();
        assert!(p3.contains("Inbox"));
        // Tags become YAML frontmatter the KB strips and Onyx reads; an untagged
        // note (p1) stays plain Markdown.
        let m3 = std::fs::read_to_string(&p3).unwrap();
        assert!(
            m3.starts_with(
                "---\ntitle: \"Note\"\ntags:\n  - \"kkt\"\n  - \"duality\"\nsource: flux-agent\n"
            ),
            "got: {m3}"
        );
        assert!(!std::fs::read_to_string(&p1).unwrap().starts_with("---"));
        assert_eq!(sanitize_note_name("   ...  "), "Untitled note");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_scroll_articles_both_shapes_and_skips_empty() {
        let bare = r#"[
            {"id":"a1","title":"Diffusion Models","url":"https://x/1","updated_at":"2026-06-01T10:00:00","ai_summary":"a primer","content_markdown":"long body about denoising"},
            {"id":"a2","title":"Empty","url":"https://x/2","updated_at":"t","content_markdown":""},
            {"id":"","title":"No id","content_markdown":"skip me"}
        ]"#;
        let docs = parse_scroll(bare).unwrap();
        assert_eq!(docs.len(), 1, "empty-body + missing-id rows are skipped");
        assert_eq!(docs[0].doc_id, "a1");
        assert!(
            docs[0].body.starts_with("a primer"),
            "ai_summary is prepended"
        );
        assert_eq!(docs[0].path, "https://x/1");

        // Wrapped shape: {"articles":[…]}
        let wrapped = r#"{"articles":[{"id":"b1","title":"T","content_markdown":"body"}]}"#;
        assert_eq!(parse_scroll(wrapped).unwrap().len(), 1);

        // A binary/PDF-blob body is dropped, but a summary keeps the article.
        // `\0` in the JSON source decodes to NUL chars (control) → looks_binary.
        let blob = "\\u0000".repeat(500);
        let with_sum = format!(
            r#"[{{"id":"c1","title":"PDF","ai_summary":"the gist","content_markdown":"{blob}"}}]"#
        );
        let docs = parse_scroll(&with_sum).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(
            docs[0].body.trim(),
            "the gist",
            "binary body dropped, summary kept"
        );
        let no_sum = format!(r#"[{{"id":"c2","title":"PDF","content_markdown":"{blob}"}}]"#);
        assert!(
            parse_scroll(&no_sum).unwrap().is_empty(),
            "binary body + no summary → skipped"
        );
        assert!(looks_binary(&"\u{0}".repeat(500)) && !looks_binary("plain readable text"));
        // djb2 is stable + sensitive to change (drives incremental skip).
        assert_eq!(djb2("2026-06-01"), djb2("2026-06-01"));
        assert_ne!(djb2("2026-06-01"), djb2("2026-06-02"));
    }

    #[test]
    fn reindex_and_query_rank_related_higher() {
        // Build a tiny vault-like index by hand (hash embedder, no Ollama needed).
        let dir = std::env::temp_dir().join(format!("flux-kb-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));

        let raw = vec![
            RawDoc {
                doc_id: "a.md".into(),
                title: "Rust".into(),
                path: "/a.md".into(),
                mtime: 1,
                body: "memory safety in rust, the borrow checker and lifetimes".into(),
            },
            RawDoc {
                doc_id: "b.md".into(),
                title: "Cooking".into(),
                path: "/b.md".into(),
                mtime: 1,
                body: "tomato basil pasta recipe with garlic and olive oil".into(),
            },
        ];
        store.reindex_source("onyx", Embedder::Hash, raw).unwrap();
        store.data.write().embedder = Embedder::Hash;

        let hits = store
            .query("rust ownership and borrowing", 5, None)
            .unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].title, "Rust", "the rust note should rank first");

        // Incremental: same mtime → chunks unchanged (no re-embed needed).
        let before = store.data.read().chunks.len();
        let same = vec![RawDoc {
            doc_id: "a.md".into(),
            title: "Rust".into(),
            path: "/a.md".into(),
            mtime: 1,
            body: "changed but mtime same".into(),
        }];
        store.reindex_source("onyx", Embedder::Hash, same).unwrap();
        // a.md kept (mtime unchanged), b.md removed (absent from this batch).
        assert!(store.data.read().chunks.iter().any(|c| c.doc_id == "a.md"));
        assert!(!store.data.read().chunks.iter().any(|c| c.doc_id == "b.md"));
        assert!(store.data.read().chunks.len() <= before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_source_indexes_browsing_and_cites_the_url() {
        let dir = std::env::temp_dir().join(format!("flux-kb-web-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));
        store.data.write().embedder = Embedder::Hash;

        // Reindex the "web" source from Trail snapshots (no file/HTTP connector).
        let web = vec![crate::trace::WebDoc {
            doc_id: "42".into(),
            title: "CUDA out of memory — fix".into(),
            url: "https://forum.example/cuda-oom".into(),
            mtime: 100,
            body: "resolving a CUDA out of memory error by reducing the batch size and clearing the cache".into(),
        }];
        store
            .reindex(
                Some("web".into()),
                Corpora {
                    web,
                    ..Default::default()
                },
            )
            .unwrap();

        let hits = store
            .query("cuda memory error", 5, Some(vec!["web".into()]))
            .unwrap();
        assert!(!hits.is_empty(), "the browsed page should be retrievable");
        assert_eq!(hits[0].source, "web");
        // The citation points back at the page URL so a Notebook chip re-opens it.
        assert_eq!(hits[0].path, "https://forum.example/cuda-oom");

        // Absent from a later (empty) web batch → evicted, mirroring snapshot eviction.
        store
            .reindex(Some("web".into()), Corpora::default())
            .unwrap();
        assert!(!store.data.read().chunks.iter().any(|c| c.source == "web"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_docs_purges_forgotten_web_pages_immediately() {
        // The trace_forget privacy cascade: a forgotten page's text must leave
        // the KB at once, without waiting for the next reindex.
        let dir = std::env::temp_dir().join(format!("flux-kb-forget-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));
        store.data.write().embedder = Embedder::Hash;

        let web = vec![
            crate::trace::WebDoc {
                doc_id: "1".into(),
                title: "Keep".into(),
                url: "https://keep.example/".into(),
                mtime: 1,
                body: "a page about rust lifetimes and borrowing".into(),
            },
            crate::trace::WebDoc {
                doc_id: "2".into(),
                title: "Forget".into(),
                url: "https://forget.example/".into(),
                mtime: 1,
                body: "a private page that must vanish from the index".into(),
            },
        ];
        store
            .reindex(
                Some("web".into()),
                Corpora {
                    web,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store
                .data
                .read()
                .docs
                .iter()
                .filter(|d| d.source == "web")
                .count(),
            2
        );

        store.remove_docs("web", &["2".to_string()]);
        let d = store.data.read();
        assert!(
            d.docs.iter().any(|x| x.source == "web" && x.doc_id == "1"),
            "unrelated doc kept"
        );
        assert!(
            !d.docs.iter().any(|x| x.doc_id == "2"),
            "forgotten doc gone"
        );
        assert!(
            !d.chunks.iter().any(|x| x.doc_id == "2"),
            "its chunks gone too"
        );
        drop(d);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── Scribe as a KB source ──────────────────────────────────────────────

    #[test]
    fn a_handwritten_notebook_is_still_findable() {
        // The bug this fixes: every page was ink, page_text returned "", every
        // page was skipped, and the notebook produced ZERO documents. Asking
        // about it got "the sources contain no information about that notebook"
        // - true of the corpus, and completely misleading about reality.
        let dir = std::env::temp_dir().join(format!("flux-kb-scribe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::scribe::ScribeStore::restore(dir.clone());
        let mut nb = store.create(
            "Convex Analysis & Optimization".into(),
            Some("MATH3512".into()),
        );
        nb.pages[0].strokes = r##"[{"t":"pen","color":"#fff","w":3,"pts":[[1,1],[2,2]]}]"##.into();
        nb.pages.push(crate::scribe::Page {
            id: "pg-ink2".into(),
            template: "grid".into(),
            strokes: r##"[{"t":"pen","color":"#fff","w":3,"pts":[]}]"##.into(),
            ts: 2,
        });
        store.save(nb);

        let docs = scribe_docs(&store);
        assert_eq!(docs.len(), 1, "the notebook itself must be indexed");
        let card = &docs[0];
        assert_eq!(card.title, "Convex Analysis & Optimization");
        assert!(card.body.contains("MATH3512"), "course: {}", card.body);
        assert!(card.body.contains("Pages: 2"), "{}", card.body);
        assert!(
            card.body.to_lowercase().contains("handwritten"),
            "must say why the contents aren't searchable: {}",
            card.body
        );
        assert!(
            card.body.contains("Transcribe"),
            "and what to do about it: {}",
            card.body
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn typed_scribe_pages_are_indexed_individually() {
        let dir = std::env::temp_dir().join(format!("flux-kb-scribe2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::scribe::ScribeStore::restore(dir.clone());
        let mut nb = store.create("Notes".into(), None);
        nb.pages[0] =
            crate::scribe::Page::document("Duality", "Slater's condition implies strong duality.");
        store.save(nb);

        let docs = scribe_docs(&store);
        assert_eq!(docs.len(), 2, "one page + the notebook card");
        assert!(
            docs.iter().any(|d| d.body.contains("Slater")),
            "the page's prose is indexed"
        );
        // A fully-typed notebook shouldn't be told it has handwriting.
        let card = docs
            .iter()
            .find(|d| d.doc_id.ends_with("#notebook"))
            .unwrap();
        assert!(
            !card.body.to_lowercase().contains("handwritten"),
            "{}",
            card.body
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── Vector storage: migration and the sidecar ──────────────────────────

    /// An index written before the sidecar existed, with its vectors inline.
    fn legacy_index_json(body: &str) -> String {
        let v = embedding::embed_with(body, Embedder::Hash).unwrap();
        serde_json::json!({
            "embedder": "hash",
            "docs": [{ "source": "onyx", "doc_id": "a.md", "title": "Rust",
                       "path": "/a.md", "mtime": 1, "n_chunks": 1, "indexed_at": 0 }],
            "chunks": [{ "source": "onyx", "doc_id": "a.md", "title": "Rust",
                         "path": "/a.md", "ord": 0, "text": body,
                         "embedding": v, "embedder": "hash" }],
            "last": {}, "errors": {}, "config": {}
        })
        .to_string()
    }

    #[test]
    fn an_inline_index_migrates_instead_of_forcing_a_re_embed() {
        // The upgrade path that matters: for a model-embedded corpus, throwing
        // the vectors away would mean re-running every Ollama call.
        let dir = std::env::temp_dir().join(format!("flux-kb-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let index = dir.join("kb-index.json");
        let body = "memory safety in rust, the borrow checker and lifetimes";
        std::fs::write(&index, legacy_index_json(body)).unwrap();
        assert!(!KbStore::vectors_path(&index).exists(), "no sidecar yet");

        let store = KbStore::empty(index.clone());
        let hits = store
            .query("rust ownership and borrowing", 5, None)
            .unwrap();
        assert_eq!(hits.len(), 1, "the migrated vector is still searchable");
        assert_eq!(hits[0].doc_id, "a.md");

        // And the migration is written through, so the next boot is a binary
        // read rather than a float parse.
        assert!(KbStore::vectors_path(&index).exists(), "sidecar written");
        let rewritten = std::fs::read_to_string(&index).unwrap();
        assert!(
            !rewritten.contains("\"embedding\""),
            "vectors must not be left inline in the JSON"
        );

        let next_boot = KbStore::empty(index);
        assert_eq!(
            next_boot
                .query("rust ownership and borrowing", 5, None)
                .unwrap()
                .len(),
            1,
            "reading back from the sidecar finds the same chunk"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mismatched_sidecar_is_refused_rather_than_misread() {
        // The failure this guards: rows paired to chunks by position, so a
        // sidecar of the wrong length attributes every hit to the wrong
        // document — and the results would look entirely plausible.
        let dir = std::env::temp_dir().join(format!("flux-kb-mismatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let index = dir.join("kb-index.json");

        let store = KbStore::empty(index.clone());
        let raw: Vec<RawDoc> = (0..3)
            .map(|i| RawDoc {
                doc_id: format!("d{i}.md"),
                title: format!("Doc {i}"),
                path: format!("/d{i}.md"),
                mtime: 1,
                body: format!("document {i} about rust and borrowing"),
            })
            .collect();
        store.reindex_source("onyx", Embedder::Hash, raw).unwrap();
        store.data.write().embedder = Embedder::Hash;
        store.persist();
        assert_eq!(store.query("rust borrowing", 5, None).unwrap().len(), 3);

        // Corrupt the pairing: a sidecar holding one row for a three-chunk index.
        let mut short = VecStore::default();
        short.push(&embedding::embed_with("anything", Embedder::Hash).unwrap());
        std::fs::write(KbStore::vectors_path(&index), short.to_bytes()).unwrap();

        let reopened = KbStore::empty(index);
        assert!(
            reopened
                .query("rust borrowing", 5, None)
                .unwrap()
                .is_empty(),
            "a corpus that can't be scored must return nothing, not guesses"
        );
        let d = reopened.data.read();
        assert!(
            d.paired(),
            "chunks and vectors are consistent after the reset"
        );
        assert!(
            d.errors.contains_key("onyx"),
            "and the UI is told why it's empty rather than showing a bare 0"
        );
        drop(d);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_docs_keeps_the_remaining_vectors_with_their_chunks() {
        // `remove_docs` is the privacy cascade (trace_forget). It retains
        // chunks, so it must retain rows in lockstep or every surviving hit
        // shifts onto a neighbour's vector.
        let dir = std::env::temp_dir().join(format!("flux-kb-forget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));

        let topics = [
            "rust borrow checker",
            "tomato basil pasta",
            "tensor gradients",
        ];
        let raw: Vec<RawDoc> = topics
            .iter()
            .enumerate()
            .map(|(i, t)| RawDoc {
                doc_id: format!("d{i}.md"),
                title: t.to_string(),
                path: format!("/d{i}.md"),
                mtime: 1,
                body: format!("{t} explained at some length for the chunker"),
            })
            .collect();
        store.reindex_source("onyx", Embedder::Hash, raw).unwrap();
        store.data.write().embedder = Embedder::Hash;

        let before = store.query("tensor gradients", 1, None).unwrap();
        assert_eq!(before[0].title, "tensor gradients");

        // Drop the *first* document, so everything after it shifts by one.
        store.remove_docs("onyx", &["d0.md".to_string()]);
        assert!(store.data.read().paired());

        let after = store.query("tensor gradients", 1, None).unwrap();
        assert_eq!(
            after[0].title, "tensor gradients",
            "the survivor kept its own vector"
        );
        assert!(
            !store.data.read().chunks.iter().any(|c| c.doc_id == "d0.md"),
            "the forgotten doc is gone"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── Retrieval: top-k and the parallel scan ─────────────────────────────

    fn stub_chunk(id: &str) -> KbChunk {
        KbChunk {
            source: "onyx".into(),
            doc_id: id.into(),
            title: id.into(),
            path: id.into(),
            ord: 0,
            text: id.into(),
            legacy_embedding: Vec::new(),
            embedder: Embedder::Hash,
        }
    }

    #[test]
    fn top_k_bounds_the_result_and_drops_non_matches() {
        let chunks: Vec<KbChunk> = (0..10).map(|i| stub_chunk(&format!("c{i}"))).collect();

        let mut top = TopK::new(3);
        for (i, c) in chunks.iter().enumerate() {
            top.push(i as f32 * 0.1, i, c);
        }
        let got: Vec<&str> = top
            .into_ranked()
            .iter()
            .map(|(_, _, c)| c.doc_id.as_str())
            .collect();
        assert_eq!(got, ["c9", "c8", "c7"], "best first, exactly k");

        // A zero or negative cosine is "doesn't match", not "matches weakly" —
        // asking for 5 must not pad the rail with three non-matches.
        let mut top = TopK::new(5);
        top.push(0.0, 0, &chunks[0]);
        top.push(-0.5, 1, &chunks[1]);
        top.push(0.3, 2, &chunks[2]);
        assert_eq!(top.into_ranked().len(), 1);
    }

    #[test]
    fn merged_partials_break_ties_by_corpus_order() {
        // What two rayon workers each hand back, tied at the same score. Without
        // the position tiebreak the winner would depend on which worker got
        // there first, and identical queries would reshuffle the rail.
        let chunks: Vec<KbChunk> = (0..4).map(|i| stub_chunk(&format!("c{i}"))).collect();
        let mut a = TopK::new(2);
        a.push(0.5, 3, &chunks[3]);
        let mut b = TopK::new(2);
        b.push(0.5, 1, &chunks[1]);
        let got: Vec<usize> = a
            .merge(b)
            .into_ranked()
            .iter()
            .map(|(_, i, _)| *i)
            .collect();
        assert_eq!(got, [1, 3], "earlier chunk wins an exact tie");
    }

    #[test]
    fn parallel_retrieval_matches_the_serial_scan_exactly() {
        let dir = std::env::temp_dir().join(format!("flux-kb-par-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));

        // Enough documents to cross PAR_MIN_CHUNKS, with overlapping vocabulary
        // so scores actually spread (and tie) rather than all landing at zero.
        const WORDS: [&str; 8] = [
            "rust",
            "borrow",
            "checker",
            "lifetimes",
            "pasta",
            "garlic",
            "tensor",
            "gradient",
        ];
        let raw: Vec<RawDoc> = (0..700)
            .map(|i| RawDoc {
                doc_id: format!("d{i}.md"),
                title: format!("Note {i}"),
                path: format!("/d{i}.md"),
                mtime: 1,
                body: format!(
                    "note about {} and {} and {}",
                    WORDS[i % WORDS.len()],
                    WORDS[(i * 3) % WORDS.len()],
                    WORDS[(i * 5) % WORDS.len()]
                ),
            })
            .collect();
        store.reindex_source("onyx", Embedder::Hash, raw).unwrap();
        store.data.write().embedder = Embedder::Hash;

        let d = store.data.read();
        assert!(
            d.chunks.len() >= PAR_MIN_CHUNKS,
            "corpus must cross the threshold or this exercises the serial path"
        );
        drop(d);

        let q = "rust borrow checker lifetimes";
        let got: Vec<(String, u32)> = store
            .query(q, 10, None)
            .unwrap()
            .iter()
            .map(|h| (h.doc_id.clone(), h.score))
            .collect();

        // The reference is a plain serial scan with a full sort — the shape the
        // parallel top-k replaced. That the *quantized* score tracks exact f32
        // is a separate claim, owned by `vecstore`'s recall test; what's checked
        // here is that splitting the same scan across cores changes nothing.
        let qv = embedding::embed_with(q, Embedder::Hash).unwrap();
        let d = store.data.read();
        let (qq, qs) = vecstore::quantize_query(&qv);
        let mut scored: Vec<(f32, &KbChunk)> = d
            .chunks
            .iter()
            .zip(d.vecs.rows())
            .map(|(c, (row, sc))| (vecstore::score(row, sc, &qq, qs), c))
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let want: Vec<(String, u32)> = scored
            .into_iter()
            .take(10)
            .map(|(s, c)| (c.doc_id.clone(), (s.clamp(0.0, 1.0) * 100.0).round() as u32))
            .collect();

        assert_eq!(
            got.len(),
            10,
            "the corpus has more than 10 positive matches"
        );
        assert_eq!(
            got, want,
            "parallel top-k must reproduce the serial ranking"
        );
        drop(d);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_document_records_its_own_chunk_count() {
        // Guards the flatten/re-split in `reindex_source`: if the embedding
        // stream and the per-document counts drifted apart, chunks would be
        // attributed to the wrong document and `n_chunks` would stop matching
        // what's actually stored. (It also replaces an O(n²) scan that computed
        // this by filtering every chunk built so far, per document.)
        let dir = std::env::temp_dir().join(format!("flux-kb-counts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = KbStore::empty(dir.join("kb-index.json"));

        let long = (0..8)
            .map(|i| format!("paragraph {i} ").repeat(100))
            .collect::<Vec<_>>()
            .join("\n\n");
        let raw = vec![
            RawDoc {
                doc_id: "long.md".into(),
                title: "Long".into(),
                path: "/long.md".into(),
                mtime: 1,
                body: long,
            },
            RawDoc {
                doc_id: "short.md".into(),
                title: "Short".into(),
                path: "/short.md".into(),
                mtime: 1,
                body: "one small paragraph".into(),
            },
            RawDoc {
                doc_id: "empty.md".into(),
                title: "Empty".into(),
                path: "/empty.md".into(),
                mtime: 1,
                body: String::new(),
            },
        ];
        store.reindex_source("onyx", Embedder::Hash, raw).unwrap();

        let d = store.data.read();
        for doc in &d.docs {
            let actual = d.chunks.iter().filter(|c| c.doc_id == doc.doc_id).count();
            assert_eq!(doc.n_chunks, actual, "{} n_chunks", doc.doc_id);
            // Ord is per-document and dense, which only holds if each document's
            // slice of the flattened stream was handed back intact.
            let mut ords: Vec<usize> = d
                .chunks
                .iter()
                .filter(|c| c.doc_id == doc.doc_id)
                .map(|c| c.ord)
                .collect();
            ords.sort_unstable();
            assert_eq!(ords, (0..actual).collect::<Vec<_>>(), "{} ords", doc.doc_id);
        }
        assert!(
            d.docs.iter().any(|x| x.n_chunks > 1),
            "the long document must actually split, or this asserts nothing"
        );
        assert!(
            d.docs
                .iter()
                .any(|x| x.doc_id == "empty.md" && x.n_chunks == 0),
            "an empty document is still indexed, with no chunks"
        );
        drop(d);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
