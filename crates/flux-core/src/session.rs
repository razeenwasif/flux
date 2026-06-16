//! Session persistence (BACKLOG #19): the open tabs survive a restart.
//!
//! The backend is the source of truth for tabs, so it owns the on-disk session
//! too — a tiny JSON file in the app data dir, rewritten whenever tabs change
//! (create/close/pin/focus/navigate). On boot `FluxState::restore` reads it back
//! so you "continue where you left off". Best-effort throughout: a missing or
//! corrupt file just yields an empty session, never an error.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::state::{TabGroup, TabId, TabMeta};

/// The persisted shape. Every field is `#[serde(default)]` so an older/partial
/// file (or a hand-edit) still loads.
#[derive(Serialize, Deserialize, Default)]
pub struct Session {
    #[serde(default)]
    pub tabs: Vec<TabMeta>,
    /// Last-focused tab id (0 = none).
    #[serde(default)]
    pub active: TabId,
    /// Next id to hand out — persisted so restored ids never collide.
    #[serde(default)]
    pub next_id: TabId,
    /// Manual tab groups (BACKLOG #56).
    #[serde(default)]
    pub groups: Vec<TabGroup>,
}

pub fn load(path: &Path) -> Session {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, session: &Session) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(session) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{FluxState, TabKind, TabMeta};

    fn tab(id: TabId, pinned: bool) -> TabMeta {
        TabMeta { id, kind: TabKind::Browser, url: format!("https://{id}.test"), title: String::new(), pinned, cluster: None, group: None }
    }

    #[test]
    fn round_trips() {
        let path = std::env::temp_dir().join(format!("flux-sess-{}-a.json", std::process::id()));
        save(&path, &Session { tabs: vec![tab(2, true), tab(5, false)], active: 5, next_id: 6, groups: vec![] });
        let loaded = load(&path);
        assert_eq!(loaded.tabs.len(), 2);
        assert_eq!(loaded.active, 5);
        assert_eq!(loaded.next_id, 6);
        assert!(loaded.tabs[0].pinned);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_file_is_empty() {
        assert!(load(Path::new("/no/such/flux-session.json")).tabs.is_empty());
    }

    #[test]
    fn restore_repopulates_and_bumps_next_id() {
        let path = std::env::temp_dir().join(format!("flux-sess-{}-b.json", std::process::id()));
        // next_id is deliberately stale (2) behind the restored ids (max 7).
        save(&path, &Session { tabs: vec![tab(7, true)], active: 7, next_id: 2, groups: vec![] });
        let state = FluxState::restore(path.clone());
        assert_eq!(state.active_tab(), Some(7));
        assert!(state.tabs.contains_key(&7));
        assert!(state.alloc_tab_id() >= 8, "next id must clear every restored id");
        let _ = std::fs::remove_file(&path);
    }
}
