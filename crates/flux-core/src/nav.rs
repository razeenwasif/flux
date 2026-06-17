//! Navigation toggles (BACKLOG #51/#52): Vim-style link hints + mouse gestures.
//! The behaviour lives in `assets/nav.js` (injected into every tab, inert until
//! enabled); this just holds the two flags, stamps them into new tabs' init
//! script (`__FLUX_NAV__`), and flips them live across open tabs on toggle.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct NavState {
    hints: AtomicBool,
    gestures: AtomicBool,
}

impl NavState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn hints(&self) -> bool {
        self.hints.load(Ordering::Relaxed)
    }
    pub fn gestures(&self) -> bool {
        self.gestures.load(Ordering::Relaxed)
    }
}

fn apply(app: &AppHandle, hints: bool, gestures: bool) {
    let js = format!("window.__fluxNavSet&&window.__fluxNavSet({hints},{gestures})");
    for (label, wv) in app.webviews() {
        if label.starts_with("tab-") {
            let _ = wv.eval(&js);
        }
    }
}

#[tauri::command]
pub fn nav_status(state: State<'_, NavState>) -> (bool, bool) {
    (state.hints(), state.gestures())
}

#[tauri::command]
pub fn nav_set(app: AppHandle, state: State<'_, NavState>, hints: bool, gestures: bool) {
    state.hints.store(hints, Ordering::Relaxed);
    state.gestures.store(gestures, Ordering::Relaxed);
    apply(&app, hints, gestures);
}
