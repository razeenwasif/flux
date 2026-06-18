//! Local tasks / to-dos (BACKLOG #114) — a home-screen task list, on-device and
//! private (no Google Tasks sync; that would need OAuth, deferred). Plain JSON,
//! same store shape as bookmarks/feeds. Named `todos` to avoid colliding with the
//! system task manager (`taskmgr.rs`) and the agent's `/task` loop.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Todo {
    pub id: u64,
    pub title: String,
    pub done: bool,
    pub created_ms: u64,
    /// Optional `YYYY-MM-DD` due date (display-only), or "" for none.
    #[serde(default)]
    pub due: String,
}

#[derive(Default)]
pub struct TodoStore {
    items: RwLock<Vec<Todo>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl TodoStore {
    pub fn restore(path: PathBuf) -> Self {
        let items: Vec<Todo> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = items.iter().map(|t| t.id).max().unwrap_or(0) + 1;
        Self { items: RwLock::new(items), next_id: AtomicU64::new(next), path: Some(path) }
    }

    pub fn list(&self) -> Vec<Todo> {
        self.items.read().clone()
    }

    pub fn add(&self, title: String, due: String) -> Option<Todo> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return None;
        }
        let todo = Todo {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            title,
            done: false,
            created_ms: now_ms(),
            due: due.trim().to_string(),
        };
        self.items.write().push(todo.clone());
        self.save();
        Some(todo)
    }

    pub fn toggle(&self, id: u64) {
        if let Some(t) = self.items.write().iter_mut().find(|t| t.id == id) {
            t.done = !t.done;
        }
        self.save();
    }

    pub fn remove(&self, id: u64) {
        self.items.write().retain(|t| t.id != id);
        self.save();
    }

    /// Drop every completed task; returns how many were removed.
    pub fn clear_done(&self) -> usize {
        let mut items = self.items.write();
        let before = items.len();
        items.retain(|t| !t.done);
        let removed = before - items.len();
        drop(items);
        self.save();
        removed
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

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn todos_list(store: State<'_, TodoStore>) -> Vec<Todo> {
    store.list()
}

#[tauri::command]
pub fn todo_add(store: State<'_, TodoStore>, title: String, due: Option<String>) -> Option<Todo> {
    store.add(title, due.unwrap_or_default())
}

#[tauri::command]
pub fn todo_toggle(store: State<'_, TodoStore>, id: u64) {
    store.toggle(id);
}

#[tauri::command]
pub fn todo_remove(store: State<'_, TodoStore>, id: u64) {
    store.remove(id);
}

#[tauri::command]
pub fn todos_clear_done(store: State<'_, TodoStore>) -> usize {
    store.clear_done()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_toggle_clear() {
        let s = TodoStore::default();
        let a = s.add("buy milk".into(), "".into()).unwrap();
        s.add("  ".into(), "".into()); // blank ignored
        assert_eq!(s.list().len(), 1);
        s.toggle(a.id);
        assert!(s.list()[0].done);
        let b = s.add("call alice".into(), "2026-06-20".into()).unwrap();
        assert_eq!(b.due, "2026-06-20");
        assert_eq!(s.clear_done(), 1); // the completed "buy milk"
        assert_eq!(s.list().len(), 1);
        s.remove(b.id);
        assert!(s.list().is_empty());
    }
}
