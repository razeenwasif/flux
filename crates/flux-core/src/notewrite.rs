//! Applying the agent's proposed note writes (#108).
//!
//! **Two commands, on purpose.** `note_plan` asks the model what to write and
//! returns a proposal; `note_apply` takes a proposal and writes it. Nothing
//! joins them in the backend. There is therefore no path by which a model's
//! output reaches the user's vault without passing through their approval — not
//! a policy that could be forgotten, a missing edge in the call graph.
//!
//! **Additive only, enforced twice.** [`flux_agent::NoteAction`] has no variant
//! that replaces or deletes; this layer additionally never opens a file for
//! truncation and never rewrites an existing page's prose. Appending is the
//! most destructive operation here, and appending cannot lose text.
//!
//! **Targets are validated against reality, not trusted.** The model is told
//! which notes exist, but a generated path is still checked to be inside the
//! vault and to already exist before anything is written — otherwise "append to
//! ../../.bashrc" would be a working instruction.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flux_agent::NoteAction;
use tauri::{Manager as _, State};

use crate::kbfresh::KbFreshness;

/// How much of the vault/notebook listing the model is shown. Enough to append
/// to the right note in a real vault; bounded so the prompt can't be dominated
/// by a listing on a big one.
const TARGET_LINES: usize = 120;

/// A proposal, plus everything the confirmation card needs to show it.
#[derive(serde::Serialize, specta::Type)]
pub struct NoteProposal {
    pub action: NoteAction,
    /// One-line summary for the card header.
    pub summary: String,
    /// Exactly what would be written, so the user approves content rather than
    /// a description of content.
    pub body: Option<String>,
    /// Whether this would touch anything at all.
    pub writes: bool,
}

/// Ask the model what to write. **Never writes.**
#[tauri::command]
pub async fn note_plan(
    app: tauri::AppHandle,
    kb: State<'_, crate::kb::KbStore>,
    state: State<'_, crate::state::FluxState>,
    request: String,
    context: Option<String>,
) -> Result<NoteProposal, String> {
    let targets = existing_targets(&app, kb.source_location("onyx").as_deref());
    // "note this page" is the obvious request, so fall back to the active page's
    // text. Pulled here rather than shipped in from the frontend: it's already
    // in the DOM cache, and a round trip would put the whole page through IPC.
    let context = context.or_else(|| {
        state
            .active_snapshot()
            .map(|s| s.text.to_string())
            .filter(|t| t.trim().len() >= 200)
    });
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_note(&request, &targets, context.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(NoteProposal {
        summary: action.describe(),
        body: action.body().map(str::to_string),
        writes: action.writes(),
        action,
    })
}

/// Apply an approved proposal. Called only after the user confirms.
#[tauri::command]
pub async fn note_apply(
    app: tauri::AppHandle,
    kb: State<'_, crate::kb::KbStore>,
    fresh: State<'_, Arc<KbFreshness>>,
    action: NoteAction,
) -> Result<String, String> {
    let vault = kb.source_location("onyx");
    let fresh = Arc::clone(&fresh);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || apply(&handle, vault.as_deref(), &fresh, action))
        .await
        .map_err(|e| e.to_string())?
}

