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

// ─── File operations (BACKLOG #83) ───────────────────────────────────────────
//
// All mutate the filesystem, so each runs on a blocking thread (a slow op on a
// network drive must never wedge the UI). Destructive ops are confirmed in the
// UI; delete defaults to the OS trash (recoverable) with a permanent variant
// behind an explicit gesture.

/// Run `f` on the blocking pool and flatten the join error.
async fn blocking<F>(f: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Remove a path whether it's a file, dir (recursive), or symlink.
fn remove_path(p: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(p)?.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// Recursive copy (dir trees included); symlinks are copied as their target.
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(src)?.is_dir() {
        std::fs::create_dir(dst)?;
        for ent in std::fs::read_dir(src)? {
            let ent = ent?;
            copy_recursive(&ent.path(), &dst.join(ent.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// A non-colliding sibling of `target`: `name copy`, `name copy 2`, … (the
/// extension is preserved), used so a paste/duplicate never clobbers.
fn unique_path(target: &Path) -> std::path::PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let parent = target.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|e| e.to_string_lossy().into_owned());
    let mut n = 1;
    loop {
        let name = match (&ext, n) {
            (Some(e), 1) => format!("{stem} copy.{e}"),
            (Some(e), _) => format!("{stem} copy {n}.{e}"),
            (None, 1) => format!("{stem} copy"),
            (None, _) => format!("{stem} copy {n}"),
        };
        let cand = parent.join(&name);
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// Create an empty directory at `path` (the full target path).
#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    blocking(move || {
        let p = Path::new(&path);
        if p.exists() {
            return Err(format!("{} already exists", clean(p)));
        }
        std::fs::create_dir(p).map_err(|e| format!("{}: {e}", clean(p)))
    })
    .await
}

/// Create an empty file at `path` (errors if it already exists).
#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<(), String> {
    blocking(move || {
        let p = Path::new(&path);
        if p.exists() {
            return Err(format!("{} already exists", clean(p)));
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)
            .map(|_| ())
            .map_err(|e| format!("{}: {e}", clean(p)))
    })
    .await
}

/// Rename (in place) from `from` to `to` — both full paths. Refuses to clobber.
#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || {
        let (from, to) = (Path::new(&from), Path::new(&to));
        if to.exists() {
            return Err(format!("{} already exists", clean(to)));
        }
        std::fs::rename(from, to).map_err(|e| e.to_string())
    })
    .await
}

/// Move each of `paths` into directory `dest`. Tries `rename`, falling back to
/// copy+delete across filesystems. Refuses to overwrite an existing target.
#[tauri::command]
pub async fn fs_move(paths: Vec<String>, dest: String) -> Result<(), String> {
    blocking(move || {
        let dest = Path::new(&dest);
        for src in &paths {
            let src = Path::new(src);
            let name = src.file_name().ok_or_else(|| format!("bad path: {}", clean(src)))?;
            let target = dest.join(name);
            if target == src {
                continue; // moving onto itself — no-op
            }
            if target.exists() {
                return Err(format!("{} already exists", clean(&target)));
            }
            if std::fs::rename(src, &target).is_err() {
                // Cross-device (or rename refused): copy then remove the source.
                copy_recursive(src, &target).map_err(|e| e.to_string())?;
                remove_path(src).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
}

/// Copy each of `paths` into directory `dest`; auto-uniquifies on collision so
/// pasting into the source folder duplicates ("file copy.txt") rather than fails.
#[tauri::command]
pub async fn fs_copy(paths: Vec<String>, dest: String) -> Result<(), String> {
    blocking(move || {
        let dest = Path::new(&dest);
        for src in &paths {
            let src = Path::new(src);
            let name = src.file_name().ok_or_else(|| format!("bad path: {}", clean(src)))?;
            let target = unique_path(&dest.join(name));
            copy_recursive(src, &target).map_err(|e| format!("{}: {e}", clean(src)))?;
        }
        Ok(())
    })
    .await
}

/// Send each of `paths` to the OS trash / recycle bin (recoverable).
#[tauri::command]
pub async fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    blocking(move || trash::delete_all(&paths).map_err(|e| e.to_string())).await
}

/// Permanently delete each of `paths` (recursive) — no trash, no undo.
#[tauri::command]
pub async fn fs_delete(paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        for p in &paths {
            remove_path(Path::new(p)).map_err(|e| format!("{p}: {e}"))?;
        }
        Ok(())
    })
    .await
}
