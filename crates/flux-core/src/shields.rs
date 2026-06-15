//! Content-blocker shields (BACKLOG #57) — the policy layer over `flux-filter`.
//!
//! Holds the compiled filter engine plus the user's choices: a **global** on/off
//! and a **per-site allowlist** (turn shields off for a site you trust), checked
//! before the engine runs. The native request interceptor (ADR 0007) calls
//! [`ShieldsState::should_block`] for every request; the frontend drives the
//! toggles and reads the blocked-request count for the shields badge.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use dashmap::DashMap;
use flux_filter::Filter;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::State;

/// The bundled curated starter list (major ad/tracker networks). Fetching full
/// EasyList/uBO lists is the next increment (ADR 0007).
const DEFAULT_FILTERS: &str = include_str!("../assets/default-filters.txt");

pub struct ShieldsState {
    filter: RwLock<Filter>,
    /// Page hosts where the user turned shields OFF (allowlist).
    off_for: DashMap<String, ()>,
    enabled: AtomicBool,
    blocked: AtomicU64,
}

impl Default for ShieldsState {
    fn default() -> Self {
        Self {
            filter: RwLock::new(Filter::from_list(DEFAULT_FILTERS)),
            off_for: DashMap::new(),
            enabled: AtomicBool::new(true),
            blocked: AtomicU64::new(0),
        }
    }
}

impl ShieldsState {
    pub fn new() -> Self {
        Self::default()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_list_blocks_a_major_tracker() {
        let s = ShieldsState::new();
        assert!(s.should_block("https://www.google-analytics.com/analytics.js", "https://news.com", "script"));
        assert!(s.should_block("https://doubleclick.net/ad", "https://news.com", "image"));
        assert!(!s.should_block("https://news.com/app.js", "https://news.com", "script"));
    }

    #[test]
    fn global_toggle_and_per_site_allowlist() {
        let s = ShieldsState::new();
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
