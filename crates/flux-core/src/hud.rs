//! The floating answer card (`IndexerHud.tsx`): ask your notes and read the
//! answer without leaving the page.
//!
//! Native tab webviews sit above all of the chrome's HTML, so nothing the shell
//! draws can float over a page. The card is therefore a small transparent child
//! webview of its own, top right of the content card. It's made when you ask and
//! closed when you dismiss it, so it costs no memory the rest of the time, and
//! each question starts clean.
//!
//! Two ways in: a system-wide hotkey, which is the `indexer-listen` command in
//! the key registry so Settings → Keyboard rebinds it (registering it with the
//! OS takes no permission), and `flux --ask [question]`. From another app the
//! hotkey brings Flux forward first: the page is what the card floats over.
//!
//! The first press opens the card and listens. A second stops and asks while it
//! is listening, and dismisses it otherwise.
//!
//! The card runs from the app's own assets and is the same trust as the shell:
//! it gets the main window's capability, and tab pages can't reach it.

use parking_lot::Mutex;
use tauri::AppHandle;

/// The key registry's name for the hotkey.
pub const COMMAND: &str = "indexer-listen";

/// `flux --ask "…"` before the card has asked for it.
static QUESTION: Mutex<Option<String>> = Mutex::new(None);

/// The card's question, if it was opened with one; otherwise it listens.
#[tauri::command]
pub fn hud_take_question() -> Option<String> {
    QUESTION.lock().take()
}

/// What `flux --ask` carries: no words means listen.
pub(crate) fn question_of(words: &str) -> Option<String> {
    let q = words.trim();
    (!q.is_empty()).then(|| q.to_string())
}

/// A rectangle for the card: `height` tall at most what fits, top right of the
/// content card, or of the window when the content card's rect is from another
/// window size. Logical px.
#[cfg_attr(mobile, allow(dead_code))]
fn place(
    content: Option<crate::state::ContentRect>,
    window: (f64, f64),
    height: f64,
) -> crate::state::Bounds {
    const WIDTH: f64 = 456.0;
    // The card draws 8 px inside the webview, for its shadow.
    const MARGIN: f64 = 4.0;
    const MIN_H: f64 = 64.0;
    let (win_w, win_h) = window;
    let area = content
        .filter(|r| {
            (r.window_width - win_w).abs() < 1.0
                && (r.window_height - win_h).abs() < 1.0
                && r.width >= 1.0
                && r.height >= 1.0
        })
        .map_or(
            crate::state::Bounds {
                x: 0.0,
                y: 0.0,
                width: win_w,
                height: win_h,
            },
            |r| r.bounds(),
        );
    let width = WIDTH.min((area.width - 2.0 * MARGIN).max(0.0));
    let room = (area.height - 2.0 * MARGIN).max(MIN_H);
    crate::state::Bounds {
        x: area.x + area.width - width - MARGIN,
        y: area.y + MARGIN,
        width,
        height: height.clamp(MIN_H, room),
    }
}

#[cfg(desktop)]
mod imp {
    use std::sync::atomic::{AtomicU64, Ordering};

    use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    use super::{place, COMMAND, QUESTION};
    use crate::state::{Bounds, FluxState};

    const LABEL: &str = "indexer-hud";
    /// Before the card has said how tall it is: its ask row and status line.
    const FIRST_HEIGHT: f64 = 96.0;
    /// The card's last height, in logical px: a resized window keeps it.
    static HEIGHT: AtomicU64 = AtomicU64::new(0);

    fn height() -> f64 {
        match HEIGHT.load(Ordering::Relaxed) {
            0 => FIRST_HEIGHT,
            bits => f64::from_bits(bits),
        }
    }

    fn bounds(app: &AppHandle) -> Option<Bounds> {
        let window = app.get_window(crate::webview::CHROME_WINDOW)?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.inner_size().ok()?.to_logical::<f64>(scale);
        let content = app.try_state::<FluxState>().and_then(|s| s.content_rect());
        Some(place(content, (size.width, size.height), height()))
    }

    fn apply(wv: &tauri::Webview, b: Bounds) {
        let _ = wv.set_position(LogicalPosition::new(b.x, b.y));
        let _ = wv.set_size(LogicalSize::new(b.width, b.height));
    }

