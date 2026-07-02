//! Chrome/Chromium profile reader.
//!
//! Everything here is read-only against Chrome's on-disk formats:
//!   <user-data>/<Profile>/Bookmarks            — JSON tree (this module parses it fully)
//!   <user-data>/<Profile>/Extensions/<id>/<ver>/manifest.json — extension manifests
//!   <user-data>/<Profile>/Saved Tab Groups     — SQLite (detected, not yet parsed: BACKLOG #23)

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ImportError;

// ─── Profile discovery ──────────────────────────────────────────────────────

/// Chrome user-data roots per platform, in priority order. Chromium and
/// Brave/Edge variants are BACKLOG #25 — the formats are identical.
fn user_data_roots() -> Vec<PathBuf> {
    // Only the Linux/macOS roots use $HOME; Windows uses %LOCALAPPDATA%.
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut roots = Vec::new();
    #[cfg(target_os = "linux")]
    roots.push(home.join(".config/google-chrome"));
    #[cfg(target_os = "macos")]
    roots.push(home.join("Library/Application Support/Google/Chrome"));
    #[cfg(target_os = "windows")]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Google/Chrome/User Data"));
    }
    roots
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[specta(rename = "ChromeProfilePreview")] // avoid TS-name clash; matches ipc.ts
pub struct ProfilePreview {
    /// Absolute profile directory — pass back to the import commands.
    pub dir: String,
    /// "Default", "Profile 1", …
    pub name: String,
    pub bookmark_count: usize,
    pub extension_count: usize,
    /// Whether a Saved Tab Groups database exists (import is BACKLOG #23).
    pub has_saved_tab_groups: bool,
}

/// Enumerate Chrome profiles and what each would bring over.
pub fn discover_profiles() -> Result<Vec<ProfilePreview>, ImportError> {
    let mut out = Vec::new();
    for root in user_data_roots() {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let dir = entry.path();
            // A directory is a profile iff it has a Bookmarks or Preferences file.
            if !dir.join("Bookmarks").exists() && !dir.join("Preferences").exists() {
                continue;
            }
            let bookmarks = read_bookmarks(&dir).map(|b| b.len()).unwrap_or(0);
            let extensions = list_extensions(&dir).map(|e| e.len()).unwrap_or(0);
            out.push(ProfilePreview {
                name: entry.file_name().to_string_lossy().into_owned(),
                has_saved_tab_groups: dir.join("Saved Tab Groups").exists(),
                bookmark_count: bookmarks,
                extension_count: extensions,
                dir: dir.to_string_lossy().into_owned(),
            });
        }
    }
    if out.is_empty() {
        return Err(ImportError::NotFound);
    }
    Ok(out)
}

// ─── Bookmarks ──────────────────────────────────────────────────────────────

/// A flattened bookmark: folder hierarchy preserved as a path string so the
/// Flux bookmark store can rebuild the tree (or just display the path).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[specta(rename = "ChromeBookmark")] // flux-core has its own Bookmark wire type
pub struct Bookmark {
    pub name: String,
    pub url: String,
    /// e.g. "bookmark_bar/Work/CI" — root key + folder names.
    pub folder: String,
}

/// Chrome's Bookmarks file shape (the subset we need).
#[derive(Deserialize)]
struct BookmarkFile {
    roots: std::collections::BTreeMap<String, BookmarkNode>,
}

#[derive(Deserialize)]
struct BookmarkNode {
    #[serde(rename = "type")]
    kind: String, // "url" | "folder"
    #[serde(default)]
    name: String,
    url: Option<String>,
    #[serde(default)]
    children: Vec<BookmarkNode>,
}

/// Parse `<profile>/Bookmarks` into a flat list.
pub fn read_bookmarks(profile_dir: &Path) -> Result<Vec<Bookmark>, ImportError> {
    let raw = fs::read(profile_dir.join("Bookmarks"))?;
    let file: BookmarkFile = serde_json::from_slice(&raw)
        .map_err(|source| ImportError::Parse { file: "Bookmarks", source })?;

    let mut out = Vec::new();
    for (root_name, node) in &file.roots {
        flatten(node, root_name, &mut out);
    }
    tracing::info!(target: "flux::import", count = out.len(), "parsed Chrome bookmarks");
    Ok(out)
}

