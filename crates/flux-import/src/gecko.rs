//! Zen and Firefox (Gecko-family) profile reader: bookmarks only.
//!
//! Bookmarks live in each profile's `places.sqlite`, which the browser holds
//! open (in WAL mode) while it runs. We never touch it in place: the database
//! and its `-wal` are copied to a temporary folder and the copy is read with
//! the system's `sqlite3` tool (every Mac has `/usr/bin/sqlite3`), so the
//! browser can stay open and today's bookmarks are included. Bundling SQLite
//! itself would cost about a megabyte of binary for one import.
//!
//! Without a `sqlite3` tool, we fall back to the newest JSON backup the
//! browser keeps in `bookmarkbackups/` (`.jsonlz4`, Mozilla's LZ4 framing,
//! decoded here), which can be up to a day behind.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::chrome::Bookmark;
use crate::ImportError;

/// The browsers this module knows, and where each keeps its profiles.
const BROWSERS: &[&str] = &["Zen", "Firefox"];

// Built with pushes because each root is cfg-gated per OS (as in chrome.rs).
#[allow(clippy::vec_init_then_push)]
pub(crate) fn roots(browser: &str) -> Vec<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    out.push(home.join(match browser {
        "Zen" => "Library/Application Support/zen",
        _ => "Library/Application Support/Firefox",
    }));
    #[cfg(target_os = "linux")]
    {
        out.push(home.join(match browser {
            "Zen" => ".zen",
            _ => ".mozilla/firefox",
        }));
        if browser == "Zen" {
            out.push(home.join(".var/app/app.zen_browser.zen/.zen")); // Flatpak
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata).join(match browser {
            "Zen" => "zen",
            _ => "Mozilla/Firefox",
        }));
    }
    out
}

/// One profile, as the import menu lists it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[specta(rename = "GeckoProfile")]
pub struct GeckoProfile {
    /// "Zen" or "Firefox".
    pub browser: String,
    /// The profile's own name: "Default (release)", "Work"…
    pub name: String,
    /// Absolute profile directory — pass back to the import command.
    pub dir: String,
    pub bookmark_count: usize,
    /// The profile the browser opens: the one you use.
    pub in_use: bool,
}

/// `profiles.ini`: each `[ProfileN]`'s name and folder, and which one an
/// `[Install…]` section (the browser as installed) opens by default.
pub(crate) fn parse_profiles_ini(text: &str) -> (Vec<(String, String)>, Vec<String>) {
    // A `Path` is relative to the ini's folder unless `IsRelative=0`, when
    // it's absolute anyway, so it's kept as written and resolved by the caller.
    let mut profiles = Vec::new();
    let mut defaults = Vec::new();
    let mut section = String::new();
    let (mut name, mut path) = (String::new(), String::new());
    let mut end_section = |section: &str, name: &mut String, path: &mut String| {
        if section.starts_with("Profile") && !path.is_empty() {
            profiles.push((std::mem::take(name), std::mem::take(path)));
        }
        name.clear();
        path.clear();
    };
    for line in text.lines() {
        let line = line.trim();
        if let Some(s) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            end_section(&section, &mut name, &mut path);
            section = s.to_string();
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match (k.trim(), v.trim()) {
            ("Name", v) => name = v.to_string(),
            ("Path", v) => path = v.to_string(),
            ("Default", v) if section.starts_with("Install") => defaults.push(v.to_string()),
            _ => {}
        }
    }
    end_section(&section, &mut name, &mut path);
    (profiles, defaults)
}

