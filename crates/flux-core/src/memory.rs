//! Gemma's long-term memory — a plain Markdown file the agent can **read for
//! context** and **append facts to** ("remember that …"). Unlike the per-chat
//! sliding window, this persists across conversations.
//!
//! Stored at `<app-data>/memory.md` (override with `FLUX_MEMORY_FILE` to point it
//! at a Markdown file of your choosing). Fully local — it's just a file on disk.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("FLUX_MEMORY_FILE").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("memory.md"))
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
    let p = memory_path(&app)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut content = std::fs::read_to_string(&p).unwrap_or_default();
    if content.trim().is_empty() {
        content = "# Gemma's memory\n\n".to_string();
    } else if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("- {note}\n"));
    std::fs::write(&p, &content).map_err(|e| e.to_string())?;
    Ok("Got it — I'll remember that.".into())
}

/// Overwrite the whole memory file (for editing / clearing).
#[tauri::command]
pub fn memory_write(app: AppHandle, content: String) -> Result<(), String> {
    let p = memory_path(&app)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

/// Where the memory file lives (so the UI can show / open it).
#[tauri::command]
pub fn memory_path_str(app: AppHandle) -> Result<String, String> {
    Ok(memory_path(&app)?.to_string_lossy().into_owned())
}
