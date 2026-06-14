//! Read-only filesystem explorer backend (the Files tab — ADR 0006).
//!
//! Plain `std::fs`, with the heavy command (`fs_list`) running off the main
//! thread — a directory with tens of thousands of entries is a `stat` storm
//! that must never block the UI (same lesson as the webview commands). Entries
//! are deliberately compact (the frontend derives path, extension, category,
//! and the hidden flag) so even a 10k-file listing is a small JSON payload;
//! the frontend virtualizes rendering and sorts client-side.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// One directory entry. Compact on purpose — see module docs.
#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub symlink: bool,
    /// Bytes (0 for directories).
    pub size: u64,
    /// Last-modified, Unix epoch milliseconds, if the FS reports it.
    pub modified: Option<u64>,
}

/// A directory's contents plus where it sits.
#[derive(Serialize)]
pub struct DirListing {
    /// Canonical, display-clean directory path.
    pub path: String,
    /// Parent directory, or `None` at a filesystem root.
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// A pinned spot in the left rail.
#[derive(Serialize)]
pub struct QuickLocation {
    pub name: String,
    pub path: String,
    /// "home" | "folder" | "drive" — drives the rail icon.
    pub kind: &'static str,
}

pub fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into())
}

/// Strip Windows' `\\?\` extended-length prefix that `canonicalize` adds, so
/// paths display (and round-trip) cleanly.
fn clean(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// List a directory (off the main thread).
#[tauri::command]
pub async fn fs_list(path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir(path: &str) -> Result<DirListing, String> {
    // Canonicalize → absolute, `..`-resolved, existing. (Errors if it doesn't
    // exist, which is the right behavior.)
    let canon = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    let read = std::fs::read_dir(&canon).map_err(|e| format!("{}: {e}", clean(&canon)))?;

    let mut entries = Vec::new();
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        // `file_type()` is cheap (often free from the directory read); only the
        // target `metadata()` (a stat) gives size/mtime.
        let ft = ent.file_type().ok();
        let symlink = ft.map(|t| t.is_symlink()).unwrap_or(false);
        let meta = ent.metadata().ok();
        let is_dir = meta
            .as_ref()
            .map(|m| m.is_dir())
            .or_else(|| ft.map(|t| t.is_dir()))
            .unwrap_or(false);
        let size = if is_dir { 0 } else { meta.as_ref().map(|m| m.len()).unwrap_or(0) };
        let modified = meta.as_ref().and_then(mtime_ms);
        entries.push(FileEntry { name, is_dir, symlink, size, modified });
    }

    Ok(DirListing {
        parent: canon.parent().map(clean),
        path: clean(&canon),
        entries,
    })
}

#[tauri::command]
pub fn fs_home() -> String {
    home_dir()
}

/// Quick-access locations: home + its common subfolders, plus drive roots.
#[tauri::command]
pub fn fs_quick_locations() -> Vec<QuickLocation> {
    let mut out = Vec::new();
    let home = home_dir();
    out.push(QuickLocation { name: "Home".into(), path: home.clone(), kind: "home" });
    for sub in ["Desktop", "Documents", "Downloads"] {
        let p = format!("{home}/{sub}");
        if Path::new(&p).is_dir() {
            out.push(QuickLocation { name: sub.into(), path: p, kind: "folder" });
        }
    }
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let p = format!("{}:\\", letter as char);
        if Path::new(&p).is_dir() {
            out.push(QuickLocation { name: format!("{}:", letter as char), path: p, kind: "drive" });
        }
    }
    #[cfg(not(windows))]
    if Path::new("/").is_dir() {
        out.push(QuickLocation { name: "/".into(), path: "/".into(), kind: "drive" });
    }
    out
}

/// Open a file with the OS default application (read-only — launches, never
/// mutates). Directories are navigated in-app, not opened here.
#[tauri::command]
pub async fn fs_open(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open::that(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
