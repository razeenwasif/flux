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
}

impl Default for TrackingState {
    fn default() -> Self {
        Self {
            level: AtomicI32::new(2),
        } // Balanced
    }
}

impl TrackingState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn level(&self) -> i32 {
        self.level.load(Ordering::Relaxed)
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
        s.level.store(level, Ordering::Relaxed);
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