    /// Open the card, or tell the one that's open the key was pressed again.
    /// Off the main thread: making a webview waits on it. A thread of its own,
    /// not a task: `flux --ask` arrives from single-instance's listener, which
    /// blocks a Tokio worker on accept, and a task spawned from there sits in
    /// that worker's unstealable next-task slot until the next connection.
    pub(super) fn toggle(app: &AppHandle, question: Option<String>) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Some(wv) = app.get_webview(LABEL) {
                let _ = wv.set_focus();
                let _ = app.emit_to(
                    tauri::EventTarget::webview(LABEL),
                    "flux://hud-again",
                    question,
                );
                return;
            }
            *QUESTION.lock() = question;
            if let Err(e) = open(&app) {
                tracing::warn!(target: "flux::hud", "couldn't open the answer card: {e}");
            }
        });
    }

    fn open(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_window(crate::webview::CHROME_WINDOW)
            .ok_or("chrome window missing")?;
        // The page is what it floats over, so from another app Flux comes forward.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        HEIGHT.store(0, Ordering::Relaxed);
        let b = bounds(app).ok_or("the window has no size")?;
        let builder =
            tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::App("hud.html".into()))
                .transparent(true)
                .focused(true)
                // A link in a note must not turn the card into that page.
                .on_navigation(crate::webview::is_app_origin);
        let wv = window
            .add_child(
                builder,
                LogicalPosition::new(b.x, b.y),
                LogicalSize::new(b.width, b.height),
            )
            .map_err(|e| e.to_string())?;
        apply(&wv, b);
        let _ = wv.set_focus();
        tracing::info!(target: "flux::hud", x = b.x, y = b.y, width = b.width, "answer card opened");
        Ok(())
    }

    /// Dismiss it, and give the keyboard back to the page.
    pub(super) fn close(app: &AppHandle) {
        let Some(wv) = app.get_webview(LABEL) else {
            return;
        };
        let _ = wv.close();
        let tab = app
            .try_state::<FluxState>()
            .and_then(|s| s.active_tab())
            .and_then(|id| app.get_webview(&crate::webview::label(id)));
        if let Some(tab) = tab {
            let _ = tab.set_focus();
        } else if let Some(main) = app.get_webview(crate::webview::CHROME_WINDOW) {
            let _ = main.set_focus();
        }
        tracing::info!(target: "flux::hud", "answer card closed");
    }

    pub(super) fn resize(app: &AppHandle, h: f64) {
        if !h.is_finite() {
            return;
        }
        if HEIGHT.swap(h.to_bits(), Ordering::Relaxed) == 0 {
            tracing::info!(target: "flux::hud", height = h, "answer card loaded");
        }
        if let (Some(wv), Some(b)) = (app.get_webview(LABEL), bounds(app)) {
            apply(&wv, b);
        }
    }

    /// Nothing happens while the card isn't open.
    pub(super) fn follow(app: &AppHandle) {
        if let (Some(wv), Some(b)) = (app.get_webview(LABEL), bounds(app)) {
            apply(&wv, b);
        }
    }

    pub(super) fn raise(app: &AppHandle) {
        #[cfg(target_os = "macos")]
        if let Some(wv) = app.get_webview(LABEL) {
            let _ = wv.with_webview(|platform| {
                use objc::runtime::Object;
                use objc::{msg_send, sel, sel_impl};
                // New webviews land on top. Re-adding a view to its own parent
                // moves it to the front without reloading it.
                const NS_WINDOW_ABOVE: isize = 1;
                let view = platform.inner() as *mut Object;
                unsafe {
                    let parent: *mut Object = msg_send![view, superview];
                    if !parent.is_null() {
                        let none: *mut Object = std::ptr::null_mut();
                        let _: () = msg_send![parent, addSubview: view positioned: NS_WINDOW_ABOVE relativeTo: none];
                    }
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = app;
    }

    /// Register the hotkey with the OS, replacing any earlier one. A smoke build
    /// leaves it to the real app. A chord another app already holds, or one the
    /// OS won't take, is logged and the command still runs from the launcher.
    pub(super) fn bind(app: &AppHandle) {
        if cfg!(feature = "native-smoke") {
            return;
        }
        let shortcuts = app.global_shortcut();
        let _ = shortcuts.unregister_all();
        let Some(keys) = app.try_state::<crate::keys::KeyStore>() else {
            return;
        };
        for chord in keys.keys_for(COMMAND) {
            if let Err(e) = shortcuts.register(chord.as_str()) {
                tracing::warn!(target: "flux::hud", %chord, "couldn't take the hotkey: {e}");
            }
        }
    }

    pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle(app, None);
                }
            })
            .build()
    }
}

