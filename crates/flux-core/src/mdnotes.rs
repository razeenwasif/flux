//! Notes for the tabs pane's Notes mode: plain Markdown, one file per note.
//!
//! They live in a "Flux Notes" folder of the Onyx vault when there is one, so
//! the Indexer reads them ("From your notes" finds them) and any Markdown editor
//! opens them; otherwise in Flux's own data folder. Every command works inside
//! that one folder, and a note is addressed by its name, never by a path, so
//! nothing the pane sends can reach a file outside it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{Manager, State};

use crate::kb::KbStore;
use crate::kbfresh::KbFreshness;

/// The folder's name inside the vault.
const VAULT_FOLDER: &str = "Flux Notes";
/// A note bigger than this isn't one the pane edits; it's left out of the list.
const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
/// How much of a note the list shows under its name.
const PREVIEW_CHARS: usize = 140;
/// Longest name a note gets (file systems allow 255 bytes; titles rarely need it).
const MAX_NAME_CHARS: usize = 100;

/// One note in the list.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MdNote {
    /// The file name without `.md`: what every other command takes.
    pub name: String,
    pub modified_ms: u64,
    /// The first words of the note, Markdown marks taken off.
    pub preview: String,
}

/// Where the notes are kept, for the pane to say so.
#[derive(Serialize, Clone, Debug)]
pub struct MdNotesHome {
    pub path: String,
    pub in_vault: bool,
}

/// Characters no file name may hold on one platform or another.
const BAD: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// A name the list handed out, checked before it touches the disk.
pub(crate) fn note_name(raw: &str) -> Result<String, String> {
    let n = raw.trim();
    let n = n.strip_suffix(".md").unwrap_or(n).trim();
    if n.is_empty() {
        return Err("a note needs a name".into());
    }
    if n.starts_with('.') || n.contains(BAD) || n.chars().any(char::is_control) {
        return Err(format!("“{n}” can't be a note's name"));
    }
    if n.chars().count() > MAX_NAME_CHARS {
        return Err("that name is too long".into());
    }
    Ok(n.to_string())
}

/// A title turned into a usable name: the characters a file can't have become
/// dashes, and an empty one becomes "Untitled".
pub(crate) fn name_from_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if BAD.contains(&c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let cut: String = cleaned.chars().take(MAX_NAME_CHARS).collect();
    let cut = cut.trim();
    if cut.is_empty() {
        "Untitled".into()
    } else {
        cut.to_string()
    }
}

fn file_of(dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.md", note_name(name)?)))
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The first words of a note's body: past any frontmatter and headings (the
/// first is usually the note's own name), with list, checkbox and emphasis
/// marks taken off, on one line.
pub(crate) fn preview_of(text: &str) -> String {
    let mut lines = text.lines().peekable();
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        for l in lines.by_ref() {
            if l.trim() == "---" {
                break;
            }
        }
    }
    let mut out = String::new();
    for l in lines {
        let l = l.trim();
        if l.starts_with('#') {
            continue;
        }
        let l = l.trim_start_matches(['-', '*', '+', '>']).trim_start();
        let l = l
            .strip_prefix("[ ]")
            .or_else(|| l.strip_prefix("[x]"))
            .unwrap_or(l)
            .trim();
        if l.is_empty() || l.starts_with("```") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&l.replace("**", "").replace("__", "").replace('`', ""));
        if out.chars().count() >= PREVIEW_CHARS {
            break;
        }
    }
    let mut cut: String = out.chars().take(PREVIEW_CHARS).collect();
    if out.chars().count() > PREVIEW_CHARS {
        cut.push('…');
    }
    cut
}

fn meta_of(path: &Path, name: String) -> Result<MdNote, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(path).unwrap_or_default();
    Ok(MdNote {
        name,
        modified_ms: modified_ms(&meta),
        preview: preview_of(&text),
    })
}

