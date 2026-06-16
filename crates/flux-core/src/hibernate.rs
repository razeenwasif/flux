//! Tab-hibernation state preservation (BACKLOG #45 follow-up).
//!
//! Holds per-tab scroll + form state captured when a tab is backgrounded, so a
//! woken (reloaded) tab restores it. **RAM only** — never persisted to disk; the
//! capture script (`hibernate.js`) excludes password fields. A `wake_pending`
//! flag, set when a tab is actually hibernated, ensures the state is re-applied
//! only on the wake reload — not on a tab's ordinary in-page navigations.

use dashmap::DashMap;
use tauri::State;

use crate::state::TabId;

struct Entry {
    state: String,
    wake_pending: bool,
}

#[derive(Default)]
pub struct HibernateStore {
    entries: DashMap<TabId, Entry>,
}

impl HibernateStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn capture(&self, id: TabId, state: String) {
        self.entries
            .entry(id)
            .and_modify(|e| e.state = state.clone())
            .or_insert(Entry { state, wake_pending: false });
    }

    /// Arm restore for `id` — called when the tab is hibernated.
    pub fn mark_wake(&self, id: TabId) {
        if let Some(mut e) = self.entries.get_mut(&id) {
            e.wake_pending = true;
        }
    }

    /// The captured state to restore on a wake reload, if armed (one-shot).
    pub fn take_for_restore(&self, id: TabId) -> Option<String> {
        let mut e = self.entries.get_mut(&id)?;
        if e.wake_pending {
            e.wake_pending = false;
            Some(e.state.clone())
        } else {
            None
        }
    }

    pub fn remove(&self, id: TabId) {
        self.entries.remove(&id);
    }
}

/// Page → Rust: store a tab's captured scroll/form state (a `fluxtab` plugin
/// command, like `dom_publish`, so the remote page may call it).
#[tauri::command]
pub fn hibernate_capture(store: State<'_, HibernateStore>, tab_id: TabId, state: String) {
    store.capture(tab_id, state);
}
