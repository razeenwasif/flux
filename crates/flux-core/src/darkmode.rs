//! Force-dark for all sites (BACKLOG #40). Rather than only flipping WebView2's
//! `prefers-color-scheme` (which darkens only sites that opt in, and is a no-op
//! on the WebKitGTK build), we inject a CSS "smart invert" into every tab webview
//! (`assets/darkmode.js`). That's engine-agnostic — it works on WebView2 and
//! WebKitGTK and on every site regardless of dark-mode support — and it toggles
//! live. The boot state is stamped into each tab's init script (`__FLUX_DARK__`).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct DarkState {
    on: AtomicBool,
}

impl DarkState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }
}

/// Toggle force-dark on every live tab webview, right now. New tabs pick the
/// state up from the init script's `__FLUX_DARK__` flag.
pub fn apply(app: &AppHandle, on: bool) {
    let js = format!("window.__fluxDark&&window.__fluxDark({on})");
    for (label, wv) in app.webviews() {
        if label.starts_with("tab-") {
            let _ = wv.eval(&js);
        }
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
