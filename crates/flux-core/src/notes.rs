//! Per-page notes (BACKLOG #53): a local-first note attached to a URL. Jot a
//! note while reading; it's there next time you visit. Plain JSON on disk.

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct NoteStore {
    map: RwLock<HashMap<String, String>>,
    path: Option<PathBuf>,
}

/// A page note for the notes index.
#[derive(Serialize, Clone)]
pub struct Note {
    pub url: String,
    pub text: String,
}

impl NoteStore {
    pub fn restore(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { map: RwLock::new(map), path: Some(path) }
    }

    pub fn get(&self, url: &str) -> String {
        self.map.read().get(url).cloned().unwrap_or_default()
    }

    pub fn set(&self, url: String, text: String) {
        {
            let mut m = self.map.write();
            if text.trim().is_empty() {
                m.remove(&url);
            } else {
                m.insert(url, text);
            }
        }
        self.save();
    }

    pub fn list(&self) -> Vec<Note> {
        self.map.read().iter().map(|(url, text)| Note { url: url.clone(), text: text.clone() }).collect()
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&*self.map.read()) {
            let _ = std::fs::write(path, json);
        }
    }
}

#[tauri::command]
pub fn note_get(store: State<'_, NoteStore>, url: String) -> String {
    store.get(&url)
}

#[tauri::command]
pub fn note_set(store: State<'_, NoteStore>, url: String, text: String) {
    store.set(url, text);
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
}
