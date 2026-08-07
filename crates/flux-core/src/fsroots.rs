//! Where the agent is allowed to read (#176).
//!
//! Flux's file tools have always been as permissive as the process: `list`,
//! `read` and the PDF reader take any path and open it. That was a defensible
//! default while every byte the agent saw stayed on the machine — the model *is*
//! the user's, running on their GPU.
//!
//! Cloud escalation (ADR 0018) changed the stakes. A file the agent reads while
//! escalated is a file Google receives, and "the agent can read anything on this
//! machine" is a much larger sentence when the machine is a laptop with a
//! Windows partition full of everything else you own.
//!
//! So: an **opt-in** allowance. Off by default, because turning it on by fiat
//! would silently break reads people already rely on, and a security control
//! that surprises you is one you switch off. On, it confines the *agent's*
//! reads — not the Files tab, not the PDF viewer you drove yourself. The user
//! browsing their own disk was never the thing in question.
//!
//! ## The containment check
//!
//! Two things this must not get wrong, both of which a naïve string prefix does:
//!
//!   * **`..` escapes.** `~/notes/../../etc/shadow` starts with the allowed root
//!     as text and lands nowhere near it.
//!   * **Partial component matches.** `/home/me` must not admit `/home/melissa`.
//!     Comparison is per path component, never per character.
//!
//! Paths are canonicalised where the OS can do it, which also resolves symlinks
//! — a link out of an allowed root is an escape, and the resolved target is what
//! gets judged.

