//! Per-page notes (BACKLOG #53): a local-first note attached to a URL. Jot a
//! note while reading; it's there next time you visit. Plain JSON on disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{Manager, State};

#[derive(Default)]
pub struct NoteStore {
    map: RwLock<HashMap<String, String>>,
    path: Option<PathBuf>,
    /// Bumped per change; a save that's been overtaken by a newer change skips,
    /// since that change's save writes the newer map anyway.
    seq: AtomicU64,
    /// Held across a write, so two saves never interleave.
    writing: Mutex<()>,
}

/// A page note for the notes index.
#[derive(Serialize, Clone)]
pub struct Note {
    pub url: String,
    pub text: String,
}

impl NoteStore {
    pub fn restore(path: PathBuf) -> Self {
        let map = crate::persist::load_json_or_quarantine(&path).unwrap_or_default();
        Self {
            map: RwLock::new(map),
            path: Some(path),
            ..Self::default()
        }
    }

    pub fn get(&self, url: &str) -> String {
        self.map.read().get(url).cloned().unwrap_or_default()
    }

    pub fn set(&self, url: String, text: String) {
        self.update(url, text);
        self.save();
    }

    /// Change the map; returns the change's number for `save_if_newest`.
    fn update(&self, url: String, text: String) -> u64 {
        let mut m = self.map.write();
        if text.trim().is_empty() {
            m.remove(&url);
        } else {
            m.insert(url, text);
        }
        self.seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Save, unless a newer change has come in since `seq` (its own save will).
    fn save_if_newest(&self, seq: u64) {
        let _writing = self.writing.lock();
        if self.seq.load(Ordering::Acquire) != seq {
            return;
        }
        self.save();
    }

    pub fn list(&self) -> Vec<Note> {
        self.map
            .read()
            .iter()
            .map(|(url, text)| Note {
                url: url.clone(),
                text: text.clone(),
            })
            .collect()
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        // Serialized under the lock, written after it: the write syncs to disk,
        // and holding the lock across it stalled every note read.
        let Ok(json) = serde_json::to_vec(&*self.map.read()) else {
            return;
        };
        let _ = crate::persist::write_atomic_with(path, &json, crate::persist::Durability::Barrier);
    }
}

#[tauri::command]
pub fn note_get(store: State<'_, NoteStore>, url: String) -> String {
    store.get(&url)
}

/// The map changes here, in call order; the save goes to the blocking pool. The
/// start-page scratchpad and page notes call this at every pause in typing, and
/// each save is a full flush to disk, which used to happen on the UI thread.
#[tauri::command]
pub fn note_set(app: tauri::AppHandle, store: State<'_, NoteStore>, url: String, text: String) {
    let seq = store.update(url, text);
    tauri::async_runtime::spawn_blocking(move || app.state::<NoteStore>().save_if_newest(seq));
}

#[tauri::command]
pub fn notes_list(store: State<'_, NoteStore>) -> Vec<Note> {
    store.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_empty_removes() {
        let s = NoteStore::default();
        s.set("https://a.dev".into(), "remember this".into());
        assert_eq!(s.get("https://a.dev"), "remember this");
        assert_eq!(s.list().len(), 1);
        s.set("https://a.dev".into(), "   ".into()); // blank clears
        assert!(s.get("https://a.dev").is_empty());
        assert!(s.list().is_empty());
    }

    #[test]
    fn an_overtaken_save_is_skipped_and_the_newest_written() {
        let dir = std::env::temp_dir().join(format!("flux-notes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.json");
        let s = NoteStore::restore(path.clone());
        let first = s.update("https://a.dev".into(), "draft".into());
        let second = s.update("https://a.dev".into(), "final".into());
        s.save_if_newest(first);
        assert!(
            !path.exists(),
            "the first save was overtaken by the second change"
        );
        s.save_if_newest(second);
        let saved: HashMap<String, String> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            saved.get("https://a.dev").map(String::as_str),
            Some("final")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
