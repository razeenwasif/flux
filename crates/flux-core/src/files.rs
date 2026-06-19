//! Read-only filesystem explorer backend (the Files tab — ADR 0006).
//!
//! Plain `std::fs`, with blocking filesystem work running off the main thread.
//! Entries are deliberately compact (the frontend derives path, extension,
//! category, and the hidden flag) so even a 10k-file listing is a small JSON
//! payload; the frontend virtualizes rendering and sorts client-side.

use std::collections::HashMap;
use std::path::Path;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One directory entry. Compact on purpose — see module docs.
#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub symlink: bool,
    /// Bytes when available. `None` on the fast initial listing.
    pub size: Option<u64>,
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

// ─── Live directory watch (#85) ───────────────────────────────────────────────
//
// One `notify` watcher per Files tab (keyed by tab id). The watcher emits
// `flux://fs-changed` with the watched directory; the UI debounces and re-lists
// if the change is for the directory it's showing. Stored behind a Mutex (a
// `RecommendedWatcher` is `Send` but not `Sync`).

#[derive(Default)]
pub struct FsWatchers(pub Mutex<HashMap<u64, notify::RecommendedWatcher>>);

// ─── Undo stack (#89) ─────────────────────────────────────────────────────────
//
// Reversible ops only — undo never deletes user data, it only puts files back:
// rename → rename back, move → move back, trash → restore. Backend-owned so the
// platform-specific trash-restore handle (`TrashItem`) never crosses IPC.

/// Trash-restore is platform-gated: Windows + freedesktop (Linux/BSD) only.
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
mod restore {
    use std::collections::HashSet;
    use std::path::PathBuf;

    pub type Items = Vec<trash::TrashItem>;

    /// Capture the just-trashed items so they can be restored later: match the
    /// trash listing against the original paths, newest-first, de-duped.
    pub fn capture(paths: &[String]) -> Items {
        let want: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let mut items = trash::os_limited::list().unwrap_or_default();
        items.sort_by(|a, b| b.time_deleted.cmp(&a.time_deleted));
        let mut seen = HashSet::new();
        items
            .into_iter()
            .filter(|it| {
                let full = it.original_parent.join(&it.name);
                want.contains(&full) && seen.insert(full)
            })
            .collect()
    }

    pub fn restore(items: Items) -> Result<(), String> {
        trash::os_limited::restore_all(items).map_err(|e| e.to_string())
    }
}
#[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos")))))]
mod restore {
    pub type Items = Vec<String>;
    pub fn capture(_paths: &[String]) -> Items {
        Vec::new()
    }
    pub fn restore(_items: Items) -> Result<(), String> {
        Err("Restoring from Trash isn't supported on this platform".into())
    }
}

/// One reversible operation. Reverting only ever moves files back.
enum UndoOp {
    Rename { from: String, to: String },
    /// (original source, where it was moved to) pairs.
    Move { pairs: Vec<(String, String)> },
    Trash { items: restore::Items },
}

impl UndoOp {
    /// Apply the inverse; returns a short human description for a toast.
    fn revert(self) -> Result<String, String> {
        match self {
            UndoOp::Rename { from, to } => {
                if Path::new(&from).exists() {
                    return Err(format!("{} already exists", base_name(&from)));
                }
                std::fs::rename(&to, &from).map_err(|e| e.to_string())?;
                Ok(format!("Reverted rename of {}", base_name(&from)))
            }
            UndoOp::Move { pairs } => {
                for (src, dst) in pairs.iter().rev() {
                    if std::fs::rename(dst, src).is_err() {
                        copy_recursive(Path::new(dst), Path::new(src)).map_err(|e| e.to_string())?;
                        remove_path(Path::new(dst)).map_err(|e| e.to_string())?;
                    }
                }
                Ok(format!("Moved {} item{} back", pairs.len(), if pairs.len() == 1 { "" } else { "s" }))
            }
            UndoOp::Trash { items } => {
                let n = items.len();
                restore::restore(items)?;
                Ok(format!("Restored {} item{} from Trash", n, if n == 1 { "" } else { "s" }))
            }
        }
    }
}

