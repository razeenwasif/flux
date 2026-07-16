//! Per-site "lean mode" (BACKLOG #105) — trim heavy page weight on demand.
//!
//! Research basis: ~70% of a page's JavaScript functions are never called
//! (arXiv 2106.08948 Muzeel, 2308.16729 Lacuna), and stripping unused JS cuts
//! parse time, execution, and RAM ~60%/~30%. The *fully dynamic* version of that
//! — record which functions actually run (a DevTools/CDP coverage trace), then
//! lazy-load or empty the rest with a screenshot-diff correctness oracle — needs
//! a coverage hook the native webviews don't expose through Tauri today. That
//! remains the research follow-up (see BACKLOG).
//!
//! What ships now is the achievable, safe slice: an **opt-in per-site** toggle
//! that, when on for a host, applies a curated supplementary "performance"
//! filter list (`assets/lean-filters.txt` — tag managers, product analytics,
//! A/B testing, session replay, chat/social widgets) on top of normal shields.
//! Blocking those heavy non-essential third-party scripts produces the same
//! practical effect (less JS to fetch/parse/run) without per-page coverage. It's
//! opt-in because it can break live chat / logged-in flows, so it's wrong as a
//! global default.
//!
//! Wiring: the request interceptor (#91, ADR 0007 — verified on WebView2) ORs
//! [`LeanState::should_block`] with the shields verdict for opted-in source
//! hosts. The decision layer here is engine-independent and unit-tested; the
//! per-backend interceptor hookup follows the same path shields already use.

use std::sync::atomic::{AtomicBool, Ordering};

use dashmap::DashMap;
use flux_filter::Filter;
use serde::Serialize;
use tauri::State;

/// The curated performance list, compiled once at startup.
const LEAN_FILTERS: &str = include_str!("../assets/lean-filters.txt");

pub struct LeanState {
    /// The supplementary performance filter (only consulted for opted-in hosts).
    filter: Filter,
    /// Page hosts the user turned lean mode ON for.
    on_for: DashMap<String, ()>,
    /// Master kill-switch (defaults on; individual sites are still opt-in).
    enabled: AtomicBool,
}

impl Default for LeanState {
    fn default() -> Self {
        Self::new()
    }
}

impl LeanState {
    pub fn new() -> Self {
        Self {
            filter: Filter::from_list(LEAN_FILTERS),
            on_for: DashMap::new(),
            enabled: AtomicBool::new(true),
        }
    }

    /// Is lean mode active for this page host?
    pub fn active_for(&self, host: &str) -> bool {
        self.enabled.load(Ordering::Relaxed) && self.on_for.contains_key(host)
    }

    /// The extra block verdict: `true` only when lean mode is on for the page's
    /// host AND the request matches the performance list. ORed with shields by
    /// the interceptor — never relaxes a normal-shields block.
    pub fn should_block(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        let Some(host) = host_of(source_url) else {
            return false;
        };
        if !self.active_for(host) {
            return false;
        }
        self.filter.should_block(url, source_url, request_type)
    }

    fn status(&self) -> LeanStatus {
        LeanStatus {
            enabled: self.enabled.load(Ordering::Relaxed),
            sites_on: self.on_for.iter().map(|e| e.key().clone()).collect(),
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct LeanStatus {
    pub enabled: bool,
    /// Hosts with lean mode turned on.
    pub sites_on: Vec<String>,
}

/// Host of a URL (`https://a.b/c` → `a.b`), dependency-free.
fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next().unwrap_or("");
    (!host.is_empty()).then_some(host)
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn lean_status(state: State<'_, LeanState>) -> LeanStatus {
    state.status()
}

/// Master on/off for the whole feature.
#[tauri::command]
pub fn lean_set_enabled(state: State<'_, LeanState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
}

/// Turn lean mode on/off for one site.
#[tauri::command]
pub fn lean_set_site(state: State<'_, LeanState>, host: String, on: bool) {
    if on {
        state.on_for.insert(host, ());
    } else {
        state.on_for.remove(&host);
    }
}

/// Webview layer hook: is lean mode active for this page host? (Drives whether
/// the interceptor consults the performance list for the page's requests.)
#[tauri::command]
pub fn lean_active_for(state: State<'_, LeanState>, host: String) -> bool {
    state.active_for(&host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_heavy_scripts_only_for_opted_in_sites() {
        let s = LeanState::new();
        let (gtm, page) = (
            "https://www.googletagmanager.com/gtm.js?id=GTM-X",
            "https://shop.com",
        );
        // Off by default → nothing extra blocked.
        assert!(!s.should_block(gtm, page, "script"));
        // Opt the site in → the performance list now applies there.
        s.on_for.insert("shop.com".into(), ());
        assert!(s.should_block(gtm, page, "script"));
        // …but not on a site that hasn't opted in.
        assert!(!s.should_block(gtm, "https://other.com", "script"));
    }

    #[test]
    fn first_party_app_js_is_never_touched() {
        let s = LeanState::new();
        s.on_for.insert("shop.com".into(), ());
        assert!(!s.should_block(
            "https://shop.com/app.bundle.js",
            "https://shop.com",
            "script"
        ));
    }

    #[test]
    fn master_switch_disables_everything() {
        let s = LeanState::new();
        s.on_for.insert("shop.com".into(), ());
        s.enabled.store(false, Ordering::Relaxed);
        assert!(!s.should_block(
            "https://static.hotjar.com/c/hotjar.js",
            "https://shop.com",
            "script"
        ));
        assert!(!s.active_for("shop.com"));
    }

    #[test]
    fn status_reports_opted_in_sites() {
        let s = LeanState::new();
        s.on_for.insert("a.com".into(), ());
        let st = s.status();
        assert!(st.enabled);
        assert_eq!(st.sites_on, vec!["a.com".to_string()]);
    }
}