/// Every Zen and Firefox profile on this machine that has bookmarks to read,
/// the one each browser opens first.
pub fn discover_profiles() -> Vec<GeckoProfile> {
    let mut out = Vec::new();
    for &browser in BROWSERS {
        for root in roots(browser) {
            let Ok(ini) = fs::read_to_string(root.join("profiles.ini")) else {
                continue;
            };
            let (profiles, defaults) = parse_profiles_ini(&ini);
            let mut found: Vec<GeckoProfile> = profiles
                .into_iter()
                .filter_map(|(name, path)| {
                    let dir = if Path::new(&path).is_absolute() {
                        PathBuf::from(&path)
                    } else {
                        root.join(&path)
                    };
                    if !dir.join("places.sqlite").exists() {
                        return None;
                    }
                    Some(GeckoProfile {
                        browser: browser.to_string(),
                        name: if name.is_empty() { path.clone() } else { name },
                        bookmark_count: read_bookmarks(&dir).map(|b| b.len()).unwrap_or(0),
                        in_use: defaults.iter().any(|d| d == &path),
                        dir: dir.to_string_lossy().into_owned(),
                    })
                })
                .collect();
            found.sort_by_key(|p| !p.in_use);
            out.extend(found);
        }
    }
    out
}

// ─── Reading places.sqlite ──────────────────────────────────────────────────

/// One `moz_bookmarks` row, joined to its URL.
#[derive(Debug, Deserialize)]
pub(crate) struct Row {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: i64, // 1 bookmark, 2 folder, 3 separator
    pub parent: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub guid: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

const QUERY: &str = "SELECT b.id, b.type, b.parent, b.title, b.guid, p.url \
     FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk \
     ORDER BY b.parent, b.position;";

/// Where the browser's own top-level folders go in Flux.
fn root_name(guid: &str) -> Option<&'static str> {
    Some(match guid {
        "toolbar_____" => "Toolbar",
        "menu________" => "Menu",
        "unfiled_____" => "Other",
        "mobile______" => "Mobile",
        _ => return None,
    })
}

/// A folder's name as one step of a Flux folder path, where "/" separates
/// steps: "University / Comp Sci" keeps its look with a division slash.
fn folder_title(title: &str) -> String {
    title.replace('/', "\u{2215}")
}

/// Rows into bookmarks, each with its folder path ("Toolbar/Uni/COMP2310").
/// Tags (a folder tree of their own in Places), smart folders (`place:`
/// queries) and separators are left out.
pub(crate) fn bookmarks_from_rows(rows: &[Row]) -> Vec<Bookmark> {
    let by_id: HashMap<i64, &Row> = rows.iter().map(|r| (r.id, r)).collect();
    let folder_of = |mut id: i64| -> Option<String> {
        let mut names = Vec::new();
        for _ in 0..64 {
            let row = by_id.get(&id)?;
            let guid = row.guid.as_deref().unwrap_or("");
            if guid == "tags________" {
                return None;
            }
            if let Some(root) = root_name(guid) {
                names.push(root.to_string());
                break;
            }
            if guid == "root________" || row.parent == 0 {
                break;
            }
            names.push(folder_title(row.title.as_deref().unwrap_or_default()));
            id = row.parent;
        }
        names.reverse();
        Some(names.join("/"))
    };
    rows.iter()
        .filter(|r| r.kind == 1)
        .filter_map(|r| {
            let url = r.url.as_deref()?;
            if url.starts_with("place:") {
                return None;
            }
            Some(Bookmark {
                name: r.title.clone().unwrap_or_default(),
                url: url.to_string(),
                folder: folder_of(r.parent)?,
            })
        })
        .collect()
}

// ─── The JSON backups ───────────────────────────────────────────────────────

/// Mozilla's `.jsonlz4`: `mozLz40\0`, the decompressed size (u32 LE), then
/// one LZ4 block.
pub(crate) fn moz_lz4(bytes: &[u8]) -> Option<Vec<u8>> {
    let body = bytes.strip_prefix(b"mozLz40\0")?;
    let size = u32::from_le_bytes(body.get(..4)?.try_into().ok()?) as usize;
    lz4_block(body.get(4..)?, size)
}

