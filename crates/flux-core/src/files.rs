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
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

/// One directory entry. Compact on purpose — see module docs.
#[derive(Serialize, specta::Type)]
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
#[derive(Serialize, specta::Type)]
pub struct DirListing {
    /// Canonical, display-clean directory path.
    pub path: String,
    /// Parent directory, or `None` at a filesystem root.
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// A pinned spot in the left rail.
#[derive(Serialize, specta::Type)]
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

// ─── WSL path bridge (Windows) ───────────────────────────────────────────────
//
// On the Windows build, a Unix-style path means the file lives in WSL — that is
// where a user who develops in WSL keeps everything, and `/home/me/notes` is
// what they type and what they paste to the agent. Windows' own filesystem APIs
// answer that with "The system cannot find the path specified. (os error 3)".
//
// `read_text_file` and `write_text_file` each grew their own `wsl.exe` shell-out
// for this. That was fine while they were the only two, and stopped being fine
// the moment the agent gained `list <dir>` and PDF reading: two more call sites
// meant two more copies, and the first one anybody forgot became this bug. So
// the bridge lives here once and every filesystem entry point goes through it.
//
// Everything below is `#[cfg(windows)]`. On Linux and macOS a Unix path IS the
// path, so there is nothing to bridge.

/// Does this path name something inside WSL rather than on Windows?
#[cfg(windows)]
pub(crate) fn is_wsl_path(p: &str) -> bool {
    p.starts_with('/') || p.starts_with('~')
}

/// Shell prelude every script here starts with: take the path from `$1` and
/// expand a leading `~` (which is the shell's job, and only happens for an
/// unquoted literal — an argument never expands on its own).
#[cfg(windows)]
const WSL_PRELUDE: &str = r#"p="$1"; case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/${p#\~/}";; esac; [ -n "$p" ] || { echo 'empty path' >&2; exit 2; }; "#;

/// Run one script inside WSL and return its raw stdout.
///
/// **The path is passed as an argument, never interpolated into the script.**
/// It used to be spliced in with hand-rolled quote escaping, and that is what
/// listed the wrong directory: `std::process::Command` quotes arguments by
/// MSVCRT rules, `wsl.exe` then re-parses the command line by its own, and the
/// inner quotes did not survive the round trip. `d=""; cd -- "$d"` succeeds and
/// stays exactly where it is — which is the Windows working directory, so the
/// listing came back full of files, plausible, and completely wrong.
///
/// `bash -c script name arg` puts `arg` in `$1` with no parsing of the path at
/// all. Nothing to escape means nothing to escape wrongly.
///
/// `-c`, not `-lc`: a login shell sources the user's profile, which is free to
/// print a banner or an motd, and everything here parses stdout — so that
/// output would become data. `$HOME` is set either way, and skipping profile
/// startup makes each call cheaper (this runs once per file when the agent
/// works through a folder).
#[cfg(windows)]
fn wsl_bash(script: &str, path_arg: &str, what: &str) -> Result<Vec<u8>, String> {
    let out = std::process::Command::new("wsl.exe")
        .args(["--", "bash", "-c", script, "flux", path_arg])
        .output()
        .map_err(|e| format!("couldn't reach {what} via WSL: {e}"))?;
    if !out.status.success() {
        let err: String = String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(160)
            .collect();
        return Err(format!("can't read {what}: {}", err.trim()));
    }
    Ok(out.stdout)
}

/// Read a file's **bytes** out of WSL.
///
/// Base64 in transit, deliberately: a PDF is binary, and piping raw bytes back
/// through `wsl.exe` is not guaranteed to survive intact (interop has been known
/// to translate line endings and, in some configurations, re-encode the stream).
/// `base64 -w0` is ASCII by construction, so there is nothing left to mangle.
#[cfg(windows)]
pub(crate) fn wsl_read_bytes(p: &str) -> Result<Vec<u8>, String> {
    let script = format!("{WSL_PRELUDE}base64 -w0 -- \"$p\"");
    let b64 = wsl_bash(&script, p, p)?;
    let b64: String = String::from_utf8_lossy(&b64).trim().to_string();
    base64_decode(&b64).ok_or_else(|| format!("can't read {p}: WSL returned malformed base64"))
}

/// Minimal standard-alphabet base64 decoder. Local to this bridge because the
/// only producer is the `base64 -w0` above — no padding quirks, no URL-safe
/// alphabet, no line wrapping to tolerate.
///
/// Deliberately **not** `#[cfg(windows)]` even though only Windows calls it:
/// it's the one piece of real logic in the bridge, and gating it would mean the
/// only decoder in the tree that could corrupt a PDF is also the only one the
/// test suite never runs.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        // Padding marks the end; everything before it must be a full quad.
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if chunk.len() < 4 && pad == 0 && !chunk.is_empty() {
            return None;
        }
        let mut acc = 0u32;
        for &c in chunk {
            acc = (acc << 6) | if c == b'=' { 0 } else { val(c)? };
        }
        let n = 3usize.saturating_sub(pad);
        for i in 0..n {
            out.push(((acc >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    Some(out)
}

/// List a WSL directory. `find -printf` rather than parsing `ls`: it emits
/// exactly the fields we want, tab-separated, and never tries to be readable.
#[cfg(windows)]
fn wsl_list_dir(p: &str) -> Result<DirListing, String> {
    // `find "$dir"` directly — deliberately NOT `cd "$dir" && find .`.
    //
    // That is what this did first, and it listed the wrong folder: `cd` to an
    // empty or unmoved target leaves the shell in whatever directory `wsl.exe`
    // started in (the Windows cwd, translated), so `find .` returned *that*,
    // with a zero exit status and a plausible-looking result. A listing of the
    // wrong directory that reports success is worse than an error — the agent
    // read it as the answer and kept going.
    //
    // Naming the directory in the command removes the cwd from the picture
    // entirely: if it's missing or not a directory, `find` fails and we say so.
    // Each check exits with its own status so a failure can't read as success.
    //
    // `%y` type (d/f/l), `%s` size, `%T@` mtime seconds, `%f` basename.
    // `-mindepth 1` excludes the directory itself, `-maxdepth 1` keeps it flat.
    let script = format!(
        "{WSL_PRELUDE}\
         r=$(realpath -- \"$p\") || exit 3; \
         [ -d \"$r\" ] || {{ echo \"not a directory: $r\" >&2; exit 4; }}; \
         printf 'FLUXDIR\\t%s\\n' \"$r\"; \
         find \"$r\" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'"
    );
    let raw = wsl_bash(&script, p, p)?;
    let text = String::from_utf8_lossy(&raw);

    // Find the marked line rather than trusting the first one: a shell profile
    // that prints a banner would otherwise become the directory path.
    let canon = text
        .lines()
        .find_map(|l| l.strip_prefix("FLUXDIR\t"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("can't list {p}: WSL returned no directory path"))?
        .to_string();

    let mut entries = Vec::new();
    for line in text.lines() {
        let mut f = line.split('\t');
        let (Some(ty), Some(size), Some(mtime), Some(name)) =
            (f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        // A type field is exactly one character; anything else is stray output.
        if ty.len() != 1 || f.next().is_some() {
            continue;
        }
        entries.push(FileEntry {
            name: name.to_string(),
            is_dir: ty == "d",
            symlink: ty == "l",
            size: size.parse().ok(),
            // `%T@` is float seconds; the wire format is epoch milliseconds.
            modified: mtime.parse::<f64>().ok().map(|s| (s * 1000.0) as u64),
        });
    }
    let parent = canon.rsplit_once('/').map(|(head, _)| {
        if head.is_empty() {
            "/".to_string()
        } else {
            head.to_string()
        }
    });
    Ok(DirListing {
        parent,
        path: canon,
        entries,
    })
}

/// Read a file's bytes from wherever it actually lives.
pub(crate) fn read_bytes_any(p: &str) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    if is_wsl_path(p) {
        return wsl_read_bytes(p);
    }
    #[cfg(not(windows))]
    let p = &expand_home(p);
    std::fs::read(p).map_err(|e| format!("can't read {p}: {e}"))
}

/// `~/x` → `$HOME/x`. Windows has its own expansion inside the WSL bridge.
#[cfg(not(windows))]
fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        std::env::var("HOME")
            .map(|h| format!("{h}/{rest}"))
            .unwrap_or_else(|_| p.to_string())
    } else {
        p.to_string()
    }
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
/// Android is unix-but-not-macos, so it must be excluded explicitly or it would
/// wrongly pull the `trash` crate (which doesn't build for Android — ADR 0012).
#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    )
))]
mod restore {
    use std::collections::HashSet;
    use std::path::PathBuf;

