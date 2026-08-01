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

fn default_embedder() -> Embedder {
    Embedder::Hash
}

/// One embedded chunk of a source document. The embedding is persisted (model
/// embeddings are network calls — don't recompute per load) and tagged with the
/// embedder that produced it, so the corpus re-embeds if the embedder changes.
#[derive(Serialize, Deserialize, Clone)]
pub struct KbChunk {
    pub source: String,
    pub doc_id: String,
    pub title: String,
    pub path: String,
    pub ord: usize,
    pub text: String,
    #[serde(default)]
    embedding: Vec<f32>,
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
            last: HashMap::new(),
            errors: HashMap::new(),
            config: HashMap::new(),
        }
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
pub const OWN_SOURCES: &[&str] = &["onyx", "scroll", "council", "scribe", "pdf", "pdf-ocr"];

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
        for (i, page) in nb.pages.iter().enumerate() {
            let body = crate::scribe::page_text(&page.strokes);
            if body.trim().is_empty() {
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

    /// Load the persisted index from disk (idempotent).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        if let Ok(json) = std::fs::read_to_string(path) {
            if let Ok(data) = serde_json::from_str::<KbData>(&json) {
                *self.data.write() = data;
            }
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let json = { serde_json::to_string(&*self.data.read()).ok() };
        if let Some(json) = json {
            let _ = std::fs::write(path, json);
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
            d.chunks
                .retain(|x| !(x.source == source && ids.contains(x.doc_id.as_str())));
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
            d.docs.clear();
            d.chunks.clear();
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

        let mut new_docs: Vec<KbDoc> = Vec::new();
        let mut new_chunks: Vec<KbChunk> = Vec::new();
        for doc in &raw {
            if existing.get(&doc.doc_id) == Some(&doc.mtime) {
                continue; // unchanged → its chunks are kept below
            }
            let texts = chunk_text(&doc.body);
            if texts.is_empty() {
                new_docs.push(KbDoc {
                    source: src.into(),
                    doc_id: doc.doc_id.clone(),
                    title: doc.title.clone(),
                    path: doc.path.clone(),
                    mtime: doc.mtime,
                    n_chunks: 0,
                    indexed_at: now_ms(),
                });
                continue;
            }
            let vecs = embedding::embed_batch(&texts, embedder)
                .ok_or("embedding model unavailable (is Ollama running?)")?;
            for (ord, (text, embedding)) in texts.into_iter().zip(vecs).enumerate() {
                new_chunks.push(KbChunk {
                    source: src.into(),
                    doc_id: doc.doc_id.clone(),
                    title: doc.title.clone(),
                    path: doc.path.clone(),
                    ord,
                    text,
                    embedding,
                    embedder,
                });
            }
            new_docs.push(KbDoc {
                source: src.into(),
                doc_id: doc.doc_id.clone(),
                title: doc.title.clone(),
                path: doc.path.clone(),
                mtime: doc.mtime,
                n_chunks: new_chunks.iter().filter(|c| c.doc_id == doc.doc_id).count(),
                indexed_at: now_ms(),
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
        d.chunks.retain(|x| {
            x.source != src || (present.contains(&x.doc_id) && !rebuilt.contains(&x.doc_id))
        });
        d.docs.extend(new_docs);
        d.chunks.extend(new_chunks);
        Ok(())
    }

    /// Cosine top-`k` over the corpus (optionally restricted to `sources`).
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
        let mut scored: Vec<(f32, &KbChunk)> = d
            .chunks
            .iter()
            .filter(|c| {
                allow
                    .map(|a| a.iter().any(|s| s == &c.source))
                    .unwrap_or(true)
            })
            .map(|c| (embedding::cosine(&qv, &c.embedding), c))
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored
            .into_iter()
            .take(k.clamp(1, 50))
            .map(|(score, c)| KbHit {
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
pub(crate) fn onyx_vault(location: Option<&str>) -> Option<PathBuf> {
    // In-app setting wins (the user just typed it), then the env var, then autodetect.
    let env_v = std::env::var("FLUX_ONYX_VAULT").ok();
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
        pdf_ocr: Vec::new(),
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
    title: String,
    content: String,
    folder: Option<String>,
    tags: Option<String>,
) -> Result<String, String> {
    let location = kb.source_location("onyx");
    tauri::async_runtime::spawn_blocking(move || {
        write_onyx_note(
            location.as_deref(),
            &title,
            &content,
            folder.as_deref(),
            tags.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
    tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?
}

fn write_onyx_note(
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
}
