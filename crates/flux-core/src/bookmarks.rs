//! Bookmarks (BACKLOG #22). A persisted, folder-aware bookmark store that backs
//! the `flux://bookmarks` page, the footer popover ("bookmark this page"), and
//! Chrome import (via `flux-import`, which fully parses Chrome's Bookmarks file).
//! Local-only JSON, like history. Folders are kept as path strings (Chrome's
//! shape, e.g. "Imported/Work/CI") so the page can group + so a whole folder can
//! be opened as a Flux tab group (#56) — the practical bridge for "import tab
//! groups", since Chrome live groups live in an undocumented session blob.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort hostname (sans scheme / `www.`) for a fallback bookmark label.
fn host_of(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split('/').next().unwrap_or(after);
    host.trim_start_matches("www.").to_string()
}

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Bookmark {
    pub id: u64,
    pub title: String,
    pub url: String,
    /// Folder path ("" = top level), e.g. "Imported/Work". Lets the page group
    /// and lets a folder be opened as a tab group.
    pub folder: String,
    pub added_ms: u64,
}

#[derive(Default)]
pub struct BookmarkStore {
    items: RwLock<Vec<Bookmark>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl BookmarkStore {
    pub fn restore(path: PathBuf) -> Self {
        let items: Vec<Bookmark> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = items.iter().map(|b| b.id).max().map(|m| m + 1).unwrap_or(1);
        Self { items: RwLock::new(items), next_id: AtomicU64::new(next), path: Some(path) }
    }

    pub fn list(&self) -> Vec<Bookmark> {
        self.items.read().clone()
    }

    /// Distinct folder paths, sorted — drives the page's folder grouping.
    pub fn folders(&self) -> Vec<String> {
        let mut f: Vec<String> = self.items.read().iter().map(|b| b.folder.clone()).collect();
        f.sort();
        f.dedup();
        f
    }

    /// Add one bookmark, de-duping on (url, folder). Returns the new (or existing) row.
    pub fn add(&self, title: String, url: String, folder: String) -> Bookmark {
        let mut items = self.items.write();
        if let Some(existing) = items.iter().find(|b| b.url == url && b.folder == folder) {
            return existing.clone();
        }
        let bm = Bookmark {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            title: if title.is_empty() { url.clone() } else { title },
            url,
            folder,
            added_ms: now_ms(),
        };
        items.push(bm.clone());
        drop(items);
        self.save();
        bm
    }

    /// Merge in remote bookmarks (E2E sync, #62): add any whose (url, folder)
    /// isn't already present, keeping their original timestamp but a fresh local
    /// id. Additive union — deletions don't propagate (v1). Returns the count added.
    pub fn merge(&self, remote: Vec<Bookmark>) -> usize {
        let mut items = self.items.write();
        let mut added = 0;
        for r in remote {
            if items.iter().any(|b| b.url == r.url && b.folder == r.folder) {
                continue;
            }
            items.push(Bookmark {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                title: r.title,
                url: r.url,
                folder: r.folder,
                added_ms: r.added_ms,
            });
            added += 1;
        }
        drop(items);
        if added > 0 {
            self.save();
        }
        added
    }

    pub fn remove(&self, id: u64) {
        self.items.write().retain(|b| b.id != id);
        self.save();
    }

    /// Rename a bookmark's display title. A blank title falls back to the host so
    /// a bookmark is never left label-less. Returns true if the id existed.
    pub fn rename(&self, id: u64, title: &str) -> bool {
        let mut items = self.items.write();
        let Some(b) = items.iter_mut().find(|b| b.id == id) else { return false };
        let trimmed = title.trim();
        b.title = if trimmed.is_empty() { host_of(&b.url) } else { trimmed.to_string() };
        drop(items);
        self.save();
        true
    }

    pub fn clear(&self) {
        self.items.write().clear();
        self.save();
    }

    /// Bulk import (e.g. from Chrome). De-dupes on (url, folder); `prefix` is
    /// prepended to each folder so an import is grouped (e.g. "Imported").
    /// Returns the number actually added.
    pub fn import(&self, incoming: Vec<(String, String, String)>, prefix: &str) -> usize {
        let mut items = self.items.write();
        let mut seen: std::collections::HashSet<(String, String)> =
            items.iter().map(|b| (b.url.clone(), b.folder.clone())).collect();
        let mut added = 0;
        let now = now_ms();
        for (title, url, folder) in incoming {
            let folder = if prefix.is_empty() {
                folder
            } else if folder.is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix}/{folder}")
            };
            if !seen.insert((url.clone(), folder.clone())) {
                continue;
            }
            items.push(Bookmark {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                title: if title.is_empty() { url.clone() } else { title },
                url,
                folder,
                added_ms: now,
            });
            added += 1;
        }
        drop(items);
        if added > 0 {
            self.save();
        }
        added
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&*self.items.read()) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn bookmarks_list(store: State<'_, BookmarkStore>) -> Vec<Bookmark> {
    store.list()
}