    pub type Items = Vec<trash::TrashItem>;

    /// Capture the just-trashed items so they can be restored later: match the
    /// trash listing against the original paths, newest-first, de-duped.
    pub fn capture(paths: &[String]) -> Items {
        let want: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let mut items = trash::os_limited::list().unwrap_or_default();
        items.sort_by_key(|e| std::cmp::Reverse(e.time_deleted));
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
#[cfg(not(any(
    target_os = "windows",
    all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    )
)))]
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
    Rename {
        from: String,
        to: String,
    },
    /// (original source, where it was moved to) pairs.
    Move {
        pairs: Vec<(String, String)>,
    },
    Trash {
        items: restore::Items,
    },
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
                        copy_recursive(Path::new(dst), Path::new(src))
                            .map_err(|e| e.to_string())?;
                        remove_path(Path::new(dst)).map_err(|e| e.to_string())?;
                    }
                }
                Ok(format!(
                    "Moved {} item{} back",
                    pairs.len(),
                    if pairs.len() == 1 { "" } else { "s" }
                ))
            }
            UndoOp::Trash { items } => {
                let n = items.len();
                restore::restore(items)?;
                Ok(format!(
                    "Restored {} item{} from Trash",
                    n,
                    if n == 1 { "" } else { "s" }
                ))
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
    let path = if path.is_empty() || path == "~" {
        home_dir()
    } else {
        path.to_string()
    };
    let path = path.as_str();
    // A Unix path on Windows lives in WSL — listing it with Windows' own APIs
    // gives "The system cannot find the path specified", which is exactly the
    // wall the agent hit the first time it was asked to look in `/home/…`.
    #[cfg(windows)]
    if is_wsl_path(path) {
        return wsl_list_dir(path);
    }
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
        entries.push(FileEntry {
            name,
            is_dir,
            symlink,
            size,
            modified,
        });
    }

    Ok(DirListing {
        parent: canon.parent().map(clean),
        path: clean(&canon),
        entries,
    })
}

