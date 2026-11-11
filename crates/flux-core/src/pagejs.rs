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

/// Put `value` (JSON, from serde_json) in place of `placeholder` in one of
/// Flux's page-script templates.
///
/// Exactly one occurrence is replaced, and the templates are pinned to hold
/// exactly one, in code and never in a comment (`template_placeholders_once`):
/// a second copy inside a `//` comment was how a selector became script (audit
/// S7). serde_json leaves U+2028 and U+2029 raw, and JavaScript ends a comment
/// line at either, so they're escaped too (`\u2028` is the same string in JSON).
pub fn fill(template: &str, placeholder: &str, value: &str) -> String {
    debug_assert_eq!(
        template.matches(placeholder).count(),
        1,
        "{placeholder} must occur exactly once"
    );
    let value = value
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    template.replacen(placeholder, &value, 1)
}

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
    use std::collections::BTreeMap;
    use std::ffi::CStr;
    use std::sync::mpsc::Sender;
    use std::sync::Mutex;

    use block::ConcreteBlock;
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: 4usize]
    }

    /// The named world, held for the life of the app. WebKit forgets a world
    /// nothing holds, and everything its scripts kept with it (the agent's refs,
    /// agent-tree.js), so a call's own reference isn't enough.
    unsafe fn held_world(world: &str) -> *mut Object {
        static HELD: Mutex<BTreeMap<String, usize>> = Mutex::new(BTreeMap::new());
        let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
        *held.entry(world.to_string()).or_insert_with(|| {
            let name = nsstring(world);
            let content_world: *mut Object = msg_send![class!(WKContentWorld), worldWithName: name];
            let _: *mut Object = msg_send![content_world, retain];
            let _: () = msg_send![name, release];
            content_world as usize
        }) as *mut Object
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
        let content_world = held_world(world);
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
    }
}

#[cfg(test)]
mod tests {
    use super::fill;

    /// Every template Rust fills in holds its placeholder exactly once, and
    /// never inside a comment.
    #[test]
    fn template_placeholders_once() {
        let templates: &[(&str, &str, &str)] = &[
            (
                "agent-probe.js",
                include_str!("../assets/agent-probe.js"),
                "__ARGS__",
            ),
            (
                "agent-tree.js",
                include_str!("../assets/agent-tree.js"),
                "__VER__",
            ),
            (
                "restyle.js",
                include_str!("../assets/restyle.js"),
                "__ARGS__",
            ),
            ("cite.js", include_str!("../assets/cite.js"), "__ARGS__"),
            (
                "fingerprint.js",
                include_str!("../assets/fingerprint.js"),
                "__FP_CONFIG__",
            ),
            (
                "consent.js",
                include_str!("../assets/consent.js"),
                "__FLUX_REJECT_TERMS__",
            ),
        ];
        for (name, js, ph) in templates {
            assert_eq!(js.matches(ph).count(), 1, "{name}: {ph} must occur once");
            for line in js.lines() {
                let code = line.split("//").next().unwrap_or("");
                if line.contains(ph) {
                    assert!(code.contains(ph), "{name}: {ph} is in a comment: {line}");
                }
            }
        }
    }

    /// A line or paragraph separator in a value can't end the line it lands on.
    #[test]
    fn fill_escapes_line_separators() {
        let value = serde_json::json!({ "selector": "x\u{2028}alert(1);//" }).to_string();
        let out = fill("const ARGS = __ARGS__;", "__ARGS__", &value);
        assert!(!out.contains('\u{2028}') && !out.contains('\u{2029}'));
        assert!(out.contains("\\u2028"));
        let back: serde_json::Value = serde_json::from_str(
            out.trim_start_matches("const ARGS = ")
                .trim_end_matches(';'),
        )
        .unwrap();
        assert_eq!(back["selector"], "x\u{2028}alert(1);//");
    }
}
