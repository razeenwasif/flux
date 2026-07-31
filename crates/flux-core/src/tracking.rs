//! Tracking prevention (BACKLOG #58) — third-party tracker + cookie blocking via
//! WebView2's native Edge tracking prevention. It's a **profile-wide** setting,
//! so applying it to any tab webview covers them all; it complements (doesn't
//! replace) the EasyList content blocker (#57). Default: Balanced.

use std::sync::atomic::{AtomicI32, Ordering};

use tauri::webview::Webview;
use tauri::{AppHandle, Manager, State};

/// 0 = Off · 1 = Basic · 2 = Balanced · 3 = Strict
/// (matches `COREWEBVIEW2_TRACKING_PREVENTION_LEVEL`).
pub struct TrackingState {
    level: AtomicI32,
    /// Where the level is saved. `None` = in-memory only (no app-data dir).
    path: Option<std::path::PathBuf>,
}

/// Balanced, matching the WebView2 default.
const DEFAULT_LEVEL: i32 = 2;

impl Default for TrackingState {
    fn default() -> Self {
        Self {
            level: AtomicI32::new(DEFAULT_LEVEL),
            path: None,
        }
    }
}

impl TrackingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load the saved level. Without this the setting was in-memory only and
    /// silently reverted to Balanced on every launch — which also made it
    /// useless as a workaround for a site the level itself breaks.
    pub fn restore(path: std::path::PathBuf) -> Self {
        let level = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok())
            .filter(|n| (0..=3).contains(n))
            .unwrap_or(DEFAULT_LEVEL);
        Self {
            level: AtomicI32::new(level),
            path: Some(path),
        }
    }

    pub fn level(&self) -> i32 {
        self.level.load(Ordering::Relaxed)
    }

    fn set(&self, level: i32) {
        self.level.store(level, Ordering::Relaxed);
        if let Some(p) = &self.path {
            crate::persist::save_text(p, &level.to_string());
        }
    }
}

/// Apply the current level to a freshly-created tab webview (profile-wide).
pub fn install(app: &AppHandle, webview: &Webview) {
    let level = app
        .try_state::<TrackingState>()
        .map(|s| s.level())
        .unwrap_or(2);
    apply(webview.clone(), level);
}

fn apply(webview: Webview, level: i32) {
    #[cfg(windows)]
    win::set_level(webview, level);
    #[cfg(not(windows))]
    {
        let _ = (webview, level);
    }
}

#[tauri::command]
pub fn tracking_status(state: State<'_, TrackingState>) -> i32 {
    state.level()
}

/// Set the tracking-prevention level (0–3) and apply it to open tabs.
#[tauri::command]
pub fn tracking_set_level(app: AppHandle, level: i32) {
    let level = level.clamp(0, 3);
    if let Some(s) = app.try_state::<TrackingState>() {
        s.set(level);
    }
    for (label, wv) in app.webviews() {
        if label.starts_with("tab-") {
            apply(wv, level);
        }
    }
}

#[cfg(windows)]
mod win {
    use tauri::webview::Webview;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL,
    };
    use windows::core::Interface;

    pub fn set_level(wv: Webview, level: i32) {
        let _ = wv.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let core13 = match core.cast::<ICoreWebView2_13>() {
                Ok(c) => c,
                Err(_) => return,
            };
            let profile = match core13.Profile() {
                Ok(p) => p,
                Err(_) => return,
            };
            let profile3 = match profile.cast::<ICoreWebView2Profile3>() {
                Ok(p) => p,
                Err(_) => return,
            };
            let _ = profile3
                .SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL(level));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("flux-track-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("tracking.txt");

        // Nothing saved yet: the WebView2 default.
        let s = TrackingState::restore(p.clone());
        assert_eq!(s.level(), DEFAULT_LEVEL);

        // Off (0) is the case that matters — it's the one people set to work
        // around a site the higher levels break, and `unwrap_or(default)` on a
        // falsy value would quietly undo it.
        s.set(0);
        assert_eq!(
            TrackingState::restore(p.clone()).level(),
            0,
            "0 must persist, not fall back"
        );

        s.set(3);
        assert_eq!(TrackingState::restore(p.clone()).level(), 3);

        // Garbage or an out-of-range value falls back rather than applying an
        // undefined level to the engine.
        std::fs::write(&p, "nonsense").unwrap();
        assert_eq!(TrackingState::restore(p.clone()).level(), DEFAULT_LEVEL);
        std::fs::write(&p, "9").unwrap();
        assert_eq!(TrackingState::restore(p.clone()).level(), DEFAULT_LEVEL);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
