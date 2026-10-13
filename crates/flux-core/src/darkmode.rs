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
    /// Where the setting is kept between runs. `None` = in memory only.
    path: Option<std::path::PathBuf>,
}

impl DarkState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The setting from the last run. The shell owns it (localStorage) and
    /// sends it again once booted, but setup opens the restored tab's page
    /// before that (boot.rs). Without this, a force-dark user's first page
    /// loaded light and flipped dark when the shell caught up.
    pub fn restore(path: std::path::PathBuf) -> Self {
        let on = std::fs::read_to_string(&path).is_ok_and(|s| s.trim() == "1");
        Self {
            on: AtomicBool::new(on),
            path: Some(path),
        }
    }

    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }

    /// Store the setting, writing it out only when it changed: the shell
    /// sends the same value on every boot. Queued, since this runs on the main
    /// thread; the exit flush writes anything still pending.
    fn set(&self, on: bool) {
        if self.on.swap(on, Ordering::Relaxed) != on {
            if let Some(p) = &self.path {
                crate::persist::queue_text(
                    p,
                    if on { "1" } else { "0" },
                    crate::persist::Durability::Barrier,
                );
            }
        }
    }
}

/// Toggle force-dark on every live tab and web panel, right now. New tabs pick
/// the state up from the init script's `__FLUX_DARK__` flag, and each page a tab
/// loads later from its page-load hook.
pub fn apply(app: &AppHandle, on: bool) {
    let js = format!("window.__fluxDark&&window.__fluxDark({on})");
    for (label, wv) in app.webviews() {
        // Web panels get darkmode.js and the boot flag too (panel_open).
        if label.starts_with("tab-") || label.starts_with("panel-") {
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
    state.set(on);
    apply(&app, on);
}

#[cfg(test)]
mod tests {
    use super::DarkState;

    #[test]
    fn the_setting_survives_a_restart_and_a_repeat_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("flux-dark-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("darkmode.txt");
        let state = DarkState::restore(path.clone());
        assert!(!state.is_on(), "off until the user turns it on");
        // The shell sends its value on every boot; an unchanged one is no write.
        state.set(false);
        assert!(!path.exists());
        state.set(true);
        assert!(DarkState::restore(path.clone()).is_on());
        state.set(false);
        assert!(!DarkState::restore(path.clone()).is_on());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