/// Decode one raw LZ4 block of known output size.
pub(crate) fn lz4_block(src: &[u8], out_len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(out_len);
    let mut i = 0;
    let more = |i: &mut usize, mut n: usize| -> Option<usize> {
        loop {
            let b = *src.get(*i)?;
            *i += 1;
            n += b as usize;
            if b != 255 {
                return Some(n);
            }
        }
    };
    while i < src.len() {
        let token = src[i];
        i += 1;
        let mut lit = (token >> 4) as usize;
        if lit == 15 {
            lit = more(&mut i, lit)?;
        }
        out.extend_from_slice(src.get(i..i + lit)?);
        i += lit;
        if i >= src.len() {
            break; // the last sequence is literals only
        }
        let off = u16::from_le_bytes([*src.get(i)?, *src.get(i + 1)?]) as usize;
        i += 2;
        if off == 0 || off > out.len() {
            return None;
        }
        let mut len = (token & 15) as usize;
        if len == 15 {
            len = more(&mut i, len)?;
        }
        len += 4;
        if out.len() + len > out_len {
            return None;
        }
        let start = out.len() - off;
        for k in 0..len {
            let b = out[start + k]; // byte by byte: a match may overlap itself
            out.push(b);
        }
    }
    (out.len() == out_len).then_some(out)
}

#[derive(Deserialize)]
struct Node {
    #[serde(default)]
    title: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    children: Vec<Node>,
}

fn walk(node: &Node, path: &str, out: &mut Vec<Bookmark>) {
    if node.kind == "text/x-moz-place" {
        if let Some(uri) = node.uri.as_deref().filter(|u| !u.starts_with("place:")) {
            out.push(Bookmark {
                name: node.title.clone(),
                url: uri.to_string(),
                folder: path.to_string(),
            });
        }
        return;
    }
    let here = match node.root.as_deref() {
        Some("tagsFolder") => return,
        Some("placesRoot") => String::new(),
        Some("toolbarFolder") => "Toolbar".into(),
        Some("bookmarksMenuFolder") => "Menu".into(),
        Some("unfiledBookmarksFolder") => "Other".into(),
        Some("mobileFolder") => "Mobile".into(),
        _ if path.is_empty() => folder_title(&node.title),
        _ => format!("{path}/{}", folder_title(&node.title)),
    };
    for child in &node.children {
        walk(child, &here, out);
    }
}

pub(crate) fn bookmarks_from_backup_json(json: &[u8]) -> Result<Vec<Bookmark>, ImportError> {
    let root: Node = serde_json::from_slice(json).map_err(|source| ImportError::Parse {
        file: "bookmarks backup",
        source,
    })?;
    let mut out = Vec::new();
    walk(&root, "", &mut out);
    Ok(out)
}

fn from_newest_backup(profile: &Path) -> Result<Vec<Bookmark>, ImportError> {
    let newest = fs::read_dir(profile.join("bookmarkbackups"))
        .map_err(|_| ImportError::Other("no sqlite3 tool and no bookmark backups to read".into()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.to_string_lossy().ends_with(".jsonlz4") || p.extension().is_some_and(|e| e == "json")
        })
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
        .ok_or_else(|| {
            ImportError::Other("no sqlite3 tool and no bookmark backups to read".into())
        })?;
    let bytes = fs::read(&newest)?;
    let json = if newest.extension().is_some_and(|e| e == "json") {
        bytes
    } else {
        moz_lz4(&bytes)
            .ok_or_else(|| ImportError::Other("the bookmark backup is damaged".into()))?
    };
    bookmarks_from_backup_json(&json)
}

