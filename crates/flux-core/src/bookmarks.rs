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

/// On-disk shape. Carries deletion tombstones (#62) alongside the items so a
/// delete survives restart and keeps suppressing re-adds from a stale sync blob.
#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    items: Vec<Bookmark>,
    #[serde(default)]
    tombstones: crate::tombstone::Tombstones,
}

/// Sync key for a bookmark: (url, folder) — the same identity `add`/`merge` dedupe on.
fn bm_key(url: &str, folder: &str) -> String {
    format!("{url}\n{folder}")
}

#[derive(Default)]
pub struct BookmarkStore {
    items: RwLock<Vec<Bookmark>>,
    /// Deletion tombstones keyed by `bm_key` (#62).
    tombstones: RwLock<crate::tombstone::Tombstones>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl BookmarkStore {
    pub fn restore(path: PathBuf) -> Self {
        // Tolerant load: the current `{items,tombstones}` envelope, or a legacy
        // bare `[Bookmark]` array from before tombstones existed.
        let (items, tombstones) = std::fs::read_to_string(&path)
            .ok()
            .map(|s| match serde_json::from_str::<Persisted>(&s) {
                Ok(p) => (p.items, p.tombstones),
                Err(_) => (serde_json::from_str::<Vec<Bookmark>>(&s).unwrap_or_default(), Default::default()),
            })
            .unwrap_or_default();
        let next = items.iter().map(|b| b.id).max().map(|m| m + 1).unwrap_or(1);
        Self {
            items: RwLock::new(items),
            tombstones: RwLock::new(tombstones),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<Bookmark> {
        self.items.read().clone()
    }

    /// The deletion tombstones, for the sync push payload (#62).
    pub fn tombstones(&self) -> crate::tombstone::Tombstones {
        self.tombstones.read().clone()
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
        self.tombstones.write().remove(&bm_key(&bm.url, &bm.folder)); // re-add clears any tombstone
        items.push(bm.clone());
        drop(items);
        self.save();
        bm
    }

    /// Merge in a remote payload (E2E sync, #62): union the tombstones (newest
    /// deletion wins), drop any local item a tombstone now buries, then add remote
    /// items whose (url, folder) isn't present and isn't suppressed by a tombstone
    /// newer than the item. Returns how many were newly added.
    pub fn merge(&self, remote: Vec<Bookmark>, remote_tombs: &crate::tombstone::Tombstones) -> usize {
        use crate::tombstone::{merge_into, suppressed};
        let mut tombs = self.tombstones.write();
        merge_into(&mut tombs, remote_tombs);
        let mut items = self.items.write();
        // Apply tombstones to local items (a remote delete propagates here).
        items.retain(|b| !suppressed(&tombs, &bm_key(&b.url, &b.folder), b.added_ms));
        let mut added = 0;
        for r in remote {
            let key = bm_key(&r.url, &r.folder);
            if suppressed(&tombs, &key, r.added_ms) {
                continue; // deleted somewhere, newer than this copy
            }
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
        drop(tombs);
        self.save(); // tombstone union alone is worth persisting
        added
    }

    pub fn remove(&self, id: u64) {
        let mut items = self.items.write();
        if let Some(b) = items.iter().find(|b| b.id == id) {
            self.tombstones.write().insert(bm_key(&b.url, &b.folder), now_ms());
        }
        items.retain(|b| b.id != id);
        drop(items);
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
        let mut items = self.items.write();
        let now = now_ms();
        let mut tombs = self.tombstones.write();
        for b in items.iter() {
            tombs.insert(bm_key(&b.url, &b.folder), now); // tombstone each so the clear propagates
        }
        drop(tombs);
        items.clear();
        drop(items);
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
            self.tombstones.write().remove(&bm_key(&url, &folder)); // import un-buries
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
        let snapshot = Persisted { items: self.items.read().clone(), tombstones: self.tombstones.read().clone() };
        if let Ok(json) = serde_json::to_string(&snapshot) {
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

    #[test]
    fn remove_records_tombstone_for_push() {
        let store = BookmarkStore::default();
        let a = store.add("A".into(), "https://a.dev".into(), "".into());
        store.remove(a.id);
        assert!(store.tombstones().contains_key(&bm_key("https://a.dev", "")));
    }

    #[test]
    fn merge_tombstone_propagates_deletion() {
        use crate::tombstone::Tombstones;
        let b = BookmarkStore::default();
        // Local still has X (added t=100) and Y (t=100).
        {
            let mut it = b.items.write();
            it.push(Bookmark { id: 1, title: "X".into(), url: "https://x.dev".into(), folder: "".into(), added_ms: 100 });
            it.push(Bookmark { id: 2, title: "Y".into(), url: "https://y.dev".into(), folder: "".into(), added_ms: 100 });
        }
        // Remote deleted X at t=200 and kept Y.
        let mut tombs = Tombstones::new();
        tombs.insert(bm_key("https://x.dev", ""), 200);
        let remote = vec![Bookmark { id: 9, title: "Y".into(), url: "https://y.dev".into(), folder: "".into(), added_ms: 100 }];
        let added = b.merge(remote, &tombs);
        assert_eq!(added, 0); // Y already present
        let urls: Vec<_> = b.list().iter().map(|x| x.url.clone()).collect();
        assert!(!urls.contains(&"https://x.dev".to_string()), "remote tombstone removed X");
        assert!(urls.contains(&"https://y.dev".to_string()));
    }

    #[test]
    fn merge_readd_newer_than_tombstone_survives() {
        use crate::tombstone::Tombstones;
        let b = BookmarkStore::default();
        {
            let mut it = b.items.write();
            it.push(Bookmark { id: 1, title: "X".into(), url: "https://x.dev".into(), folder: "".into(), added_ms: 300 });
        }
        let mut tombs = Tombstones::new();
        tombs.insert(bm_key("https://x.dev", ""), 200); // deleted *before* the local re-add
        b.merge(vec![], &tombs);
        assert!(b.list().iter().any(|x| x.url == "https://x.dev"), "newer re-add beats older tombstone");
    }
}
