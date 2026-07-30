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
    /// Which list this task belongs to ("Uni", "Personal", …). Free-form so the
    /// user names their own; `#[serde(default)]` means tasks saved before
    /// profiles existed load as "", which the UI shows in the default list.
    #[serde(default)]
    pub profile: String,
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
        Self {
            items: RwLock::new(items),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<Todo> {
        self.items.read().clone()
    }

    pub fn add(&self, title: String, due: String, profile: String) -> Option<Todo> {
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
            profile: profile.trim().to_string(),
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

    /// Change a task's text and/or due date. `None` leaves a field alone, so a
    /// caller can rename without touching the date (and vice versa).
    pub fn edit(&self, id: u64, title: Option<String>, due: Option<String>) -> bool {
        let mut items = self.items.write();
        let Some(t) = items.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        if let Some(v) = title {
            let v = v.trim();
            // An empty title would leave an unclickable ghost row; keep the old.
            if !v.is_empty() {
                t.title = v.to_string();
            }
        }
        if let Some(v) = due {
            t.due = v.trim().to_string();
        }
        drop(items);
        self.save();
        true
    }

    /// Reorder the tasks named in `ids` to that sequence, in place.
    ///
    /// Only the given ids move: they're lifted out of the vector and written back
    /// into the same slots in the new order, so tasks from other lists keep their
    /// positions and nothing is lost if `ids` covers only part of the store.
    pub fn reorder(&self, ids: &[u64]) -> bool {
        let mut items = self.items.write();
        let slots: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, t)| ids.contains(&t.id))
            .map(|(i, _)| i)
            .collect();
        if slots.len() < 2 {
            return false;
        }
        // Take them out, then place them back in the requested sequence. Ids that
        // no longer exist are skipped rather than shifting everything along.
        let mut taken: Vec<Todo> = slots.iter().map(|&i| items[i].clone()).collect();
        let mut ordered: Vec<Todo> = Vec::with_capacity(taken.len());
        for id in ids {
            if let Some(pos) = taken.iter().position(|t| t.id == *id) {
                ordered.push(taken.remove(pos));
            }
        }
        ordered.extend(taken); // anything `ids` didn't mention keeps relative order
        for (slot, todo) in slots.iter().zip(ordered) {
            items[*slot] = todo;
        }
        drop(items);
        self.save();
        true
    }

    /// Move a task to another list.
    pub fn set_profile(&self, id: u64, profile: String) {
        if let Some(t) = self.items.write().iter_mut().find(|t| t.id == id) {
            t.profile = profile.trim().to_string();
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
        crate::persist::save_json(path, &*self.items.read());
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn todos_list(store: State<'_, TodoStore>) -> Vec<Todo> {
    store.list()
}

#[tauri::command]
pub fn todo_add(
    store: State<'_, TodoStore>,
    title: String,
    due: Option<String>,
    profile: Option<String>,
) -> Option<Todo> {
    store.add(title, due.unwrap_or_default(), profile.unwrap_or_default())
}

/// Reorder tasks (drag in the tasks column). `ids` is the new sequence.
#[tauri::command]
pub fn todos_reorder(store: State<'_, TodoStore>, ids: Vec<u64>) -> bool {
    store.reorder(&ids)
}

/// Rename a task or change its due date (inline edit in the tasks column).
#[tauri::command]
pub fn todo_edit(
    store: State<'_, TodoStore>,
    id: u64,
    title: Option<String>,
    due: Option<String>,
) -> bool {
    store.edit(id, title, due)
}

/// Move a task to another list (drag/right-click in the tasks column).
#[tauri::command]
pub fn todo_set_profile(store: State<'_, TodoStore>, id: u64, profile: String) {
    store.set_profile(id, profile);
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
        let a = s.add("buy milk".into(), "".into(), "Uni".into()).unwrap();
        s.add("  ".into(), "".into(), "".into()); // blank ignored
        assert_eq!(s.list().len(), 1);
        s.toggle(a.id);
        assert!(s.list()[0].done);
        let b = s
            .add("call alice".into(), "2026-06-20".into(), "".into())
            .unwrap();
        assert_eq!(b.due, "2026-06-20");
        // Tasks carry the list they were filed under, and can be moved between.
        assert_eq!(s.list()[0].profile, "Uni");
        s.set_profile(b.id, "Personal".into());
        let moved = s.list().into_iter().find(|t| t.id == b.id).unwrap();
        assert_eq!(moved.profile, "Personal");
        // Editing: fields are independent, and a blank title is refused rather
        // than leaving a nameless row.
        assert!(s.edit(b.id, Some("call alice back".into()), None));
        let e = s.list().into_iter().find(|t| t.id == b.id).unwrap();
        assert_eq!(e.title, "call alice back");
        assert_eq!(
            e.due, "2026-06-20",
            "due untouched when only the title changes"
        );
        s.edit(b.id, None, Some("2026-07-01".into()));
        s.edit(b.id, Some("   ".into()), None);
        let e2 = s.list().into_iter().find(|t| t.id == b.id).unwrap();
        assert_eq!(e2.title, "call alice back", "blank title ignored");
        assert_eq!(e2.due, "2026-07-01");
        assert!(
            !s.edit(9999, Some("ghost".into()), None),
            "unknown id is a no-op"
        );
        assert_eq!(s.clear_done(), 1); // the completed "buy milk"
        assert_eq!(s.list().len(), 1);
        s.remove(b.id);
        assert!(s.list().is_empty());
    }

    #[test]
    fn reorder_permutes_named_tasks_only() {
        let s = TodoStore::default();
        let a = s.add("a".into(), "".into(), "Uni".into()).unwrap();
        let p = s.add("p".into(), "".into(), "Personal".into()).unwrap();
        let b = s.add("b".into(), "".into(), "Uni".into()).unwrap();
        let ids = |s: &TodoStore| -> Vec<u64> { s.list().iter().map(|t| t.id).collect() };
        let pos = |v: &[u64], id: u64| v.iter().position(|x| *x == id).unwrap();

        // Dragging within the Uni list swaps those two and leaves Personal's task
        // in the slot it already occupied.
        let personal_slot = pos(&ids(&s), p.id);
        assert!(s.reorder(&[b.id, a.id]));
        let after = ids(&s);
        assert_eq!(after.len(), 3, "nothing lost or duplicated");
        assert!(
            pos(&after, b.id) < pos(&after, a.id),
            "requested order applied"
        );
        assert_eq!(pos(&after, p.id), personal_slot, "other lists undisturbed");

        // Stale ids are skipped rather than shifting the rest along, and a
        // single-task list is nothing to reorder.
        assert!(s.reorder(&[a.id, 4242, b.id]));
        let after = ids(&s);
        assert_eq!(after.len(), 3);
        assert!(pos(&after, a.id) < pos(&after, b.id));
        assert!(!s.reorder(&[p.id]), "one task is a no-op");
    }
}
