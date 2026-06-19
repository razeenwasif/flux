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

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Window};

const PEEK_JS: &str = include_str!("../assets/peek.js");

/// Monotonic peek label suffix — each peek is its own short-lived window, so the
/// promote/close commands can act on *the calling* window without us tracking ids.
static PEEK_SEQ: AtomicU64 = AtomicU64::new(1);

fn host_of(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split('/').next().unwrap_or(after);
    host.trim_start_matches("www.").to_string()
}

/// Spawn a floating peek window for `url`. Shared by the chrome trigger
/// (`peek_open`) and the page trigger (`chrome_peek_url`).
fn open_peek(app: &AppHandle, url: &str) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("can only peek web pages".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|_| format!("invalid URL: {url}"))?;
    let n = PEEK_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("peek-{n}");
    // Cosmetic element-hiding (#57): inject the per-page shields CSS so a blocked
    // ad slot doesn't leave a gap — the network-level block is the interceptor
    // installed below. Mirrors the tab webview path.
    let app_for_load = app.clone();
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(format!("Peek · {}", host_of(url)))
        .inner_size(960.0, 680.0)
        .min_inner_size(420.0, 360.0)
        .center()
        .always_on_top(true)
        .initialization_script(PEEK_JS)
        .on_page_load(move |webview, payload| {
            let css = app_for_load
                .try_state::<crate::shields::ShieldsState>()
                .map(|s| s.cosmetic_css(&payload.url().to_string()))
                .unwrap_or_default();
            if !css.is_empty() {
                if let Ok(lit) = serde_json::to_string(&css) {
                    let _ = webview.eval(&format!(
                        "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-cosmetic');\
                         if(!s){{s=d.createElement('style');s.id='flux-cosmetic';}}s.textContent=c;\
                         var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                    ));
                }
            }
        })
        .build()
        .map_err(|e| format!("open peek: {e}"))?;
    // Network-level content blocking + HTTPS-only + lean (#57/#91/#105), same
    // policy as tab webviews — peeks are a separate window so they need it wired
    // explicitly (Windows/WebView2; no-op elsewhere).
    crate::netfilter::install_on_window(app, &win);
    Ok(())
}

/// A peek window self-identifies by its `peek-` label — the guard that stops a
/// normal tab page (which also holds `fluxtab:default`) from invoking the
/// promote/close commands against the main window.
fn is_peek(window: &Window) -> bool {
    window.label().starts_with("peek-")
}

/// Open a link in a peek window (chrome trigger — link menu, ⌘K).
#[tauri::command]
pub fn peek_open(app: AppHandle, url: String) -> Result<(), String> {
    open_peek(&app, &url)
}

/// Open a link in a peek window (page trigger — `newtab.js` Alt-click / menu).
/// A separate name from `peek_open` so the chrome path stays a plain app command
/// and only this one is exposed to remote pages via the `fluxtab` plugin.
#[tauri::command]
pub fn chrome_peek_url(app: AppHandle, url: String) -> Result<(), String> {
    open_peek(&app, &url)
}

/// Promote the peek's current page to a real focused tab in the main window,
/// then dismiss the peek. No-op (beyond closing) if not called from a peek.
#[tauri::command]
pub fn peek_promote(app: AppHandle, window: Window, url: String) -> Result<(), String> {
    if !is_peek(&window) {
        return Err("not a peek window".into());
    }
    app.emit("flux://open-url", (url, false)).map_err(|e| e.to_string())?;
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
    fn host_strips_scheme_and_www() {
        assert_eq!(host_of("https://www.example.com/x?y=1"), "example.com");
        assert_eq!(host_of("http://news.ycombinator.com/"), "news.ycombinator.com");
    }
}