/// One frame of a streamed directory listing (#86). Sent over a Channel so a
/// pathological directory (100k+ entries) is delivered in chunks instead of one
/// giant JSON payload that stalls the UI. Hand-mirrored in `ipc.ts`.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ListMsg {
    /// Sent first, once the directory opens — lets the UI set cwd / watch before
    /// any entries arrive.
    Head {
        path: String,
        parent: Option<String>,
    },
    /// A batch of up to `LIST_CHUNK` entries.
    Entries { entries: Vec<FileEntry> },
    /// Sent last: how many entries were streamed in total.
    Done { total: usize },
    /// Listing failed (canonicalize / read_dir). The command still resolves `Ok`.
    Error { message: String },
}

/// Entries per streamed chunk. Big enough that small/medium dirs arrive in one
/// or two frames, small enough that no single payload is huge.
const LIST_CHUNK: usize = 2000;

/// Stream a directory listing in chunks over a Channel (#86): a `Head` frame,
/// then `Entries` frames of up to `LIST_CHUNK`, then `Done`. Reads the directory
/// exactly once (no per-page re-scan). Replaces the single-payload `fs_list` for
/// the explorer's main load path; `fs_list` stays for callers that want it whole.
#[tauri::command]
pub async fn fs_list_stream(path: String, on_msg: Channel<ListMsg>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(message) = stream_dir(&path, &on_msg) {
            let _ = on_msg.send(ListMsg::Error { message });
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn stream_dir(path: &str, on_msg: &Channel<ListMsg>) -> Result<(), String> {
    let path = if path.is_empty() || path == "~" {
        home_dir()
    } else {
        path.to_string()
    };
    let canon = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let read = std::fs::read_dir(&canon).map_err(|e| format!("{}: {e}", clean(&canon)))?;

    on_msg
        .send(ListMsg::Head {
            path: clean(&canon),
            parent: canon.parent().map(clean),
        })
        .map_err(|e| e.to_string())?;

    let mut chunk: Vec<FileEntry> = Vec::with_capacity(LIST_CHUNK);
    let mut total = 0usize;
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let ft = ent.file_type().ok();
        chunk.push(FileEntry {
            name,
            is_dir: ft.map(|t| t.is_dir()).unwrap_or(false),
            symlink: ft.map(|t| t.is_symlink()).unwrap_or(false),
            size: None,
            modified: None,
        });
        total += 1;
        if chunk.len() >= LIST_CHUNK {
            let batch = std::mem::replace(&mut chunk, Vec::with_capacity(LIST_CHUNK));
            on_msg
                .send(ListMsg::Entries { entries: batch })
                .map_err(|e| e.to_string())?;
        }
    }
    if !chunk.is_empty() {
        on_msg
            .send(ListMsg::Entries { entries: chunk })
            .map_err(|e| e.to_string())?;
    }
    on_msg
        .send(ListMsg::Done { total })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One recursive-search hit (#88). Carries the full path (search results span many
/// directories). Not specta-generated — the frontend has a matching hand-written type.
#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Heavy build/VCS dirs we never descend into during search — they're huge and
/// rarely what the user is looking for.
const SEARCH_SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "venv",
    ".venv",
    "__pycache__",
];

/// Recursively search filenames under `root` for a case-insensitive substring.
/// Bounded (hit cap, depth cap, visited-node budget) so a huge tree can't hang the
/// UI; skips hidden + heavy dirs and never follows symlinked dirs (loop-safe).
#[tauri::command]
pub async fn fs_search(
    root: String,
    query: String,
    limit: usize,
    semantic: bool,
) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut hits = search_tree(&root, &query, limit.clamp(1, 2000))?;
        if semantic && hits.len() > 1 {
            semantic_rerank(&query, &mut hits);
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-order the top fuzzy hits by semantic similarity of the **filename** to the
/// query (#88/#11). No-op unless the real (model) embedder is live — the hashing
/// fallback isn't semantic. Fuzzy stays the base so exact matches don't sink;
/// semantic nudges within the pool. Note: this only *re-orders* subsequence
/// matches; true intent search (a query finding a differently-named file) would
/// need a pre-built file-embedding index.
fn semantic_rerank(query: &str, hits: &mut Vec<SearchHit>) {
    use crate::embedding::{cosine, current, embed_batch, Embedder};
    if !matches!(current(), Embedder::Model) {
        return;
    }
    let pool = hits.len().min(60); // bound the embed cost (one batched call)
                                   // One batched call: [query, name0, name1, …].
    let mut inputs = Vec::with_capacity(pool + 1);
    inputs.push(query.to_string());
    inputs.extend(hits[..pool].iter().map(|h| h.name.clone()));
    let Some(vecs) = embed_batch(&inputs, Embedder::Model) else {
        return;
    };
    if vecs.len() != pool + 1 {
        return;
    }
    let qv = &vecs[0];
    // Blend: preserve fuzzy order as a descending base, let semantic shift an item
    // by up to ~half the pool. Higher = better.
    let mut scored: Vec<(f32, SearchHit)> = hits
        .drain(..pool)
        .enumerate()
        .map(|(i, h)| {
            let fuzzy_base = (pool - i) as f32;
            let sem = cosine(qv, &vecs[i + 1]).max(0.0);
            (fuzzy_base + sem * pool as f32 * 0.5, h)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let reranked: Vec<SearchHit> = scored.into_iter().map(|(_, h)| h).collect();
    hits.splice(0..0, reranked);
}

/// Fuzzy subsequence score (fzf-style): `None` if the query's chars don't all
/// appear in order, else a score where higher = better (start / word-boundary /
/// contiguous-run bonuses, shorter name preferred). Both args must be lowercased.
fn fuzzy_score(needle: &str, hay: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let h: Vec<char> = hay.chars().collect();
    let mut score = 0i32;
    let mut hi = 0usize;
    let mut prev: Option<usize> = None;
    for nc in needle.chars() {
        let pos = (hi..h.len()).find(|&i| h[i] == nc)?;
        if pos == 0 {
            score += 18; // start of the name
        } else if !h[pos - 1].is_alphanumeric() {
            score += 12; // right after a separator (word boundary)
        }
        if prev == Some(pos.wrapping_sub(1)) {
            score += 8; // contiguous with the previous match
        }
        score += 2;
        prev = Some(pos);
        hi = pos + 1;
    }
    score -= (h.len() as i32) / 8; // mild shorter-is-better
    Some(score)
}

fn search_tree(root: &str, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let root = if root.is_empty() || root == "~" {
        home_dir()
    } else {
        root.to_string()
    };
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let canon = std::fs::canonicalize(&root).map_err(|e| format!("{root}: {e}"))?;
    const MAX_DEPTH: usize = 12;
    const MAX_VISIT: usize = 200_000;
    const CANDIDATE_CAP: usize = 4000; // collect more than `limit`, then rank + trim
    let mut scored: Vec<(i32, SearchHit)> = Vec::new();
    let mut stack = vec![(canon, 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if scored.len() >= CANDIDATE_CAP || visited >= MAX_VISIT {
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in read.flatten() {
            visited += 1;
            let name = ent.file_name().to_string_lossy().into_owned();
            let ft = ent.file_type().ok();
            let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
            let is_link = ft.map(|t| t.is_symlink()).unwrap_or(false);
            if let Some(score) = fuzzy_score(&q, &name.to_ascii_lowercase()) {
                scored.push((
                    score,
                    SearchHit {
                        path: clean(&ent.path()),
                        name: name.clone(),
                        is_dir,
                    },
                ));
            }
            if is_dir
                && !is_link
                && depth < MAX_DEPTH
                && !name.starts_with('.')
                && !SEARCH_SKIP.contains(&name.as_str())
            {
                stack.push((ent.path(), depth + 1));
            }
        }
    }
    // Best score first; ties keep discovery order (stable sort).
    scored.sort_by_key(|e| std::cmp::Reverse(e.0));
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, h)| h).collect())
}

#[tauri::command]
pub fn fs_home() -> String {
    home_dir()
}

/// Quick-access locations: home + its common subfolders, drive roots, and (on
/// Windows) installed WSL distributions.
#[tauri::command]
pub async fn fs_quick_locations() -> Vec<QuickLocation> {
    tauri::async_runtime::spawn_blocking(quick_locations)
        .await
        .unwrap_or_default()
}

fn quick_locations() -> Vec<QuickLocation> {
    let mut out = Vec::new();
    let home = home_dir();
    out.push(QuickLocation {
        name: "Home".into(),
        path: home.clone(),
        kind: "home",
    });
    for sub in ["Desktop", "Documents", "Downloads"] {
        let p = format!("{home}/{sub}");
        if Path::new(&p).is_dir() {
            out.push(QuickLocation {
                name: sub.into(),
                path: p,
                kind: "folder",
            });
        }
    }
    #[cfg(windows)]
    {
        out.extend(windows_drives());
        out.extend(wsl_distros());
    }
    #[cfg(not(windows))]
    if Path::new("/").is_dir() {
        out.push(QuickLocation {
            name: "/".into(),
            path: "/".into(),
            kind: "drive",
        });
    }
    out
}

/// Mounted Windows drive letters. Uses Win32's logical-drive bitmask rather than
/// probing every `A:\`..`Z:\` path with filesystem metadata calls.
#[cfg(windows)]
fn windows_drives() -> Vec<QuickLocation> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let path = format!("{letter}:\\");
        let wide: Vec<u16> = OsStr::new(&path).encode_wide().chain(Some(0)).collect();
        let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
        let label = match drive_type {
            DRIVE_REMOVABLE => format!("{}: Removable", letter),
            DRIVE_REMOTE => format!("{}: Network", letter),
            DRIVE_CDROM => format!("{}: Disc", letter),
            DRIVE_RAMDISK => format!("{}: RAM disk", letter),
            DRIVE_FIXED => format!("{}:", letter),
            _ => continue,
        };
        out.push(QuickLocation {
            name: label,
            path,
            kind: "drive",
        });
    }
    out
}

/// Installed WSL distributions, reachable from Windows at
/// `\\wsl.localhost\<distro>`. Prefer Explorer's UNC provider, then fall back to
/// `wsl.exe -l -q`; resilient to UTF-16LE/UTF-8 output and BOM/NUL noise.
#[cfg(windows)]
fn wsl_distros() -> Vec<QuickLocation> {
    use std::collections::HashSet;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no flash of a console window

    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // Prefer the UNC provider because it matches what Explorer exposes and
    // works even when `wsl.exe` is unavailable from PATH. `wsl$` is the older
    // alias, kept as a fallback for older Windows installs.
    for root in [r"\\wsl.localhost\", r"\\wsl$\"] {
        if let Ok(read) = std::fs::read_dir(root) {
            for ent in read.flatten() {
                let name = ent.file_name().to_string_lossy().into_owned();
                if name.is_empty() || !seen.insert(name.to_ascii_lowercase()) {
                    continue;
                }
                out.push(QuickLocation {
                    name,
                    path: clean(&ent.path()),
                    kind: "linux",
                });
            }
        }
    }
    if !out.is_empty() {
        return out;
    }

    let output = match std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => {
            return vec![
                QuickLocation {
                    name: "WSL".into(),
                    path: r"\\wsl.localhost\".into(),
                    kind: "linux",
                },
                QuickLocation {
                    name: "WSL (legacy)".into(),
                    path: r"\\wsl$\".into(),
                    kind: "linux",
                },
            ];
        }
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

    out.extend(
        text.replace('\0', "")
            .trim_start_matches('\u{feff}')
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .filter(|name| seen.insert(name.to_ascii_lowercase()))
            .map(|name| QuickLocation {
                name: name.to_string(),
                path: format!(r"\\wsl.localhost\{name}"),
                kind: "linux",
            }),
    );
    if out.is_empty() {
        out.push(QuickLocation {
            name: "WSL".into(),
            path: r"\\wsl.localhost\".into(),
            kind: "linux",
        });
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
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
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
pub async fn fs_move(
    undo: State<'_, UndoStack>,
    paths: Vec<String>,
    dest: String,
) -> Result<(), String> {
    let (paths2, dest2) = (paths.clone(), dest.clone());
    let pairs =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(String, String)>, String> {
            let dest = Path::new(&dest2);
            let mut pairs = Vec::new();
            for src in &paths2 {
                let src_p = Path::new(src);
                let name = src_p
                    .file_name()
                    .ok_or_else(|| format!("bad path: {}", clean(src_p)))?;
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
            let name = src
                .file_name()
                .ok_or_else(|| format!("bad path: {}", clean(src)))?;
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
        #[cfg(desktop)]
        {
            trash::delete_all(&paths).map_err(|e| e.to_string())?;
            Ok(restore::capture(&paths))
        }
        // Android has no freedesktop/Windows recycle bin the `trash` crate can
        // reach (ADR 0012); erring keeps this recoverable-by-design rather than
        // silently permanent-deleting. `fs_delete` is the explicit hard delete.
        #[cfg(mobile)]
        {
            let _ = paths;
            Err("Moving to Trash isn't supported on this platform".to_string())
        }
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
pub async fn fs_watch(
    app: AppHandle,
    watchers: State<'_, FsWatchers>,
    id: u64,
    path: String,
) -> Result<(), String> {
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

/// An attachment read from a file path (a file dragged from the explorer into the
/// agent panel). Images come back base64 + a `data_url` for the thumbnail; text/
/// code files come back as `text`.
#[derive(Serialize)]
pub struct DroppedAttachment {
    pub kind: String, // "image" | "text"
    pub name: String,
    pub b64: String,
    pub text: String,
    pub data_url: String,
}

/// Read a dropped file for the agent panel (#115). Images → base64; text → text;
/// other binaries are declined. 20 MB cap, matching the 📎 upload path.
#[tauri::command]
pub async fn attachment_read(path: String) -> Result<DroppedAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let p = Path::new(&path);
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let meta = std::fs::metadata(p).map_err(|e| format!("can't read {name}: {e}"))?;
        if meta.len() > 20 * 1024 * 1024 {
            return Err(format!("{name} is too large (max 20 MB)"));
        }
        let image_mime = match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            "bmp" => Some("image/bmp"),
            _ => None,
        };
        let is_text = matches!(
            ext.as_str(),
            "txt"
                | "md"
                | "markdown"
                | "json"
                | "jsonc"
                | "csv"
                | "tsv"
                | "log"
                | "yaml"
                | "yml"
                | "toml"
                | "ini"
                | "xml"
                | "html"
                | "htm"
                | "css"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "rs"
                | "py"
                | "go"
                | "java"
                | "c"
                | "cpp"
                | "h"
                | "sh"
                | "sql"
                | "rb"
                | "php"
                | "swift"
                | "kt"
        );
        let bytes = std::fs::read(p).map_err(|e| format!("can't read {name}: {e}"))?;
        if let Some(mime) = image_mime {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let data_url = format!("data:{mime};base64,{b64}");
            Ok(DroppedAttachment {
                kind: "image".into(),
                name,
                b64,
                text: String::new(),
                data_url,
            })
        } else if is_text {
            Ok(DroppedAttachment {
                kind: "text".into(),
                name,
                b64: String::new(),
                text: String::from_utf8_lossy(&bytes).into_owned(),
                data_url: String::new(),
            })
        } else {
            Err(format!(
                "can't attach {name} — only images and text files are supported"
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a text file's content for the agent's context ("read src/foo.rs"). Handles
/// WSL/unix paths on a Windows build (reads via `wsl.exe cat`, expanding `~`), and
/// Windows / `\\wsl.localhost` paths via std::fs. Capped so it doesn't blow the
/// prompt; returns the text (with a truncation note if it was long).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = path.trim();
        if p.is_empty() {
            return Err("no file path given".into());
        }
        let raw: String = read_text_raw(p)?;
        const CAP: usize = 60_000;
        if raw.chars().count() > CAP {
            let head: String = raw.chars().take(CAP).collect();
            Ok(format!("{head}\n…(truncated; {} bytes total)", raw.len()))
        } else {
            Ok(raw)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a file as text from wherever it lives. Both platforms go through the one
/// byte reader (which owns the WSL bridge on Windows); the only difference left
/// is that text is lossy-decoded and bytes aren't.
fn read_text_raw(p: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_bytes_any(p)?).into_owned())
}

/// Write a text file (overwrites). WSL-aware on Windows for unix paths. Only called
/// after the user approves an edit diff in the agent panel.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = path.trim();
        if p.is_empty() {
            return Err("no file path given".into());
        }
        write_text_raw(p, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn write_text_raw(p: &str, content: &str) -> Result<(), String> {
    use std::io::Write as _;
    if is_wsl_path(p) {
        // Same argument-not-interpolation rule as the readers, and for the same
        // reason: a mangled quote here wouldn't list the wrong directory, it
        // would write the user's file to the wrong place — or to a path that
        // is empty, which `cat >` turns into an ambiguous-redirect failure at
        // best. This runs on an approved edit, so it must land where promised.
        let script = format!("{WSL_PRELUDE}cat > \"$p\"");
        let mut child = std::process::Command::new("wsl.exe")
            .args(["--", "bash", "-c", &script, "flux", p])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("couldn't write {p} via WSL: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        let status = child.wait().map_err(|e| e.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("WSL write of {p} failed"))
        };
    }
    std::fs::write(p, content).map_err(|e| format!("can't write {p}: {e}"))
}

#[cfg(not(windows))]
fn write_text_raw(p: &str, content: &str) -> Result<(), String> {
    let expanded = if let Some(rest) = p.strip_prefix("~/") {
        std::env::var("HOME")
            .map(|h| format!("{h}/{rest}"))
            .unwrap_or_else(|_| p.to_string())
    } else {
        p.to_string()
    };
    std::fs::write(&expanded, content).map_err(|e| format!("can't write {p}: {e}"))
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn recursive_search_matches_and_skips() {
        // Build a small tree in a unique temp dir.
        let base = std::env::temp_dir().join(format!("flux_search_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        std::fs::write(base.join("alpha.txt"), b"x").unwrap();
        std::fs::write(base.join("sub/ALPHA_two.md"), b"x").unwrap();
        std::fs::write(base.join("sub/deep/beta.rs"), b"x").unwrap();
        std::fs::write(base.join("node_modules/pkg/alpha_dep.js"), b"x").unwrap();

        std::fs::write(base.join("MyConfigFile.json"), b"x").unwrap();

        let root = base.to_string_lossy().into_owned();
        let hits = search_tree(&root, "alpha", 100).unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        // Case-insensitive, recurses into normal subdirs…
        assert!(names.contains(&"alpha.txt"));
        assert!(names.contains(&"ALPHA_two.md"));
        // …but never descends node_modules.
        assert!(!names.iter().any(|n| n.contains("alpha_dep")));
        // A non-matching query is empty; a blank query returns nothing.
        assert!(search_tree(&root, "zzzznope", 100).unwrap().is_empty());
        assert!(search_tree(&root, "   ", 100).unwrap().is_empty());
        // Limit is honored.
        assert!(search_tree(&root, "a", 1).unwrap().len() <= 1);
        // Fuzzy subsequence: "mcf" matches MyConfigFile (non-contiguous).
        let fuzzy = search_tree(&root, "mcf", 100).unwrap();
        assert!(fuzzy.iter().any(|h| h.name == "MyConfigFile.json"));
        // The best fuzzy match ranks first: "config" → MyConfigFile, not alpha files.
        let cfg = search_tree(&root, "config", 100).unwrap();
        assert_eq!(
            cfg.first().map(|h| h.name.as_str()),
            Some("MyConfigFile.json")
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod wsl_bridge_tests {
    use super::base64_decode;

    /// The bridge ships a PDF through `base64 -w0`, so a decoder bug is a
    /// silently corrupted document rather than an error. These run on every
    /// platform even though only Windows calls the decoder.
    #[test]
    fn decodes_the_three_padding_cases() {
        // 3n bytes (no padding), 3n+1 ("=="), 3n+2 ("=") — the boundaries where
        // a hand-rolled decoder gets the tail length wrong.
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert_eq!(base64_decode("YWI=").unwrap(), b"ab");
        assert_eq!(base64_decode("").unwrap(), b"");
    }

    #[test]
    fn round_trips_arbitrary_bytes_including_a_pdf_header() {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let encode = |data: &[u8]| -> String {
            let mut s = String::new();
            for c in data.chunks(3) {
                let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                for i in 0..4 {
                    if i <= c.len() {
                        s.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
                    } else {
                        s.push('=');
                    }
                }
            }
            s
        };
        // Every byte value, so a sign-extension or lookup slip shows up.
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(base64_decode(&encode(&all)).unwrap(), all);
        let pdf = b"%PDF-1.7\n\x01\x02\xff\xfe binary \x00 bytes";
        assert_eq!(base64_decode(&encode(pdf)).unwrap(), pdf);
    }

    #[test]
    fn rejects_garbage_rather_than_returning_half_a_file() {
        assert!(base64_decode("not base64!").is_none());
        assert!(base64_decode("YWJ").is_none()); // truncated quad, no padding
    }

    #[test]
    fn tolerates_whitespace() {
        // `-w0` shouldn't wrap, but a stray newline from the shell must not
        // corrupt the payload.
        assert_eq!(base64_decode("YWJj\n").unwrap(), b"abc");
        assert_eq!(base64_decode("YWJj YWJj").unwrap(), b"abcabc");
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    /// `stream_dir` should send Head, then chunked Entries summing to the file
    /// count, then a Done carrying that same total (#86).
    #[test]
    fn streams_head_chunks_then_done() {
        let base = std::env::temp_dir().join(format!("flux_stream_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // One more than a chunk so we exercise the multi-frame path.
        let n = LIST_CHUNK + 7;
        for i in 0..n {
            std::fs::write(base.join(format!("f{i:05}.txt")), b"x").unwrap();
        }

        let frames: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = frames.clone();
        let chan: Channel<ListMsg> = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                sink.lock().push(serde_json::from_str(&s).unwrap());
            }
            Ok(())
        });

        stream_dir(&base.to_string_lossy(), &chan).unwrap();
        let frames = frames.lock();

        assert_eq!(frames.first().unwrap()["kind"], "head");
        assert_eq!(frames.last().unwrap()["kind"], "done");
        assert_eq!(frames.last().unwrap()["total"], n);

        let streamed: usize = frames
            .iter()
            .filter(|f| f["kind"] == "entries")
            .map(|f| f["entries"].as_array().unwrap().len())
            .sum();
        assert_eq!(streamed, n);
        // No single chunk exceeds the cap.
        assert!(frames
            .iter()
            .filter(|f| f["kind"] == "entries")
            .all(|f| f["entries"].as_array().unwrap().len() <= LIST_CHUNK));

        let _ = std::fs::remove_dir_all(&base);
    }
}
