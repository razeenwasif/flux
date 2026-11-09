//! Shields on iOS (ADR 0021). WKWebView has no per-request hook Rust can own,
//! so iOS runs the rules the way macOS does: as a `WKContentRuleList` inside
//! WebKit. Shields already writes its lists as WebKit content-blocker JSON
//! (`webkit-cb.json`); the tab plugin compiles that once per rule set (WebKit
//! keeps the compiled list across launches) and attaches it to each tab,
//! deciding per site as each page starts, from the switches sent here.
//!
//! WebKit reports each block to the plugin's navigation delegate (the private
//! `_webView:contentRuleListWithIdentifier:performedAction:forURL:`), and the
//! plugin calls [`flux_ios_shields_blocked`] so the counts, the tracker graph
//! and the badge work as on macOS.

use std::ffi::{c_char, CStr};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tauri_plugin_flux_webview::{FluxWebviewExt, ShieldsArgs};

use crate::shields::ShieldsState;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    crate::netfilter::set_app(app);
    sync(app);
}

/// Send the rules and switches to the native layer: at boot, after the lists
/// refresh, and whenever a switch changes.
pub fn sync(app: &AppHandle) {
    let Some(s) = app.try_state::<ShieldsState>() else {
        return;
    };
    let args = ShieldsArgs {
        path: s
            .content_blocker_json()
            .map(|p| p.to_string_lossy().into_owned()),
        stamp: s.content_blocker_stamp(),
        enabled: s.is_enabled(),
        off: s.sites_off(),
    };
    if let Err(e) = app.flux_webview().shields(args) {
        tracing::warn!(target: "flux::netfilter", error = %e, "iOS shields sync failed");
    }
}

/// Called by the tab plugin (Swift) for each request WebKit's rules blocked.
///
/// # Safety
/// `page` and `url` are NUL-terminated strings owned by the caller for the
/// duration of the call (Swift's `withCString`).
#[no_mangle]
pub unsafe extern "C" fn flux_ios_shields_blocked(
    tab: i32,
    page: *const c_char,
    url: *const c_char,
) {
    let Some(app) = APP.get() else { return };
    if page.is_null() || url.is_null() {
        return;
    }
    let page = CStr::from_ptr(page).to_string_lossy();
    let url = CStr::from_ptr(url).to_string_lossy();
    let tab = (tab >= 0).then_some(tab as crate::state::TabId);
    crate::netfilter::record_block(app, tab, &page, &url);
}
