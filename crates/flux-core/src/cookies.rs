//! Cookie controls (BACKLOG #58): clear cookies for a site or everywhere, and
//! per-site **clear-on-close**, via WebView2's `ICoreWebView2CookieManager`.
//!
//! All tab webviews + the shell share one cookie store (same WebView2
//! environment), so we run cookie ops through the **main** webview — it's always
//! alive, which avoids a race with a closing tab during clear-on-close.
//! Windows-only for now (WebKitGTK uses a different API).

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Per-site privacy flags.
#[derive(Default)]
pub struct CookieState {
    /// Hosts whose cookies are wiped when their tab closes.
    clear_on_close: DashMap<String, ()>,
}

impl CookieState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn should_clear_on_close(&self, host: &str) -> bool {
        self.clear_on_close.contains_key(host)
    }
    fn status(&self) -> CookieStatus {
        CookieStatus { clear_on_close: self.clear_on_close.iter().map(|e| e.key().clone()).collect() }
    }
}

#[derive(Serialize)]
pub struct CookieStatus {
    pub clear_on_close: Vec<String>,
}

/// Host of a URL (`https://a.b.com/x` → `a.b.com`).
pub fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1)?;
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    Some(host.split(':').next().unwrap_or(host))
}

/// Clear cookies for `host` (all schemes) through the main webview. Called by
/// the clear-on-close hook in `webview_close`.
pub fn clear_for_host(app: &AppHandle, host: &str) {
    let _ = clear(app, Some(host.to_string()));
}

/// Clear cookies for one host (all schemes).
#[tauri::command]
pub fn cookies_clear_site(app: AppHandle, host: String) -> Result<(), String> {
    clear(&app, Some(host))
}

/// Clear every cookie in the store.
#[tauri::command]
pub fn cookies_clear_all(app: AppHandle) -> Result<(), String> {
    clear(&app, None)
}

/// Flag (or unflag) a host to clear its cookies when its tab closes.
#[tauri::command]
pub fn cookies_set_clear_on_close(state: tauri::State<'_, CookieState>, host: String, on: bool) {
    if on {
        state.clear_on_close.insert(host, ());
    } else {
        state.clear_on_close.remove(&host);
    }
}

#[tauri::command]
pub fn cookies_status(state: tauri::State<'_, CookieState>) -> CookieStatus {
    state.status()
}

fn clear(app: &AppHandle, host: Option<String>) -> Result<(), String> {
    // The shell ("main") webview is always alive and shares the cookie store.
    let main = app.get_webview_window("main").ok_or("no main window")?;
    #[cfg(windows)]
    {
        win::clear(main, host);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (main, host);
        Err("cookie controls need WebView2 (Windows) for now".into())
    }
}

#[cfg(windows)]
mod win {
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{w, Interface, HSTRING};

    /// Run the (deferred) cookie deletion on the webview's UI thread.
    pub fn clear(win: WebviewWindow, host: Option<String>) {
        let _ = win.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let core2 = match core.cast::<ICoreWebView2_2>() {
                Ok(c2) => c2,
                Err(_) => return,
            };
            let cm = match core2.CookieManager() {
                Ok(cm) => cm,
                Err(_) => return,
            };
            match &host {
                Some(h) => {
                    for scheme in ["https", "http"] {
                        let uri = HSTRING::from(format!("{scheme}://{h}"));
                        let _ = cm.DeleteCookies(w!(""), &uri);
                    }
                    tracing::info!(target: "flux::cookies", "cleared cookies for {h}");
                }
                None => {
                    let _ = cm.DeleteAllCookies();
                    tracing::info!(target: "flux::cookies", "cleared all cookies");
                }
            }
        });
    }
}
