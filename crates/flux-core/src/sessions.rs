//! Named sessions (BACKLOG #47): save the current tabs as a named snapshot you
//! can restore later. Distinct from the always-on session (#19, `session.json`,
//! "continue where you left off") — these are deliberate, named bundles you keep
//! around ("Research", "Trip planning", …). Local-only JSON.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::{FluxState, TabKind};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct SavedTab {
    pub url: String,
    pub title: String,
    pub pinned: bool,
    /// Which workspace this tab was in, **by name**.
    ///
    /// The name, not the id: workspace ids are per-device counters, so an id
    /// meaning "Coursework" on one machine means something else (or nothing) on
    /// another — the same reason task and session ids can't cross either. A
    /// session used to be a flat URL list, so restoring one collapsed every
    /// workspace into whichever was active.
    ///
    /// `serde(default)` so sessions saved before this load as `""` and restore
    /// into the current workspace, exactly as they did.
    #[serde(default)]
    pub workspace: String,
}

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct SavedSession {
    pub id: u64,
    pub name: String,
    pub created_ms: u64,
    pub tabs: Vec<SavedTab>,
}

/// On-disk shape: items + deletion tombstones (#62), keyed by session name.
#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    items: Vec<SavedSession>,
    #[serde(default)]
    tombstones: crate::tombstone::Tombstones,
}

