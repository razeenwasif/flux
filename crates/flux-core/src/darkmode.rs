//! Native dark mode (BACKLOG #40-ish). Sets WebView2's profile-level
//! `PreferredColorScheme` to Dark, so pages that honor `prefers-color-scheme`
//! (most modern sites) render dark — no CSS-filter hacks. The setting is
//! profile-wide, so it applies to every tab at once and persists with the
//! profile. Off = Auto (follow the OS).
//!
//! For sites that *don't* support `prefers-color-scheme`, Chromium's algorithmic
//! force-dark is a heavier, startup-only browser flag — a noted follow-up.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, State};

#[derive(Default)]
pub struct DarkState {
    on: AtomicBool,
}

impl DarkState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Apply the preferred color scheme to the shared WebView2 profile.
pub fn apply(app: &AppHandle, on: bool) {
    #[cfg(windows)]
    win::apply(app, on);
    #[cfg(not(windows))]
    {
        let _ = (app, on);
    }
}

#[tauri::command]
pub fn darkmode_status(state: State<'_, DarkState>) -> bool {
    state.on.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn darkmode_set(app: AppHandle, state: State<'_, DarkState>, on: bool) {
    state.on.store(on, Ordering::Relaxed);
    apply(&app, on);
}

#[cfg(windows)]
mod win {
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_13, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
        COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
    };
    use windows::core::Interface;

    pub fn apply(app: &AppHandle, on: bool) {
        // PreferredColorScheme is profile-level (shared by every tab webview in
        // this environment), so setting it through the always-alive main webview
        // takes effect for all pages.
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let _ = win.with_webview(move |platform| unsafe {
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
            let scheme = if on {
                COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
            } else {
                COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO
            };
            let _ = profile.SetPreferredColorScheme(scheme);
        });
    }
}