#[derive(Default)]
pub struct UndoStack(Mutex<Vec<UndoOp>>);

impl UndoStack {
    fn push(&self, op: UndoOp) {
        let mut s = self.0.lock();
        s.push(op);
        let cap = 50;
        if s.len() > cap {
            let excess = s.len() - cap;
            s.drain(0..excess);
        }
    }
    fn pop(&self) -> Option<UndoOp> {
        self.0.lock().pop()
    }
}

fn base_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

/// Strip Windows' `\\?\` extended-length prefix that `canonicalize` adds, so
/// paths display (and round-trip) cleanly. UNC paths (e.g. WSL's
/// `\\wsl.localhost\Ubuntu-24.04`) come back as `\\?\UNC\server\share\…`, which
/// must fold back to `\\server\share\…` to stay navigable.
fn clean(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// List a directory (off the main thread).
#[tauri::command]
pub async fn fs_list(path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir(path: &str) -> Result<DirListing, String> {
    // Empty / "~" → home (the Files popout panel opens with no path on first use).
    let path = if path.is_empty() || path == "~" { home_dir() } else { path.to_string() };
    let path = path.as_str();
    // Canonicalize → absolute, `..`-resolved, existing. (Errors if it doesn't
    // exist, which is the right behavior.)
    let canon = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    let read = std::fs::read_dir(&canon).map_err(|e| format!("{}: {e}", clean(&canon)))?;

    let mut entries = Vec::new();
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        // Keep the initial listing cheap. `metadata()` is a per-entry stat and
        // can hang on cloud, shell, network, or removable-backed folders on
        // Windows. `file_type()` is usually supplied by the directory read.
        let ft = ent.file_type().ok();
        let symlink = ft.map(|t| t.is_symlink()).unwrap_or(false);
        let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
        let size = None;
        let modified = None;
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

/// Quick-access locations: home + its common subfolders, drive roots, and (on
/// Windows) installed WSL distributions.
#[tauri::command]
pub async fn fs_quick_locations() -> Vec<QuickLocation> {
    tauri::async_runtime::spawn_blocking(quick_locations).await.unwrap_or_default()
}

fn quick_locations() -> Vec<QuickLocation> {
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
    {
        for letter in b'A'..=b'Z' {
            let p = format!("{}:\\", letter as char);
            if Path::new(&p).is_dir() {
                out.push(QuickLocation { name: format!("{}:", letter as char), path: p, kind: "drive" });
            }
        }
        out.extend(wsl_distros());
    }
    #[cfg(not(windows))]
    if Path::new("/").is_dir() {
        out.push(QuickLocation { name: "/".into(), path: "/".into(), kind: "drive" });
    }
    out
}

/// Installed WSL distributions, reachable from Windows at
/// `\\wsl.localhost\<distro>`. Listed via `wsl.exe -l -q` (metadata only — does
/// not start a distro); resilient to the UTF-16LE/UTF-8 output quirk and any
/// BOM/NUL noise. Best-effort: any failure yields an empty list.
#[cfg(windows)]
fn wsl_distros() -> Vec<QuickLocation> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no flash of a console window

    let output = match std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };

    // wsl.exe historically emits UTF-16LE; newer builds emit UTF-8. Detect by
    // the density of NUL bytes (every other byte is 0 in UTF-16LE ASCII).
    let text = {
        let nul = output.iter().filter(|&&b| b == 0).count();
        if nul > output.len() / 4 {
            let u16s: Vec<u16> = output
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16s)
        } else {
            String::from_utf8_lossy(&output).into_owned()
        }
    };

    text.replace('\0', "")
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| QuickLocation {
            name: name.to_string(),
            path: format!(r"\\wsl.localhost\{name}"),
            kind: "linux",
        })
        .collect()
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
pub async fn fs_rename(undo: State<'_, UndoStack>, from: String, to: String) -> Result<(), String> {
    let (f, t) = (from.clone(), to.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let (fp, tp) = (Path::new(&f), Path::new(&t));
        if tp.exists() {
            return Err(format!("{} already exists", clean(tp)));
        }
        std::fs::rename(fp, tp).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    undo.push(UndoOp::Rename { from, to });
    Ok(())
}

/// Move each of `paths` into directory `dest`. Tries `rename`, falling back to
/// copy+delete across filesystems. Refuses to overwrite an existing target.
#[tauri::command]
pub async fn fs_move(undo: State<'_, UndoStack>, paths: Vec<String>, dest: String) -> Result<(), String> {
    let (paths2, dest2) = (paths.clone(), dest.clone());
    let pairs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(String, String)>, String> {
        let dest = Path::new(&dest2);
        let mut pairs = Vec::new();
        for src in &paths2 {
            let src_p = Path::new(src);
            let name = src_p.file_name().ok_or_else(|| format!("bad path: {}", clean(src_p)))?;
            let target = dest.join(name);
            if target == src_p {
                continue; // moving onto itself — no-op
            }
            if target.exists() {
                return Err(format!("{} already exists", clean(&target)));
            }
            if std::fs::rename(src_p, &target).is_err() {
                // Cross-device (or rename refused): copy then remove the source.
                copy_recursive(src_p, &target).map_err(|e| e.to_string())?;
                remove_path(src_p).map_err(|e| e.to_string())?;
            }
            pairs.push((src.clone(), clean(&target)));
        }
        Ok(pairs)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !pairs.is_empty() {
        undo.push(UndoOp::Move { pairs });
    }
    Ok(())
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

/// Send each of `paths` to the OS trash / recycle bin (recoverable + undoable).
#[tauri::command]
pub async fn fs_trash(undo: State<'_, UndoStack>, paths: Vec<String>) -> Result<(), String> {
    let items = tauri::async_runtime::spawn_blocking(move || -> Result<restore::Items, String> {
        trash::delete_all(&paths).map_err(|e| e.to_string())?;
        Ok(restore::capture(&paths))
    })
    .await
    .map_err(|e| e.to_string())??;
    if !items.is_empty() {
        undo.push(UndoOp::Trash { items });
    }
    Ok(())
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

/// Undo the last reversible op (rename / move / trash). Returns a description
/// for a toast, or `None` if nothing is left to undo.
#[tauri::command]
pub async fn fs_undo(undo: State<'_, UndoStack>) -> Result<Option<String>, String> {
    let Some(op) = undo.pop() else {
        return Ok(None);
    };
    let desc = tauri::async_runtime::spawn_blocking(move || op.revert())
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(desc))
}

/// Start (or replace) a live watch on `path` for the Files tab `id`. Emits
/// `flux://fs-changed` with the watched directory when its contents change.
#[tauri::command]
pub async fn fs_watch(app: AppHandle, watchers: State<'_, FsWatchers>, id: u64, path: String) -> Result<(), String> {
    let watcher = tauri::async_runtime::spawn_blocking(move || make_watcher(app, path))
        .await
        .map_err(|e| e.to_string())??;
    // Replacing drops the previous watcher, which stops the old watch.
    watchers.0.lock().insert(id, watcher);
    Ok(())
}

fn make_watcher(app: AppHandle, path: String) -> Result<notify::RecommendedWatcher, String> {
    use notify::Watcher;
    let emit_path = path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // Scope to the shell window — tab webviews never need (or, per ACL, can
        // receive) this, and it keeps the event off remote pages entirely.
        if res.is_ok() {
            let _ = app.emit_to("main", "flux://fs-changed", emit_path.clone());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

/// Stop watching for the Files tab `id` (on tab close / unmount).
#[tauri::command]
pub fn fs_unwatch(watchers: State<'_, FsWatchers>, id: u64) {
    watchers.0.lock().remove(&id);
}
