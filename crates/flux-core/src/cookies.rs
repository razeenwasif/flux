//! Cookie controls (BACKLOG #58): clear cookies for a site or everywhere, via
//! WebView2's `ICoreWebView2CookieManager`.
//!
//! Tab webviews share one cookie store (same WebView2 environment), so any open
//! tab's cookie manager operates on the whole store — we just need *some* tab
//! webview to reach it. Windows-only for now (WebKitGTK uses a different API).

use tauri::webview::Webview;
use tauri::{AppHandle, Manager};

/// Any open tab webview (they share the cookie store), or `None` if no page is
/// open to reach the cookie manager through.
fn any_tab_webview(app: &AppHandle) -> Option<Webview> {
    app.webviews()
        .into_iter()
        .find(|(label, _)| label.starts_with("tab-"))
        .map(|(_, wv)| wv)
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

fn clear(app: &AppHandle, host: Option<String>) -> Result<(), String> {
    let wv = any_tab_webview(app).ok_or("open a page first — cookies are cleared through a tab webview")?;
    #[cfg(windows)]
    {
        win::clear(wv, host);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (wv, host);
        Err("cookie controls need WebView2 (Windows) for now".into())
    }
}

#[cfg(windows)]
mod win {
    use tauri::webview::Webview;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{w, Interface, HSTRING};

    /// Run the (deferred) cookie deletion on the webview's UI thread.
    pub fn clear(wv: Webview, host: Option<String>) {
        let _ = wv.with_webview(move |platform| unsafe {
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
                    // Empty name = every cookie for that origin; both schemes.
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
