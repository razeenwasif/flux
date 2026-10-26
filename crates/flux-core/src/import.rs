//! The welcome's import (Flux Next "welcome"): what other browsers on this
//! machine have, and bringing it into Flux — bookmarks (each browser's bar
//! becomes Flux's), the last 180 days of history, and Arc's pinned sites.
//! The reading is flux-import's browsers.rs; this puts it in Flux's stores.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bookmarks::BookmarkStore;
use crate::history::HistoryStore;
use flux_import::browsers::{self, FoundBrowser};

/// How far back history comes from.
const HISTORY_DAYS: u64 = 180;

fn since_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .saturating_sub(HISTORY_DAYS * 86_400_000)
}

/// Every browser on this machine and what it has. Reads databases, so off
/// the main thread.
#[tauri::command]
pub async fn import_scan() -> Vec<FoundBrowser> {
    tauri::async_runtime::spawn_blocking(|| browsers::scan(since_ms()))
        .await
        .unwrap_or_default()
}

/// One profile to bring over.
#[derive(Deserialize, Clone, Debug, specta::Type)]
pub struct ImportPick {
    pub browser: String,
    /// The profile's directory, as `import_scan` gave it.
    pub dir: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, specta::Type)]
pub struct ImportResult {
    pub bookmarks: u32,
    pub history: u32,
    pub pinned: u32,
    /// "Chrome: …" for each part that couldn't be read.
    pub failed: Vec<String>,
}

type Read = (
    Vec<(String, String, String)>,
    Vec<(String, String, u64, u32)>,
    Vec<(String, String, String)>,
    Vec<String>,
);

fn read(picks: &[ImportPick], bookmarks: bool, history: bool, pinned: bool) -> Read {
    let since = since_ms();
    let (mut books, mut pages, mut pins, mut failed) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for pick in picks {
        let name = browsers::name_of(&pick.browser);
        let dir = std::path::Path::new(&pick.dir);
        if bookmarks {
            match browsers::bookmarks(&pick.browser, dir) {
                Ok(b) => books.extend(b.into_iter().map(|b| (b.name, b.url, b.folder))),
                // A profile without a bookmarks file has none to bring.
                Err(flux_import::ImportError::Io(e))
                    if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => failed.push(format!("{name} bookmarks: {e}")),
            }
        }
        if history {
            match browsers::history(&pick.browser, dir, since) {
                Ok(v) => pages.extend(
                    v.into_iter()
                        .map(|p| (p.url, p.title, p.last_visit_ms, p.visits)),
                ),
                Err(e) => failed.push(format!("{name} history: {e}")),
            }
        }
        if pinned && pick.browser == "arc" {
            match browsers::arc_pinned() {
                Ok((p, _)) => pins.extend(p.into_iter().map(|b| (b.name, b.url, b.folder))),
                Err(e) => failed.push(format!("Arc pinned sites: {e}")),
            }
        }
    }
    (books, pages, pins, failed)
}

/// Bring the picked profiles over. Importing again adds only what's new.
#[tauri::command]
pub async fn import_run(
    bookmark_store: State<'_, BookmarkStore>,
    history_store: State<'_, HistoryStore>,
    picks: Vec<ImportPick>,
    bookmarks: bool,
    history: bool,
    pinned: bool,
) -> Result<ImportResult, String> {
    let (books, pages, pins, failed) =
        tauri::async_runtime::spawn_blocking(move || read(&picks, bookmarks, history, pinned))
            .await
            .map_err(|e| e.to_string())?;
    let result = ImportResult {
        bookmarks: bookmark_store.import(books, "") as u32,
        pinned: bookmark_store.import(pins, "") as u32,
        history: history_store.import(pages) as u32,
        failed,
    };
    history_store.persist_if_dirty();
    tracing::info!(target: "flux::import", ?result, "imported from other browsers");
    Ok(result)
}

/// A first launch: nothing visited and nothing bookmarked. The welcome shows
/// itself only then; an existing profile finds it in the launcher.
#[tauri::command]
pub async fn import_fresh(
    bookmark_store: State<'_, BookmarkStore>,
    history_store: State<'_, HistoryStore>,
) -> Result<bool, String> {
    Ok(bookmark_store.list().is_empty() && history_store.is_empty())
}

/// A site for the new tab's shortcuts.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct SiteSuggestion {
    pub url: String,
    pub host: String,
    pub title: String,
}

/// The sites you visit most, from history (imported or Flux's own), for the
/// welcome's pinned sites; Arc's Favorites first when there are any.
#[tauri::command]
pub async fn import_top_sites(
    history_store: State<'_, HistoryStore>,
    limit: Option<usize>,
) -> Result<Vec<SiteSuggestion>, String> {
    let limit = limit.unwrap_or(12).min(40);
    let favorites = tauri::async_runtime::spawn_blocking(|| {
        browsers::arc_pinned()
            .map(|(p, _)| p)
            .unwrap_or_default()
            .into_iter()
            .filter(|b| b.folder == "Arc/Favorites")
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    let host_of = |url: &str| -> String {
        let rest = url.split_once("://").map_or(url, |(_, r)| r);
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        host.strip_prefix("www.").unwrap_or(host).to_string()
    };
    let mut out: Vec<SiteSuggestion> = Vec::new();
    let mut push = |url: String, title: String| {
        let host = host_of(&url);
        if !host.is_empty() && !out.iter().any(|s| s.host == host) {
            out.push(SiteSuggestion { url, host, title });
        }
    };
    for f in favorites {
        push(f.url, f.name);
    }
    for (host, title, _) in history_store.top_sites(limit * 2) {
        push(format!("https://{host}/"), title);
    }
    out.truncate(limit);
    Ok(out)
}

/// System Settings at Full Disk Access, where Flux can be let into Safari's
/// (and on recent macOS, Chrome's and Firefox's) data.
#[tauri::command]
pub fn import_open_disk_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("only macOS keeps browsers' data behind Full Disk Access".into())
}
