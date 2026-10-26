//! Every browser Flux can import from, for the welcome flow (Flux Next
//! "welcome"): Chrome, Arc, Safari, Firefox, Brave and Zen, plus Edge and
//! Chromium when they're here. What each has (bookmarks, history from the
//! last 180 days, Arc's pinned sites), and readers that put it in Flux's
//! shape: a browser's bookmarks bar becomes Flux's bar (the top level), its
//! other folders go under the browser's name. Nothing is changed in the other
//! browser, and it can stay open (sqlite.rs).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chrome::Bookmark;
use crate::{gecko, plist, sqlite, ImportError};

/// One profile of a browser, as the import list shows it.
#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct FoundProfile {
    /// Absolute profile directory, passed back to import it.
    pub dir: String,
    pub name: String,
    /// The profile the browser opens: the one you use.
    pub in_use: bool,
    pub bookmarks: u32,
    /// Pages visited in the last 180 days, when they could be counted.
    pub history: Option<u32>,
    /// Arc's pinned tabs and Favorites.
    pub pinned: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct FoundBrowser {
    /// "chrome", "arc", "safari", "firefox", "brave", "zen", "edge", "chromium".
    pub id: String,
    pub name: String,
    /// "ready"; "locked" (macOS keeps its data from Flux until it has Full
    /// Disk Access: Safari's, and Chrome's on recent macOS); "empty" (here,
    /// with nothing to bring); "missing".
    pub state: String,
    /// "Default profile", "7 spaces", "Needs Full Disk Access", "Not on this Mac".
    pub detail: String,
    pub profiles: Vec<FoundProfile>,
}

/// A page from another browser's history.
#[derive(Debug, Clone, PartialEq)]
pub struct Visit {
    pub url: String,
    pub title: String,
    pub last_visit_ms: u64,
    pub visits: u32,
}

/// What a history import keeps: the most recent pages, at most this many per
/// profile (Flux's own history keeps 10,000).
const HISTORY_CAP: usize = 10_000;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// The Chromium family: where each keeps its profiles.
fn chromium_root(id: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let rel = match id {
        "chrome" => "Library/Application Support/Google/Chrome",
        "arc" => "Library/Application Support/Arc/User Data",
        "brave" => "Library/Application Support/BraveSoftware/Brave-Browser",
        "edge" => "Library/Application Support/Microsoft Edge",
        "chromium" => "Library/Application Support/Chromium",
        _ => return None,
    };
    #[cfg(target_os = "linux")]
    let rel = match id {
        "chrome" => ".config/google-chrome",
        "brave" => ".config/BraveSoftware/Brave-Browser",
        "edge" => ".config/microsoft-edge",
        "chromium" => ".config/chromium",
        _ => return None,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return Some(home().join(rel));
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
        Some(local.join(match id {
            "chrome" => "Google/Chrome/User Data",
            "brave" => "BraveSoftware/Brave-Browser/User Data",
            "edge" => "Microsoft/Edge/User Data",
            "chromium" => "Chromium/User Data",
            _ => return None,
        }))
    }
}

const CHROMIUM: &[(&str, &str)] = &[
    ("chrome", "Chrome"),
    ("arc", "Arc"),
    ("brave", "Brave"),
    ("edge", "Edge"),
    ("chromium", "Chromium"),
];

pub fn name_of(id: &str) -> &'static str {
    match id {
        "safari" => "Safari",
        "firefox" => "Firefox",
        "zen" => "Zen",
        _ => CHROMIUM
            .iter()
            .find(|(i, _)| *i == id)
            .map_or("Browser", |(_, n)| n),
    }
}

// ─── Time ───────────────────────────────────────────────────────────────────

/// Chromium counts microseconds from 1601; Firefox from 1970; Safari counts
/// seconds from 2001.
const CHROME_EPOCH_MS: u64 = 11_644_473_600_000;
const SAFARI_EPOCH_S: u64 = 978_307_200;

fn chrome_time(ms: u64) -> u64 {
    (ms + CHROME_EPOCH_MS) * 1000
}
fn from_chrome_time(t: f64) -> u64 {
    ((t / 1000.0) as u64).saturating_sub(CHROME_EPOCH_MS)
}
fn safari_time(ms: u64) -> u64 {
    (ms / 1000).saturating_sub(SAFARI_EPOCH_S)
}
fn from_safari_time(t: f64) -> u64 {
    ((t + SAFARI_EPOCH_S as f64) * 1000.0) as u64
}

