//! Boot timing, and the restored tab's page started during setup.
//!
//! The restored active tab used to wait for the whole shell: WebKit up, the
//! shell's HTML, CSS and entry JS, the first render, `shell_snapshot`, then the
//! tiling effect's `webview_open`. That was a median 451 ms after the window
//! was up (performance audit 2026-10-13, #4). Setup already knows that tab, so
//! [`open_early_webview`] starts its page there, through the same creation code
//! as `webview_open`, at the rect the shell last gave it (saved in
//! session.json). The shell's own `webview_open` then finds it open and only
//! sets its bounds and shows it. Once the shell is listening for page events
//! it marks `listening`, and the page is handed over (`webview::early_handoff`).
//!
//! [`mark`] puts each step on one clock, started at the top of `main`, under
//! the `flux::boot` target in flux.log. The shell reports its own milestones
//! through the `boot_mark` command.

// Mobile opens no page during setup, so the planning below is unused there.
#![cfg_attr(mobile, allow(dead_code))]

use std::sync::OnceLock;
use std::time::Instant;

use crate::state::{Bounds, FluxState, TabId, TabKind};

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Start the boot clock. `main` calls this first, so the marks include the
/// time before Tauri exists; `run` calls it too, a no-op by then.
pub fn start_clock() {
    STARTED.get_or_init(Instant::now);
}

fn since_start_ms() -> u128 {
    STARTED.get_or_init(Instant::now).elapsed().as_millis()
}

/// Log a boot milestone with the time since the process started.
pub fn mark(name: &str) {
    tracing::info!(target: "flux::boot", mark = name, since_start_ms = since_start_ms(), "boot mark");
}

/// A milestone in the shell's own boot (first paint, its first page webview),
/// logged on the same clock as the Rust marks. `listening` (its page-event
/// listeners are live) is also when the shell can take over the page setup
/// opened, so that mark hands it over.
#[tauri::command]
pub async fn boot_mark(app: tauri::AppHandle, name: String) {
    if !is_mark_name(&name) {
        return;
    }
    mark(&format!("shell.{name}"));
    #[cfg(desktop)]
    if name == "listening" {
        crate::webview::early_handoff(&app);
    }
    #[cfg(mobile)]
    let _ = app;
}

/// Only short plain labels reach the log. The shell is the only caller, but a
/// log line is no place for whatever a bug might send.
fn is_mark_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

/// How setup opens the restored active tab's page.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EarlyPlan {
    pub tab_id: TabId,
    pub url: String,
    pub at: Bounds,
    /// Shown at once only in a window the size the saved rect was laid out in.
    /// Otherwise the page loads hidden, and the shell shows it once it has
    /// measured where it goes.
    pub visible: bool,
}

/// The shell's default sidebar width (App.tsx), for a page opened before any
/// rect was saved. That page is hidden, and the shell sets its real bounds
/// before showing it, so this only sets the width of its first layout.
const DEFAULT_SIDEBAR_W: f64 = 252.0;

/// Below this a guessed rect is no use even as a first layout width.
const MIN_GUESS: f64 = 200.0;

/// Decide whether setup opens the active tab's page, and where. `window` is
/// the chrome window's inner size in logical px. `Err` says why not, for the
/// boot log.
///
/// Only a plain web page in view: the shell renders flux:// pages, terminals
/// and files itself, a private tab is never restored (and must not load before
/// the shell can mark it), and a tab in another workspace or a folder isn't
/// what the shell will put on screen.
pub(crate) fn plan(state: &FluxState, window: (f64, f64)) -> Result<EarlyPlan, &'static str> {
    let id = state.active_tab().ok_or("no active tab")?;
    let tab = state
        .tabs
        .get(&id)
        .map(|t| t.value().clone())
        .ok_or("no active tab")?;
    if tab.kind != TabKind::Browser {
        return Err("the active tab is not a web page");
    }
    if tab.private {
        return Err("the active tab is private");
    }
    if tab.workspace != state.active_workspace() || tab.folder.is_some() {
        return Err("the active tab is not in view");
    }
    let is_web = tauri::Url::parse(&tab.url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
    if !is_web {
        return Err("the active tab is not an http(s) page");
    }
    let (win_w, win_h) = window;
    if !(win_w.is_finite() && win_h.is_finite() && win_w >= 1.0 && win_h >= 1.0) {
        return Err("the window has no size yet");
    }
    let saved = state.content_rect().filter(|r| {
        [r.x, r.y, r.width, r.height, r.window_width, r.window_height]
            .iter()
            .all(|v| v.is_finite())
            && r.width >= 1.0
            && r.height >= 1.0
    });
    let (at, visible) = match saved {
        // The same window: the shell will lay the card out exactly where it
        // was, so the page can be on screen before the shell is.
        Some(r)
            if (r.window_width - win_w).abs() < 1.0 && (r.window_height - win_h).abs() < 1.0 =>
        {
            (r.bounds(), true)
        }
        // A different window: the card takes up most of the change, but the
        // shell may also shed or add columns, so load the page out of sight.
        Some(r) => {
            let grown = Bounds {
                width: r.width + (win_w - r.window_width),
                height: r.height + (win_h - r.window_height),
                ..r.bounds()
            };
            (fit(grown, window).unwrap_or_else(|| guess(window)), false)
        }
        None => (guess(window), false),
    };
    Ok(EarlyPlan {
        tab_id: id,
        url: tab.url,
        at,
        visible,
    })
}

