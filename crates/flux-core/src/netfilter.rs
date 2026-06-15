//! Native content-blocker request interceptor (BACKLOG #91/#57, ADR 0007).
//!
//! Bridges the tested `flux-filter` / `shields` engine to the platform webview's
//! request pipeline — the part that can only be verified at runtime on the real
//! backend. On Windows, WebView2's `WebResourceRequested` (the only
//! network-level hook the native webview exposes) asks `ShieldsState` per
//! request and answers blocked ones with a 403, so nothing downloads. Off
//! Windows it's a no-op — the WebKitGTK interceptor is a follow-up.
//!
//! The COM usage was compile-verified against `x86_64-pc-windows-msvc`; only its
//! runtime behavior needs a Windows smoke test. The `flux::netfilter` tracing
//! lines (in the `tauri dev` terminal) trace install + per-request verdicts.

use tauri::webview::Webview;
use tauri::AppHandle;

/// Install the content-blocker interceptor on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(windows)]
    install_windows(app.clone(), webview);
    #[cfg(not(windows))]
    {
        let _ = (app, webview);
    }
}

#[cfg(windows)]
fn install_windows(app: AppHandle, webview: &Webview) {
    use tauri::Manager;
    let r = webview.with_webview(move |platform| {
        tracing::info!(target: "flux::netfilter", "with_webview callback running");
        // `with_webview` runs on the webview's UI thread — where the WebView2
        // event handler must also live.
        let controller = platform.controller();
        unsafe {
            let core = match controller.CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(target: "flux::netfilter", "CoreWebView2() failed: {e}");
                    return;
                }
            };
            let shields_app = app.clone();
            let verdict = move |url: &str, source: &str, ty: &str| match shields_app
                .try_state::<crate::shields::ShieldsState>()
            {
                Some(s) => s.should_block(url, source, ty),
                None => {
                    tracing::warn!(target: "flux::netfilter", "ShieldsState not managed");
                    false
                }
            };
            match win::install_interceptor(&core, verdict) {
                Ok(()) => tracing::info!(target: "flux::netfilter", "interceptor installed"),
                Err(e) => tracing::warn!(target: "flux::netfilter", "install failed: {e}"),
            }
        }
    });
    if let Err(e) = r {
        tracing::warn!(target: "flux::netfilter", "with_webview failed: {e}");
    }
}

#[cfg(windows)]
mod win {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{w, Interface, Result, PWSTR};
    use windows::Win32::System::Com::IStream;

    /// Hook `WebResourceRequested` on `core`, blocking requests for which
    /// `should_block(url, source_url, request_type)` returns true.
    pub unsafe fn install_interceptor(
        core: &ICoreWebView2,
        should_block: impl Fn(&str, &str, &str) -> bool + 'static,
    ) -> Result<()> {
        core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        let core2 = core.clone();
        let mut seen: u32 = 0;
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| unsafe {
            let args = match args {
                Some(a) => a,
                None => return Ok(()),
            };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let url = webview2_com::take_pwstr(uri);

            let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
            let _ = args.ResourceContext(&mut ctx);
            let req_type = context_to_type(ctx);

            // Source = the page making the request (its host drives per-site
            // shields + first-/third-party). The top document is a good proxy.
            let mut src = PWSTR::null();
            let source = if core2.Source(&mut src).is_ok() {
                webview2_com::take_pwstr(src)
            } else {
                String::new()
            };

            let blocked = should_block(&url, &source, req_type);

            // DIAG: trace the first 40 requests (verdicts) + every block, so a
            // smoke test shows whether the handler fires and what it decides.
            seen += 1;
            if blocked || seen <= 40 {
                let host = url.split('/').nth(2).unwrap_or(url.as_str());
                tracing::info!(target: "flux::netfilter", "req #{seen} blocked={blocked} type={req_type} host={host}");
            }

            if blocked {
                // Answer with a bodyless 403 → the resource never loads.
                let env = core2.cast::<ICoreWebView2_2>()?.Environment()?;
                let resp =
                    env.CreateWebResourceResponse(None::<&IStream>, 403, w!("Blocked by Flux"), w!(""))?;
                args.SetResponse(&resp)?;
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        core.add_WebResourceRequested(&handler, &mut token)?;
        Ok(())
    }

    /// Map a WebView2 resource context to an adblock request type.
    fn context_to_type(ctx: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
        match ctx {
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "xmlhttprequest",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
            _ => "other",
        }
    }
}
