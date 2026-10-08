//! Peek / glance windows (BACKLOG #50).
//!
//! Open a link in a transient, always-on-top floating window without committing
//! it to a tab — Arc's "Little Arc". A peek is its own `WebviewWindow` (label
//! `peek-<n>`), which is the right model under Flux's native-webview overlay
//! constraint: a DOM overlay in the chrome can't cover the OS webview layer, but
//! a separate floating window can. The injected `peek.js` adds an "Open as tab"
//! pill (promote → a real tab + close) and Esc-to-dismiss; those go through the
//! `fluxtab` bridge (capabilities/peek.json), guarded here so only peek windows
//! can self-close.
//!
//! Peeks are standalone always-on-top `WebviewWindow`s — a desktop-only concept
//! (Android has no floating windows; ADR 0012). On mobile the module compiles to
//! the `stub` below: the five commands stay (IPC surface unchanged) but report
//! that peeking isn't available.

#[cfg(desktop)]
mod real {
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Window};

const PEEK_JS: &str = include_str!("../assets/peek.js");

/// Monotonic peek label suffix — each peek is its own short-lived window, so the
/// promote/close commands can act on *the calling* window without us tracking ids.
static PEEK_SEQ: AtomicU64 = AtomicU64::new(1);

/// `chrome_peek_url` is callable by any remote page with no proof of a user
/// gesture, and every peek is a full always-on-top window: cap how many may be
/// open and how often a page may open one (a real Alt-click is never this fast).
const MAX_OPEN_PEEKS: usize = 4;
const PAGE_PEEK_GAP_MS: u64 = 750;
static LAST_PAGE_PEEK_MS: AtomicU64 = AtomicU64::new(0);

/// Claim the page-peek slot at `now` (ms): refused within `PAGE_PEEK_GAP_MS` of
/// the last one. Compare-and-swap, so two racing calls can't both get through.
fn claim_page_peek(last: &AtomicU64, now: u64) -> bool {
    let prev = last.load(Ordering::Relaxed);
    now.saturating_sub(prev) >= PAGE_PEEK_GAP_MS
        && last
            .compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
}

/// The storage session a peek must share with the tab it came from.
#[derive(Clone, Copy, Default)]
struct Session {
    private: bool,
    container: u32,
}

fn session_of(app: &AppHandle, tab: Option<crate::state::TabId>) -> Session {
    tab.and_then(|id| {
        let s = app.try_state::<crate::state::FluxState>()?;
        let t = s.tabs.get(&id)?;
        Some(Session {
            private: t.private,
            container: t.container,
        })
    })
    .unwrap_or_default()
}

fn host_of(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split('/').next().unwrap_or(after);
    host.trim_start_matches("www.").to_string()
}

