//! HTTPS-only mode (BACKLOG #58): upgrade `http://` → `https://` through the
//! request interceptor (ADR 0007), with a per-site "allow HTTP" exception.
//!
//! Off by default. There's no downgrade interstitial yet, so a site with no
//! HTTPS would simply fail to load under HTTPS-only — hence opt-in, plus the
//! per-site allowlist to recover ("this site is http-only, allow it").

use std::sync::atomic::{AtomicBool, Ordering};

use dashmap::DashMap;
use serde::Serialize;
use tauri::State;

pub struct HttpsState {
    enabled: AtomicBool,
    /// Hosts the user has allowed to stay on plain HTTP.
    allow_http: DashMap<String, ()>,
}

impl Default for HttpsState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            allow_http: DashMap::new(),
        }
    }
}

impl HttpsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// If this `http://` URL should be upgraded, return its `https://` form.
    /// `None` when disabled, already secure, loopback/`.local`, or allowlisted.
    pub fn upgrade(&self, url: &str) -> Option<String> {
        if !self.enabled.load(Ordering::Relaxed) {
            return None;
        }
        let rest = url.strip_prefix("http://")?;
        let host = rest.split(['/', '?', '#', ':']).next().unwrap_or(rest);
        if is_local(host) || self.allow_http.contains_key(host) {
            return None;
        }
        Some(format!("https://{rest}"))
    }

    fn status(&self) -> HttpsStatus {
        HttpsStatus {
            enabled: self.enabled.load(Ordering::Relaxed),
            sites_allow_http: self.allow_http.iter().map(|e| e.key().clone()).collect(),
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct HttpsStatus {
    pub enabled: bool,
    /// Hosts allowlisted to stay on HTTP.
    pub sites_allow_http: Vec<String>,
}

/// Loopback / local hosts are never upgraded (no public HTTPS).
fn is_local(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.starts_with("127.")
        || host == "[::1]"
        || host == "0.0.0.0"
}

#[tauri::command]
pub fn https_status(state: State<'_, HttpsState>) -> HttpsStatus {
    state.status()
}

#[tauri::command]
pub fn https_set_enabled(state: State<'_, HttpsState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
}

/// Allow (or stop allowing) a host to stay on plain HTTP under HTTPS-only.
#[tauri::command]
pub fn https_allow_site(state: State<'_, HttpsState>, host: String, allow: bool) {
    if allow {
        state.allow_http.insert(host, ());
    } else {
        state.allow_http.remove(&host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_only_when_enabled() {
        let s = HttpsState::new();
        assert_eq!(s.upgrade("http://example.com/x"), None); // off by default
        s.enabled.store(true, Ordering::Relaxed);
        assert_eq!(
            s.upgrade("http://example.com/x?q=1").as_deref(),
            Some("https://example.com/x?q=1")
        );
        assert_eq!(s.upgrade("https://example.com/x"), None); // already secure
        assert_eq!(s.upgrade("http://localhost:8080/x"), None); // loopback
        assert_eq!(s.upgrade("http://127.0.0.1/x"), None);
    }

    #[test]
    fn per_site_allowlist() {
        let s = HttpsState::new();
        s.enabled.store(true, Ordering::Relaxed);
        s.allow_http.insert("old.example".into(), ());
        assert_eq!(s.upgrade("http://old.example/p"), None); // allowlisted → stays http
        assert!(s.upgrade("http://other.example/p").is_some());
    }
}
