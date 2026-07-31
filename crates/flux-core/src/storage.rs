//! On-disk browsing data: how much the engine is holding, and how to clear it.
//!
//! This exists because of a real gap, found while chasing a renderer crash. A
//! service-worker CacheStorage had grown to **753 MB** without anything ever
//! saying so, and there was no way to clear it from inside Flux — the only cure
//! was deleting folders by hand from PowerShell. Every other browser has this;
//! Flux didn't.
//!
//! **It was not the crash.** That turned out to be two injected page scripts
//! calling the IPC bridge at document-created (see `webview.rs`), and clearing
//! the caches changed nothing. The size was a real problem worth surfacing on its
//! own terms — a browser that sells itself on being light shouldn't quietly sit
//! on a gigabyte — but this is hygiene, not a fix for anything.
//!
//!
//! **Clearing is deferred to the next launch.** The engine holds these files open
//! while it runs, so deleting them live either fails or corrupts the profile
//! further — and the case that matters most is a profile so broken it crashes on
//! load, where "close the browser first" is the only order that works. So
//! `storage_clear` writes a marker and [`apply_pending_clear`] acts on it at boot,
//! before any webview exists.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// A group of on-disk data the user can reason about and clear independently.
struct Category {
    key: &'static str,
    label: &'static str,
    hint: &'static str,
    /// Paths relative to the profile root. Missing ones simply contribute 0 —
    /// the layout is engine-specific and this must not fail on an unknown one.
    paths: &'static [&'static str],
    /// Above this, the category is called out as abnormal. `None` = never warn.
    warn_over: Option<u64>,
}

const MB: u64 = 1024 * 1024;

/// Chromium's profile layout (WebView2 on Windows). WebKitGTK stores different
/// names in a different root; unknown paths report 0 rather than erroring, so the
/// page degrades to showing less rather than lying.
const CATEGORIES: &[Category] = &[
    Category {
        key: "serviceworkers",
        label: "Service workers",
        hint: "Offline caches sites install. The group most likely to grow without bound — one reached 753 MB here before anything surfaced it.",
        paths: &["Default/Service Worker"],
        // A healthy service-worker store is single-digit MB. A quarter of a
        // gigabyte already means something is not evicting, which is worth saying
        // even though a large store has not been shown to break anything.
        warn_over: Some(250 * MB),
    },
    Category {
        key: "cache",
        label: "Cache",
        hint: "Fetched pages, scripts and images. Safe to clear; the first load of each site is slower afterwards.",
        paths: &["Default/Cache", "Default/Code Cache", "Default/GPUCache"],
        warn_over: Some(1024 * MB),
    },
    Category {
        key: "sitedata",
        label: "Site storage",
        hint: "localStorage, IndexedDB and session storage. Clearing can sign you out of sites that keep their session here.",
        paths: &[
            "Default/Local Storage",
            "Default/IndexedDB",
            "Default/Session Storage",
        ],
        warn_over: Some(512 * MB),
    },
    Category {
        key: "cookies",
        label: "Cookies",
        hint: "Signs you out of everything. Kept separate so the other options don't cost you your logins.",
        paths: &["Default/Network"],
        warn_over: None,
    },
];

/// One row in the storage report.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StorageEntry {
    pub key: String,
    pub label: String,
    pub hint: String,
    pub bytes: u64,
    /// This category is larger than it has any business being.
    pub warn: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StorageReport {
    pub entries: Vec<StorageEntry>,
    pub total_bytes: u64,
    /// Any category is over its threshold, or the profile as a whole is.
    pub warn: bool,
    /// Set once a clear is queued, so the UI can say a restart is needed.
    pub pending: Vec<String>,
    /// Where this was measured, for the "it's not lying, go look" case.
    pub root: String,
}

/// Whole-profile ceiling. Independently of any one category, a browsing profile
/// past this is worth a word — Flux's pitch is being light on resources.
const TOTAL_WARN: u64 = 2048 * MB;

/// Root of the engine's on-disk profile.
///
/// WebView2 puts its profile in an `EBWebView` folder under the app's local data
/// dir; WebKitGTK keeps its data directly in the app data dir.
pub fn profile_root(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    if cfg!(windows) {
        Some(base.join("EBWebView"))
    } else {
        Some(base)
    }
}

/// Total size of a directory tree, following no symlinks.
///
/// Returns what it could read rather than failing: a profile with one unreadable
/// file should still report a number, since the number is the whole point.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // never follow: a loop would hang the walk
        }
        if ft.is_dir() {
            total += dir_size(&e.path());
        } else if let Ok(m) = e.metadata() {
            total += m.len();
        }
    }
    total
}

/// Must match `identifier` in tauri.conf.json — the boot-time pass runs before
/// Tauri exists and so can't ask it where anything is.
const IDENTIFIER: &str = "dev.flux.browser";

/// Where the marker lives, resolved from the environment alone so the same
/// function works before Tauri is built and after.
fn marker_path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
    } else if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        PathBuf::from(x)
    } else {
        PathBuf::from(std::env::var("HOME").ok()?).join(".local/share")
    };
    Some(base.join(IDENTIFIER).join("pending-clear.json"))
}

/// A queued clear. **Absolute paths, resolved when it was queued** — the boot
/// pass deletes exactly what the report measured, instead of recomputing the
/// layout and risking deleting somewhere else entirely.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Pending {
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
}

fn read_pending_file() -> Pending {
    marker_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Pending>(&s).ok())
        .unwrap_or_default()
}

fn read_pending(_app: &AppHandle) -> Vec<String> {
    read_pending_file().keys
}

