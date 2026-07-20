//! Android JNI surface (ADR 0012, Milestone 3). Android's system WebView has no
//! network hook Rust can own directly, so the Kotlin `FluxWebViewPlugin` overrides
//! `WebViewClient.shouldInterceptRequest` and calls back here per request — the
//! mobile analogue of the Windows `WebResourceRequested` path. The verdict is the
//! same `ShieldsState::should_block` the desktop uses.
//!
//! `should_block` already applies the global toggle + per-site allowlist, so the
//! Kotlin side calls unconditionally and a `false` means "let it through". A
//! missing app handle (before boot finishes) or any error → not blocked.

use std::sync::OnceLock;

use jni::objects::{JClass, JString};
use jni::sys::jboolean;
use jni::JNIEnv;
use tauri::{AppHandle, Manager};

/// Set once during boot so the JNI callback (no `AppHandle` of its own) can reach
/// the managed `ShieldsState`.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

/// `dev.flux.webview.FluxWebViewPlugin.nativeShouldBlock(url, source, type)`.
/// Returns 1 (block) / 0 (allow). Named to match the JNI mangling of that Kotlin
/// static method — do not rename without updating the Kotlin `external fun`.
///
/// # Safety
/// Called by the JVM with valid `JNIEnv` + `JString`s; standard JNI contract.
#[no_mangle]
pub extern "system" fn Java_dev_flux_webview_FluxWebViewPlugin_nativeShouldBlock(
    mut env: JNIEnv,
    _class: JClass,
    url: JString,
    source: JString,
    request_type: JString,
) -> jboolean {
    let url: String = env.get_string(&url).map(Into::into).unwrap_or_default();
    let source: String = env.get_string(&source).map(Into::into).unwrap_or_default();
    let rtype: String = env
        .get_string(&request_type)
        .map(Into::into)
        .unwrap_or_default();

    let blocked = APP.get().is_some_and(|app| {
        app.try_state::<crate::shields::ShieldsState>()
            .is_some_and(|s| s.should_block(&url, &source, &rtype))
    });
    blocked as jboolean
}
