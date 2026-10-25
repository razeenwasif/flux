//! Run Flux's own script in a tab's page and read its answer.
//!
//! The script runs in a JavaScript world of its own (WKWebView's
//! `callAsyncJavaScript` with a `WKContentWorld`, macOS 11+): it shares the
//! page's DOM but none of its scripts, so the page can neither see it nor
//! answer in its place. Shields' element picker and the agent's look at a page
//! (what a step's target is, whether the step did anything) go through here.
//! Elsewhere there's no such world and the answer is `None`; callers fall back
//! to their cautious path.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::state::TabId;

/// Run `body` (the body of an async function: `return` gives the answer) in
/// `world` on `tab`'s page. The answer must be a string; `None` for anything
/// else, an error, no page, or no answer within `timeout`.
pub async fn run_isolated(
    app: &AppHandle,
    tab: TabId,
    world: &'static str,
    body: String,
    timeout: Duration,
) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let webview = app.get_webview(&format!("tab-{tab}"))?;
        // A suspended page (tab sleep) runs no script.
        crate::tabsleep::resume(app, tab);
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        webview
            .with_webview(move |p| unsafe { mac::call(p.inner() as _, world, &body, tx) })
            .ok()?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout).ok().flatten())
            .await
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tab, world, body, timeout);
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::CStr;
    use std::sync::mpsc::Sender;

    use block::ConcreteBlock;
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: 4usize]
    }

    pub unsafe fn call(webview: *mut Object, world: &str, body: &str, tx: Sender<Option<String>>) {
        let can: BOOL = if webview.is_null() {
            NO
        } else {
            msg_send![webview, respondsToSelector:
                sel!(callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:)]
        };
        if can == NO {
            let _ = tx.send(None);
            return;
        }
        let tx = std::sync::Mutex::new(Some(tx));
        let block = ConcreteBlock::new(move |result: *mut Object, err: *mut Object| {
            let text = if err.is_null() && !result.is_null() {
                let is_text: BOOL = msg_send![result, isKindOfClass: class!(NSString)];
                if is_text == NO {
                    None
                } else {
                    let utf8: *const std::os::raw::c_char = msg_send![result, UTF8String];
                    (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
                }
            } else {
                None
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(text);
            }
        });
        let block = block.copy();
        let name = nsstring(world);
        let content_world: *mut Object = msg_send![class!(WKContentWorld), worldWithName: name];
        let source = nsstring(body);
        let args: *mut Object = msg_send![class!(NSDictionary), dictionary];
        let no_frame: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![webview,
            callAsyncJavaScript: source
            arguments: args
            inFrame: no_frame
            inContentWorld: content_world
            completionHandler: &*block];
        let _: () = msg_send![source, release];
        let _: () = msg_send![name, release];
    }
}
