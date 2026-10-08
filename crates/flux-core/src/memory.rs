//! Gemma's long-term memory — a plain Markdown file the agent can **read for
//! context** and **append facts to** ("remember that …"). Unlike the per-chat
//! sliding window, this persists across conversations.
//!
//! Stored at `<app-data>/memory.md` (override with `FLUX_MEMORY_FILE` to point it
//! at a Markdown file of your choosing). Fully local — it's just a file on disk.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("FLUX_MEMORY_FILE").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("memory.md"))
}

/// The full memory file (empty string if it doesn't exist yet).
#[tauri::command]
pub fn memory_read(app: AppHandle) -> Result<String, String> {
    let p = memory_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Append one fact as a Markdown bullet. Returns a short confirmation.
#[tauri::command]
pub fn memory_append(app: AppHandle, note: String) -> Result<String, String> {
    let note = note.trim();
    if note.is_empty() {
        return Err("nothing to remember".into());
    }
    append_note(&memory_path(&app)?, note)?;
    Ok("Got it — I'll remember that.".into())
}

/// Add `- note` to the file at `p`, heading a new or blank file. Appends rather
/// than rewriting: the file may be the user's own notes (`FLUX_MEMORY_FILE`),
/// and rewriting it from a read that failed (a stray non-UTF-8 byte, a
/// permission or sharing error) replaced everything in it with one bullet.
fn append_note(p: &Path, note: &str) -> Result<(), String> {
    use std::io::Write as _;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Only a missing file means "start fresh". Read as bytes: the content is
    // never rewritten, so it doesn't have to be valid UTF-8.
    let existing = match std::fs::read(p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("couldn't read {}: {e}", p.display())),
    };
    let mut add = String::new();
    if existing.iter().all(u8::is_ascii_whitespace) {
        add.push_str("# Gemma's memory\n\n");
    } else if !existing.ends_with(b"\n") {
        add.push('\n');
    }
    add.push_str(&format!("- {note}\n"));
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .and_then(|mut f| f.write_all(add.as_bytes()))
        .map_err(|e| e.to_string())
}

/// Overwrite the whole memory file (for editing / clearing).
#[tauri::command]
pub fn memory_write(app: AppHandle, content: String) -> Result<(), String> {
    let p = memory_path(&app)?;
    // Atomic (temp file + rename), so a failed write can't leave the file
    // truncated; through a symlinked FLUX_MEMORY_FILE to the file it names.
    let target = std::fs::canonicalize(&p).unwrap_or(p);
    crate::persist::write_atomic(&target, content.as_bytes()).map_err(|e| e.to_string())
}

/// Where the memory file lives (so the UI can show / open it).
#[tauri::command]
pub fn memory_path_str(app: AppHandle) -> Result<String, String> {
    Ok(memory_path(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-memory-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn appending_keeps_a_file_that_is_not_utf8() {
        let dir = scratch("latin1");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("me.md");
        // A Windows-1252 apostrophe: not valid UTF-8, so a string read fails.
        let notes = b"# My notes\n\nIt\x92s mine".to_vec();
        std::fs::write(&p, &notes).unwrap();
        append_note(&p, "my flight is Tuesday").unwrap();
        let after = std::fs::read(&p).unwrap();
        assert!(after.starts_with(&notes), "the user's notes survive");
        assert!(after.ends_with(b"mine\n- my flight is Tuesday\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_error_writes_nothing() {
        let dir = scratch("unreadable");
        std::fs::create_dir_all(&dir).unwrap();
        // A directory where the file should be: the read fails, not NotFound.
        assert!(append_note(&dir, "x").is_err());
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_file_starts_with_a_header() {
        let dir = scratch("new");
        let p = dir.join("memory.md");
        append_note(&p, "a").unwrap();
        append_note(&p, "b").unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "# Gemma's memory\n\n- a\n- b\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