fn flatten(node: &BookmarkNode, path: &str, out: &mut Vec<Bookmark>) {
    match node.kind.as_str() {
        "url" => {
            if let Some(url) = &node.url {
                out.push(Bookmark { name: node.name.clone(), url: url.clone(), folder: path.into() });
            }
        }
        "folder" => {
            // Root nodes' own names ("Bookmarks bar") duplicate the root key —
            // only nested folders extend the path.
            let nested = format!("{path}/{}", node.name);
            let child_path = if node.name.is_empty() { path } else { &nested };
            for child in &node.children {
                flatten(child, child_path, out);
            }
        }
        other => tracing::debug!(target: "flux::import", kind = other, "skipping bookmark node"),
    }
}

// ─── Extensions (inventory only) ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
}

/// Walk `<profile>/Extensions/<id>/<version>/manifest.json`.
/// Names starting with `__MSG_` are locale keys; resolving them needs the
/// `_locales` tree (BACKLOG #24) — until then we surface the raw id.
pub fn list_extensions(profile_dir: &Path) -> Result<Vec<InstalledExtension>, ImportError> {
    let mut out = Vec::new();
    let ext_root = profile_dir.join("Extensions");
    let Ok(ids) = fs::read_dir(&ext_root) else { return Ok(out) };

    for id_entry in ids.flatten() {
        let id = id_entry.file_name().to_string_lossy().into_owned();
        // Chrome keeps one subdir per installed version; take the latest.
        let Ok(versions) = fs::read_dir(id_entry.path()) else { continue };
        let Some(latest) = versions.flatten().map(|v| v.path()).max() else { continue };

        let Ok(raw) = fs::read(latest.join("manifest.json")) else { continue };
        let Ok(m) = serde_json::from_slice::<Manifest>(&raw) else { continue };
        let name = if m.name.starts_with("__MSG_") { id.clone() } else { m.name };
        out.push(InstalledExtension { id, name, version: m.version });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a throwaway fake Chrome profile on disk.
    fn fake_profile() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-import-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("Bookmarks"),
            r#"{
              "roots": {
                "bookmark_bar": {
                  "type": "folder", "name": "Bookmarks bar",
                  "children": [
                    { "type": "url", "name": "Rust", "url": "https://rust-lang.org" },
                    { "type": "folder", "name": "Work", "children": [
                      { "type": "url", "name": "CI", "url": "https://ci.example.com" }
                    ]}
                  ]
                },
                "other": { "type": "folder", "name": "Other bookmarks", "children": [] }
              }
            }"#,
        )
        .unwrap();

        let ext = dir.join("Extensions/abcdefghijklmnop/1.2.3_0");
        fs::create_dir_all(&ext).unwrap();
        fs::write(ext.join("manifest.json"), r#"{"name":"uBlock Origin","version":"1.2.3"}"#)
            .unwrap();
        dir
    }

    #[test]
    fn bookmarks_flatten_with_folder_paths() {
        let dir = fake_profile();
        let books = read_bookmarks(&dir).unwrap();
        assert_eq!(books.len(), 2);
        assert!(books.contains(&Bookmark {
            name: "Rust".into(),
            url: "https://rust-lang.org".into(),
            folder: "bookmark_bar/Bookmarks bar".into(),
        }));
        // Nested folder extends the path.
        assert!(books.iter().any(|b| b.name == "CI" && b.folder.ends_with("/Work")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extensions_are_inventoried_from_manifests() {
        let dir = fake_profile();
        let exts = list_extensions(&dir).unwrap();
        assert_eq!(exts.len(), 1);
        assert_eq!(exts[0].name, "uBlock Origin");
        assert_eq!(exts[0].version, "1.2.3");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_bookmarks_file_is_an_io_error() {
        assert!(matches!(
            read_bookmarks(Path::new("/nonexistent-profile")),
            Err(ImportError::Io(_))
        ));
    }
}
