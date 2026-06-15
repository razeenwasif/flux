//! Content-blocker shields (BACKLOG #57) — the policy layer over `flux-filter`.
//!
//! Holds the compiled filter engine plus the user's choices: a **global** on/off
//! and a **per-site allowlist** (turn shields off for a site you trust), checked
//! before the engine runs. The native request interceptor (ADR 0007) calls
//! [`ShieldsState::should_block`] for every request; the frontend drives the
//! toggles and reads the blocked-request count for the shields badge.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use flux_filter::Filter;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// The bundled curated starter list (major ad/tracker networks) — always active,
/// so blocking works offline / before the big lists download.
const DEFAULT_FILTERS: &str = include_str!("../assets/default-filters.txt");

/// Upstream filter lists fetched + cached on top of the bundled default.
/// `(cache filename, url)`.
const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt"),
];

/// Re-fetch a cached list once it's older than this.
const MAX_AGE_DAYS: u64 = 5;

pub struct ShieldsState {
    filter: RwLock<Filter>,
    /// Page hosts where the user turned shields OFF (allowlist).
    off_for: DashMap<String, ()>,
    enabled: AtomicBool,
    blocked: AtomicU64,
    /// Where fetched lists are cached (`None` → bundled default only; tests).
    filters_dir: Option<PathBuf>,
}

impl Default for ShieldsState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ShieldsState {
    /// Start with the bundled default list (fast — parsing the big lists is
    /// deferred to [`refresh`](Self::refresh) on a background thread).
    pub fn new(filters_dir: Option<PathBuf>) -> Self {
        Self {
            filter: RwLock::new(Filter::from_list(DEFAULT_FILTERS)),
            off_for: DashMap::new(),
            enabled: AtomicBool::new(true),
            blocked: AtomicU64::new(0),
            filters_dir,
        }
    }

    /// Fetch any stale/missing upstream lists, then rebuild the filter from the
    /// bundled default + every cached list and swap it in. Blocking + heavy
    /// (parses tens of thousands of rules) — call from a background thread.
    pub fn refresh(&self) {
        let Some(dir) = &self.filters_dir else { return };
        let _ = std::fs::create_dir_all(dir);
        for (name, url) in LISTS {
            let path = dir.join(name);
            if is_stale(&path) {
                match fetch(url) {
                    Ok(body) if body.len() > 1024 => {
                        let _ = std::fs::write(&path, body);
                    }
                    Ok(_) => tracing::warn!(target: "flux::shields", "{url}: suspiciously small, kept old"),
                    Err(e) => tracing::warn!(target: "flux::shields", "{url}: {e}"),
                }
            }
        }
        let mut text = String::from(DEFAULT_FILTERS);
        for (name, _) in LISTS {
            if let Ok(s) = std::fs::read_to_string(dir.join(name)) {
                text.push('\n');
                text.push_str(&s);
            }
        }
        *self.filter.write() = Filter::from_list(&text);
        tracing::info!(target: "flux::shields", "content-filter lists refreshed ({} bytes of rules)", text.len());
    }

    /// The interception verdict for one request. `source_url` is the page making
    /// it (its host drives the per-site allowlist + first-/third-party rules).
    pub fn should_block(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        if let Some(host) = host_of(source_url) {
            if self.off_for.contains_key(host) {
                return false;
            }
        }
        let blocked = self.filter.read().should_block(url, source_url, request_type);
        if blocked {
            self.blocked.fetch_add(1, Ordering::Relaxed);
        }
        blocked
    }

    fn status(&self) -> ShieldsStatus {
        ShieldsStatus {
            enabled: self.enabled.load(Ordering::Relaxed),
            blocked: self.blocked.load(Ordering::Relaxed),
            sites_off: self.off_for.iter().map(|e| e.key().clone()).collect(),
        }
    }
}

#[derive(Serialize)]
pub struct ShieldsStatus {
    /// Global shields on/off.
    pub enabled: bool,
    /// Requests blocked this session.
    pub blocked: u64,
    /// Hosts the user has allowlisted (shields off).
    pub sites_off: Vec<String>,
}

/// Host of a URL (`https://a.b.com/x` → `a.b.com`), best-effort and dependency
/// -free (the URL is already validated upstream).
fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1)?;
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?; // strip userinfo
    Some(host.split(':').next().unwrap_or(host)) // strip port
}

/// A cached list is stale if missing or older than [`MAX_AGE_DAYS`].
fn is_stale(path: &Path) -> bool {
    match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(mtime) => mtime.elapsed().map(|e| e.as_secs() > MAX_AGE_DAYS * 86_400).unwrap_or(true),
        Err(_) => true,
    }
}

/// Download a filter list (a few MB) — generous timeout, off the main thread.
fn fetch(url: &str) -> Result<String, String> {
    ureq::get(url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn shields_status(state: State<'_, ShieldsState>) -> ShieldsStatus {
    state.status()
}

#[tauri::command]
pub fn shields_set_enabled(state: State<'_, ShieldsState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
}

/// Turn shields on/off for one site (`on = false` allowlists the host).
#[tauri::command]
pub fn shields_set_site(state: State<'_, ShieldsState>, host: String, on: bool) {
    if on {
        state.off_for.remove(&host);
    } else {
        state.off_for.insert(host, ());
    }
}

/// Diagnostic / agent hook: would this request be blocked? (Does not count.)
#[tauri::command]
pub fn shields_check(
    state: State<'_, ShieldsState>,
    url: String,
    source: String,
    request_type: String,
) -> bool {
    if !state.enabled.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(host) = host_of(&source) {
        if state.off_for.contains_key(host) {
            return false;
        }
    }
    state.filter.read().should_block(&url, &source, &request_type)
}

/// Re-fetch the upstream filter lists + rebuild, on a background thread (the
/// download + parse are heavy). Fire-and-forget.
#[tauri::command]
pub fn shields_refresh(app: AppHandle) {
    std::thread::spawn(move || app.state::<ShieldsState>().refresh());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_list_blocks_a_major_tracker() {
        let s = ShieldsState::new(None);
        assert!(s.should_block("https://www.google-analytics.com/analytics.js", "https://news.com", "script"));
        assert!(s.should_block("https://doubleclick.net/ad", "https://news.com", "image"));
        assert!(!s.should_block("https://news.com/app.js", "https://news.com", "script"));
    }

    #[test]
    fn global_toggle_and_per_site_allowlist() {
        let s = ShieldsState::new(None);
        let (url, page) = ("https://google-analytics.com/ga.js", "https://news.com");
        assert!(s.should_block(url, page, "script"));

        // Allowlist the page host → no longer blocked there.
        s.off_for.insert("news.com".into(), ());
        assert!(!s.should_block(url, page, "script"));
        // …but still blocked on another site.
        assert!(s.should_block(url, "https://other.com", "script"));

        // Global off → nothing blocked anywhere.
        s.enabled.store(false, Ordering::Relaxed);
        assert!(!s.should_block(url, "https://other.com", "script"));
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.com/x?y"), Some("a.b.com"));
        assert_eq!(host_of("http://user@h.com:8080/p"), Some("h.com"));
        assert_eq!(host_of("not a url"), None);
    }
}
