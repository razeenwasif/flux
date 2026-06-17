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
use std::time::{SystemTime, UNIX_EPOCH};

use flux_embed::{embed, EMBED_DIM};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A saved page. `text` is the visible-text capture (no remote resources, so it
/// renders offline). Persisted as-is; the embedding is recomputed, not stored.
#[derive(Serialize, Deserialize, Clone)]
pub struct ArchiveEntry {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub saved_ms: u64,
    pub text: String,
}

/// List/search row — metadata + a short snippet (the full text stays out of list
/// payloads; fetch it with `archive_get`).
#[derive(Serialize, Clone)]
pub struct ArchiveMeta {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub saved_ms: u64,
    pub snippet: String,
    /// Relevance 0–100 (search results only; 0 for plain listing).
    pub score: u32,
}

struct Inner {
    entries: Vec<ArchiveEntry>,
    /// Parallel to `entries`; recomputed, never persisted.
    vectors: Vec<[f32; EMBED_DIM]>,
}

pub struct ArchiveStore {
    path: Option<PathBuf>,
    inner: RwLock<Inner>,
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

impl Default for ArchiveStore {
    fn default() -> Self {
        Self { path: None, inner: RwLock::new(Inner { entries: Vec::new(), vectors: Vec::new() }), next_id: AtomicU64::new(1) }
    }
}

impl ArchiveStore {
    /// Load from disk (missing/corrupt → empty), recomputing embeddings.
    pub fn restore(path: PathBuf) -> Self {
        let entries: Vec<ArchiveEntry> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let vectors = entries.iter().map(|e| embed(&e.text)).collect();
        let next = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        Self { path: Some(path), inner: RwLock::new(Inner { entries, vectors }), next_id: AtomicU64::new(next) }
    }

    /// Save a page (or refresh it if the URL is already archived). Returns the
    /// row. Empty text is rejected by the caller.
    pub fn save(&self, url: String, title: String, text: String) -> ArchiveMeta {
        let vector = embed(&text);
        let mut g = self.inner.write();
        let result = if let Some(i) = g.entries.iter().position(|e| e.url == url) {
            // Re-save → update in place, keep the id.
            let e = &mut g.entries[i];
            e.title = title;
            e.text = text;
            e.saved_ms = now_ms();
            g.vectors[i] = vector;
            meta(&g.entries[i], 0)
        } else {
            let entry = ArchiveEntry { id: self.next_id.fetch_add(1, Ordering::Relaxed), url, title, saved_ms: now_ms(), text };
            let m = meta(&entry, 0);
            g.entries.push(entry);
            g.vectors.push(vector);
            m
        };
        drop(g);
        self.persist();
        result
    }

    /// Newest first.
    pub fn list(&self) -> Vec<ArchiveMeta> {
        let g = self.inner.read();
        let mut v: Vec<ArchiveMeta> = g.entries.iter().map(|e| meta(e, 0)).collect();
        // Newest first; tiebreak by id (higher = saved later) so same-millisecond
        // saves stay deterministically ordered.
        v.sort_by(|a, b| b.saved_ms.cmp(&a.saved_ms).then(b.id.cmp(&a.id)));
        v
    }

    pub fn get(&self, id: u64) -> Option<ArchiveEntry> {
        self.inner.read().entries.iter().find(|e| e.id == id).cloned()
    }

    pub fn delete(&self, id: u64) {
        {
            let mut g = self.inner.write();
            if let Some(i) = g.entries.iter().position(|e| e.id == id) {
                g.entries.remove(i);
                g.vectors.remove(i);
            }
        }
        self.persist();
    }

    /// Semantic search: cosine (= dot, since embeddings are L2-normalized)
    /// against the query embedding, most-relevant first. Falls back to newest
    /// when the query is empty.
    pub fn search(&self, query: &str, limit: usize) -> Vec<ArchiveMeta> {
        if query.trim().is_empty() {
            let mut v = self.list();
            if limit > 0 {
                v.truncate(limit);
            }
            return v;
        }
        let q = embed(query);
        let g = self.inner.read();
        let mut scored: Vec<(usize, f32)> = g
            .vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, v.iter().zip(q.iter()).map(|(a, b)| a * b).sum::<f32>()))
            .filter(|(_, s)| *s > 0.02) // drop near-orthogonal noise
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if limit > 0 {
            scored.truncate(limit);
        }
        scored.iter().map(|(i, s)| meta(&g.entries[*i], (s.clamp(0.0, 1.0) * 100.0).round() as u32)).collect()
    }

    pub fn len(&self) -> usize {
        self.inner.read().entries.len()
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let g = self.inner.read();
        if let Ok(json) = serde_json::to_string(&g.entries) {
            let _ = std::fs::write(path, json);
        }
    }
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