/// Spawn a floating peek window for `url` in the opener's `session`. Shared by
/// the chrome trigger (`peek_open`) and the page trigger (`chrome_peek_url`).
fn open_peek(app: &AppHandle, url: &str, session: Session) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("can only peek web pages".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|_| format!("invalid URL: {url}"))?;
    if crate::webview::is_app_origin(&parsed) {
        return Err("can only peek web pages".into()); // e.g. http://tauri.localhost
    }
    let n = PEEK_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("peek-{n}");
    // Cosmetic element-hiding (#57): inject the per-page shields CSS so a blocked
    // ad slot doesn't leave a gap — the network-level block is the interceptor
    // installed below. Mirrors the tab webview path.
    let app_for_load = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(format!("Peek · {}", host_of(url)))
        .inner_size(960.0, 680.0)
        .min_inner_size(420.0, 360.0)
        .center()
        .always_on_top(true)
        .initialization_script(PEEK_JS)
        // A link peeked from a Private tab must not land in the persistent jar.
        .incognito(session.private)
        .on_navigation(|u| !crate::webview::is_app_origin(u))
        .on_page_load(move |webview, payload| {
            let css = app_for_load
                .try_state::<crate::shields::ShieldsState>()
                .map(|s| s.cosmetic_css(payload.url().as_ref()))
                .unwrap_or_default();
            if !css.is_empty() {
                if let Ok(lit) = serde_json::to_string(&css) {
                    let _ = webview.eval(format!(
                        "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-cosmetic');\
                         if(!s){{s=d.createElement('style');s.id='flux-cosmetic';}}s.textContent=c;\
                         var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                    ));
                }
            }
        });
    // …nor one from a container tab in the default jar (#59).
    if !session.private && session.container != 0 {
        if let Ok(dir) = app.path().app_data_dir() {
            builder =
                builder.data_directory(dir.join("containers").join(session.container.to_string()));
        }
    }
    // Same outbound proxy (#63) as tab webviews: a peek must not go direct.
    if let Some(proxy) = app
        .try_state::<crate::proxy::ProxyState>()
        .and_then(|s| s.parsed())
    {
        builder = builder.proxy_url(proxy);
    }
    let win = builder.build().map_err(|e| format!("open peek: {e}"))?;
    // Network-level content blocking + HTTPS-only + lean (#57/#91/#105), same
    // policy as tab webviews — peeks are a separate window so they need it wired
    // explicitly (Windows/WebView2; no-op elsewhere). Likewise tracking
    // prevention (#58) and the per-site permission decisions.
    crate::netfilter::install_on_window(app, &win);
    crate::tracking::install(app, win.as_ref());
    crate::permissions::install(app, win.as_ref());
    Ok(())
}

/// A peek window self-identifies by its `peek-` label — the guard that stops a
/// normal tab page (which also holds `fluxtab:default`) from invoking the
/// promote/close commands against the main window.
fn is_peek(window: &Window) -> bool {
    window.label().starts_with("peek-")
}

/// Open a link in a peek window (chrome trigger — link menu, ⌘K).
///
/// **Async on purpose:** building the window + installing the WebView2 request
/// interceptor (`with_webview`) needs the main thread. A *synchronous* command
/// runs ON the main thread and would deadlock against `with_webview` — freezing
/// the app. Async runs it off-main (like `webview_open`), so the work marshals
/// to the main thread cleanly.
#[tauri::command]
pub async fn peek_open(app: AppHandle, url: String) -> Result<(), String> {
    let active = app
        .try_state::<crate::state::FluxState>()
        .and_then(|s| s.active_tab());
    open_peek(&app, &url, session_of(&app, active))
}

/// Open a link in a peek window (page trigger — `newtab.js` Alt-click / menu).
/// A separate name from `peek_open` so the chrome path stays a plain app command
/// and only this one is exposed to remote pages via the `fluxtab` plugin. Async
/// for the same main-thread reason as [`peek_open`].
#[tauri::command]
pub async fn chrome_peek_url(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
) -> Result<(), String> {
    // Only a tab page may ask: not a peek re-spawning itself, not a panel.
    let tab = webview
        .label()
        .strip_prefix("tab-")
        .and_then(|s| s.parse::<crate::state::TabId>().ok())
        .ok_or("peeks can only be opened from a tab")?;
    let open = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("peek-"))
        .count();
    if open >= MAX_OPEN_PEEKS {
        return Err("too many peek windows open".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if !claim_page_peek(&LAST_PAGE_PEEK_MS, now) {
        return Err("peek rate-limited".into());
    }
    open_peek(&app, &url, session_of(&app, Some(tab)))
}

/// Promote the peek's current page to a real focused tab in the main window,
/// then dismiss the peek. No-op (beyond closing) if not called from a peek.
#[tauri::command]
pub fn peek_promote(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    if !is_peek(&window) {
        return Err("not a peek window".into());
    }
    // `url` comes from the page and becomes a new tab via flux://open-url.
    match url.parse::<tauri::Url>() {
        Ok(u) if matches!(u.scheme(), "http" | "https") && !crate::webview::is_app_origin(&u) => {}
        _ => return Err("can only promote web pages".into()),
    }
    app.emit("flux://open-url", (url, false))
        .map_err(|e| e.to_string())?;
    // Surface the main window so the freshly-promoted tab is actually seen — the
    // peek was always-on-top, so without this the new tab lands behind it.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    let _ = window.close();
    Ok(())
}

/// "Keep" a peek: drop always-on-top so it stops floating over everything and
/// behaves like a normal window you can leave open alongside the main one.
#[tauri::command]
pub fn peek_pin(window: Window) {
    if is_peek(&window) {
        let _ = window.set_always_on_top(false);
    }
}

/// Dismiss the peek. Guarded so only a peek window can close itself.
#[tauri::command]
pub fn peek_close(window: Window) {
    if is_peek(&window) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_cannot_open_peeks_back_to_back() {
        let last = AtomicU64::new(0);
        assert!(claim_page_peek(&last, 1_000_000));
        assert!(
            !claim_page_peek(&last, 1_000_050),
            "a timer can't open one every 50 ms"
        );
        assert!(!claim_page_peek(&last, 1_000_000 + PAGE_PEEK_GAP_MS - 1));
        assert!(claim_page_peek(&last, 1_000_000 + PAGE_PEEK_GAP_MS));
    }

    #[test]
    fn host_strips_scheme_and_www() {
        assert_eq!(host_of("https://www.example.com/x?y=1"), "example.com");
        assert_eq!(
            host_of("http://news.ycombinator.com/"),
            "news.ycombinator.com"
        );
    }
}
} // mod real
#[cfg(desktop)]
pub use real::*;

/// Mobile stub (ADR 0012): no floating always-on-top windows on Android.
#[cfg(mobile)]
mod stub {
    use tauri::{AppHandle, Window};

    const NB: &str = "peek windows aren't available on mobile";

    #[tauri::command]
    pub async fn peek_open(_app: AppHandle, _url: String) -> Result<(), String> {
        Err(NB.into())
    }

    #[tauri::command]
    pub async fn chrome_peek_url(_app: AppHandle, _url: String) -> Result<(), String> {
        Err(NB.into())
    }

    #[tauri::command]
    pub fn peek_promote(_app: AppHandle, _window: Window, _url: String) -> Result<(), String> {
        Err(NB.into())
    }

    #[tauri::command]
    pub fn peek_pin(_window: Window) {}

    #[tauri::command]
    pub fn peek_close(_window: Window) {}
}
#[cfg(mobile)]
pub use stub::*;