fn apply(
    app: &tauri::AppHandle,
    vault: Option<&str>,
    fresh: &KbFreshness,
    action: NoteAction,
) -> Result<String, String> {
    match action {
        NoteAction::Nothing { reason } => Err(format!("nothing to write: {reason}")),

        NoteAction::NewNote {
            title,
            body,
            folder,
            tags,
        } => {
            let path = crate::kb::write_onyx_note(
                vault,
                &title,
                &body,
                folder.as_deref(),
                tags.as_deref(),
            )?;
            fresh.touch("onyx");
            Ok(path)
        }

        NoteAction::AppendNote { path, body } => {
            let root = crate::kb::onyx_vault(vault)
                .ok_or("Set your Onyx vault path in the Notebook panel first")?;
            let target = resolve_in_vault(&root, &path)?;
            append_to_file(&target, &body)?;
            fresh.touch("onyx");
            Ok(target.display().to_string())
        }

        NoteAction::NewPage {
            notebook,
            title,
            body,
        } => {
            let store = app
                .try_state::<crate::scribe::ScribeStore>()
                .ok_or("Scribe isn't available")?;
            let mut nb = store.load(&notebook).ok_or("no such notebook")?;
            nb.pages.push(crate::scribe::Page::document(&title, &body));
            let id = nb.id.clone();
            store.save(nb);
            fresh.touch("scribe");
            Ok(format!("flux://scribe#{id}"))
        }

        NoteAction::AppendPage {
            notebook,
            page,
            body,
        } => {
            let store = app
                .try_state::<crate::scribe::ScribeStore>()
                .ok_or("Scribe isn't available")?;
            let mut nb = store.load(&notebook).ok_or("no such notebook")?;
            let target = nb
                .pages
                .iter_mut()
                .find(|p| p.id == page)
                .ok_or("no such page in that notebook")?;
            crate::scribe::append_prose(target, &body)?;
            let id = nb.id.clone();
            store.save(nb);
            fresh.touch("scribe");
            Ok(format!("flux://scribe#{id}"))
        }
    }
}

/// Resolve a model-supplied path inside the vault, or refuse.
///
/// The model is *told* which notes exist, but "told" is not a control: a
/// generated `../../.ssh/config` would otherwise be a working instruction, and
/// so would an absolute path to anywhere on disk. The resolved path must stay
/// under the vault root and must already exist — appending is for notes that
/// are there, and creating goes through `NewNote`, which builds its own path.
fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return Err("no note path given".into());
    }
    let joined = root.join(rel);
    // Canonicalize *both* sides: symlinks and `..` only resolve on a real path,
    // and comparing strings before that check is how traversal guards fail.
    let real = joined
        .canonicalize()
        .map_err(|_| format!("no such note in your vault: {rel}"))?;
    let real_root = root
        .canonicalize()
        .map_err(|e| format!("vault unreadable: {e}"))?;
    if !real.starts_with(&real_root) {
        return Err(format!("{rel} is outside your vault"));
    }
    if real
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case("md"))
    {
        return Err("only markdown notes can be appended to".into());
    }
    Ok(real)
}

/// Append, with a blank line so the addition reads as its own paragraph.
///
/// `append(true)` rather than read-modify-write: there is no code path here
/// that can truncate a note, even if the write fails halfway.
fn append_to_file(path: &Path, body: &str) -> Result<(), String> {
    let body = body.trim_end();
    if body.is_empty() {
        return Err("nothing to append".into());
    }
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("couldn't open {}: {e}", path.display()))?;
    write!(f, "\n\n{body}\n").map_err(|e| format!("couldn't append: {e}"))
}

