//! Offline page archive + semantic search (BACKLOG #69).
//!
//! "Read-later" that actually works offline AND is semantically searchable —
//! the novel combination. Unlike Omni (#66), which POSTs page text to an
//! external service, this is fully local: saved pages live in
//! `<app_data>/archive/archive.json`, and search runs the local `flux-embed`
//! hashing embedder (no network, no model weights). Embeddings aren't persisted
//! — they're recomputed in memory on load (cheap, ~50 µs/page, and robust to an
//! embedder change). Stores the page's visible text, so the reader can render
//! it with no remote resources.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::embedding::{self, Embedder};

fn default_embedder() -> Embedder {
    Embedder::Hash
}

/// A saved page. `text` is the visible-text capture (no remote resources, so it
/// renders offline). The embedding is **persisted** (recomputing model
/// embeddings on every load would mean N network calls) and tagged with the
/// embedder that produced it (#11), so a corpus migrates if the embedder changes.
#[derive(Serialize, Deserialize, Clone)]
pub struct ArchiveEntry {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub saved_ms: u64,
    pub text: String,
    #[serde(default)]
    embedding: Vec<f32>,
    #[serde(default = "default_embedder")]
    embedder: Embedder,
}

/// List/search row — metadata + a short snippet (the full text stays out of list
/// payloads; fetch it with `archive_get`).
#[derive(Serialize, Clone, specta::Type)]
pub struct ArchiveMeta {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub saved_ms: u64,
    pub snippet: String,
    /// Relevance 0–100 (search results only; 0 for plain listing).
    pub score: u32,
}

type Entries = Arc<RwLock<Vec<ArchiveEntry>>>;

pub struct ArchiveStore {
    path: Option<PathBuf>,
    entries: Entries,
    /// The embedder this store's vectors use (chosen at load; whole corpus stays
    /// on one kind so cosine is meaningful).
    embedder: Embedder,
    next_id: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn snippet(text: &str) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(180).collect()
}

fn meta(e: &ArchiveEntry, score: u32) -> ArchiveMeta {
    ArchiveMeta { id: e.id, url: e.url.clone(), title: e.title.clone(), saved_ms: e.saved_ms, snippet: snippet(&e.text), score }
}

fn write_json(path: &Option<PathBuf>, entries: &[ArchiveEntry]) {
    if let Some(path) = path {
        if let Ok(json) = serde_json::to_string(entries) {
            let _ = std::fs::write(path, json);
        }
    }
}

impl Default for ArchiveStore {
    fn default() -> Self {
        Self { path: None, entries: Arc::new(RwLock::new(Vec::new())), embedder: Embedder::Hash, next_id: AtomicU64::new(1) }
    }
}

impl ArchiveStore {
    /// Load from disk (missing/corrupt → empty). Picks the embedder available
    /// now; if the persisted vectors were made by a different one (e.g. the user
    /// pulled the model since), re-embeds the corpus in the background so search
    /// stays fast + consistent.
    pub fn restore(path: PathBuf) -> Self {
        let entries: Vec<ArchiveEntry> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        let embedder = embedding::current();
        let needs_migrate = entries.iter().any(|e| e.embedder != embedder || e.embedding.is_empty());
        let store = Self { path: Some(path), entries: Arc::new(RwLock::new(entries)), embedder, next_id: AtomicU64::new(next) };
        if needs_migrate {
            let entries = Arc::clone(&store.entries);
            let path = store.path.clone();
            std::thread::spawn(move || migrate(entries, path, embedder));
        }
        store
    }

    /// Save a page (or refresh it if the URL is already archived). Returns the row.
    pub fn save(&self, url: String, title: String, text: String) -> ArchiveMeta {
        let embedding = embedding::embed_with(&text, self.embedder).unwrap_or_default();
        let mut g = self.entries.write();
        let result = if let Some(e) = g.iter_mut().find(|e| e.url == url) {
            e.title = title;
            e.text = text;
            e.saved_ms = now_ms();
            e.embedding = embedding;
            e.embedder = self.embedder;
            meta(e, 0)
        } else {
            let entry = ArchiveEntry { id: self.next_id.fetch_add(1, Ordering::Relaxed), url, title, saved_ms: now_ms(), text, embedding, embedder: self.embedder };
            let m = meta(&entry, 0);
            g.push(entry);
            m
        };
        write_json(&self.path, &g);
        result
    }

    /// Newest first.
    pub fn list(&self) -> Vec<ArchiveMeta> {
        let g = self.entries.read();
        let mut v: Vec<ArchiveMeta> = g.iter().map(|e| meta(e, 0)).collect();
        // Newest first; tiebreak by id (higher = saved later) for same-ms saves.
        v.sort_by(|a, b| b.saved_ms.cmp(&a.saved_ms).then(b.id.cmp(&a.id)));
        v
    }

    pub fn get(&self, id: u64) -> Option<ArchiveEntry> {
        self.entries.read().iter().find(|e| e.id == id).cloned()
    }

