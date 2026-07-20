//! Native content-blocker request interceptor (BACKLOG #91/#57, ADR 0007).
//!
//! Bridges the tested `flux-filter` / `shields` engine to the platform webview's
//! request pipeline — the part that can only be verified at runtime on the real
//! backend.
//!
//! **Windows (WebView2):** `WebResourceRequested` (the only network-level hook
//! the engine exposes) asks `ShieldsState` per request and answers blocked ones
//! with a 403, so nothing downloads. Callback-driven → also feeds the tracker
//! graph and HTTPS-only upgrades.
//!
//! **Linux (WebKitGTK):** the engine exposes no per-request callback; instead
//! it *natively compiles* declarative rules. Shields persists its lists as
//! WebKit content-blocker JSON (`webkit-cb.json`); this module compiles that
//! once per app run via `UserContentFilterStore` and attaches the compiled
//! filter to every webview's `UserContentManager`. Blocking runs inside
//! WebKit itself. Trade-off vs Windows: no per-request verdicts, so the
//! tracker graph and HTTPS-only upgrades don't populate on this path.
//!
//! The COM usage was compile-verified against `x86_64-pc-windows-msvc`; only its
//! runtime behavior needs a Windows smoke test. The `flux::netfilter` tracing
//! lines (in the `tauri dev` terminal) trace install + per-request verdicts.

use tauri::webview::Webview;
use tauri::AppHandle;

/// Install the content-blocker interceptor on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    {
        let app = app.clone();
        let r = webview.with_webview(move |platform| wire(&app, platform));
        if let Err(e) = r {
            tracing::warn!(target: "flux::netfilter", "with_webview failed: {e}");
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, webview);
    }
}

/// Same interceptor, but for a standalone `WebviewWindow` (e.g. a peek window,
/// #50) — peeks are their own window, not a `tab-*` child webview, so they'd
/// otherwise miss shields/HTTPS-only/lean entirely.
pub fn install_on_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    {
        let app = app.clone();
        let r = window.with_webview(move |platform| wire(&app, platform));
        if let Err(e) = r {
            tracing::warn!(target: "flux::netfilter", "with_webview (window) failed: {e}");
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, window);
    }
}

/// Attach the compiled shields content blocker to a fresh WebKitGTK webview.
/// Runs on the GTK main thread (where `with_webview` puts us) — required by
/// both the filter store and the thread-local compile state in `gtk`.
#[cfg(target_os = "linux")]
fn wire(app: &AppHandle, platform: tauri::webview::PlatformWebview) {
    use tauri::Manager;
    let Some(shields) = app.try_state::<crate::shields::ShieldsState>() else {
        return;
    };
    let Some(json_path) = shields.content_blocker_json() else {
        tracing::warn!(target: "flux::netfilter", "no content-blocker JSON yet; webview unfiltered");
        return;
    };
    // The compiled-filter cache lives next to the JSON source.
    let store_dir = json_path.with_file_name("cb-store");
    gtk::attach(&json_path, &store_dir, &platform.inner());
}

/// Attach the compiled shields content blocker to a fresh WKWebView (macOS).
/// WebKit compiles the SAME content-blocker JSON that WebKitGTK uses into a
/// `WKContentRuleList`, so macOS is declarative like Linux (not per-request like
/// Windows). Runs on the webview's main thread (where `with_webview` puts us).
#[cfg(target_os = "macos")]
fn wire(app: &AppHandle, platform: tauri::webview::PlatformWebview) {
    use tauri::Manager;
    let Some(shields) = app.try_state::<crate::shields::ShieldsState>() else {
        return;
    };
    let Some(json_path) = shields.content_blocker_json() else {
        tracing::warn!(target: "flux::netfilter", "no content-blocker JSON yet; webview unfiltered");
        return;
    };
    let Ok(json) = std::fs::read_to_string(&json_path) else {
        return;
    };
    mac::attach(platform.inner() as *mut objc::runtime::Object, &json);
}

/// WKContentRuleList compile + attach via Cocoa. The compile is async (the store
/// takes a completion block); the block retains the webview so it's still valid
/// when the compiled rules land, adds them, then releases. All selectors are
/// standard WebKit API.
#[cfg(target_os = "macos")]
mod mac {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    const NSUTF8_STRING_ENCODING: usize = 4;

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: NSUTF8_STRING_ENCODING]
    }

    pub fn attach(webview: *mut Object, json: &str) {
        if webview.is_null() {
            return;
        }
        unsafe {
            let store: *mut Object = msg_send![class!(WKContentRuleListStore), defaultStore];
            if store.is_null() {
                return;
            }
            let ident = nsstring("flux-shields");
            let json_ns = nsstring(json);

            // Keep the webview alive across the async compile; released in the block.
            let _: () = msg_send![webview, retain];
            let block = ConcreteBlock::new(move |list: *mut Object, _err: *mut Object| unsafe {
                if !list.is_null() {
                    let config: *mut Object = msg_send![webview, configuration];
                    if !config.is_null() {
                        let ucc: *mut Object = msg_send![config, userContentController];
                        if !ucc.is_null() {
                            let _: () = msg_send![ucc, addContentRuleList: list];
                        }
                    }
                }
                let _: () = msg_send![webview, release];
            });
            let block = block.copy();
            let _: () = msg_send![store,
                compileContentRuleListForIdentifier: ident
                encodedContentRuleList: json_ns
                completionHandler: &*block];
        }
    }
}

