//! Fingerprint defences (BACKLOG #60): canvas, WebGL and Web Audio readbacks
//! carry a little noise, keyed by this session and the site (`fingerprint.js`).
//!
//! On unless switched off in Settings → Privacy, and off wherever Shields is
//! (globally, or for the site), which is how a site that breaks gets fixed. The
//! script runs in every frame of tab and panel pages, decides for itself from
//! the top page's host, and carries the list of sites where Shields is off.
//! When a switch changes, macOS swaps the script in every open page so the
//! reload that follows uses the new list; elsewhere it applies to new tabs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

const SCRIPT: &str = include_str!("../assets/fingerprint.js");
/// How Flux finds its script among a page's.
const MARKER: &str = "/*flux-fp*/";

pub struct FingerprintState {
    on: AtomicBool,
    path: Option<PathBuf>,
    /// New every launch: the next session's noise can't be matched to this one.
    secret: String,
}

impl FingerprintState {
    /// The setting from `path` ("0" is off; anything else, or nothing, is on).
    pub fn restore(path: Option<PathBuf>) -> Self {
        let on = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_none_or(|s| s.trim() != "0");
        Self {
            on: AtomicBool::new(on),
            path,
            secret: format!("{:016x}", rand::random::<u64>()),
        }
    }

    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }

    fn set(&self, on: bool) {
        self.on.store(on, Ordering::Relaxed);
        if let Some(p) = &self.path {
            let _ = std::fs::write(p, if on { "1" } else { "0" });
        }
    }
}

/// The script with its settings: this session's secret, whether it's on, and
/// the hosts where Shields is off.
fn script_with(secret: &str, on: bool, off: &[String]) -> String {
    let config = serde_json::json!({ "secret": secret, "on": on, "off": off });
    SCRIPT.replace("__FP_CONFIG__", &config.to_string())
}

/// What goes into a page now.
pub fn script(app: &AppHandle) -> String {
    let Some(fp) = app.try_state::<FingerprintState>() else {
        return script_with("", false, &[]);
    };
    let (shields_on, off) = app
        .try_state::<crate::shields::ShieldsState>()
        .map(|s| (s.is_enabled(), s.sites_off()))
        .unwrap_or((true, Vec::new()));
    script_with(&fp.secret, fp.is_on() && shields_on, &off)
}

/// Put the current settings into every open page's script (macOS). Pages pick
/// them up at their next load.
pub fn refresh(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let source = script(app);
        for (label, webview) in app.webviews() {
            if !(label.starts_with("tab-") || label.starts_with("panel-")) {
                continue;
            }
            let source = source.clone();
            let _ = webview.with_webview(move |pw| unsafe { mac::swap(pw.inner() as _, &source) });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn fingerprint_get(state: State<'_, FingerprintState>) -> bool {
    state.is_on()
}

#[tauri::command]
pub fn fingerprint_set(app: AppHandle, state: State<'_, FingerprintState>, on: bool) {
    state.set(on);
    refresh(&app);
}

#[cfg(target_os = "macos")]
mod mac {
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: 4usize]
    }

    /// Replace Flux's fingerprint script among `webview`'s user scripts, keeping
    /// the others (and their order) as they were.
    pub unsafe fn swap(webview: *mut Object, source: &str) {
        if webview.is_null() {
            return;
        }
        let config: *mut Object = msg_send![webview, configuration];
        let ucc: *mut Object = msg_send![config, userContentController];
        if ucc.is_null() {
            return;
        }
        let current: *mut Object = msg_send![ucc, userScripts];
        let scripts: *mut Object = msg_send![current, copy];
        let count: usize = msg_send![scripts, count];
        let marker = nsstring(super::MARKER);
        let ours = (0..count).any(|i| {
            let s: *mut Object = msg_send![scripts, objectAtIndex: i];
            let text: *mut Object = msg_send![s, source];
            let has: BOOL = msg_send![text, containsString: marker];
            has != NO
        });
        if ours {
            let _: () = msg_send![ucc, removeAllUserScripts];
            for i in 0..count {
                let s: *mut Object = msg_send![scripts, objectAtIndex: i];
                let text: *mut Object = msg_send![s, source];
                let has: BOOL = msg_send![text, containsString: marker];
                if has == NO {
                    let _: () = msg_send![ucc, addUserScript: s];
                    continue;
                }
                let src = nsstring(source);
                let fresh: *mut Object = msg_send![class!(WKUserScript), alloc];
                // At document start (0), in every frame.
                let fresh: *mut Object = msg_send![fresh,
                    initWithSource: src
                    injectionTime: 0isize
                    forMainFrameOnly: NO];
                let _: () = msg_send![ucc, addUserScript: fresh];
                let _: () = msg_send![fresh, release];
                let _: () = msg_send![src, release];
            }
        }
        let _: () = msg_send![marker, release];
        let _: () = msg_send![scripts, release];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_carries_its_settings_as_data() {
        let s = script_with("abc123", true, &["example.com".into(), "a\"b".into()]);
        assert!(s.starts_with(MARKER));
        assert!(!s.contains("__FP_CONFIG__"));
        assert!(
            s.contains(r#"{"off":["example.com","a\"b"],"on":true,"secret":"abc123"}"#),
            "{s}"
        );
        // A host can't break out of the JSON it's embedded in.
        assert_eq!(s.matches("const CONFIG = ").count(), 1);
    }

    #[test]
    fn the_setting_survives_a_restart_and_the_secret_does_not() {
        let dir = std::env::temp_dir().join(format!("flux-fp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fingerprint.txt");
        let a = FingerprintState::restore(Some(path.clone()));
        assert!(a.is_on(), "on by default");
        a.set(false);
        let b = FingerprintState::restore(Some(path.clone()));
        assert!(!b.is_on());
        assert_ne!(a.secret, b.secret);
        assert_eq!(a.secret.len(), 16);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
