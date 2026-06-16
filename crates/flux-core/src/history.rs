//! Browsing history (BACKLOG #39). A persisted, searchable store of visited
//! pages — feeds the `flux://history` page, omnibox suggestions (#32), and the
//! command palette (#6). Recorded automatically from `dom_publish` (so it
//! captures the real navigated URL + page title), deduped per visit, ranked by
//! a simple frecency (recency + visit count). Local-only, like everything else.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// Cap the store so it can't grow without bound; evict the oldest beyond this.
const MAX_ENTRIES: usize = 10_000;
/// Re-visiting the same URL within this window doesn't double-count (capture.js
/// re-publishes on SPA mutations, which would otherwise inflate visit counts).
const VISIT_DEDUP_MS: u64 = 30_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub last_visit_ms: u64,
    pub visits: u32,
    /// Precomputed lowercased "url\ntitle" for substring search — set on
    /// insert/update and recomputed on load. Skipped on disk + IPC (recomputable,
    /// and the frontend doesn't need it). Avoids re-lowercasing every entry on
    /// every omnibox keystroke.
    #[serde(skip)]
    key: String,
}

fn search_key(url: &str, title: &str) -> String {
    let mut k = url.to_lowercase();
    k.push('\n');
    k.push_str(&title.to_lowercase());
    k
}

impl HistoryEntry {
    /// Frecency: recency in seconds, plus ~a day of recency credit per visit.
    fn score(&self) -> u64 {
        self.last_visit_ms / 1000 + (self.visits as u64) * 86_400
    }
}

#[derive(Default)]
pub struct HistoryStore {
    entries: RwLock<HashMap<String, HistoryEntry>>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
}

impl HistoryStore {
    pub fn restore(path: PathBuf) -> Self {
        let s = Self::empty(path);
        s.hydrate();
        s
    }

    /// An empty store bound to `path` — does NO disk I/O. Pair with `hydrate()`
    /// on a background thread so a large history.json doesn't block window show.
    pub fn empty(path: PathBuf) -> Self {
        Self { entries: RwLock::new(HashMap::new()), path: Some(path), dirty: AtomicBool::new(false) }
    }