use std::path::{Component, Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The persisted allowance.
#[derive(Serialize, Deserialize, Clone, Default, specta::Type)]
pub struct AgentRoots {
    /// Off by default — see the module docs.
    pub enabled: bool,
    /// Directories the agent may read inside, recursively.
    pub roots: Vec<String>,
}

pub struct RootsStore {
    path: Option<PathBuf>,
    state: Mutex<AgentRoots>,
    loaded: std::sync::atomic::AtomicBool,
}

impl Default for RootsStore {
    fn default() -> Self {
        RootsStore {
            path: None,
            state: Mutex::new(AgentRoots::default()),
            loaded: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl RootsStore {
    pub fn empty(path: PathBuf) -> Self {
        RootsStore {
            path: Some(path),
            ..Default::default()
        }
    }

    fn hydrate(&self) {
        use std::sync::atomic::Ordering;
        if self.loaded.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(p) = &self.path else { return };
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<AgentRoots>(&s) {
                *self.state.lock() = v;
            }
        }
    }

    pub fn get(&self) -> AgentRoots {
        self.hydrate();
        self.state.lock().clone()
    }

    pub fn set(&self, next: AgentRoots) {
        self.hydrate();
        *self.state.lock() = next;
        if let Some(p) = &self.path {
            crate::persist::save_json_pretty(p, &*self.state.lock());
        }
    }

    /// Gate one path. `Ok(())` when the agent may read it.
    pub fn check(&self, path: &str) -> Result<(), String> {
        let cfg = self.get();
        if !cfg.enabled {
            return Ok(());
        }
        if cfg.roots.is_empty() {
            return Err(
                "the agent's file access is limited, but no folders are allowed yet — \
                 add one in Settings → Agent file access"
                    .into(),
            );
        }
        if cfg.roots.iter().any(|r| contains(r, path)) {
            return Ok(());
        }
        Err(format!(
            "{path} is outside the folders the agent may read. Allowed: {}. \
             Change this in Settings → Agent file access.",
            cfg.roots.join(", ")
        ))
    }
}

/// Resolve a path as far as the OS allows, then normalise what's left.
///
/// `canonicalize` is preferred because it resolves symlinks, but it fails on a
/// path that doesn't exist yet — and a *root* the user typed may legitimately be
/// gone. Falling back to lexical normalisation keeps the check working instead
/// of failing open.
fn resolve(p: &str) -> PathBuf {
    let expanded = expand_home(p);
    match std::fs::canonicalize(&expanded) {
        Ok(c) => strip_verbatim(c),
        Err(_) => lexical(Path::new(&expanded)),
    }
}

/// `~/x` → `$HOME/x`. The agent and the user both write `~`.
fn expand_home(p: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if home.is_empty() {
        return p.to_string();
    }
    if p == "~" {
        return home;
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return format!("{home}/{rest}");
    }
    p.to_string()
}

/// Drop Windows' `\\?\` extended-length prefix, so a canonicalised path compares
/// equal to one the user typed.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// Resolve `.` and `..` textually, without touching the filesystem.
///
/// A `..` that would climb past the root is dropped rather than kept, matching
/// what the kernel does at `/` — and meaning a crafted path can never end up
/// *shorter* than the root yet still compare as inside it.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Is `path` inside `root` (or the root itself)?
///
/// Component-wise, never a string prefix: `/home/me` must not admit
/// `/home/melissa`. Case-insensitive on Windows, where it genuinely is.
pub fn contains(root: &str, path: &str) -> bool {
    let (r, p) = (resolve(root), resolve(path));
    let (mut rc, mut pc) = (r.components(), p.components());
    loop {
        match (rc.next(), pc.next()) {
            // Root exhausted: everything it required matched, so `path` is at or
            // below it.
            (None, _) => return true,
            // Path exhausted first: it's a parent of the root, not inside it.
            (Some(_), None) => return false,
            (Some(a), Some(b)) => {
                let (a, b) = (a.as_os_str(), b.as_os_str());
                let same = if cfg!(windows) {
                    a.to_string_lossy()
                        .eq_ignore_ascii_case(&b.to_string_lossy())
                } else {
                    a == b
                };
                if !same {
                    return false;
                }
            }
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_roots_get(store: tauri::State<'_, RootsStore>) -> AgentRoots {
    store.get()
}

#[tauri::command]
pub fn agent_roots_set(store: tauri::State<'_, RootsStore>, roots: AgentRoots) {
    store.set(roots);
}

/// The places worth pre-filling the allowance with — the vault, scribe,
/// downloads and home. Deliberately **not** the drives: naming a drive is a
/// convenience, letting the agent read it is a decision.
#[tauri::command]
pub fn agent_roots_suggested(
    app: tauri::AppHandle,
    kb: tauri::State<'_, crate::kb::KbStore>,
) -> Vec<String> {
    crate::places::places(&app, kb.source_location("onyx").as_deref())
        .into_iter()
        // A drive is named by its single letter. Skipping them here is the whole
        // point: `c` is offered as a shorthand, not as an allowance.
        .filter(|p| p.name.chars().count() > 1)
        .map(|p| p.path)
        .collect()
}

// ─── Agent-scoped file reads ─────────────────────────────────────────────────
//
// The agent gets its own commands rather than a flag on the shared ones, so the
// gate cannot be bypassed by calling the ungated version — and so the Files tab
// and the PDF viewer, which are the *user* opening their own files, stay exactly
// as they were.

#[tauri::command]
pub async fn agent_fs_list(
    store: tauri::State<'_, RootsStore>,
    path: String,
) -> Result<crate::files::DirListing, String> {
    store.check(&path)?;
    crate::files::fs_list(path).await
}

#[tauri::command]
pub async fn agent_read_text_file(
    store: tauri::State<'_, RootsStore>,
    path: String,
) -> Result<String, String> {
    store.check(&path)?;
    crate::files::read_text_file(path).await
}

/// The agent's file write (the `edit` tool). Gated for the same reason as the
/// reads, and more so: this one changes the file. A path the agent may not read
/// is certainly not one it may overwrite.
#[tauri::command]
pub async fn agent_write_text_file(
    store: tauri::State<'_, RootsStore>,
    path: String,
    content: String,
) -> Result<(), String> {
    store.check(&path)?;
    crate::files::write_text_file(path, content).await
}

/// The agent's PDF read. `pdf_fetch` also serves `http(s)://`, which the gate has
/// no opinion about — only local paths are checked.
#[tauri::command]
pub async fn agent_pdf_fetch(
    store: tauri::State<'_, RootsStore>,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        store.check(&url)?;
    }
    crate::pdf::pdf_fetch(url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_contains_itself_and_its_children() {
        assert!(contains("/home/me", "/home/me"));
        assert!(contains("/home/me", "/home/me/notes"));
        assert!(contains("/home/me", "/home/me/a/b/c.pdf"));
    }

    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_inside() {
        // The bug a string `starts_with` would have: "/home/melissa" begins with
        // "/home/me" as text, and is a completely different person's files.
        assert!(!contains("/home/me", "/home/melissa"));
        assert!(!contains("/home/me", "/home/me2/x"));
        assert!(!contains("/mnt/c", "/mnt/certificates"));
    }

    #[test]
    fn dot_dot_cannot_climb_out() {
        assert!(!contains("/home/me", "/home/me/../other"));
        assert!(!contains("/home/me", "/home/me/notes/../../etc/shadow"));
        // …and a `..` that stays inside is still inside.
        assert!(contains("/home/me", "/home/me/a/../b"));
    }

    #[test]
    fn a_parent_of_the_root_is_not_inside_it() {
        assert!(!contains("/home/me/docs", "/home/me"));
        assert!(!contains("/home/me", "/"));
    }

    #[test]
    fn excess_dot_dot_cannot_underflow_into_a_match() {
        // Climbing past `/` must not leave a path so short it trivially matches.
        assert!(!contains("/home/me", "/../../../../etc/shadow"));
    }

    #[test]
    fn disabled_allows_everything_and_empty_allows_nothing() {
        let s = RootsStore::default();
        // Off: the historical behaviour, unchanged.
        assert!(s.check("/anywhere/at/all").is_ok());

        // On with nothing allowed is a misconfiguration, not a licence — and the
        // message has to say how to fix it rather than just refusing.
        s.set(AgentRoots {
            enabled: true,
            roots: vec![],
        });
        let err = s.check("/anywhere").unwrap_err();
        assert!(err.contains("Settings"), "{err}");
    }

    #[test]
    fn enabled_gates_on_the_allowed_roots() {
        let s = RootsStore::default();
        s.set(AgentRoots {
            enabled: true,
            roots: vec!["/home/me".into(), "/data/shared".into()],
        });
        assert!(s.check("/home/me/notes.md").is_ok());
        assert!(s.check("/data/shared/x").is_ok());

        let err = s.check("/mnt/c/Users/me/taxes.pdf").unwrap_err();
        // The refusal must name the path and the allowance, or the user can't
        // tell whether to fix the request or the setting.
        assert!(err.contains("taxes.pdf"), "{err}");
        assert!(err.contains("/home/me"), "{err}");
    }

    /// The one case that depends on the OS rather than on the arithmetic above:
    /// a symlink inside an allowed root pointing out of it. Lexical normalisation
    /// cannot see this — only `canonicalize` can — so it is worth a real
    /// filesystem.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_an_escape() {
        let base = std::env::temp_dir().join(format!("flux_roots_{}", std::process::id()));
        let inside = base.join("allowed");
        let outside = base.join("secret");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keys.txt"), "sensitive").unwrap();
        let link = inside.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let root = inside.to_string_lossy().into_owned();
        // A real file inside is fine…
        std::fs::write(inside.join("ok.txt"), "fine").unwrap();
        assert!(contains(&root, &inside.join("ok.txt").to_string_lossy()));
        // …and the same read *through* the symlink resolves outside, so it must
        // be refused even though the path text sits under the root.
        assert!(
            !contains(&root, &link.join("keys.txt").to_string_lossy()),
            "a symlink pointing out of the root must not be treated as inside it"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tilde_resolves_the_same_on_both_sides() {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        assert!(contains("~", &format!("{home}/x")));
        assert!(contains(&home, "~/x"));
    }
}