#[derive(Default)]
pub struct SessionStore {
    items: RwLock<Vec<SavedSession>>,
    /// Deletion tombstones keyed by session name (#62).
    tombstones: RwLock<crate::tombstone::Tombstones>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl SessionStore {
    pub fn restore(path: PathBuf) -> Self {
        // Tolerant load: `{items,tombstones}` envelope or a legacy bare array.
        let (items, tombstones) = std::fs::read_to_string(&path)
            .ok()
            .map(|s| match serde_json::from_str::<Persisted>(&s) {
                Ok(p) => (p.items, p.tombstones),
                Err(_) => (
                    serde_json::from_str::<Vec<SavedSession>>(&s).unwrap_or_default(),
                    Default::default(),
                ),
            })
            .unwrap_or_default();
        let next = items.iter().map(|s| s.id).max().map(|m| m + 1).unwrap_or(1);
        Self {
            items: RwLock::new(items),
            tombstones: RwLock::new(tombstones),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<SavedSession> {
        self.items.read().clone()
    }

    /// Deletion tombstones, for the sync push payload (#62).
    pub fn tombstones(&self) -> crate::tombstone::Tombstones {
        self.tombstones.read().clone()
    }

    pub fn save(&self, name: String, tabs: Vec<SavedTab>) -> SavedSession {
        let s = SavedSession {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            name: if name.trim().is_empty() {
                "Untitled".into()
            } else {
                name
            },
            created_ms: now_ms(),
            tabs,
        };
        self.tombstones.write().remove(&s.name); // re-saving a name clears its tombstone
        self.items.write().push(s.clone());
        self.save_disk();
        s
    }

    /// Merge in a remote payload (E2E sync, #62): union tombstones (newest wins),
    /// drop locally-buried sessions, then add remote sessions whose name isn't
    /// present and isn't suppressed. Returns how many were newly added.
    pub fn merge(
        &self,
        remote: Vec<SavedSession>,
        remote_tombs: &crate::tombstone::Tombstones,
    ) -> usize {
        use crate::tombstone::{merge_into, suppressed};
        let mut tombs = self.tombstones.write();
        merge_into(&mut tombs, remote_tombs);
        let mut items = self.items.write();
        items.retain(|s| !suppressed(&tombs, &s.name, s.created_ms));
        let mut added = 0;
        for r in remote {
            if suppressed(&tombs, &r.name, r.created_ms) {
                continue;
            }
            if items.iter().any(|s| s.name == r.name) {
                continue;
            }
            items.push(SavedSession {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                name: r.name,
                created_ms: r.created_ms,
                tabs: r.tabs,
            });
            added += 1;
        }
        drop(items);
        drop(tombs);
        self.save_disk();
        added
    }

    pub fn delete(&self, id: u64) {
        let mut items = self.items.write();
        if let Some(s) = items.iter().find(|s| s.id == id) {
            self.tombstones.write().insert(s.name.clone(), now_ms());
        }
        items.retain(|s| s.id != id);
        drop(items);
        self.save_disk();
    }

    pub fn tabs_of(&self, id: u64) -> Vec<SavedTab> {
        self.items
            .read()
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.tabs.clone())
            .unwrap_or_default()
    }

    fn save_disk(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let snapshot = Persisted {
            items: self.items.read().clone(),
            tombstones: self.tombstones.read().clone(),
        };
        crate::persist::save_json(path, &snapshot);
    }
}

/// Snapshot the current real web tabs (skips terminal/files + flux:// pages).
pub(crate) fn snapshot(state: &FluxState) -> Vec<SavedTab> {
    // id → name, resolved once: a session spans every workspace, so this would
    // otherwise be a linear scan per tab.
    let names: std::collections::HashMap<u32, String> = state
        .workspaces_list()
        .into_iter()
        .map(|w| (w.id, w.name))
        .collect();
    state
        .ordered_tabs()
        .into_iter()
        .filter(|t| matches!(t.kind, TabKind::Browser) && t.url.starts_with("http"))
        .map(|t| SavedTab {
            url: t.url,
            title: t.title,
            pinned: t.pinned,
            workspace: names.get(&t.workspace).cloned().unwrap_or_default(),
        })
        .collect()
}

// ─── Daily auto-snapshots (BACKLOG #47) ──────────────────────────────────────
//
// Distinct from named sessions: Flux quietly snapshots your open tabs into a
// per-day bucket on a timer, keeping the last week, so you can "reopen yesterday"
// without having saved anything. One bucket per UTC day, refreshed in place, so a
// day's entry holds that day's most recent tab set.

const SNAPSHOT_DAYS: usize = 7;
const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct DaySnapshot {
    /// UTC day index (epoch ms / 86_400_000) — this snapshot's bucket + key.
    pub day: u64,
    /// When the bucket was last refreshed (ms) — the label the UI renders.
    pub captured_ms: u64,
    pub tabs: Vec<SavedTab>,
}

#[derive(Default)]
pub struct SnapshotStore {
    snaps: RwLock<Vec<DaySnapshot>>,
    path: Option<PathBuf>,
}

impl SnapshotStore {
    pub fn restore(path: PathBuf) -> Self {
        let snaps = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            snaps: RwLock::new(snaps),
            path: Some(path),
        }
    }

    /// Newest day first.
    pub fn list(&self) -> Vec<DaySnapshot> {
        let mut v = self.snaps.read().clone();
        v.sort_unstable_by_key(|e| std::cmp::Reverse(e.day));
        v
    }

    pub fn tabs_of(&self, day: u64) -> Vec<SavedTab> {
        self.snaps
            .read()
            .iter()
            .find(|s| s.day == day)
            .map(|s| s.tabs.clone())
            .unwrap_or_default()
    }

    /// Record the current tabs into today's bucket (create or refresh), keeping
    /// the last `SNAPSHOT_DAYS` days. No-op for an empty set so a freshly-started
    /// or all-`flux://` session never clobbers a real day's snapshot.
    pub fn capture(&self, tabs: Vec<SavedTab>) {
        if tabs.is_empty() {
            return;
        }
        let now = now_ms();
        let day = now / DAY_MS;
        let mut snaps = self.snaps.write();
        match snaps.iter_mut().find(|s| s.day == day) {
            Some(s) => {
                s.tabs = tabs;
                s.captured_ms = now;
            }
            None => snaps.push(DaySnapshot {
                day,
                captured_ms: now,
                tabs,
            }),
        }
        snaps.sort_unstable_by_key(|e| std::cmp::Reverse(e.day));
        snaps.truncate(SNAPSHOT_DAYS);
        let json = serde_json::to_string(&*snaps).ok();
        drop(snaps);
        if let (Some(path), Some(json)) = (&self.path, json) {
            let _ = crate::persist::write_atomic(path, json.as_bytes());
        }
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sessions_list(store: State<'_, SessionStore>) -> Vec<SavedSession> {
    store.list()
}

/// Save the current open tabs as a named session. Returns the new session.
#[tauri::command]
pub fn session_save(
    state: State<'_, FluxState>,
    store: State<'_, SessionStore>,
    name: String,
) -> SavedSession {
    store.save(name, snapshot(&state))
}

#[tauri::command]
pub fn session_delete(store: State<'_, SessionStore>, id: u64) {
    store.delete(id);
}

/// The tabs of a saved session — the shell opens them (it owns webview lifecycle).
#[tauri::command]
pub fn session_restore(store: State<'_, SessionStore>, id: u64) -> Vec<SavedTab> {
    store.tabs_of(id)
}

/// The daily auto-snapshots, newest day first (#47).
#[tauri::command]
pub fn snapshots_list(store: State<'_, SnapshotStore>) -> Vec<DaySnapshot> {
    store.list()
}

/// The tabs captured for a given day (#47) — the shell reopens them.
#[tauri::command]
pub fn snapshot_restore(store: State<'_, SnapshotStore>, day: u64) -> Vec<SavedTab> {
    store.tabs_of(day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_delete() {
        let store = SessionStore::default();
        let tabs = vec![SavedTab {
            url: "https://a.dev".into(),
            title: "A".into(),
            pinned: false,
            workspace: "Uni".into(),
        }];
        let s = store.save("Work".into(), tabs);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.tabs_of(s.id).len(), 1);
        assert_eq!(
            store.tabs_of(s.id)[0].workspace,
            "Uni",
            "workspace round-trips"
        );
        store.delete(s.id);
        assert!(store.list().is_empty());
    }

    #[test]
    fn a_pre_workspace_session_still_loads() {
        // Sessions saved before tabs carried a workspace must load as "" and
        // restore into the active one, not fail to deserialize.
        let old = r#"{"items":[{"id":1,"name":"Old","created_ms":1,
            "tabs":[{"url":"https://a.dev","title":"A","pinned":true}]}],"tombstones":{}}"#;
        let p: Persisted = serde_json::from_str(old).expect("old shape still parses");
        assert_eq!(p.items[0].tabs[0].workspace, "");
        assert!(p.items[0].tabs[0].pinned);
    }