/// A compact listing of what exists, so the model appends to real targets.
fn existing_targets(app: &tauri::AppHandle, vault: Option<&str>) -> String {
    // The vault's own folders, first. Without them the model saw a flat list of
    // note *files* and had nothing to match "save it under 00 - Optimization"
    // against, so `new_note`'s folder came back null and the note landed at the
    // vault root — or it invented a folder name close to but not the user's.
    let mut out = crate::places::describe(&crate::places::places(app, vault));
    if !out.is_empty() {
        out.push_str(
            "Use a folder name from the list verbatim when the user names one. Do not invent \
             folders that aren't listed.\n\n",
        );
    }
    if let Some(root) = crate::kb::onyx_vault(vault) {
        out.push_str("Onyx notes (path — append_note uses these):\n");
        let mut n = 0;
        for p in crate::kb::onyx_note_paths(&root) {
            if n >= TARGET_LINES {
                out.push_str("  …\n");
                break;
            }
            out.push_str(&format!("  {p}\n"));
            n += 1;
        }
        if n == 0 {
            out.push_str("  (none yet)\n");
        }
    }
    if let Some(store) = app.try_state::<crate::scribe::ScribeStore>() {
        out.push_str("\nScribe notebooks (id — name):\n");
        for meta in store.list() {
            out.push_str(&format!("  {} — {}\n", meta.id, meta.name));
            if let Some(nb) = store.load(&meta.id) {
                for (i, page) in nb.pages.iter().enumerate().take(40) {
                    out.push_str(&format!("    page {} — id {}\n", i + 1, page.id));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test directory: these run in parallel in one process, so a shared
    /// pid-keyed path had them deleting each other's vault mid-test.
    fn vault(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flux-notewrite-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Calculus")).unwrap();
        std::fs::write(
            d.join("Calculus/convex.md"),
            "# Convex\n\nSlater's condition.",
        )
        .unwrap();
        d
    }

    #[test]
    fn appending_adds_and_never_replaces() {
        let d = vault("append");
        let note = d.join("Calculus/convex.md");
        let before = std::fs::read_to_string(&note).unwrap();

        append_to_file(&note, "Strong duality holds.").unwrap();
        let after = std::fs::read_to_string(&note).unwrap();

        assert!(after.starts_with(&before), "the original text is untouched");
        assert!(after.contains("Strong duality holds."));
        // Twice over, because "append" that clobbers on the second write is the
        // failure that would actually cost the user something.
        append_to_file(&note, "KKT conditions.").unwrap();
        let twice = std::fs::read_to_string(&note).unwrap();
        assert!(twice.starts_with(&after));
        assert!(twice.contains("Strong duality holds.") && twice.contains("KKT conditions."));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_generated_path_cannot_escape_the_vault() {
        // The model is told what exists, but being told is not a control — this
        // is what stands between a bad generation and ~/.bashrc.
        let d = vault("escape");
        let outside = d.parent().unwrap().join("flux-notewrite-outside.md");
        std::fs::write(&outside, "not yours").unwrap();

        for bad in [
            "../flux-notewrite-outside.md",
            "Calculus/../../flux-notewrite-outside.md",
            "/etc/passwd",
        ] {
            assert!(
                resolve_in_vault(&d, bad).is_err(),
                "escaped the vault via {bad}"
            );
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "not yours");

        // And a real note inside it still resolves.
        assert!(resolve_in_vault(&d, "Calculus/convex.md").is_ok());
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn appending_refuses_targets_that_dont_exist_or_arent_notes() {
        let d = vault("targets");
        // Creating is `new_note`'s job; append is for what's already written, so
        // a typo'd path fails loudly instead of quietly making a new file.
        assert!(resolve_in_vault(&d, "Calculus/nope.md").is_err());
        std::fs::write(d.join("Calculus/data.json"), "{}").unwrap();
        assert!(resolve_in_vault(&d, "Calculus/data.json").is_err());
        assert!(resolve_in_vault(&d, "").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_append_is_refused() {
        // A model that returns an empty body shouldn't silently "succeed" and
        // leave the user believing something was saved.
        let d = vault("empty");
        let note = d.join("Calculus/convex.md");
        let before = std::fs::read_to_string(&note).unwrap();
        assert!(append_to_file(&note, "   \n  ").is_err());
        assert_eq!(std::fs::read_to_string(&note).unwrap(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_vocabulary_cannot_express_a_destructive_edit() {
        // A guard can be forgotten; an unrepresentable action cannot be taken.
        // If a variant is ever added, this is the test that should stop it.
        let schema = flux_agent::note_action_schema().to_string();
        for forbidden in [
            "delete",
            "replace",
            "rewrite",
            "overwrite",
            "remove",
            "edit",
        ] {
            assert!(
                !schema.contains(forbidden),
                "note vocabulary gained a `{forbidden}` capability"
            );
        }
    }
}