/// Every bookmark in a Zen or Firefox profile.
pub fn read_bookmarks(profile_dir: &Path) -> Result<Vec<Bookmark>, ImportError> {
    let out = match crate::sqlite::tool() {
        Some(_) => bookmarks_from_rows(&crate::sqlite::query::<Row>(
            &profile_dir.join("places.sqlite"),
            QUERY,
            "places.sqlite",
        )?),
        None => from_newest_backup(profile_dir)?,
    };
    tracing::info!(target: "flux::import", count = out.len(), "parsed Gecko bookmarks");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_ini_names_the_profile_in_use() {
        let ini = "[General]\nVersion=2\n\n[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/k5.Default (release)\n\n[Profile1]\nName=Work\nIsRelative=1\nPath=Profiles/w6.Work\nDefault=1\n\n[Install6ED3]\nDefault=Profiles/k5.Default (release)\nLocked=1\n";
        let (profiles, defaults) = parse_profiles_ini(ini);
        assert_eq!(
            profiles,
            vec![
                (
                    "Default (release)".to_string(),
                    "Profiles/k5.Default (release)".to_string()
                ),
                ("Work".to_string(), "Profiles/w6.Work".to_string()),
            ]
        );
        assert_eq!(defaults, vec!["Profiles/k5.Default (release)".to_string()]);
    }

    fn row(id: i64, kind: i64, parent: i64, title: &str, guid: &str, url: Option<&str>) -> Row {
        Row {
            id,
            kind,
            parent,
            title: Some(title.into()),
            guid: Some(guid.into()),
            url: url.map(Into::into),
        }
    }

    #[test]
    fn rows_become_bookmarks_with_their_folders() {
        let rows = vec![
            row(1, 2, 0, "", "root________", None),
            row(2, 2, 1, "menu", "menu________", None),
            row(3, 2, 1, "toolbar", "toolbar_____", None),
            row(4, 2, 1, "tags", "tags________", None),
            row(10, 2, 3, "Uni / CS", "f1", None),
            row(11, 1, 10, "Wattle", "b1", Some("https://wattle.anu.edu.au")),
            row(12, 1, 3, "GitHub", "b2", Some("https://github.com")),
            row(13, 1, 2, "Recent", "b3", Some("place:sort=8")),
            row(14, 3, 3, "", "s1", None),
            row(20, 2, 4, "rust", "t1", None),
            row(21, 1, 20, "", "b4", Some("https://doc.rust-lang.org")),
        ];
        let got = bookmarks_from_rows(&rows);
        assert_eq!(
            got,
            vec![
                Bookmark {
                    name: "Wattle".into(),
                    url: "https://wattle.anu.edu.au".into(),
                    folder: "Toolbar/Uni \u{2215} CS".into()
                },
                Bookmark {
                    name: "GitHub".into(),
                    url: "https://github.com".into(),
                    folder: "Toolbar".into()
                },
            ]
        );
    }

    #[test]
    fn lz4_blocks_decode_with_overlapping_matches() {
        // "abc" as literals, then a 6-byte match at offset 3: "abcabcabc".
        assert_eq!(
            lz4_block(&[0x32, b'a', b'b', b'c', 3, 0], 9).unwrap(),
            b"abcabcabc"
        );
        // Literals only.
        assert_eq!(
            lz4_block(&[0x50, b'h', b'e', b'l', b'l', b'o'], 5).unwrap(),
            b"hello"
        );
        // A bad offset is refused, not a panic.
        assert!(lz4_block(&[0x12, b'a', 9, 0], 6).is_none());
        let framed = [
            b"mozLz40\0".as_slice(),
            &9u32.to_le_bytes(),
            &[0x32, b'a', b'b', b'c', 3, 0],
        ]
        .concat();
        assert_eq!(moz_lz4(&framed).unwrap(), b"abcabcabc");
    }

    #[test]
    fn a_backup_tree_reads_like_the_database() {
        let json = br#"{"guid":"root________","title":"","root":"placesRoot","children":[
            {"title":"toolbar","root":"toolbarFolder","type":"text/x-moz-place-container","children":[
                {"title":"Uni","type":"text/x-moz-place-container","children":[
                    {"title":"Wattle","type":"text/x-moz-place","uri":"https://wattle.anu.edu.au"}]},
                {"title":"sep","type":"text/x-moz-place-separator"}]},
            {"title":"tags","root":"tagsFolder","type":"text/x-moz-place-container","children":[
                {"title":"x","type":"text/x-moz-place","uri":"https://x.dev"}]}]}"#;
        let got = bookmarks_from_backup_json(json).unwrap();
        assert_eq!(
            got,
            vec![Bookmark {
                name: "Wattle".into(),
                url: "https://wattle.anu.edu.au".into(),
                folder: "Toolbar/Uni".into()
            }]
        );
    }
}