/// Measure the profile. Walks the tree, so callers run it off the UI thread.
#[tauri::command]
pub async fn storage_usage(app: AppHandle) -> Result<StorageReport, String> {
    let pending = read_pending(&app);
    let root = profile_root(&app).ok_or("no app data directory")?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        let entries: Vec<StorageEntry> = CATEGORIES
            .iter()
            .map(|c| {
                let bytes: u64 = c.paths.iter().map(|p| dir_size(&root.join(p))).sum();
                StorageEntry {
                    key: c.key.to_string(),
                    label: c.label.to_string(),
                    hint: c.hint.to_string(),
                    bytes,
                    warn: c.warn_over.is_some_and(|limit| bytes > limit),
                }
            })
            .collect();
        let total_bytes = entries.iter().map(|e| e.bytes).sum();
        StorageReport {
            warn: total_bytes > TOTAL_WARN || entries.iter().any(|e| e.warn),
            entries,
            total_bytes,
            pending,
            root: root.to_string_lossy().to_string(),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    // Cache it so the resource monitor can warn without walking the tree again.
    if let Some(cache) = app.try_state::<StorageWarn>() {
        *cache.0.lock() = Some(report.clone());
    }
    Ok(report)
}

/// Queue categories for deletion at next launch. Returns the message to show.
///
/// Nothing is deleted here — see the module docs on why clearing is deferred.
#[tauri::command]
pub fn storage_clear(app: AppHandle, keys: Vec<String>) -> Result<String, String> {
    let known: Vec<String> = keys
        .into_iter()
        .filter(|k| CATEGORIES.iter().any(|c| c.key == k))
        .collect();
    if known.is_empty() {
        return Err("nothing selected to clear".into());
    }
    let root = profile_root(&app).ok_or("no app data directory")?;
    let paths: Vec<String> = CATEGORIES
        .iter()
        .filter(|c| known.iter().any(|k| k == c.key))
        .flat_map(|c| c.paths.iter())
        .map(|rel| root.join(rel).to_string_lossy().to_string())
        .collect();
    let p = marker_path().ok_or("no app data directory")?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string(&Pending {
        keys: known.clone(),
        paths,
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("couldn't queue the clear: {e}"))?;
    Ok(format!(
        "{} queued — deleted next time Flux starts.",
        known.len()
    ))
}

/// Forget a queued clear.
#[tauri::command]
pub fn storage_clear_cancel() -> Result<(), String> {
    if let Some(p) = marker_path() {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Delete anything queued by a previous run.
///
/// **Call before Tauri builds the app**, while the engine holds nothing open: on
/// Windows a live WebView2 keeps profile files locked, so a delete would either
/// fail or half-succeed and leave the profile worse than it found it.
pub fn apply_pending_clear_early() {
    let pending = read_pending_file();
    if pending.paths.is_empty() {
        return;
    }
    // Drop the marker first: a path that somehow kills the process must not make
    // every future launch retry it forever.
    if let Some(p) = marker_path() {
        let _ = std::fs::remove_file(p);
    }
    for path in &pending.paths {
        let target = Path::new(path);
        if !target.exists() {
            continue;
        }
        let freed = dir_size(target);
        match std::fs::remove_dir_all(target) {
            Ok(()) => {
                tracing::info!(target: "flux::storage", path, freed, "cleared browsing data")
            }
            Err(e) => {
                tracing::warn!(target: "flux::storage", path, error = %e, "couldn't clear")
            }
        }
    }
}

/// Cached snapshot so the chrome can warn without re-walking the profile.
#[derive(Default)]
pub struct StorageWarn(pub parking_lot::Mutex<Option<StorageReport>>);

/// The last measured report, if one has been taken this session. Cheap — used by
/// the resource monitor to show a warning without walking the tree again.
#[tauri::command]
pub fn storage_last(state: State<'_, StorageWarn>) -> Option<StorageReport> {
    state.0.lock().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_are_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for c in CATEGORIES {
            assert!(seen.insert(c.key), "duplicate key {}", c.key);
            assert!(!c.paths.is_empty(), "{} has no paths", c.key);
            assert!(!c.hint.is_empty(), "{} has no hint", c.key);
        }
        // Cookies must never be swept up by a "clear the junk" click — it's the
        // one category that costs the user their logins.
        let cookies = CATEGORIES.iter().find(|c| c.key == "cookies").unwrap();
        assert!(
            cookies.warn_over.is_none(),
            "cookies must not be flagged as excessive; size isn't the problem there"
        );
    }

    #[test]
    fn dir_size_walks_and_survives_a_bad_entry() {
        let dir = std::env::temp_dir().join(format!("flux-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("sub/b.bin"), vec![0u8; 2000]).unwrap();
        std::fs::write(dir.join("sub/deeper/c.bin"), vec![0u8; 3000]).unwrap();
        assert_eq!(dir_size(&dir), 6000, "recurses into every level");

        // A path that doesn't exist is 0, not a panic — the layout differs per
        // engine and a missing directory is the normal case, not an error.
        assert_eq!(dir_size(&dir.join("nope")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn warn_thresholds() {
        let sw = CATEGORIES
            .iter()
            .find(|c| c.key == "serviceworkers")
            .unwrap();
        let limit = sw.warn_over.unwrap();
        // The size actually observed in the wild must trip the warning.
        assert!(
            753 * MB > limit,
            "753 MB is the size that went unnoticed; it has to be flagged"
        );
        // A healthy store must not.
        assert!(8 * MB < limit, "a normal service-worker store stays quiet");
    }
}