    #[test]
    fn empty_name_becomes_untitled() {
        let store = SessionStore::default();
        let s = store.save("  ".into(), vec![]);
        assert_eq!(s.name, "Untitled");
    }

    #[test]
    fn delete_records_tombstone() {
        let store = SessionStore::default();
        let s = store.save("Research".into(), vec![]);
        store.delete(s.id);
        assert!(store.tombstones().contains_key("Research"));
    }

    #[test]
    fn merge_tombstone_propagates_session_deletion() {
        use crate::tombstone::Tombstones;
        let b = SessionStore::default();
        {
            let mut it = b.items.write();
            it.push(SavedSession {
                id: 1,
                name: "Research".into(),
                created_ms: 100,
                tabs: vec![],
            });
        }
        let mut tombs = Tombstones::new();
        tombs.insert("Research".into(), 200); // deleted remotely
        let added = b.merge(
            vec![SavedSession {
                id: 9,
                name: "Trip".into(),
                created_ms: 100,
                tabs: vec![],
            }],
            &tombs,
        );
        assert_eq!(added, 1); // Trip is new
        let names: Vec<_> = b.list().iter().map(|x| x.name.clone()).collect();
        assert!(names.contains(&"Trip".to_string()));
        assert!(
            !names.contains(&"Research".to_string()),
            "remote delete propagated"
        );
    }
}