#[tauri::command]
pub fn bookmark_folders(store: State<'_, BookmarkStore>) -> Vec<String> {
    store.folders()
}

#[tauri::command]
pub fn bookmark_add(
    store: State<'_, BookmarkStore>,
    title: String,
    url: String,
    folder: Option<String>,
) -> Bookmark {
    store.add(title, url, folder.unwrap_or_default())
}

#[tauri::command]
pub fn bookmark_remove(store: State<'_, BookmarkStore>, id: u64) {
    store.remove(id);
}

#[tauri::command]
pub fn bookmark_rename(store: State<'_, BookmarkStore>, id: u64, title: String) {
    store.rename(id, &title);
}

#[tauri::command]
pub fn bookmarks_clear(store: State<'_, BookmarkStore>) {
    store.clear();
}

/// Import every bookmark from a Chrome profile into the store under an
/// "Imported" folder prefix. Returns how many new ones were added.
#[tauri::command]
pub fn bookmarks_import_chrome(store: State<'_, BookmarkStore>, profile_dir: String) -> Result<usize, String> {
    let books = flux_import::chrome::read_bookmarks(std::path::Path::new(&profile_dir))
        .map_err(|e| e.to_string())?;
    let incoming = books.into_iter().map(|b| (b.name, b.url, b.folder)).collect();
    Ok(store.import(incoming, "Imported"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_dedupes_and_import_counts_new() {
        let store = BookmarkStore::default();
        store.add("Rust".into(), "https://rust-lang.org".into(), "".into());
        // same url+folder → no duplicate
        store.add("Rust".into(), "https://rust-lang.org".into(), "".into());
        assert_eq!(store.list().len(), 1);

        let incoming = vec![
            ("Rust".into(), "https://rust-lang.org".into(), "".into()), // dup vs existing (folder "Imported" differs → added)
            ("CI".into(), "https://ci.example.com".into(), "Work".into()),
        ];
        let added = store.import(incoming, "Imported");
        assert_eq!(added, 2); // both land under "Imported[/Work]", distinct from the root one
        assert!(store.folders().iter().any(|f| f == "Imported/Work"));
    }

    #[test]
    fn remove_and_clear() {
        let store = BookmarkStore::default();
        let a = store.add("A".into(), "https://a.dev".into(), "".into());
        store.add("B".into(), "https://b.dev".into(), "".into());
        store.remove(a.id);
        assert_eq!(store.list().len(), 1);
        store.clear();
        assert!(store.list().is_empty());
    }

    #[test]
    fn rename_updates_title_and_blank_falls_back_to_host() {
        let store = BookmarkStore::default();
        let a = store.add("Old".into(), "https://www.example.com/x".into(), "".into());
        assert!(store.rename(a.id, "  My Site  "));
        assert_eq!(store.list()[0].title, "My Site"); // trimmed
        store.rename(a.id, "   "); // blank → host fallback
        assert_eq!(store.list()[0].title, "example.com");
        assert!(!store.rename(9999, "nope")); // unknown id
    }
}
