//! Navigation toggles (BACKLOG #51/#52): Vim-style link hints + mouse gestures.
//! The behaviour lives in `assets/nav.js` (added to pages only while one of
//! the two is on, webview.rs); this holds the two flags, stamps them into new
//! tabs' init script (`__FLUX_NAV__`), and flips them live across open tabs
//! on toggle, adding the script to pages that don't have it.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct NavState {
    hints: AtomicBool,
    gestures: AtomicBool,
    /// Where the flags are kept between runs. `None` = in memory only.
    path: Option<std::path::PathBuf>,
}

/// The file's text for a pair of flags: hints, then gestures, as `0`/`1`.
fn encode(hints: bool, gestures: bool) -> String {
    format!("{}{}", u8::from(hints), u8::from(gestures))
}

impl NavState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The flags from the last run. The shell owns them (localStorage) and
    /// sends them again once booted, but setup opens the restored tab's page
    /// before that (boot.rs), and that page kept the defaults: link hints and
    /// gestures did nothing there until it was reloaded.
    pub fn restore(path: std::path::PathBuf) -> Self {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let mut flags = text.trim().bytes().map(|b| b == b'1');
        Self {
            hints: AtomicBool::new(flags.next().unwrap_or(false)),
            gestures: AtomicBool::new(flags.next().unwrap_or(false)),
            path: Some(path),
        }
    }

    pub fn hints(&self) -> bool {
        self.hints.load(Ordering::Relaxed)
    }
    pub fn gestures(&self) -> bool {
        self.gestures.load(Ordering::Relaxed)
    }

    /// Store the flags, writing them out only when they changed: the shell
    /// sends the same pair on every boot. Queued, since this runs on the main
    /// thread; the exit flush writes anything still pending.
    fn set(&self, hints: bool, gestures: bool) {
        let was = (
            self.hints.swap(hints, Ordering::Relaxed),
            self.gestures.swap(gestures, Ordering::Relaxed),
        );
        if was != (hints, gestures) {
            if let Some(p) = &self.path {
                crate::persist::queue_text(
                    p,
                    &encode(hints, gestures),
                    crate::persist::Durability::Barrier,
                );
            }
        }
    }
}

fn apply(app: &AppHandle, hints: bool, gestures: bool) {
    // nav.js goes only into pages loaded while one is on; open pages get it now.
    if hints || gestures {
        crate::webview::add_page_script(app, None, "nav");
    }
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
    state.set(hints, gestures);
    apply(&app, hints, gestures);
}

#[cfg(test)]
mod tests {
    use super::NavState;

    #[test]
    fn the_flags_survive_a_restart_and_a_repeat_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("flux-nav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nav.txt");
        let state = NavState::restore(path.clone());
        assert!(!state.hints() && !state.gestures(), "off until turned on");
        // The shell sends its pair on every boot; an unchanged one is no write.
        state.set(false, false);
        assert!(!path.exists());

        state.set(true, false);
        let back = NavState::restore(path.clone());
        assert!(back.hints() && !back.gestures());

        state.set(false, true);
        let back = NavState::restore(path.clone());
        assert!(!back.hints() && back.gestures(), "each flag is its own");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_reads_as_off() {
        let dir = std::env::temp_dir().join(format!("flux-nav-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("nav.txt");
        for text in ["", "x", "1", "yes"] {
            std::fs::write(&path, text).unwrap();
            let s = NavState::restore(path.clone());
            // Only a `1` turns a flag on; a short file leaves the rest off.
            assert_eq!(s.hints(), text == "1", "{text:?}");
            assert!(!s.gestures(), "{text:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
