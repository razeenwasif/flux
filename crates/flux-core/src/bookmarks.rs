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
                Err(_) => (
                    serde_json::from_str::<Vec<Bookmark>>(&s).unwrap_or_default(),
                    Default::default(),
                ),
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

    /// The first bookmark for exactly `url`, in any folder — what the address
    /// bar's star shows. The shell used to fetch the whole list for this on
    /// every active-tab change.
    pub fn find(&self, url: &str) -> Option<u64> {
        self.items
            .read()
            .iter()
            .find(|b| b.url == url)
            .map(|b| b.id)
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
    pub fn merge(
        &self,
        remote: Vec<Bookmark>,
        remote_tombs: &crate::tombstone::Tombstones,
    ) -> usize {
        use crate::tombstone::{merge_into, suppressed};
        // Lock order is items -> tombstones, as in every mutation and save().
        // Taking tombstones first here deadlocked auto-sync against the UI thread.
        let mut items = self.items.write();
        let mut tombs = self.tombstones.write();
        merge_into(&mut tombs, remote_tombs);
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
            self.tombstones
                .write()
                .insert(bm_key(&b.url, &b.folder), now_ms());
        }
        items.retain(|b| b.id != id);
        drop(items);
        self.save();
    }

    /// Rename a bookmark's display title. A blank title falls back to the host so
    /// a bookmark is never left label-less. Returns true if the id existed.
    pub fn rename(&self, id: u64, title: &str) -> bool {
        let mut items = self.items.write();
        let Some(b) = items.iter_mut().find(|b| b.id == id) else {
            return false;
        };
        let trimmed = title.trim();
        b.title = if trimmed.is_empty() {
            host_of(&b.url)
        } else {
            trimmed.to_string()
        };
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
        let mut seen: std::collections::HashSet<(String, String)> = items
            .iter()
            .map(|b| (b.url.clone(), b.folder.clone()))
            .collect();
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

    /// Move a folder and everything under it to `to` ("" is the top level).
    /// A bookmark already at its new place is dropped rather than doubled; the
    /// old place is tombstoned so a synced device moves it too. Returns how many
    /// bookmarks moved.
    pub fn move_folder(&self, from: &str, to: &str) -> usize {
        let from = from.trim_matches('/');
        let to = to.trim_matches('/');
        if from.is_empty() || from == to {
            return 0;
        }
        let new_folder = |folder: &str| -> Option<String> {
            let rest = if folder == from {
                ""
            } else {
                folder.strip_prefix(from)?.strip_prefix('/')?
            };
            Some(match (to.is_empty(), rest.is_empty()) {
                (true, _) => rest.to_string(),
                (false, true) => to.to_string(),
                (false, false) => format!("{to}/{rest}"),
            })
        };
        let mut items = self.items.write();
        let mut tombs = self.tombstones.write();
        let now = now_ms();
        let mut taken: std::collections::HashSet<(String, String)> = items
            .iter()
            .filter(|b| new_folder(&b.folder).is_none())
            .map(|b| (b.url.clone(), b.folder.clone()))
            .collect();
        let mut moved = 0;
        items.retain_mut(|b| {
            let Some(dest) = new_folder(&b.folder) else {
                return true;
            };
            tombs.insert(bm_key(&b.url, &b.folder), now);
            if !taken.insert((b.url.clone(), dest.clone())) {
                return false; // already there
            }
            tombs.remove(&bm_key(&b.url, &dest));
            b.folder = dest;
            moved += 1;
            true
        });
        drop(tombs);
        drop(items);
        if moved > 0 {
            self.save();
        }
        moved
    }

    /// Remove a folder and everything under it. Returns how many went.
    pub fn remove_folder(&self, folder: &str) -> usize {
        let folder = folder.trim_matches('/');
        if folder.is_empty() {
            return 0;
        }
        let inside =
            |f: &str| f == folder || f.strip_prefix(folder).is_some_and(|r| r.starts_with('/'));
        let mut items = self.items.write();
        let mut tombs = self.tombstones.write();
        let now = now_ms();
        let before = items.len();
        items.retain(|b| {
            if inside(&b.folder) {
                tombs.insert(bm_key(&b.url, &b.folder), now);
                false
            } else {
                true
            }
        });
        let gone = before - items.len();
        drop(tombs);
        drop(items);
        if gone > 0 {
            self.save();
        }
        gone
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // The guards live to the end of this one statement, so no mutation can
        // land between the snapshot and queueing it: an older snapshot (the sync
        // thread's merge) can't be queued after a newer one (a UI-thread add).
        crate::persist::queue_json(
            path,
            &Persisted {
                items: self.items.read().clone(),
                tombstones: self.tombstones.read().clone(),
            },
            crate::persist::Durability::Barrier,
        );
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn bookmarks_list(store: State<'_, BookmarkStore>) -> Vec<Bookmark> {
    store.list()
}

#[tauri::command]
pub fn bookmark_find(store: State<'_, BookmarkStore>, url: String) -> Option<u64> {
    store.find(&url)
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
pub fn bookmarks_import_chrome(
    store: State<'_, BookmarkStore>,
    profile_dir: String,
) -> Result<usize, String> {
    let books = flux_import::chrome::read_bookmarks(std::path::Path::new(&profile_dir))
        .map_err(|e| e.to_string())?;
    let incoming = books
        .into_iter()
        .map(|b| (b.name, b.url, b.folder))
        .collect();
    Ok(store.import(incoming, "Imported"))
}

/// The Zen and Firefox profiles the import menu offers, each browser's
/// profile in use first. Off the main thread: counting reads each database.
#[tauri::command]
pub async fn gecko_import_preview() -> Vec<flux_import::gecko::GeckoProfile> {
    tauri::async_runtime::spawn_blocking(flux_import::gecko::discover_profiles)
        .await
        .unwrap_or_default()
}

/// Where an imported Zen/Firefox bookmark goes (flux-import's browsers.rs,
/// which the welcome's import shares): the toolbar is Flux's bar.
use flux_import::browsers::gecko_folder;

/// Import every bookmark from a Zen or Firefox profile into the store (see
/// `gecko_folder` for where each goes). Importing again adds only what's new,
/// and first moves an earlier import's "Zen/Toolbar" to the top level, where
/// this version puts it. Returns how many were added.
#[tauri::command]
pub async fn bookmarks_import_gecko(
    store: State<'_, BookmarkStore>,
    profile_dir: String,
    browser: String,
) -> Result<usize, String> {
    let books = tauri::async_runtime::spawn_blocking(move || {
        flux_import::gecko::read_bookmarks(std::path::Path::new(&profile_dir))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let browser = if browser == "Firefox" {
        "Firefox"
    } else {
        "Zen"
    };
    store.move_folder(&format!("{browser}/Toolbar"), "");
    let incoming = books
        .into_iter()
        .map(|b| {
            let folder = gecko_folder(browser, &b.folder);
            (b.name, b.url, folder)
        })
        .collect();
    Ok(store.import(incoming, ""))
}

/// Move a folder (and its subfolders) somewhere else; "" is the top level.
#[tauri::command]
pub fn bookmarks_move_folder(store: State<'_, BookmarkStore>, from: String, to: String) -> usize {
    store.move_folder(&from, &to)
}

/// Remove a folder and everything in it.
#[tauri::command]
pub fn bookmarks_remove_folder(store: State<'_, BookmarkStore>, folder: String) -> usize {
    store.remove_folder(&folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_moves_and_removes_with_its_subfolders() {
        let store = BookmarkStore::default();
        store.add("A".into(), "https://a.dev".into(), "Zen/Toolbar".into());
        store.add("B".into(), "https://b.dev".into(), "Zen/Toolbar/Uni".into());
        store.add("C".into(), "https://c.dev".into(), "Zen/Other".into());
        store.add("B".into(), "https://b.dev".into(), "Uni".into()); // already at the destination
        store.add("D".into(), "https://d.dev".into(), "Zen/Toolbarish".into()); // not inside it
        assert_eq!(store.move_folder("Zen/Toolbar", ""), 1);
        let mut at: Vec<_> = store
            .list()
            .into_iter()
            .map(|b| (b.url, b.folder))
            .collect();
        at.sort();
        assert_eq!(
            at,
            vec![
                ("https://a.dev".to_string(), "".to_string()),
                ("https://b.dev".to_string(), "Uni".to_string()),
                ("https://c.dev".to_string(), "Zen/Other".to_string()),
                ("https://d.dev".to_string(), "Zen/Toolbarish".to_string()),
            ]
        );
        assert!(store
            .tombstones()
            .contains_key(&bm_key("https://b.dev", "Zen/Toolbar/Uni")));
        assert_eq!(store.remove_folder("Zen"), 2);
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn zen_toolbar_lands_on_the_bar_and_the_rest_under_zen() {
        assert_eq!(gecko_folder("Zen", "Toolbar"), "");
        assert_eq!(
            gecko_folder("Zen", "Toolbar/Personal/Shopping"),
            "Personal/Shopping"
        );
        assert_eq!(
            gecko_folder("Zen", "Other/software dev"),
            "Zen/Other/software dev"
        );
        assert_eq!(gecko_folder("Firefox", "Toolbarn"), "Firefox/Toolbarn");
    }

    #[test]
    fn find_matches_the_exact_url_in_any_folder() {
        let store = BookmarkStore::default();
        assert_eq!(store.find("https://a.dev"), None);
        let a = store.add("A".into(), "https://a.dev".into(), "Work".into());
        store.add("B".into(), "https://b.dev".into(), "".into());
        assert_eq!(store.find("https://a.dev"), Some(a.id));
        // Exact match only: the star is for this page, not its site.
        assert_eq!(store.find("https://a.dev/page"), None);
        store.remove(a.id);
        assert_eq!(store.find("https://a.dev"), None);
    }

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
    fn concurrent_saves_leave_the_newest_snapshot_on_disk() {
        // Each add saves; a save that snapshotted first must not rename last.
        let dir = std::env::temp_dir().join(format!("flux-bm-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("bookmarks.json");
        let store = std::sync::Arc::new(BookmarkStore::restore(path.clone()));
        let workers: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.add(String::new(), format!("https://{i}.dev"), String::new());
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert_eq!(BookmarkStore::restore(path).list().len(), 8);
        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(store
            .tombstones()
            .contains_key(&bm_key("https://a.dev", "")));
    }

    #[test]
    fn merge_tombstone_propagates_deletion() {
        use crate::tombstone::Tombstones;
        let b = BookmarkStore::default();
        // Local still has X (added t=100) and Y (t=100).
        {
            let mut it = b.items.write();
            it.push(Bookmark {
                id: 1,
                title: "X".into(),
                url: "https://x.dev".into(),
                folder: "".into(),
                added_ms: 100,
            });
            it.push(Bookmark {
                id: 2,
                title: "Y".into(),
                url: "https://y.dev".into(),
                folder: "".into(),
                added_ms: 100,
            });
        }
        // Remote deleted X at t=200 and kept Y.
        let mut tombs = Tombstones::new();
        tombs.insert(bm_key("https://x.dev", ""), 200);
        let remote = vec![Bookmark {
            id: 9,
            title: "Y".into(),
            url: "https://y.dev".into(),
            folder: "".into(),
            added_ms: 100,
        }];
        let added = b.merge(remote, &tombs);
        assert_eq!(added, 0); // Y already present
        let urls: Vec<_> = b.list().iter().map(|x| x.url.clone()).collect();
        assert!(
            !urls.contains(&"https://x.dev".to_string()),
            "remote tombstone removed X"
        );
        assert!(urls.contains(&"https://y.dev".to_string()));
    }

    #[test]
    fn merge_readd_newer_than_tombstone_survives() {
        use crate::tombstone::Tombstones;
        let b = BookmarkStore::default();
        {
            let mut it = b.items.write();
            it.push(Bookmark {
                id: 1,
                title: "X".into(),
                url: "https://x.dev".into(),
                folder: "".into(),
                added_ms: 300,
            });
        }
        let mut tombs = Tombstones::new();
        tombs.insert(bm_key("https://x.dev", ""), 200); // deleted *before* the local re-add
        b.merge(vec![], &tombs);
        assert!(
            b.list().iter().any(|x| x.url == "https://x.dev"),
            "newer re-add beats older tombstone"
        );
    }
}