    pub fn delete(&self, id: u64) {
        let mut g = self.entries.write();
        g.retain(|e| e.id != id);
        write_json(&self.path, &g);
    }

    /// Semantic search: cosine against the query embedding, most-relevant first.
    /// Empty query → newest. Embeds the query with the store's embedder; if that
    /// embedder is unavailable now (Model with Ollama down), falls back to newest.
    pub fn search(&self, query: &str, limit: usize) -> Vec<ArchiveMeta> {
        if query.trim().is_empty() {
            let mut v = self.list();
            if limit > 0 {
                v.truncate(limit);
            }
            return v;
        }
        let Some(q) = embedding::embed_with(query, self.embedder) else {
            return self.list().into_iter().take(if limit > 0 { limit } else { usize::MAX }).collect();
        };
        let g = self.entries.read();
        let mut scored: Vec<(usize, f32)> = g
            .iter()
            .enumerate()
            .map(|(i, e)| (i, embedding::cosine(&e.embedding, &q)))
            .filter(|(_, s)| *s > 0.02) // drop near-orthogonal noise
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if limit > 0 {
            scored.truncate(limit);
        }
        scored.iter().map(|(i, s)| meta(&g[*i], (s.clamp(0.0, 1.0) * 100.0).round() as u32)).collect()
    }

    pub fn len(&self) -> usize {
        self.entries.read().len()
    }
}

/// Re-embed every entry with `target` (background, on an embedder change) and
/// persist. Runs once after a restore where the persisted vectors don't match
/// the now-available embedder.
fn migrate(entries: Entries, path: Option<PathBuf>, target: Embedder) {
    // Snapshot the texts to embed without holding the lock during network calls.
    let todo: Vec<(u64, String)> = entries
        .read()
        .iter()
        .filter(|e| e.embedder != target || e.embedding.is_empty())
        .map(|e| (e.id, e.text.clone()))
        .collect();
    for (id, text) in todo {
        let Some(vec) = embedding::embed_with(&text, target) else { return }; // embedder vanished → abort
        let mut g = entries.write();
        if let Some(e) = g.iter_mut().find(|e| e.id == id) {
            e.embedding = vec;
            e.embedder = target;
        }
    }
    write_json(&path, &entries.read());
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Save the active page for offline reading + semantic search.
#[tauri::command]
pub fn archive_save(
    state: State<'_, crate::state::FluxState>,
    archive: State<'_, ArchiveStore>,
) -> Result<ArchiveMeta, String> {
    let snap = state.active_snapshot().ok_or("no active page to save")?;
    if snap.text.trim().is_empty() {
        return Err("this page has no readable text to save".into());
    }
    let title = state
        .active_tab()
        .and_then(|id| state.tabs.get(&id).map(|t| t.title.clone()))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| snap.url.clone());
    Ok(archive.save(snap.url.clone(), title, snap.text.to_string()))
}

#[tauri::command]
pub fn archive_list(archive: State<'_, ArchiveStore>) -> Vec<ArchiveMeta> {
    archive.list()
}

#[tauri::command]
pub fn archive_get(archive: State<'_, ArchiveStore>, id: u64) -> Option<ArchiveEntry> {
    archive.get(id)
}

#[tauri::command]
pub fn archive_delete(archive: State<'_, ArchiveStore>, id: u64) {
    archive.delete(id);
}

#[tauri::command]
pub fn archive_search(archive: State<'_, ArchiveStore>, query: String, limit: usize) -> Vec<ArchiveMeta> {
    archive.search(&query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_get_delete() {
        let a = ArchiveStore::default();
        let m = a.save("https://x.com".into(), "X".into(), "hello world content".into());
        assert_eq!(a.len(), 1);
        assert!(a.get(m.id).is_some());
        assert_eq!(a.list()[0].title, "X");
        a.delete(m.id);
        assert_eq!(a.len(), 0);
    }

    #[test]
    fn re_saving_same_url_updates_in_place() {
        let a = ArchiveStore::default();
        let m1 = a.save("https://x.com".into(), "Old".into(), "v1".into());
        let m2 = a.save("https://x.com".into(), "New".into(), "v2 updated".into());
        assert_eq!(m1.id, m2.id, "same URL keeps the id");
        assert_eq!(a.len(), 1);
        assert_eq!(a.get(m1.id).unwrap().title, "New");
    }

    #[test]
    fn semantic_search_ranks_relevant_first() {
        let a = ArchiveStore::default();
        a.save("https://a".into(), "Rust".into(), "rust ownership borrow checker lifetimes memory safety".into());
        a.save("https://b".into(), "Cooking".into(), "pasta tomato garlic basil olive oil recipe kitchen".into());
        let hits = a.search("memory safety ownership in rust", 5);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].title, "Rust", "the rust page should rank first");
    }

    #[test]
    fn empty_query_lists_newest_first() {
        let a = ArchiveStore::default();
        a.save("https://a".into(), "First".into(), "alpha".into());
        a.save("https://b".into(), "Second".into(), "beta".into());
        let hits = a.search("", 10);
        assert_eq!(hits[0].title, "Second");
    }
}