/// `b` moved and cut to lie inside the window, or `None` if too little is left.
fn fit(b: Bounds, (win_w, win_h): (f64, f64)) -> Option<Bounds> {
    let x = b.x.clamp(0.0, win_w);
    let y = b.y.clamp(0.0, win_h);
    let width = b.width.min(win_w - x);
    let height = b.height.min(win_h - y);
    (width >= MIN_GUESS && height >= MIN_GUESS).then_some(Bounds {
        x,
        y,
        width,
        height,
    })
}

/// The window right of a default-width sidebar, or the whole window when that
/// leaves too little.
fn guess((win_w, win_h): (f64, f64)) -> Bounds {
    let beside = Bounds {
        x: DEFAULT_SIDEBAR_W,
        y: 0.0,
        width: win_w - DEFAULT_SIDEBAR_W,
        height: win_h,
    };
    fit(beside, (win_w, win_h)).unwrap_or(Bounds {
        x: 0.0,
        y: 0.0,
        width: win_w,
        height: win_h,
    })
}

/// Open the restored active tab's page now, from setup. Called at the end of
/// setup, once every store a page webview reads at creation (dark mode,
/// shields, proxy, containers, extensions, boosts) is managed. Desktop only:
/// Android has one system WebView, driven by the shell (ADR 0012).
pub(crate) fn open_early_webview(app: &tauri::AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let Some(state) = app.try_state::<FluxState>() else {
            return;
        };
        let Some(window) = app.get_window("main") else {
            return;
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let Ok(size) = window.inner_size() else {
            return;
        };
        let size = size.to_logical::<f64>(scale);
        let page = match plan(&state, (size.width, size.height)) {
            Ok(page) => page,
            Err(reason) => {
                tracing::info!(target: "flux::boot", reason, "no early webview");
                return;
            }
        };
        let opener = crate::webview::Opener::Boot {
            visible: page.visible,
        };
        match crate::webview::open_tab_webview(app, page.tab_id, &page.url, page.at, opener) {
            Ok(_) => {
                tracing::info!(
                    target: "flux::boot",
                    mark = "webview.early",
                    since_start_ms = since_start_ms(),
                    tab_id = page.tab_id,
                    visible = page.visible,
                    "boot mark"
                );
            }
            Err(e) => tracing::warn!(target: "flux::boot", "early webview failed: {e}"),
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ContentRect, TabMeta};

    fn tab(id: TabId, url: &str) -> TabMeta {
        TabMeta {
            id,
            kind: TabKind::Browser,
            url: url.into(),
            title: String::new(),
            pinned: false,
            cluster: None,
            group: None,
            folder: None,
            custom_title: None,
            workspace: 1,
            private: false,
            container: 0,
        }
    }

    fn with_active(t: TabMeta) -> FluxState {
        let state = FluxState::new();
        state.set_active_tab(t.id);
        state.tabs.insert(t.id, t);
        state
    }

    const WINDOW: (f64, f64) = (1440.0, 900.0);

    fn saved_in(window: (f64, f64)) -> ContentRect {
        ContentRect {
            x: 260.5,
            y: 44.0,
            width: 900.25,
            height: 840.0,
            window_width: window.0,
            window_height: window.1,
        }
    }

    #[test]
    fn the_same_window_shows_the_page_where_it_was() {
        let state = with_active(tab(7, "https://example.com/a"));
        state.note_content_rect(saved_in(WINDOW));
        let page = plan(&state, WINDOW).unwrap();
        assert_eq!(page.tab_id, 7);
        assert_eq!(page.url, "https://example.com/a");
        assert!(page.visible);
        assert_eq!(
            page.at,
            saved_in(WINDOW).bounds(),
            "exactly, fractions and all"
        );
    }

    #[test]
    fn a_different_window_loads_the_page_hidden() {
        let state = with_active(tab(7, "https://example.com/"));
        state.note_content_rect(saved_in((1600.0, 1000.0)));
        let page = plan(&state, WINDOW).unwrap();
        assert!(
            !page.visible,
            "the shell may lay this window out differently"
        );
        // The card took the window's change; the sidebar didn't move.
        assert_eq!(page.at.x, 260.5);
        assert_eq!(page.at.width, 900.25 - 160.0);
        assert_eq!(page.at.height, 840.0 - 100.0);
        // A rect from a much bigger window still ends up inside this one.
        state.note_content_rect(ContentRect {
            x: 2000.0,
            ..saved_in((3000.0, 2000.0))
        });
        let page = plan(&state, WINDOW).unwrap();
        assert!(page.at.x + page.at.width <= WINDOW.0);
        assert!(page.at.y + page.at.height <= WINDOW.1);
    }

    #[test]
    fn no_saved_rect_loads_the_page_hidden_beside_the_sidebar() {
        let state = with_active(tab(7, "http://example.com/"));
        let page = plan(&state, WINDOW).unwrap();
        assert!(!page.visible);
        assert_eq!(
            page.at,
            Bounds {
                x: DEFAULT_SIDEBAR_W,
                y: 0.0,
                width: WINDOW.0 - DEFAULT_SIDEBAR_W,
                height: WINDOW.1,
            }
        );
        // Too narrow for a sidebar guess: the whole window.
        assert_eq!(plan(&state, (300.0, 600.0)).unwrap().at.x, 0.0);
    }

    #[test]
    fn only_a_web_page_in_view_opens_early() {
        assert!(plan(&FluxState::new(), WINDOW).is_err(), "no tabs at all");
        for url in [
            "flux://start",
            "file:///Users/me/a.html",
            "about:blank",
            "not a url",
        ] {
            let state = with_active(tab(1, url));
            assert!(
                plan(&state, WINDOW).is_err(),
                "{url} is the shell's to render"
            );
        }
        let state = with_active(TabMeta {
            kind: TabKind::Terminal,
            ..tab(1, "https://example.com/")
        });
        assert!(plan(&state, WINDOW).is_err(), "a terminal tab");
        let state = with_active(TabMeta {
            private: true,
            ..tab(1, "https://example.com/")
        });
        assert!(plan(&state, WINDOW).is_err(), "a private tab");
        let state = with_active(TabMeta {
            workspace: 2,
            ..tab(1, "https://example.com/")
        });
        assert!(plan(&state, WINDOW).is_err(), "another workspace's tab");
        let state = with_active(TabMeta {
            folder: Some(3),
            ..tab(1, "https://example.com/")
        });
        assert!(plan(&state, WINDOW).is_err(), "a parked folder tab");
        let state = with_active(tab(1, "https://example.com/"));
        assert!(plan(&state, (0.0, 0.0)).is_err(), "a window with no size");
    }

    #[test]
    fn a_nonsense_saved_rect_is_ignored() {
        let state = with_active(tab(7, "https://example.com/"));
        state.note_content_rect(ContentRect {
            width: 0.0,
            ..saved_in(WINDOW)
        });
        let page = plan(&state, WINDOW).unwrap();
        assert!(!page.visible, "an empty rect is no rect");
        state.note_content_rect(ContentRect {
            x: f64::NAN,
            ..saved_in(WINDOW)
        });
        assert!(!plan(&state, WINDOW).unwrap().visible);
    }

    #[test]
    fn only_plain_mark_names_are_logged() {
        assert!(is_mark_name("first_paint"));
        assert!(is_mark_name("first_webview_open"));
        assert!(!is_mark_name(""));
        assert!(!is_mark_name("first paint"));
        assert!(!is_mark_name("a\nflux::boot: forged"));
        assert!(!is_mark_name(&"x".repeat(41)));
    }
}