// ─── Finding them ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Count {
    c: i64,
}

fn count(db: &Path, sql: &str, file: &'static str) -> Option<u32> {
    sqlite::peek::<Count>(db, sql, file)
        .ok()
        .and_then(|r| r.first().map(|c| c.c.max(0) as u32))
}

/// `Local State`: each profile folder's display name, and the one last used.
fn local_state(root: &Path) -> (HashMap<String, String>, Option<String>) {
    let Ok(raw) = std::fs::read(root.join("Local State")) else {
        return (HashMap::new(), None);
    };
    let v: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let names = v["profile"]["info_cache"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(dir, info)| Some((dir.clone(), info["name"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    (names, v["profile"]["last_used"].as_str().map(String::from))
}

fn chromium_profiles(id: &str, since_ms: u64) -> Vec<FoundProfile> {
    let Some(root) = chromium_root(id) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let (names, last_used) = local_state(&root);
    let mut out: Vec<FoundProfile> = entries
        .flatten()
        .filter(|e| e.path().join("Preferences").exists())
        .map(|e| {
            let dir = e.path();
            let folder = e.file_name().to_string_lossy().into_owned();
            let history = count(
                &dir.join("History"),
                &format!(
                    "SELECT COUNT(DISTINCT url) AS c FROM visits WHERE visit_time >= {};",
                    chrome_time(since_ms)
                ),
                "History",
            );
            FoundProfile {
                name: names
                    .get(&folder)
                    .cloned()
                    .unwrap_or_else(|| folder.clone()),
                in_use: last_used.as_deref() == Some(folder.as_str()),
                bookmarks: chromium_bookmarks(id, &dir).map_or(0, |b| b.len() as u32),
                history,
                pinned: 0,
                dir: dir.to_string_lossy().into_owned(),
            }
        })
        // A profile with nothing to bring is noise in the list.
        .filter(|p| p.bookmarks > 0 || p.history.unwrap_or(0) > 0 || p.in_use)
        .collect();
    out.sort_by(|a, b| b.in_use.cmp(&a.in_use).then(a.name.cmp(&b.name)));
    if out.len() == 1 {
        out[0].in_use = true;
    }
    out
}

fn arc_sidebar() -> PathBuf {
    home().join("Library/Application Support/Arc/StorableSidebar.json")
}

fn safari_dir() -> PathBuf {
    home().join("Library/Safari")
}

/// Whether macOS keeps `path` from us (privacy protection: Full Disk Access
/// lets Flux in).
fn locked(path: &Path) -> bool {
    let denied = |e: std::io::Error| e.kind() == std::io::ErrorKind::PermissionDenied;
    if path.is_dir() {
        std::fs::read_dir(path).err().is_some_and(denied)
    } else {
        std::fs::File::open(path).err().is_some_and(denied)
    }
}

/// Where a browser keeps its data, to tell "not here" from "here, but locked".
fn data_dirs(id: &str) -> Vec<PathBuf> {
    match id {
        "safari" => vec![safari_dir()],
        "firefox" | "zen" => gecko::roots(name_of(id)),
        _ => chromium_root(id).into_iter().collect(),
    }
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// What's on this machine to import from: the six always (so a missing one
/// says so), Edge and Chromium when they're here.
pub fn scan(since_ms: u64) -> Vec<FoundBrowser> {
    let mut out = Vec::new();
    let ready = |id: &str, detail: String, profiles: Vec<FoundProfile>| FoundBrowser {
        id: id.into(),
        name: name_of(id).into(),
        state: "ready".into(),
        detail,
        profiles,
    };
    // Not found: locked when macOS hides it, empty when it's here with
    // nothing to bring, missing when it isn't here at all.
    let absent = |id: &str| {
        let dirs: Vec<PathBuf> = data_dirs(id).into_iter().filter(|d| d.exists()).collect();
        let (state, detail) = if dirs.iter().any(|d| locked(d)) {
            ("locked", "Needs Full Disk Access")
        } else if dirs.is_empty() {
            ("missing", "Not on this Mac")
        } else {
            ("empty", "Nothing to bring")
        };
        FoundBrowser {
            id: id.into(),
            name: name_of(id).into(),
            state: state.into(),
            detail: detail.into(),
            profiles: Vec::new(),
        }
    };
    let gecko_all = gecko::discover_profiles();
    for id in [
        "chrome", "arc", "safari", "firefox", "brave", "zen", "edge", "chromium",
    ] {
        let found = match id {
            "safari" => scan_safari(since_ms),
            "firefox" | "zen" => {
                let browser = name_of(id);
                let profiles: Vec<FoundProfile> = gecko_all
                    .iter()
                    .filter(|p| p.browser == browser)
                    .map(|p| FoundProfile {
                        dir: p.dir.clone(),
                        name: p.name.clone(),
                        in_use: p.in_use,
                        bookmarks: p.bookmark_count as u32,
                        history: count(
                            &Path::new(&p.dir).join("places.sqlite"),
                            &format!(
                                "SELECT COUNT(DISTINCT place_id) AS c FROM moz_historyvisits WHERE visit_date >= {};",
                                since_ms * 1000
                            ),
                            "places.sqlite",
                        ),
                        pinned: 0,
                    })
                    .collect();
                match profiles.as_slice() {
                    [] => None,
                    [one] => Some(ready(id, format!("{} profile", one.name), profiles)),
                    many => Some(ready(id, plural(many.len(), "profile"), profiles)),
                }
            }
            _ => {
                let mut profiles = chromium_profiles(id, since_ms);
                if profiles.is_empty() {
                    None
                } else if id == "arc" {
                    let (pins, spaces) = arc_pinned().unwrap_or_default();
                    if let Some(p) = profiles.iter_mut().find(|p| p.in_use) {
                        p.pinned = pins.len() as u32;
                    }
                    Some(ready(id, plural(spaces, "space"), profiles))
                } else if profiles.len() == 1 {
                    let detail = format!("{} profile", profiles[0].name);
                    Some(ready(id, detail, profiles))
                } else {
                    let detail = plural(profiles.len(), "profile");
                    Some(ready(id, detail, profiles))
                }
            }
        };
        match found {
            Some(b) => out.push(b),
            None => {
                let b = absent(id);
                // Edge and Chromium are listed only when there's something.
                if !(matches!(id, "edge" | "chromium") && b.state != "locked") {
                    out.push(b);
                }
            }
        }
    }
    out
}

fn scan_safari(since_ms: u64) -> Option<FoundBrowser> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let dir = safari_dir();
    if !dir.exists() {
        return None;
    }
    let history = dir.join("History.db");
    match locked(&history) {
        // scan()'s fallback says so.
        true => None,
        false => {
            let profile = FoundProfile {
                dir: dir.to_string_lossy().into_owned(),
                name: "Safari".into(),
                in_use: true,
                bookmarks: safari_bookmarks().map_or(0, |b| b.len() as u32),
                history: count(
                    &history,
                    &format!(
                        "SELECT COUNT(DISTINCT history_item) AS c FROM history_visits WHERE visit_time >= {};",
                        safari_time(since_ms)
                    ),
                    "History.db",
                ),
                pinned: 0,
            };
            Some(FoundBrowser {
                id: "safari".into(),
                name: "Safari".into(),
                state: "ready".into(),
                detail: "Bookmarks and history".into(),
                profiles: vec![profile],
            })
        }
    }
}

// ─── Bookmarks ──────────────────────────────────────────────────────────────

fn web(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// A Chromium-family profile's bookmarks: the bar at the top level, "Other"
/// and "Mobile" under the browser's name.
fn chromium_bookmarks(id: &str, profile: &Path) -> Result<Vec<Bookmark>, ImportError> {
    let raw = std::fs::read(profile.join("Bookmarks"))?;
    let v: Value = serde_json::from_slice(&raw).map_err(|source| ImportError::Parse {
        file: "Bookmarks",
        source,
    })?;
    let browser = name_of(id);
    let mut out = Vec::new();
    fn walk(node: &Value, folder: &str, out: &mut Vec<Bookmark>) {
        for child in node["children"].as_array().into_iter().flatten() {
            match child["type"].as_str() {
                Some("url") => {
                    let url = child["url"].as_str().unwrap_or_default();
                    if web(url) {
                        out.push(Bookmark {
                            name: child["name"].as_str().unwrap_or_default().to_string(),
                            url: url.to_string(),
                            folder: folder.to_string(),
                        });
                    }
                }
                Some("folder") => {
                    let name = child["name"].as_str().unwrap_or_default();
                    let sub = match (folder, name) {
                        (f, "") => f.to_string(),
                        ("", n) => n.to_string(),
                        (f, n) => format!("{f}/{n}"),
                    };
                    walk(child, &sub, out);
                }
                _ => {}
            }
        }
    }
    let roots = &v["roots"];
    walk(&roots["bookmark_bar"], "", &mut out);
    walk(&roots["other"], &format!("{browser}/Other"), &mut out);
    walk(&roots["synced"], &format!("{browser}/Mobile"), &mut out);
    Ok(out)
}

/// Where a Zen or Firefox bookmark goes: the toolbar is Flux's bar, so its
/// folders and bookmarks land at the top level as they sat there; the rest
/// (menu, other, mobile) stays together under the browser's name
/// ("Zen/Other/software dev").
pub fn gecko_folder(browser: &str, folder: &str) -> String {
    match folder.strip_prefix("Toolbar") {
        Some("") => String::new(),
        Some(rest) if rest.starts_with('/') => rest[1..].to_string(),
        _ if folder.is_empty() => browser.to_string(),
        _ => format!("{browser}/{folder}"),
    }
}

/// Safari's bookmarks: its Favorites bar at the top level, the menu and the
/// reading list under "Safari".
fn safari_bookmarks() -> Result<Vec<Bookmark>, ImportError> {
    let v = plist::read(&safari_dir().join("Bookmarks.plist"))?;
    let mut out = Vec::new();
    fn walk(node: &Value, folder: &str, out: &mut Vec<Bookmark>) {
        for child in node["Children"].as_array().into_iter().flatten() {
            match child["WebBookmarkType"].as_str() {
                Some("WebBookmarkTypeLeaf") => {
                    let url = child["URLString"].as_str().unwrap_or_default();
                    if web(url) {
                        let name = child["URIDictionary"]["title"].as_str().unwrap_or_default();
                        out.push(Bookmark {
                            name: name.to_string(),
                            url: url.to_string(),
                            folder: folder.to_string(),
                        });
                    }
                }
                Some("WebBookmarkTypeList") => {
                    let title = child["Title"].as_str().unwrap_or_default();
                    let sub = match (folder, title) {
                        ("", "BookmarksBar") => String::new(),
                        ("", "BookmarksMenu") => "Safari/Menu".to_string(),
                        ("", "com.apple.ReadingList") => "Safari/Reading List".to_string(),
                        ("", t) => format!("Safari/{t}"),
                        (f, t) => format!("{f}/{t}"),
                    };
                    walk(child, &sub, out);
                }
                _ => {}
            }
        }
    }
    walk(&v, "", &mut out);
    Ok(out)
}

/// A profile's bookmarks, in Flux's folders.
pub fn bookmarks(id: &str, profile: &Path) -> Result<Vec<Bookmark>, ImportError> {
    match id {
        "safari" => safari_bookmarks(),
        "firefox" | "zen" => {
            let browser = name_of(id);
            Ok(gecko::read_bookmarks(profile)?
                .into_iter()
                .filter(|b| web(&b.url))
                .map(|b| Bookmark {
                    folder: gecko_folder(browser, &b.folder),
                    ..b
                })
                .collect())
        }
        _ => chromium_bookmarks(id, profile),
    }
}

// ─── Arc's pinned sites ─────────────────────────────────────────────────────

/// Arc's pinned tabs, each space's under "Arc/<space>" with its folders, and
/// its Favorites under "Arc/Favorites"; and how many spaces there are.
pub fn arc_pinned() -> Result<(Vec<Bookmark>, usize), ImportError> {
    let raw = std::fs::read(arc_sidebar())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|source| ImportError::Parse {
        file: "StorableSidebar.json",
        source,
    })?;
    Ok(arc_pinned_from(&v))
}

fn arc_pinned_from(v: &Value) -> (Vec<Bookmark>, usize) {
    let Some(container) = v["sidebar"]["containers"]
        .as_array()
        .and_then(|cs| cs.iter().find(|c| c.get("spaces").is_some()))
    else {
        return (Vec::new(), 0);
    };
    // Arc's lists alternate an id and the object it names; the objects carry
    // their own id too.
    let objects = |key: &str| -> Vec<&Value> {
        container[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x.is_object())
            .collect()
    };
    let items: HashMap<&str, &Value> = objects("items")
        .into_iter()
        .filter_map(|i| Some((i["id"].as_str()?, i)))
        .collect();
    fn walk(id: &str, folder: &str, items: &HashMap<&str, &Value>, out: &mut Vec<Bookmark>) {
        let Some(node) = items.get(id) else { return };
        for child in node["childrenIds"].as_array().into_iter().flatten() {
            let Some(cid) = child.as_str() else { continue };
            let Some(item) = items.get(cid) else { continue };
            let data = &item["data"];
            if let Some(tab) = data.get("tab") {
                let url = tab["savedURL"].as_str().unwrap_or_default();
                if web(url) {
                    let name = item["title"]
                        .as_str()
                        .filter(|t| !t.is_empty())
                        .or_else(|| tab["savedTitle"].as_str())
                        .unwrap_or_default();
                    out.push(Bookmark {
                        name: name.to_string(),
                        url: url.to_string(),
                        folder: folder.to_string(),
                    });
                }
            } else if data.get("list").is_some() {
                let name = item["title"].as_str().unwrap_or("Folder");
                walk(cid, &format!("{folder}/{name}"), items, out);
            } else {
                // Tab groups and split views: their tabs, in place.
                walk(cid, folder, items, out);
            }
        }
    }
    let mut out = Vec::new();
    let spaces = objects("spaces");
    for (n, space) in spaces.iter().enumerate() {
        let ids = space["containerIDs"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let pinned = ids
            .iter()
            .position(|x| x == "pinned")
            .and_then(|i| ids.get(i + 1))
            .and_then(Value::as_str);
        let title = space["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map_or_else(|| format!("Space {}", n + 1), String::from);
        if let Some(id) = pinned {
            walk(id, &format!("Arc/{title}"), &items, &mut out);
        }
    }
    for id in container["topAppsContainerIDs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        walk(id, "Arc/Favorites", &items, &mut out);
    }
    (out, spaces.len())
}

// ─── History ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct HistRow {
    url: String,
    #[serde(default)]
    title: Option<String>,
    last: f64,
    n: i64,
}

/// A profile's history since `since_ms`, the most recent pages first.
pub fn history(id: &str, profile: &Path, since_ms: u64) -> Result<Vec<Visit>, ImportError> {
    let (db, sql, file, time): (PathBuf, String, &'static str, fn(f64) -> u64) = match id {
        "safari" => (
            safari_dir().join("History.db"),
            format!(
                "SELECT i.url AS url, MAX(v.title) AS title, MAX(v.visit_time) AS last, COUNT(*) AS n \
                 FROM history_visits v JOIN history_items i ON i.id = v.history_item \
                 WHERE v.visit_time >= {} GROUP BY i.id ORDER BY last DESC LIMIT {HISTORY_CAP};",
                safari_time(since_ms)
            ),
            "History.db",
            from_safari_time,
        ),
        "firefox" | "zen" => (
            profile.join("places.sqlite"),
            format!(
                "SELECT p.url AS url, p.title AS title, MAX(v.visit_date) AS last, COUNT(*) AS n \
                 FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id \
                 WHERE v.visit_date >= {} GROUP BY p.id ORDER BY last DESC LIMIT {HISTORY_CAP};",
                since_ms * 1000
            ),
            "places.sqlite",
            |t| (t / 1000.0) as u64,
        ),
        _ => (
            profile.join("History"),
            format!(
                "SELECT u.url AS url, u.title AS title, MAX(v.visit_time) AS last, COUNT(*) AS n \
                 FROM visits v JOIN urls u ON u.id = v.url \
                 WHERE v.visit_time >= {} GROUP BY u.id ORDER BY last DESC LIMIT {HISTORY_CAP};",
                chrome_time(since_ms)
            ),
            "History",
            from_chrome_time,
        ),
    };
    let rows: Vec<HistRow> = sqlite::query(&db, &sql, file)?;
    Ok(rows
        .into_iter()
        .filter(|r| web(&r.url))
        .map(|r| Visit {
            title: r.title.unwrap_or_default(),
            last_visit_ms: time(r.last),
            visits: r.n.clamp(1, u32::MAX as i64) as u32,
            url: r.url,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clocks_convert_both_ways() {
        // 26 Oct 2026, 10:30 AEDT.
        let ms = 1_792_971_000_000;
        assert_eq!(from_chrome_time(chrome_time(ms) as f64), ms);
        assert_eq!(from_safari_time(safari_time(ms) as f64), ms);
        assert_eq!(safari_time(SAFARI_EPOCH_S * 1000), 0);
    }

    #[test]
    fn a_chromium_bar_is_flux_bar_and_the_rest_goes_under_its_name() {
        let dir = std::env::temp_dir().join(format!("flux-chromium-bm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Bookmarks"),
            r#"{"roots":{
              "bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[
                {"type":"url","name":"Docs","url":"https://docs.rs/"},
                {"type":"folder","name":"Uni","children":[{"type":"url","name":"Wattle","url":"https://wattle.anu.edu.au/"}]},
                {"type":"url","name":"Bookmarklet","url":"javascript:alert(1)"}]},
              "other":{"type":"folder","name":"Other bookmarks","children":[{"type":"url","name":"Rust","url":"https://rust-lang.org/"}]},
              "synced":{"type":"folder","name":"Mobile bookmarks","children":[]}}}"#,
        )
        .unwrap();
        let got = chromium_bookmarks("brave", &dir).unwrap();
        let rows: Vec<(&str, &str)> = got
            .iter()
            .map(|b| (b.name.as_str(), b.folder.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![("Docs", ""), ("Wattle", "Uni"), ("Rust", "Brave/Other")]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gecko_toolbar_is_the_bar() {
        assert_eq!(gecko_folder("Zen", "Toolbar"), "");
        assert_eq!(gecko_folder("Zen", "Toolbar/Uni"), "Uni");
        assert_eq!(gecko_folder("Zen", "Other/dev"), "Zen/Other/dev");
        assert_eq!(gecko_folder("Firefox", ""), "Firefox");
    }

    #[test]
    fn arc_pins_come_with_their_space_and_folders() {
        let v: Value = serde_json::from_str(
            r#"{"sidebar":{"containers":[{"global":{}},{
              "spaces":["s1",{"id":"s1","title":"Uni","containerIDs":["pinned","p1","unpinned","u1"]},
                        "s2",{"id":"s2","title":"","containerIDs":["pinned","p2","unpinned","u2"]}],
              "topAppsContainerIDs":[{"default":{}},"t1"],
              "items":[
                "p1",{"id":"p1","childrenIds":["a","f"],"data":{"itemContainer":{}}},
                "a",{"id":"a","title":null,"childrenIds":[],"data":{"tab":{"savedURL":"https://wattle.anu.edu.au/","savedTitle":"Wattle"}}},
                "f",{"id":"f","title":"COMP3320","childrenIds":["b"],"data":{"list":{}}},
                "b",{"id":"b","title":"Lab","childrenIds":[],"data":{"tab":{"savedURL":"https://gitlab.anu.edu.au/","savedTitle":"GitLab"}}},
                "u1",{"id":"u1","childrenIds":["c"],"data":{"itemContainer":{}}},
                "c",{"id":"c","title":"Today","childrenIds":[],"data":{"tab":{"savedURL":"https://news.ycombinator.com/","savedTitle":"HN"}}},
                "p2",{"id":"p2","childrenIds":[],"data":{"itemContainer":{}}},
                "t1",{"id":"t1","childrenIds":["d"],"data":{"itemContainer":{}}},
                "d",{"id":"d","title":"","childrenIds":[],"data":{"tab":{"savedURL":"https://github.com/","savedTitle":"GitHub"}}}
              ]}]}}"#,
        )
        .unwrap();
        let (pins, spaces) = arc_pinned_from(&v);
        assert_eq!(spaces, 2);
        let rows: Vec<(&str, &str)> = pins
            .iter()
            .map(|b| (b.name.as_str(), b.folder.as_str()))
            .collect();
        // Today's (unpinned) tabs stay behind.
        assert_eq!(
            rows,
            vec![
                ("Wattle", "Arc/Uni"),
                ("Lab", "Arc/Uni/COMP3320"),
                ("GitHub", "Arc/Favorites")
            ]
        );
    }

    #[test]
    fn chromium_history_reads_the_last_visits() {
        let Some(tool) = crate::sqlite::tool() else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("flux-chromium-hist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let now = 1_792_971_000_000u64;
        let day = 86_400_000u64;
        let sql = format!(
            "CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT);\
             CREATE TABLE visits(id INTEGER PRIMARY KEY, url INT, visit_time INT);\
             INSERT INTO urls VALUES (1,'https://docs.rs/','Docs'),(2,'https://old.test/','Old'),(3,'chrome://settings','S');\
             INSERT INTO visits(url, visit_time) VALUES (1,{a}),(1,{b}),(2,{c}),(3,{a});",
            a = chrome_time(now - day),
            b = chrome_time(now - 2 * day),
            c = chrome_time(now - 400 * day),
        );
        assert!(std::process::Command::new(&tool)
            .arg(dir.join("History"))
            .arg(sql)
            .status()
            .unwrap()
            .success());
        let got = history("chrome", &dir, now - 180 * day).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].url, "https://docs.rs/");
        assert_eq!(got[0].visits, 2);
        assert_eq!(got[0].last_visit_ms, now - day);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
