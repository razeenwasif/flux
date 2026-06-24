//! TUI app launcher — a curated, editable bar of the user's terminal apps, so
//! they open in a Flux Terminal tab with one click (sibling to the native
//! `PagesBar`). The list is persisted to `<app_data>/tui-apps.json`; each entry
//! is a shell command run in a fresh terminal (the shell is the user's
//! `$FLUX_SHELL`, so commands resolve on that shell's PATH — incl. WSL).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

/// One launchable terminal app.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct TuiApp {
    /// Stable id (frontend-generated; used as the keyed-list key).
    pub id: String,
    pub name: String,
    /// An emoji/glyph for the chip.
    pub icon: String,
    /// Shell command to run in the new terminal (e.g. `onyx`, or `cd ~/X && cargo run`).
    pub cmd: String,
    /// Working directory, or empty for the shell default.
    pub cwd: String,
}

/// First-run seeds — the user's known TUI apps. Edited freely afterwards.
fn seed_defaults() -> Vec<TuiApp> {
    [("onyx", "Onyx", "📝"), ("scroll", "Scroll", "📜"), ("council", "Council", "⚖")]
        .into_iter()
        .map(|(cmd, name, icon)| TuiApp {
            id: cmd.to_string(),
            name: name.to_string(),
            icon: icon.to_string(),
            cmd: cmd.to_string(),
            cwd: String::new(),
        })
        .collect()
}

pub struct TuiAppsStore {
    path: Option<PathBuf>,
    apps: Mutex<Vec<TuiApp>>,
    loaded: AtomicBool,
}

impl Default for TuiAppsStore {
    fn default() -> Self {
        TuiAppsStore { path: None, apps: Mutex::new(Vec::new()), loaded: AtomicBool::new(false) }
    }
}

impl TuiAppsStore {
    pub fn empty(path: PathBuf) -> Self {
        TuiAppsStore { path: Some(path), ..Default::default() }
    }

    /// Load from disk; on first run (no file) seed the defaults and persist them.
    pub fn hydrate(&self) {
        if self.loaded.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Vec<TuiApp>>(&s) {
                *self.apps.lock() = v;
                return;
            }
        }
        // No file (or unreadable) → first run: seed + persist.
        *self.apps.lock() = seed_defaults();
        self.persist();
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        if let Ok(json) = serde_json::to_string_pretty(&*self.apps.lock()) {
            let _ = std::fs::write(path, json);
        }
    }

    pub fn list(&self) -> Vec<TuiApp> {
        self.hydrate();
        self.apps.lock().clone()
    }

    pub fn set(&self, apps: Vec<TuiApp>) {
        self.hydrate(); // ensure `loaded` is set so we don't clobber on a later hydrate
        *self.apps.lock() = apps;
        self.persist();
    }
}

/// The full app list (seeded on first run).
#[tauri::command]
pub fn tui_apps_list(store: State<'_, TuiAppsStore>) -> Vec<TuiApp> {
    store.list()
}

/// Replace the whole list (add/remove/reorder/edit happen frontend-side, then save).
#[tauri::command]
pub fn tui_apps_set(store: State<'_, TuiAppsStore>, apps: Vec<TuiApp>) {
    store.set(apps);
}

/// Best-effort scan of the standard user bin dirs for executable names — a
/// quick-add helper for the editor. Scans the *Flux process's* home (so on a
/// Windows build this sees Windows bins, not WSL ones).
#[tauri::command]
pub fn tui_apps_detect() -> Vec<String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    if home.is_empty() {
        return Vec::new();
    }
    let mut found = std::collections::BTreeSet::new();
    for sub in [".cargo/bin", ".local/bin", "go/bin", "bin"] {
        let dir = std::path::Path::new(&home).join(sub);
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for ent in read.flatten() {
            if ent.file_type().map(|t| t.is_file() || t.is_symlink()).unwrap_or(false) {
                let name = ent.file_name().to_string_lossy().into_owned();
                // Drop Windows extensions so the command is shell-agnostic.
                let name = name.trim_end_matches(".exe").trim_end_matches(".cmd").to_string();
                if !name.is_empty() && !name.starts_with('.') {
                    found.insert(name);
                }
            }
        }
    }
    found.into_iter().collect()
}
