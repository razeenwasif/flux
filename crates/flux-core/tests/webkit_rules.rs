//! Shields on macOS (netfilter.rs) hands WebKit the content-blocker JSON that
//! `flux_filter::to_content_blocker_json` writes, and WebKit refuses a whole
//! list over one rule it can't compile, which leaves every page unfiltered. This
//! probe compiles the bundled list in a real `WKContentRuleListStore`, the way
//! the app does, so a translator change that WebKit rejects fails CI instead.
//!
//! Its own `main` (harness = false): the store answers on the main queue, which
//! only runs while the main thread spins its run loop. `FLUX_PROBE_LISTS` (paths
//! joined with `:`) compiles more lists too, e.g. the cached EasyList:
//! `FLUX_PROBE_LISTS=~/Library/Application\ Support/dev.flux.browser/filters/easylist.txt`.

// A command-line probe: printing what WebKit said is its job.
#![allow(clippy::print_stdout, clippy::print_stderr)]

#[cfg(target_os = "macos")]
fn main() {
    let bundled = include_str!("../assets/default-filters.txt");
    let mut failed = false;
    failed |= !probe("bundled list", bundled);
    if let Ok(paths) = std::env::var("FLUX_PROBE_LISTS") {
        let mut text = String::from(bundled);
        for path in paths.split(':').filter(|p| !p.is_empty()) {
            match std::fs::read_to_string(path) {
                Ok(list) => {
                    text.push('\n');
                    text.push_str(&list);
                }
                Err(e) => {
                    eprintln!("webkit_rules: {path}: {e}");
                    failed = true;
                }
            }
        }
        failed |= !probe("FLUX_PROBE_LISTS", &text);
    }
    if failed {
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("webkit_rules: macOS only, skipped");
}

/// Translate `rules` like shields.rs does and compile the result. True if
/// WebKit accepted it.
#[cfg(target_os = "macos")]
fn probe(name: &str, rules: &str) -> bool {
    // shields.rs CB_MAX_RULES: WebKit's own ceiling is higher.
    let Some(json) = flux_filter::to_content_blocker_json(rules, 75_000) else {
        eprintln!("webkit_rules: {name}: no rules translated");
        return false;
    };
    let count = serde_json::from_str::<Vec<serde_json::Value>>(&json).map_or(0, |v| v.len());
    match mac::compile(&json) {
        Ok(()) => {
            println!("webkit_rules: {name}: WebKit compiled {count} rules");
            true
        }
        Err(e) => {
            eprintln!("webkit_rules: {name}: WebKit refused {count} rules: {e}");
            false
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::CStr;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "WebKit", kind = "framework")]
    extern "C" {}

    const NSUTF8_STRING_ENCODING: usize = 4;

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: NSUTF8_STRING_ENCODING]
    }

    unsafe fn describe(err: *mut Object) -> String {
        let text: *mut Object = msg_send![err, localizedDescription];
        if text.is_null() {
            return "unknown error".into();
        }
        let utf8: *const std::os::raw::c_char = msg_send![text, UTF8String];
        CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    /// Compile `json` in a throwaway store and wait for WebKit's answer.
    pub fn compile(json: &str) -> Result<(), String> {
        let dir = std::env::temp_dir().join(format!("flux-webkit-rules-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let outcome: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
        unsafe {
            let path = nsstring(&dir.to_string_lossy());
            let url: *mut Object =
                msg_send![class!(NSURL), fileURLWithPath: path isDirectory: true];
            let store: *mut Object = msg_send![class!(WKContentRuleListStore), storeWithURL: url];
            if store.is_null() {
                return Err("no WKContentRuleListStore".into());
            }
            let ident = nsstring("flux-probe");
            let encoded = nsstring(json);
            let done = outcome.clone();
            let block = ConcreteBlock::new(move |list: *mut Object, err: *mut Object| {
                *done.borrow_mut() = Some(if err.is_null() && !list.is_null() {
                    Ok(())
                } else if err.is_null() {
                    Err("no list and no error".into())
                } else {
                    Err(describe(err))
                });
            })
            .copy();
            let _: () = msg_send![store,
                compileContentRuleListForIdentifier: ident
                encodedContentRuleList: encoded
                completionHandler: &*block];

            let mode = nsstring("kCFRunLoopDefaultMode");
            let run_loop: *mut Object = msg_send![class!(NSRunLoop), currentRunLoop];
            let deadline = Instant::now() + Duration::from_secs(180);
            while outcome.borrow().is_none() && Instant::now() < deadline {
                let soon: *mut Object =
                    msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.1f64];
                let _: objc::runtime::BOOL = msg_send![run_loop, runMode: mode beforeDate: soon];
            }
            for s in [path, ident, encoded, mode] {
                let _: () = msg_send![s, release];
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        let result = outcome.borrow_mut().take();
        result.unwrap_or_else(|| Err("WebKit didn't answer in 3 minutes".into()))
    }
}