/// Open the card, or press its key again. `question` asks that instead of
/// listening.
pub fn toggle(app: &AppHandle, question: Option<String>) {
    #[cfg(desktop)]
    imp::toggle(app, question);
    #[cfg(mobile)]
    let _ = (app, question);
}

/// After a rebind, and at launch.
pub fn bind(app: &AppHandle) {
    #[cfg(desktop)]
    imp::bind(app);
    #[cfg(mobile)]
    let _ = app;
}

#[cfg(desktop)]
pub(crate) use imp::plugin;

/// The content card moved: the card goes with it.
pub(crate) fn follow(app: &AppHandle) {
    #[cfg(desktop)]
    imp::follow(app);
    #[cfg(mobile)]
    let _ = app;
}

/// A webview was just made, which puts it on top: the card goes back above it.
pub(crate) fn raise(app: &AppHandle) {
    #[cfg(desktop)]
    imp::raise(app);
    #[cfg(mobile)]
    let _ = app;
}

/// The launcher's "Ask out loud", and the menu bar's.
#[tauri::command]
pub fn hud_toggle(app: AppHandle) {
    toggle(&app, None);
}

/// Async, so it runs off the thread that closing a webview waits on.
#[tauri::command]
pub async fn hud_close(app: AppHandle) {
    #[cfg(desktop)]
    imp::close(&app);
    #[cfg(mobile)]
    let _ = app;
}

/// The card's height in logical px, as it has laid itself out.
#[tauri::command]
pub async fn hud_resize(app: AppHandle, height: f64) {
    #[cfg(desktop)]
    imp::resize(&app, height);
    #[cfg(mobile)]
    let _ = (app, height);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ContentRect;

    const WINDOW: (f64, f64) = (1440.0, 900.0);

    fn card() -> ContentRect {
        ContentRect {
            x: 268.0,
            y: 16.0,
            width: 900.0,
            height: 868.0,
            window_width: WINDOW.0,
            window_height: WINDOW.1,
        }
    }

    #[test]
    fn it_sits_top_right_of_the_content_card() {
        let b = place(Some(card()), WINDOW, 200.0);
        assert_eq!(b.width, 456.0);
        assert_eq!(b.x + b.width, 268.0 + 900.0 - 4.0);
        assert_eq!(b.y, 16.0 + 4.0);
        assert_eq!(b.height, 200.0);
    }

    #[test]
    fn a_long_answer_stops_at_what_fits_and_a_short_one_stays_usable() {
        assert_eq!(place(Some(card()), WINDOW, 5000.0).height, 868.0 - 8.0);
        assert_eq!(place(Some(card()), WINDOW, 1.0).height, 64.0);
    }

    #[test]
    fn a_narrow_card_narrows_it() {
        let narrow = ContentRect {
            width: 300.0,
            ..card()
        };
        let b = place(Some(narrow), WINDOW, 200.0);
        assert_eq!(b.width, 292.0);
        assert_eq!(b.x, 268.0 + 4.0);
    }

    #[test]
    fn a_rect_from_another_window_size_falls_back_to_the_window() {
        // A saved rect from before a resize says nothing about where things are.
        let stale = ContentRect {
            window_width: 1600.0,
            ..card()
        };
        let b = place(Some(stale), WINDOW, 200.0);
        assert_eq!(b.x + b.width, 1440.0 - 4.0);
        assert_eq!(b.y, 4.0);
        assert_eq!(place(None, WINDOW, 200.0), b);
    }

    #[test]
    fn no_words_means_listen() {
        assert_eq!(question_of(""), None);
        assert_eq!(question_of("   "), None);
        assert_eq!(
            question_of(" what is KKT? ").as_deref(),
            Some("what is KKT?")
        );
    }
}