/// Wire the WebView2 `WebResourceRequested` interceptor with Flux's policy.
/// Runs on the webview's UI thread (where `with_webview` puts us) — the only
/// place the WebView2 event handler may be installed.
#[cfg(windows)]
fn wire(app: &AppHandle, platform: tauri::webview::PlatformWebview) {
    use tauri::Manager;
    let controller = platform.controller();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "flux::netfilter", "CoreWebView2() failed: {e}");
                return;
            }
        };
        let policy_app = app.clone();
        // Per request: block trackers/ads (shields), else upgrade http→https
        // (HTTPS-only), else allow.
        let verdict = move |url: &str, source: &str, ty: &str| -> win::Decision {
            let shields_block = policy_app
                .try_state::<crate::shields::ShieldsState>()
                .is_some_and(|s| s.should_block(url, source, ty));
            // Lean mode (#105): extra heavy-script blocking for opted-in sites.
            let lean_block = !shields_block
                && policy_app
                    .try_state::<crate::leanmode::LeanState>()
                    .is_some_and(|l| l.should_block(url, source, ty));
            let blocked = shields_block || lean_block;
            // Tracker graph (#129): record this first-party → third-party contact.
            if let Some(t) = policy_app.try_state::<crate::trackers::TrackerStore>() {
                t.record(source, url, blocked);
            }
            if blocked {
                return win::Decision::Block;
            }
            if let Some(h) = policy_app.try_state::<crate::https::HttpsState>() {
                if let Some(secure) = h.upgrade(url) {
                    return win::Decision::Redirect(secure);
                }
            }
            win::Decision::Allow
        };
        match win::install_interceptor(&core, verdict) {
            Ok(()) => tracing::info!(target: "flux::netfilter", "interceptor installed"),
            Err(e) => tracing::warn!(target: "flux::netfilter", "install failed: {e}"),
        }
    }
}

#[cfg(target_os = "linux")]
mod gtk {
    //! One-time compile of the shields content-blocker JSON via WebKit's
    //! `UserContentFilterStore`, attached to every webview. The safe
    //! `webkit2gtk` crate doesn't wrap the filter-store API, so this uses the
    //! `-sys` FFI directly. Everything here runs on the GTK main thread: the
    //! store's async save completes on the main loop, so a `thread_local`
    //! state machine is sound and lock-free.

    use std::cell::RefCell;
    use std::ffi::CString;
    use std::path::Path;

    use glib::translate::ToGlibPtr;
    use glib_sys::{g_bytes_new, g_bytes_unref, g_error_free, gpointer, GError};
    use gobject_sys::{g_object_ref, g_object_unref, GObject};
    use webkit2gtk_sys::{
        webkit_user_content_filter_store_new, webkit_user_content_filter_store_save,
        webkit_user_content_filter_store_save_finish, webkit_user_content_manager_add_filter,
        webkit_web_view_get_user_content_manager, WebKitUserContentFilter,
        WebKitUserContentManager, WebKitWebView,
    };

    /// Identifier the compiled rule set is cached under in the store dir —
    /// WebKit skips recompilation when the source bytes are unchanged.
    const FILTER_ID: &[u8] = b"flux-shields\0";

    enum CbState {
        /// No compile started yet.
        Untried,
        /// Compile in flight; managers (each `g_object_ref`'d) waiting for it.
        Compiling(Vec<*mut WebKitUserContentManager>),
        /// Compiled — one process-lifetime ref held, attach directly.
        Ready(*mut WebKitUserContentFilter),
        /// Compile failed; don't retry every webview (log once, run unfiltered).
        Failed,
    }

    thread_local! {
        static STATE: RefCell<CbState> = const { RefCell::new(CbState::Untried) };
    }