    /// Load entries from disk into the store, recomputing each search key. Merges
    /// (never clobbers an entry already recorded since boot), so it's safe to run
    /// after the store is live. Does not mark the store dirty.
    pub fn hydrate(&self) {
        let Some(path) = &self.path else { return };
        let Some(loaded) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<HistoryEntry>>(&s).ok())
        else {
            return;
        };
        let mut e = self.entries.write();
        for mut entry in loaded {
            entry.key = search_key(&entry.url, &entry.title);
            e.entry(entry.url.clone()).or_insert(entry);
        }
    }

    /// Record (or refresh) a visit. Ignores non-http(s) URLs (flux://, files, …).
    pub fn record(&self, url: &str, title: &str) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return;
        }
        let now = now_ms();
        // Fast path under a READ lock: a URL already seen within the dedup window
        // is the same visit — nothing meaningful changed, so take no write lock and
        // leave `dirty` alone. Without this, an actively-mutating page (capture.js
        // republishes every ~400ms) kept history perpetually dirty, rewriting the
        // whole ~2 MB file every 60s for a page you're just sitting on.
        if let Some(en) = self.entries.read().get(url) {
            if now.saturating_sub(en.last_visit_ms) < VISIT_DEDUP_MS {
                return;
            }
        }
        {
            let mut e = self.entries.write();
            match e.get_mut(url) {
                Some(en) => {
                    if now.saturating_sub(en.last_visit_ms) >= VISIT_DEDUP_MS {
                        en.visits += 1;
                    }
                    en.last_visit_ms = now;
                    if !title.trim().is_empty() && title != en.title {
                        en.title = title.to_string();
                        en.key = search_key(&en.url, &en.title);
                    }
                }
                None => {
                    let key = search_key(url, title);
                    e.insert(url.to_string(), HistoryEntry { url: url.to_string(), title: title.to_string(), last_visit_ms: now, visits: 1, key });
                    if e.len() > MAX_ENTRIES {
                        if let Some(oldest) = e.values().min_by_key(|x| x.last_visit_ms).map(|x| x.url.clone()) {
                            e.remove(&oldest);
                        }
                    }
                }
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Most-recently-visited entries (the history page's default view).
    pub fn recent(&self, limit: usize) -> Vec<HistoryEntry> {
        let mut v: Vec<HistoryEntry> = self.entries.read().values().cloned().collect();
        v.sort_unstable_by(|a, b| b.last_visit_ms.cmp(&a.last_visit_ms));
        v.truncate(limit);
        v
    }

    /// Substring match on URL + title, ranked by frecency.
    pub fn search(&self, query: &str, limit: usize) -> Vec<HistoryEntry> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return self.recent(limit);
        }
        // Match against the precomputed lowercased key — no per-entry allocation.
        let mut v: Vec<HistoryEntry> = self
            .entries
            .read()
            .values()
            .filter(|e| e.key.contains(&q))
            .cloned()
            .collect();
        v.sort_unstable_by(|a, b| b.score().cmp(&a.score()));
        v.truncate(limit);
        v
    }

    pub fn delete(&self, url: &str) {
        self.entries.write().remove(url);
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn clear(&self) {
        self.entries.write().clear();
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Persist to disk if anything changed since the last save (called on a timer).
    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let snapshot: Vec<HistoryEntry> = self.entries.read().values().cloned().collect();
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

use tauri::State;

#[tauri::command]
pub fn history_recent(store: State<'_, HistoryStore>, limit: Option<usize>) -> Vec<HistoryEntry> {
    store.recent(limit.unwrap_or(200))
}

#[tauri::command]
pub fn history_search(store: State<'_, HistoryStore>, query: String, limit: Option<usize>) -> Vec<HistoryEntry> {
    store.search(&query, limit.unwrap_or(200))
}

#[tauri::command]
pub fn history_delete(store: State<'_, HistoryStore>, url: String) {
    store.delete(&url);
}

#[tauri::command]
pub fn history_clear(store: State<'_, HistoryStore>) {
    store.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_dedups_and_ranks() {
        let h = HistoryStore::default();
        h.record("https://a.com", "Alpha");
        h.record("https://a.com", "Alpha"); // within dedup window → no extra visit
        h.record("https://b.com/page", "Beta search");
        assert_eq!(h.entries.read().len(), 2);
        assert_eq!(h.entries.read()["https://a.com"].visits, 1);

        // non-http skipped
        h.record("flux://start", "Start");
        h.record("file:///x", "X");
        assert_eq!(h.entries.read().len(), 2);

        // search by title + url substring
        let r = h.search("beta", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://b.com/page");
        assert_eq!(h.search("a.com", 10).len(), 1);
        assert_eq!(h.search("", 10).len(), 2); // empty → recent

        h.delete("https://a.com");
        assert_eq!(h.entries.read().len(), 1);
        h.clear();
        assert!(h.entries.read().is_empty());
    }

    #[test]
    fn hydrate_recomputes_search_key_after_load() {
        let dir = std::env::temp_dir().join(format!("flux-hist-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("history.json");

        let a = HistoryStore::restore(path.clone());
        a.record("https://example.com/page", "Gamma Report");
        a.persist_if_dirty();

        // Fresh store loaded from disk (key is #[serde(skip)] → must be recomputed
        // by hydrate, or search would silently return nothing after a restart).
        let b = HistoryStore::restore(path.clone());
        assert_eq!(b.entries.read().len(), 1);
        assert_eq!(b.search("gamma", 10).len(), 1, "search must work on loaded entries");
        assert_eq!(b.search("example.com", 10).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
