//! Browser-context bridge for the embedded terminal (BACKLOG #65/#4).
//!
//! A `flux` CLI run *inside* the terminal needs the active page's content, but
//! it's a separate process. On Windows the terminal is usually WSL, whose own
//! network namespace can't reach a Windows-side loopback socket — so the bridge
//! is a plain file: Flux writes the active tab's context to
//! `<app_data>/rpc/active.json`, and the CLI reads it. The path reaches the
//! shell via `FLUX_RPC_DIR` (+ `WSLENV` `/p`, so WSL sees the translated `/mnt`
//! path). The CLI side lives in `cli.rs`.
//!
//! Only *browser* tabs produce context; switching to a terminal/files tab keeps
//! the last page's context (you usually want the page you were just looking at).
//! Private tabs write a `{ "private": true }` stub — no URL/text on disk.

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

use crate::state::FluxState;
use crate::state::TabKind;

/// Where the active-page context file lives (managed state so `terminal_env`
/// and the spawner can hand it to the shell).
pub struct RpcDir(pub PathBuf);

impl RpcDir {
    pub fn dir(&self) -> &std::path::Path {
        &self.0
    }
    fn active_path(&self) -> PathBuf {
        self.0.join("active.json")
    }
}

#[derive(Serialize)]
struct ActiveContext {
    tab_id: u64,
    url: String,
    title: String,
    private: bool,
    /// `captured_at_ms` of the snapshot (0 if none yet).
    captured_ms: u64,
    text: String,
    /// Absolute http(s) links found on the page, deduped + capped.
    links: Vec<String>,
}

/// Recompute + atomically write `active.json` from the current active tab.
/// Called on `dom_publish` (active tab) and on tab switch. No-op without an
/// `RpcDir`. Keeps the last browser context when the active tab isn't a browser.
pub fn publish_active(app: &tauri::AppHandle) {
    let Some(dir) = app.try_state::<RpcDir>() else { return };
    let state = app.state::<FluxState>();
    let Some(id) = state.active_tab() else { return };
    let Some(tab) = state.tabs.get(&id) else { return };
    if tab.kind != TabKind::Browser {
        return; // terminal/files tab → leave the last page's context in place
    }

    let ctx = if tab.private {
        // Private tabs leave no trace on disk.
        ActiveContext { tab_id: id, url: String::new(), title: String::new(), private: true, captured_ms: 0, text: String::new(), links: Vec::new() }
    } else {
        let snap = state.dom_cache.get(&id);
        let Some(snap) = snap else { return }; // no snapshot yet → keep last
        ActiveContext {
            tab_id: id,
            url: tab.url.clone(),
            title: tab.title.clone(),
            private: false,
            captured_ms: snap.captured_at_ms,
            text: snap.text.to_string(),
            links: extract_links(&snap.html),
        }
    };
    drop(tab);
    write_atomic(&dir.active_path(), &ctx);
}

/// Serialize + write via a temp file then rename, so a reader never sees a
/// half-written file.
fn write_atomic(path: &std::path::Path, ctx: &ActiveContext) {
    let Ok(json) = serde_json::to_string_pretty(ctx) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, path); // replaces on all platforms
    }
}

/// Extract absolute http(s) hrefs from captured HTML — deduped, capped. A simple
/// scan (no HTML parser dependency); good enough for `flux extract-json | jq`.
fn extract_links(html: &str) -> Vec<String> {
    const CAP: usize = 500;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, _) in html.match_indices("href=") {
        let rest = &html[i + 5..];
        let quote = match rest.as_bytes().first() {
            Some(b'"') => '"',
            Some(b'\'') => '\'',
            _ => continue,
        };
        let rest = &rest[1..];
        let Some(end) = rest.find(quote) else { continue };
        let href = &rest[..end];
        if (href.starts_with("http://") || href.starts_with("https://")) && seen.insert(href) {
            out.push(href.to_string());
            if out.len() >= CAP {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_absolute_links_deduped() {
        // r##"…"## because the content contains `"#` (href="#frag").
        let html = r##"<a href="https://a.com/x">A</a><a href='https://b.com'>B</a>
            <a href="/relative">rel</a><a href="https://a.com/x">dup</a><a href="#frag">f</a>"##;
        let links = extract_links(html);
        assert_eq!(links, vec!["https://a.com/x".to_string(), "https://b.com".to_string()]);
    }

    #[test]
    fn ignores_non_http_and_malformed() {
        assert!(extract_links(r#"<a href="mailto:x@y.z">m</a><a href=noquote>n</a>"#).is_empty());
    }
}