    /// Attach the shields filter to `wv`'s content manager, kicking off the
    /// one-time async compile on first call. Main thread only.
    pub fn attach(json_path: &Path, store_dir: &Path, wv: &webkit2gtk::WebView) {
        let wv_ptr: *mut WebKitWebView = wv.to_glib_none().0;
        if wv_ptr.is_null() {
            return;
        }
        let ucm = unsafe { webkit_web_view_get_user_content_manager(wv_ptr) };
        if ucm.is_null() {
            return;
        }
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            match &mut *state {
                CbState::Ready(filter) => unsafe {
                    webkit_user_content_manager_add_filter(ucm, *filter);
                },
                CbState::Compiling(pending) => unsafe {
                    // Keep the manager alive until the compile lands — the
                    // webview could be closed before then.
                    g_object_ref(ucm.cast::<GObject>());
                    pending.push(ucm);
                },
                CbState::Failed => {}
                CbState::Untried => {
                    let Ok(json) = std::fs::read(json_path) else {
                        tracing::warn!(target: "flux::netfilter", "content-blocker JSON unreadable");
                        *state = CbState::Failed;
                        return;
                    };
                    let _ = std::fs::create_dir_all(store_dir);
                    let Ok(dir_c) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
                        *state = CbState::Failed;
                        return;
                    };
                    unsafe {
                        let store = webkit_user_content_filter_store_new(dir_c.as_ptr());
                        if store.is_null() {
                            *state = CbState::Failed;
                            return;
                        }
                        let bytes = g_bytes_new(json.as_ptr().cast(), json.len());
                        g_object_ref(ucm.cast::<GObject>());
                        // The store ref is released in `saved` (its source object).
                        webkit_user_content_filter_store_save(
                            store,
                            FILTER_ID.as_ptr().cast(),
                            bytes,
                            std::ptr::null_mut(),
                            Some(saved),
                            std::ptr::null_mut(),
                        );
                        g_bytes_unref(bytes);
                        tracing::info!(
                            target: "flux::netfilter",
                            bytes = json.len(),
                            "compiling WebKit content blocker"
                        );
                        *state = CbState::Compiling(vec![ucm]);
                    }
                }
            }
        });
    }

    /// Async-save completion: attach the compiled filter to every webview that
    /// opened while compiling, and cache it for all future ones.
    unsafe extern "C" fn saved(src: *mut GObject, res: *mut gio_sys::GAsyncResult, _ud: gpointer) {
        let mut err: *mut GError = std::ptr::null_mut();
        let filter = webkit_user_content_filter_store_save_finish(src.cast(), res, &mut err);
        if !err.is_null() {
            let msg = std::ffi::CStr::from_ptr((*err).message)
                .to_string_lossy()
                .into_owned();
            g_error_free(err);
            tracing::warn!(target: "flux::netfilter", "content-blocker compile failed: {msg}");
        }
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let pending = match std::mem::replace(&mut *state, CbState::Failed) {
                CbState::Compiling(p) => p,
                other => {
                    *state = other; // shouldn't happen; restore
                    Vec::new()
                }
            };
            for ucm in pending {
                if !filter.is_null() {
                    webkit_user_content_manager_add_filter(ucm, filter);
                }
                g_object_unref(ucm.cast::<GObject>());
            }
            if !filter.is_null() {
                // Hold the compiled filter for the life of the process.
                *state = CbState::Ready(filter);
                tracing::info!(target: "flux::netfilter", "WebKit content blocker active");
            }
        });
        g_object_unref(src); // the store — created in attach, owned by this callback
    }
}

#[cfg(windows)]
mod win {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{w, Interface, Result, HSTRING, PWSTR};
    use windows::Win32::System::Com::IStream;

    /// What to do with a request.
    pub enum Decision {
        Allow,
        /// Drop it with a 403 (content blocker).
        Block,
        /// 307-redirect it to this URL (HTTPS-only upgrade).
        Redirect(String),
    }

    /// Hook `WebResourceRequested` on `core`, applying `decide(url, source,
    /// request_type)` to every request.
    pub unsafe fn install_interceptor(
        core: &ICoreWebView2,
        decide: impl Fn(&str, &str, &str) -> Decision + 'static,
    ) -> Result<()> {
        core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        let core2 = core.clone();
        let handler =
            WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| unsafe {
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

                match decide(&url, &source, req_type) {
                    Decision::Allow => {}
                    Decision::Block => {
                        // Bodyless 403 → the resource never loads.
                        let env = core2.cast::<ICoreWebView2_2>()?.Environment()?;
                        let resp = env.CreateWebResourceResponse(
                            None::<&IStream>,
                            403,
                            w!("Blocked by Flux"),
                            w!(""),
                        )?;
                        args.SetResponse(&resp)?;
                    }
                    Decision::Redirect(secure) => {
                        // 307 with a Location header → upgrade to HTTPS.
                        let env = core2.cast::<ICoreWebView2_2>()?.Environment()?;
                        let headers = HSTRING::from(format!("Location: {secure}"));
                        let resp = env.CreateWebResourceResponse(
                            None::<&IStream>,
                            307,
                            w!("Upgraded to HTTPS"),
                            &headers,
                        )?;
                        args.SetResponse(&resp)?;
                    }
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
