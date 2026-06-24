//! TUI app launcher — a curated, editable bar of the user's terminal apps, so
//! they open in a Flux Terminal tab with one click (sibling to the native
//! `PagesBar`). The list is persisted to `<app_data>/tui-apps.json`; each entry
//! is a shell command run in a fresh terminal (the shell is the user's
//! `$FLUX_SHELL`, so commands resolve on that shell's PATH — incl. WSL).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

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

/// Bump when adding new default apps; existing users get the new ones merged in
/// once (by id, without clobbering their edits/order) via `hydrate`.
const SEED_VERSION: u32 = 2;

/// Default TUI apps (all launch by binary name on the terminal shell's PATH).
/// Users add/remove/reorder freely afterwards.
fn seed_defaults() -> Vec<TuiApp> {
    [
        ("onyx", "Onyx", "📝"),
        ("scroll", "Scroll", "📜"),
        ("council", "Council", "⚖"),
        ("audiopulse", "AudioPulse", "🎵"),
        ("boxtube", "BoxTube", "📺"),
        ("kata", "Kata", "🥋"),
        ("mamba", "Mamba", "🐍"),
        ("forge", "Forge", "🔨"),
        ("lazygit", "LazyGit", "🌿"),
        ("conduit", "Conduit", "🔌"),
        ("mirage", "Mirage", "🌫"),
        ("tuxedo", "Tuxedo", "🐧"),
    ]
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

/// On-disk shape. Older builds wrote a bare `Vec<TuiApp>`; `hydrate` reads both.
#[derive(Serialize, Deserialize, Default)]
struct TuiAppsFile {
    #[serde(default)]
    seed_version: u32,
    apps: Vec<TuiApp>,
}

pub struct TuiAppsStore {
    path: Option<PathBuf>,
    apps: Mutex<Vec<TuiApp>>,
    seed_version: AtomicU32,
    loaded: AtomicBool,
}

impl Default for TuiAppsStore {
    fn default() -> Self {
        TuiAppsStore {
            path: None,
            apps: Mutex::new(Vec::new()),
            seed_version: AtomicU32::new(0),
            loaded: AtomicBool::new(false),
        }
    }
}

impl TuiAppsStore {
    pub fn empty(path: PathBuf) -> Self {
        TuiAppsStore { path: Some(path), ..Default::default() }
    }

    /// Load from disk; first run seeds the defaults, and an existing list from an
    /// older seed version gets new defaults merged in once (by id, preserving the
    /// user's edits/order). Reads both the current `{seed_version,apps}` shape and
    /// the legacy bare `[TuiApp]` array.
    pub fn hydrate(&self) {
        if self.loaded.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };

        let mut had_file = false;
        let mut version = 0u32;
        let mut apps: Vec<TuiApp> = Vec::new();
        if let Ok(s) = std::fs::read_to_string(path) {
            had_file = true;
            if let Ok(f) = serde_json::from_str::<TuiAppsFile>(&s) {
                version = f.seed_version;
                apps = f.apps;
            } else if let Ok(v) = serde_json::from_str::<Vec<TuiApp>>(&s) {
                apps = v; // legacy bare-array format → seed_version 0
            }
        }

        let mut changed = false;
        if !had_file {
            apps = seed_defaults();
            version = SEED_VERSION;
            changed = true;
        } else if version < SEED_VERSION {
            // Merge in defaults the user doesn't already have (by id), keeping
            // their existing entries + order; new ones append.
            let have: HashSet<&str> = apps.iter().map(|a| a.id.as_str()).collect();
            let add: Vec<TuiApp> = seed_defaults().into_iter().filter(|d| !have.contains(d.id.as_str())).collect();
            if !add.is_empty() {
                apps.extend(add);
            }
            version = SEED_VERSION;
            changed = true;
        }

        *self.apps.lock() = apps;
        self.seed_version.store(version, Ordering::Release);
        if changed {
            self.persist();
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let file = TuiAppsFile { seed_version: self.seed_version.load(Ordering::Acquire), apps: self.apps.lock().clone() };
        if let Ok(json) = serde_json::to_string_pretty(&file) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_seeds_all_defaults() {
        let dir = std::env::temp_dir().join(format!("flux-tuiapps-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = TuiAppsStore::empty(dir.join("tui-apps.json"));
        let apps = store.list();
        assert_eq!(apps.len(), seed_defaults().len());
        assert!(apps.iter().any(|a| a.id == "lazygit" && a.cmd == "lazygit"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_list_merging_new_defaults_once() {
        let dir = std::env::temp_dir().join(format!("flux-tuiapps-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tui-apps.json");
        // Legacy bare-array file with a single, user-renamed entry.
        let legacy = r#"[{"id":"onyx","name":"My Onyx","icon":"📝","cmd":"onyx","cwd":"/home/me"}]"#;
        std::fs::write(&path, legacy).unwrap();

        let store = TuiAppsStore::empty(path.clone());
        let apps = store.list();
        // The user's edit is preserved…
        let onyx = apps.iter().find(|a| a.id == "onyx").unwrap();
        assert_eq!(onyx.name, "My Onyx");
        assert_eq!(onyx.cwd, "/home/me");
        // …and the new defaults were merged in (no duplicate onyx).
        assert_eq!(apps.iter().filter(|a| a.id == "onyx").count(), 1);
        assert!(apps.iter().any(|a| a.id == "forge"));
        assert_eq!(apps.len(), seed_defaults().len());

        // Re-hydrating a fresh store reads the now-migrated file without re-adding.
        let store2 = TuiAppsStore::empty(path);
        assert_eq!(store2.list().len(), seed_defaults().len());
        let _ = std::fs::remove_dir_all(&dir);
    }
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