/// Every note in `dir`, the most recently changed first.
pub(crate) fn list_in(dir: &Path) -> Vec<MdNote> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<MdNote> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()?.to_str()? != "md" {
                return None;
            }
            let name = note_name(p.file_stem()?.to_str()?).ok()?;
            let meta = e.metadata().ok()?;
            if !meta.is_file() || meta.len() > MAX_NOTE_BYTES {
                return None;
            }
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            Some(MdNote {
                name,
                modified_ms: modified_ms(&meta),
                preview: preview_of(&text),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

pub(crate) fn read_in(dir: &Path, name: &str) -> Result<String, String> {
    let p = file_of(dir, name)?;
    let meta = std::fs::metadata(&p).map_err(|_| format!("there's no note called “{name}”"))?;
    if meta.len() > MAX_NOTE_BYTES {
        return Err("that note is too big to edit here".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Write a note whole. Through a temporary file and a rename, so a crash mid-
/// write leaves the old note rather than half a new one.
pub(crate) fn write_in(dir: &Path, name: &str, content: &str) -> Result<MdNote, String> {
    let name = note_name(name)?;
    let p = file_of(dir, &name)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{name}.md.tmp"));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    meta_of(&p, name)
}

/// A new note titled `title`, never over an existing one: "Lab", then "Lab 2"…
pub(crate) fn create_in(dir: &Path, title: &str) -> Result<MdNote, String> {
    let base = name_from_title(title);
    let mut name = base.clone();
    let mut n = 2;
    while file_of(dir, &name)?.exists() {
        name = format!("{base} {n}");
        n += 1;
    }
    let heading = title.trim();
    let heading = if heading.is_empty() {
        "Untitled"
    } else {
        heading
    };
    write_in(dir, &name, &format!("# {heading}\n\n"))
}

pub(crate) fn rename_in(dir: &Path, from: &str, to: &str) -> Result<MdNote, String> {
    let src = file_of(dir, from)?;
    let to = name_from_title(to);
    let dst = file_of(dir, &to)?;
    if src == dst {
        return meta_of(&src, to);
    }
    if dst.exists() {
        return Err(format!("there's already a note called “{to}”"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    meta_of(&dst, to)
}

/// The folder the notes are kept in.
fn home(app: &tauri::AppHandle, kb: &KbStore) -> Result<(PathBuf, bool), String> {
    if let Some(vault) = crate::kb::onyx_vault(kb.source_location("onyx").as_deref()) {
        return Ok((vault.join(VAULT_FOLDER), true));
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((data.join("md-notes"), false))
}

/// Run `f` on the notes folder off the UI thread, and tell the Indexer when a
/// note in the vault changed.
async fn with_home<T: Send + 'static>(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    fresh: Option<State<'_, Arc<KbFreshness>>>,
    f: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (dir, in_vault) = home(&app, &kb)?;
    let out = tauri::async_runtime::spawn_blocking(move || f(&dir))
        .await
        .map_err(|e| e.to_string())?;
    if in_vault && out.is_ok() {
        if let Some(fresh) = fresh {
            fresh.touch("onyx");
        }
    }
    out
}

#[tauri::command]
pub async fn md_notes_home(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
) -> Result<MdNotesHome, String> {
    let (dir, in_vault) = home(&app, &kb)?;
    Ok(MdNotesHome {
        path: dir.display().to_string(),
        in_vault,
    })
}

#[tauri::command]
pub async fn md_notes_list(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
) -> Result<Vec<MdNote>, String> {
    with_home(app, kb, None, |dir| Ok(list_in(dir))).await
}

#[tauri::command]
pub async fn md_note_read(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    name: String,
) -> Result<String, String> {
    with_home(app, kb, None, move |dir| read_in(dir, &name)).await
}

#[tauri::command]
pub async fn md_note_write(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    fresh: State<'_, Arc<KbFreshness>>,
    name: String,
    content: String,
) -> Result<MdNote, String> {
    with_home(app, kb, Some(fresh), move |dir| {
        write_in(dir, &name, &content)
    })
    .await
}

#[tauri::command]
pub async fn md_note_create(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    fresh: State<'_, Arc<KbFreshness>>,
    title: String,
) -> Result<MdNote, String> {
    with_home(app, kb, Some(fresh), move |dir| create_in(dir, &title)).await
}

#[tauri::command]
pub async fn md_note_rename(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    fresh: State<'_, Arc<KbFreshness>>,
    name: String,
    to: String,
) -> Result<MdNote, String> {
    with_home(app, kb, Some(fresh), move |dir| rename_in(dir, &name, &to)).await
}

/// To the Trash, not gone: a note is someone's writing.
#[tauri::command]
pub async fn md_note_delete(
    app: tauri::AppHandle,
    kb: State<'_, KbStore>,
    fresh: State<'_, Arc<KbFreshness>>,
    name: String,
) -> Result<(), String> {
    with_home(app, kb, Some(fresh), move |dir| {
        let p = file_of(dir, &name)?;
        #[cfg(desktop)]
        {
            trash::delete(&p).map_err(|e| e.to_string())
        }
        #[cfg(mobile)]
        {
            let _ = p;
            Err("Moving to Trash isn't supported on this platform".to_string())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "flux-mdnotes-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_name_never_leaves_the_folder() {
        for bad in [
            "",
            "  ",
            "../escape",
            "a/b",
            "a\\b",
            ".hidden",
            "c:thing",
            "x\u{0}y",
        ] {
            assert!(note_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert_eq!(note_name(" Lab 6.md ").unwrap(), "Lab 6");
        assert_eq!(name_from_title("a/b: c?"), "a-b- c-");
        assert_eq!(name_from_title("  ..  "), "Untitled");
    }

    #[test]
    fn create_write_list_rename_round_trip() {
        let dir = scratch("roundtrip");
        let a = create_in(&dir, "Lab notes").unwrap();
        assert_eq!(a.name, "Lab notes");
        let b = create_in(&dir, "Lab notes").unwrap();
        assert_eq!(b.name, "Lab notes 2", "never over an existing note");
        write_in(
            &dir,
            "Lab notes",
            "# Lab notes\n\n- [ ] read the spec\n- [x] set up\n",
        )
        .unwrap();
        assert_eq!(
            read_in(&dir, "Lab notes").unwrap(),
            "# Lab notes\n\n- [ ] read the spec\n- [x] set up\n"
        );
        let names: Vec<_> = list_in(&dir).into_iter().map(|n| n.name).collect();
        assert_eq!(names.len(), 2);
        assert!(
            rename_in(&dir, "Lab notes 2", "Lab notes").is_err(),
            "a rename can't overwrite"
        );
        let r = rename_in(&dir, "Lab notes 2", "Week 13").unwrap();
        assert_eq!(r.name, "Week 13");
        assert!(read_in(&dir, "Lab notes 2").is_err());
        // No temporary file is left behind.
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_preview_skips_frontmatter_and_marks() {
        let text = "---\ntags: [uni]\n---\n# Lab 6\n\n- [ ] read the **spec**\n> quoted\n";
        assert_eq!(preview_of(text), "read the spec quoted");
        let long = "word ".repeat(80);
        assert!(preview_of(&long).ends_with('…'));
    }
}
