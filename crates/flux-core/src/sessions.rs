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

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedTab {
    pub url: String,
    pub title: String,
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedSession {
    pub id: u64,
    pub name: String,
    pub created_ms: u64,
    pub tabs: Vec<SavedTab>,
}

#[derive(Default)]
pub struct SessionStore {
    items: RwLock<Vec<SavedSession>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl SessionStore {
    pub fn restore(path: PathBuf) -> Self {
        let items: Vec<SavedSession> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = items.iter().map(|s| s.id).max().map(|m| m + 1).unwrap_or(1);
        Self { items: RwLock::new(items), next_id: AtomicU64::new(next), path: Some(path) }
    }

    pub fn list(&self) -> Vec<SavedSession> {
        self.items.read().clone()
    }

    pub fn save(&self, name: String, tabs: Vec<SavedTab>) -> SavedSession {
        let s = SavedSession {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            name: if name.trim().is_empty() { "Untitled".into() } else { name },
            created_ms: now_ms(),
            tabs,
        };
        self.items.write().push(s.clone());
        self.save_disk();
        s
    }

    /// Merge in remote sessions (E2E sync, #62): add any whose name isn't already
    /// present (additive union; fresh local id). Returns the count added.
    pub fn merge(&self, remote: Vec<SavedSession>) -> usize {
        let mut items = self.items.write();
        let mut added = 0;
        for r in remote {
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
        if added > 0 {
            self.save_disk();
        }
        added
    }

    pub fn delete(&self, id: u64) {
        self.items.write().retain(|s| s.id != id);
        self.save_disk();
    }

    pub fn tabs_of(&self, id: u64) -> Vec<SavedTab> {
        self.items.read().iter().find(|s| s.id == id).map(|s| s.tabs.clone()).unwrap_or_default()
    }

    fn save_disk(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&*self.items.read()) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Snapshot the current real web tabs (skips terminal/files + flux:// pages).
fn snapshot(state: &FluxState) -> Vec<SavedTab> {
    state
        .ordered_tabs()
        .into_iter()
        .filter(|t| matches!(t.kind, TabKind::Browser) && t.url.starts_with("http"))
        .map(|t| SavedTab { url: t.url, title: t.title, pinned: t.pinned })
        .collect()
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sessions_list(store: State<'_, SessionStore>) -> Vec<SavedSession> {
    store.list()
}

/// Save the current open tabs as a named session. Returns the new session.
#[tauri::command]
pub fn session_save(state: State<'_, FluxState>, store: State<'_, SessionStore>, name: String) -> SavedSession {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_delete() {
        let store = SessionStore::default();
        let tabs = vec![SavedTab { url: "https://a.dev".into(), title: "A".into(), pinned: false }];
        let s = store.save("Work".into(), tabs);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.tabs_of(s.id).len(), 1);
        store.delete(s.id);
        assert!(store.list().is_empty());
    }

    #[test]
    fn empty_name_becomes_untitled() {
        let store = SessionStore::default();
        let s = store.save("  ".into(), vec![]);
        assert_eq!(s.name, "Untitled");
    }
}
