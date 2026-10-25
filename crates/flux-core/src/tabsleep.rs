//! Tab sleep in three steps (Flux Next).
//!
//! 1. **Throttled.** A page that isn't on screen is a hidden view, and WebKit
//!    already throttles those: timers, animation frames and painting slow down.
//! 2. **Suspended** after five idle minutes (macOS): WebKit stops the page's
//!    scripts, timers and media but keeps all of it in memory, so switching back
//!    is instant.
//! 3. **Discarded** beyond a warm set of four background tabs, or when a page's
//!    web process passes 256 MB: its webview closes. First Flux keeps WebKit's
//!    own record of the page (`interactionState`: its history, scroll and form
//!    state) and a half-resolution snapshot. Waking restores that record in a
//!    webview that stays hidden while the shell paints the snapshot, until
//!    WebKit reports the page's first real paint, so there's no blank frame.
//!
//! The shell decides when (`sleepPolicy.ts`); this module does the engine work
//! and reports what sleep would cost: playing audio and camera, microphone or
//! screen capture (never slept), unsaved edits or a leave-page prompt (never
//! discarded unless memory is critical). It also passes on the system's
//! memory-pressure signal. Windows and Linux keep the old single step: the
//! checks report nothing and suspending does nothing.

use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU8;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::time::Duration;

use dashmap::{DashMap, DashSet};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::TabId;

/// Snapshots kept for discarded tabs: the oldest goes first.
const MAX_SNAPSHOTS: usize = 40;

/// What sleeping a tab would cost, for the shell's policy.
#[derive(Serialize, Clone, Debug, Default, specta::Type)]
pub struct SleepCheck {
    pub tab_id: TabId,
    /// Physical memory of the page's web process, in MB (macOS).
    pub memory_mb: Option<u32>,
    /// What would stop if the tab slept at all: "playing audio", "using the
    /// camera"… Such a tab isn't suspended or discarded.
    pub keep_awake: Option<String>,
    /// What a discard would lose: "unsaved edits" or "a leave-page prompt".
    pub keep_loaded: Option<String>,
    /// Suspended (step 2) right now.
    pub suspended: bool,
}

#[derive(Default)]
struct Store {
    suspended: DashSet<TabId>,
    /// The page's own answer from its last check, kept because a suspended
    /// page runs no script to ask.
    page_veto: DashMap<TabId, Option<String>>,
    /// Discarded tabs' snapshots (JPEG), with the order they were taken in.
    snapshots: DashMap<TabId, (u64, Arc<Vec<u8>>)>,
    /// Discarded tabs WebKit kept a record of (the record itself lives with
    /// the main-thread code).
    saved: DashSet<TabId>,
    /// Tabs waking from a discard: hidden until the page draws.
    waking: DashSet<TabId>,
}

static STORE: std::sync::LazyLock<Store> = std::sync::LazyLock::new(Store::default);
static TAKEN: AtomicU64 = AtomicU64::new(0);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn store_snapshot(tab: TabId, jpeg: Vec<u8>) {
    let at = TAKEN.fetch_add(1, Ordering::Relaxed);
    STORE.snapshots.insert(tab, (at, Arc::new(jpeg)));
    while STORE.snapshots.len() > MAX_SNAPSHOTS {
        let oldest = STORE
            .snapshots
            .iter()
            .min_by_key(|e| e.value().0)
            .map(|e| *e.key());
        match oldest {
            Some(t) => {
                STORE.snapshots.remove(&t);
            }
            None => break,
        }
    }
}

/// The tab closed: drop everything kept for it.
pub fn forget(app: &AppHandle, tab: TabId) {
    STORE.suspended.remove(&tab);
    STORE.page_veto.remove(&tab);
    STORE.snapshots.remove(&tab);
    STORE.waking.remove(&tab);
    if STORE.saved.remove(&tab).is_some() {
        #[cfg(target_os = "macos")]
        mac::drop_state(tab);
    }
    let _ = app;
}

/// Whether `tab` is waking from a discard with WebKit's record to restore:
/// its webview opens hidden, and the shell shows it once it has drawn.
pub fn opens_hidden(tab: TabId) -> bool {
    STORE.saved.contains(&tab)
}

/// A new webview for `tab` opened hidden ([`opens_hidden`]): restore WebKit's
/// record of the page into it and watch for its first paint (main thread,
/// from `with_webview`). The shell shows it on `flux://tab-painted`, which the
/// first paint or the end of the load sends.
/// # Safety
/// `webview` is the tab's live WKWebView, on the main thread.
#[cfg(target_os = "macos")]
pub unsafe fn restore_into(webview: *mut objc::runtime::Object, tab: TabId) {
    if STORE.saved.remove(&tab).is_some() {
        STORE.waking.insert(tab);
        mac::restore(webview, tab);
    }
}

/// WebKit drew the page (or it finished loading): a waking tab can be shown.
pub fn painted(app: &AppHandle, tab: TabId) {
    if STORE.waking.remove(&tab).is_some() {
        let _ = app.emit("flux://tab-painted", tab);
    }
}

/// Undo a suspension; called before anything shows the page or runs script in
/// it. Cheap when it isn't suspended.
pub fn resume(app: &AppHandle, tab: TabId) {
    if STORE.suspended.remove(&tab).is_none() {
        return;
    }
    // Taken at suspend time, and the page moves on from here.
    STORE.snapshots.remove(&tab);
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&format!("tab-{tab}")) {
        let _ = wv.with_webview(|p| unsafe { mac::set_suspended(p.inner() as _, false) });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Step 2: suspend a background tab. Its snapshot is taken first, while the
/// page is live: one taken after resuming a suspended page shows the top of
/// the page rather than where you were. False when it isn't open, or this
/// platform can't.
#[tauri::command]
pub async fn webview_suspend(app: AppHandle, tab_id: TabId) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let Some(wv) = app.get_webview(&format!("tab-{tab_id}")) else {
            return Ok(false);
        };
        STORE.suspended.insert(tab_id);
        wv.with_webview(move |p| unsafe { mac::snapshot_then_suspend(p.inner() as _, tab_id) })
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tab_id);
        Ok(false)
    }
}

/// What sleeping each tab would cost (see [`SleepCheck`]). Tabs without a
/// webview are left out.
#[tauri::command]
pub async fn tab_sleep_check(app: AppHandle, tab_ids: Vec<TabId>) -> Vec<SleepCheck> {
    #[cfg(target_os = "macos")]
    {
        let mut pending = Vec::new();
        for tab in tab_ids {
            let Some(wv) = app.get_webview(&format!("tab-{tab}")) else {
                continue;
            };
            let suspended = STORE.suspended.contains(&tab);
            let (tx, rx) = std::sync::mpsc::channel::<mac::Part>();
            if wv
                .with_webview(move |p| unsafe { mac::check(p.inner() as _, !suspended, tx) })
                .is_ok()
            {
                pending.push((tab, suspended, rx));
            }
        }
        tauri::async_runtime::spawn_blocking(move || {
            pending
                .into_iter()
                .map(|(tab, suspended, rx)| collect(tab, suspended, &rx))
                .collect()
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        tab_ids
            .into_iter()
            .map(|tab_id| SleepCheck {
                tab_id,
                ..Default::default()
            })
            .collect()
    }
}

/// One tab's check: the native half arrives at once, the page's own answer
/// when its script has run (a suspended page's comes from its last check).
#[cfg(target_os = "macos")]
fn collect(tab: TabId, suspended: bool, rx: &std::sync::mpsc::Receiver<mac::Part>) -> SleepCheck {
    let mut check = SleepCheck {
        tab_id: tab,
        suspended,
        ..Default::default()
    };
    let mut page: Option<Option<String>> = None;
    let deadline = std::time::Instant::now() + Duration::from_millis(600);
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(mac::Part::Native {
                memory_mb,
                keep_awake,
            }) => {
                check.memory_mb = memory_mb;
                check.keep_awake = keep_awake;
                if suspended {
                    break;
                }
            }
            Ok(mac::Part::Page(veto)) => {
                page = Some(veto);
                break;
            }
            Err(_) => break,
        }
    }
    match page {
        Some(veto) => {
            STORE.page_veto.insert(tab, veto.clone());
            check.keep_loaded = veto;
        }
        None => check.keep_loaded = STORE.page_veto.get(&tab).and_then(|v| v.clone()),
    }
    check
}

/// Before a discard closes `tab`'s webview: keep WebKit's record of the page
/// and a snapshot to wake from. Waits for the snapshot at most a second.
pub async fn before_discard(app: &AppHandle, tab: TabId) {
    STORE.suspended.remove(&tab);
    STORE.page_veto.remove(&tab);
    // A suspended tab's snapshot was taken when it was suspended.
    let need_shot = !STORE.snapshots.contains_key(&tab);
    #[cfg(target_os = "macos")]
    {
        let Some(wv) = app.get_webview(&format!("tab-{tab}")) else {
            return;
        };
        let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
        let kept =
            wv.with_webview(move |p| unsafe { mac::keep(p.inner() as _, tab, need_shot, tx) });
        if kept.is_err() {
            return;
        }
        STORE.saved.insert(tab);
        let shot = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(1)).ok().flatten()
        })
        .await
        .ok()
        .flatten();
        if let Some(jpeg) = shot {
            store_snapshot(tab, jpeg);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, need_shot);
}

/// The snapshot `tab` was discarded with, as a data URL, handed over once:
/// the shell paints it while the tab wakes.
#[tauri::command]
pub fn tab_snapshot(tab_id: TabId) -> Option<String> {
    use base64::Engine;
    let (_, (_, jpeg)) = STORE.snapshots.remove(&tab_id)?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg.as_slice())
    ))
}

// ─── Memory pressure ─────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
static PRESSURE: AtomicU8 = AtomicU8::new(0);

/// The system's memory pressure: "normal", "warn" or "critical". macOS reports
/// it itself; elsewhere this is always "normal" and the shell reads free
/// memory instead.
#[tauri::command]
pub fn memory_pressure() -> String {
    #[cfg(target_os = "macos")]
    let level = PRESSURE.load(Ordering::Relaxed);
    #[cfg(not(target_os = "macos"))]
    let level = 0u8;
    pressure_name(level).into()
}

fn pressure_name(level: u8) -> &'static str {
    match level {
        2 => "critical",
        1 => "warn",
        _ => "normal",
    }
}

/// Listen to the kernel's memory-pressure notifications (a dispatch source) and
/// pass each change to the shell as `flux://memory-pressure`.
pub fn watch_memory_pressure(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::watch_pressure(app.clone());
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn pressure_changed(app: &AppHandle, level: u8) {
    if PRESSURE.swap(level, Ordering::Relaxed) != level {
        tracing::info!(target: "flux::sleep", level = pressure_name(level), "memory pressure");
        let _ = app.emit("flux://memory-pressure", pressure_name(level));
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::CStr;
    use std::os::raw::c_void;
    use std::sync::mpsc::Sender;

    use block::ConcreteBlock;
    use objc::rc::StrongPtr;
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};

    use super::{HashMap, TabId};

    /// WebKit's half of a check.
    pub enum Part {
        Native {
            memory_mb: Option<u32>,
            keep_awake: Option<String>,
        },
        /// The page's own answer (`hibernate.js`).
        Page(Option<String>),
    }

    /// WebKit's records of discarded pages. NSData-like and immutable, so
    /// holding and releasing them off the main thread is fine.
    struct Saved(StrongPtr);
    unsafe impl Send for Saved {}
    static STATES: std::sync::LazyLock<parking_lot::Mutex<HashMap<TabId, Saved>>> =
        std::sync::LazyLock::new(Default::default);

    pub fn drop_state(tab: TabId) {
        STATES.lock().remove(&tab);
    }

    unsafe fn nsstring(s: &str) -> *mut Object {
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithBytes: s.as_ptr() length: s.len() encoding: 4usize]
    }

    unsafe fn responds(obj: *mut Object, sel: objc::runtime::Sel) -> bool {
        let yes: BOOL = msg_send![obj, respondsToSelector: sel];
        yes != NO
    }

    pub unsafe fn set_suspended(webview: *mut Object, on: bool) {
        if webview.is_null() {
            return;
        }
        let done = ConcreteBlock::new(|_ok: BOOL| {}).copy();
        if on && responds(webview, sel!(_suspendPage:)) {
            let _: () = msg_send![webview, _suspendPage: &*done];
        } else if !on && responds(webview, sel!(_resumePage:)) {
            let _: () = msg_send![webview, _resumePage: &*done];
        }
    }

    /// The page's web process's physical footprint, in MB.
    unsafe fn memory_mb(webview: *mut Object) -> Option<u32> {
        if !responds(webview, sel!(_webProcessIdentifier)) {
            return None;
        }
        let pid: libc::pid_t = msg_send![webview, _webProcessIdentifier];
        if pid <= 0 {
            return None;
        }
        let mut info: libc::rusage_info_v2 = std::mem::zeroed();
        let ok = libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V2,
            (&mut info as *mut libc::rusage_info_v2).cast(),
        );
        (ok == 0).then_some((info.ri_phys_footprint / (1024 * 1024)) as u32)
    }

    /// What would stop if the page slept: sound, or a capture in progress.
    unsafe fn keep_awake(webview: *mut Object) -> Option<String> {
        if responds(webview, sel!(_isPlayingAudio)) {
            let playing: BOOL = msg_send![webview, _isPlayingAudio];
            if playing != NO {
                return Some("playing audio".into());
            }
        }
        // WKMediaCaptureState: 0 none, 1 active, 2 muted (still holding it).
        if responds(webview, sel!(cameraCaptureState)) {
            let state: isize = msg_send![webview, cameraCaptureState];
            if state != 0 {
                return Some("using the camera".into());
            }
        }
        if responds(webview, sel!(microphoneCaptureState)) {
            let state: isize = msg_send![webview, microphoneCaptureState];
            if state != 0 {
                return Some("using the microphone".into());
            }
        }
        if responds(webview, sel!(_displayCaptureState)) {
            let state: isize = msg_send![webview, _displayCaptureState];
            if state != 0 {
                return Some("sharing the screen".into());
            }
        }
        None
    }

    /// Answer a check on `tx`: WebKit's half now, then (unless the page is
    /// suspended) the page's own when its script has run.
    pub unsafe fn check(webview: *mut Object, ask_page: bool, tx: Sender<Part>) {
        if webview.is_null() {
            return;
        }
        let _ = tx.send(Part::Native {
            memory_mb: memory_mb(webview),
            keep_awake: keep_awake(webview),
        });
        if !ask_page {
            return;
        }
        let tx = std::sync::Mutex::new(Some(tx));
        let block = ConcreteBlock::new(move |result: *mut Object, err: *mut Object| {
            let mut veto = None;
            if err.is_null() && !result.is_null() {
                let is_text: BOOL = msg_send![result, isKindOfClass: class!(NSString)];
                if is_text != NO {
                    let utf8: *const std::os::raw::c_char = msg_send![result, UTF8String];
                    if !utf8.is_null() {
                        let text = CStr::from_ptr(utf8).to_string_lossy().into_owned();
                        veto = (!text.is_empty()).then_some(text);
                    }
                }
            }
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(Part::Page(veto));
            }
        })
        .copy();
        let js = nsstring("window.__fluxSleepVeto ? window.__fluxSleepVeto() : ''");
        let _: () = msg_send![webview, evaluateJavaScript: js completionHandler: &*block];
        let _: () = msg_send![js, release];
    }

    /// Before a discard: keep WebKit's record of the page, and (when `shot`)
    /// take its snapshot, sent as JPEG on `tx` (else `None`).
    pub unsafe fn keep(webview: *mut Object, tab: TabId, shot: bool, tx: Sender<Option<Vec<u8>>>) {
        if webview.is_null() {
            let _ = tx.send(None);
            return;
        }
        if responds(webview, sel!(interactionState)) {
            let state: *mut Object = msg_send![webview, interactionState];
            if !state.is_null() {
                STATES.lock().insert(tab, Saved(StrongPtr::retain(state)));
            }
        }
        if !shot {
            let _ = tx.send(None);
            return;
        }
        let tx = std::sync::Mutex::new(Some(tx));
        snapshot(webview, move |jpeg| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(jpeg);
            }
        });
    }

    /// Snapshot the page, then suspend it, unless it was shown meanwhile.
    pub unsafe fn snapshot_then_suspend(webview: *mut Object, tab: TabId) {
        if webview.is_null() {
            return;
        }
        // Kept alive until the snapshot is back.
        let _: () = msg_send![webview, retain];
        let wk = webview as usize;
        snapshot(webview, move |jpeg| {
            let webview = wk as *mut Object;
            if super::STORE.suspended.contains(&tab) {
                if let Some(jpeg) = jpeg {
                    super::store_snapshot(tab, jpeg);
                }
                set_suspended(webview, true);
            }
            let _: () = msg_send![webview, release];
        });
    }

    /// What's on screen in `webview`, at half resolution (1× on a Retina
    /// screen), as JPEG; `done` runs on the main thread.
    unsafe fn snapshot(webview: *mut Object, done: impl Fn(Option<Vec<u8>>) + 'static) {
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct Rect {
            x: f64,
            y: f64,
            w: f64,
            h: f64,
        }
        let bounds: Rect = msg_send![webview, bounds];
        if bounds.w < 1.0 || bounds.h < 1.0 {
            done(None);
            return;
        }
        let config: *mut Object = msg_send![class!(WKSnapshotConfiguration), new];
        let width: *mut Object = msg_send![class!(NSNumber), numberWithDouble: bounds.w / 2.0];
        let _: () = msg_send![config, setSnapshotWidth: width];
        let block = ConcreteBlock::new(move |image: *mut Object, err: *mut Object| {
            done(if err.is_null() && !image.is_null() {
                jpeg_of(image)
            } else {
                None
            });
        })
        .copy();
        let _: () =
            msg_send![webview, takeSnapshotWithConfiguration: config completionHandler: &*block];
        let _: () = msg_send![config, release];
    }

    /// An NSImage as JPEG bytes.
    unsafe fn jpeg_of(image: *mut Object) -> Option<Vec<u8>> {
        let none: *mut c_void = std::ptr::null_mut();
        let cg: *mut c_void =
            msg_send![image, CGImageForProposedRect: none context: none hints: none];
        if cg.is_null() {
            return None;
        }
        let rep: *mut Object = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: *mut Object = msg_send![rep, initWithCGImage: cg];
        if rep.is_null() {
            return None;
        }
        let key = nsstring("NSImageCompressionFactor");
        let quality: *mut Object = msg_send![class!(NSNumber), numberWithDouble: 0.6f64];
        let props: *mut Object =
            msg_send![class!(NSDictionary), dictionaryWithObject: quality forKey: key];
        // NSBitmapImageFileTypeJPEG
        let data: *mut Object = msg_send![rep, representationUsingType: 3usize properties: props];
        let out = if data.is_null() {
            None
        } else {
            let bytes: *const u8 = msg_send![data, bytes];
            let len: usize = msg_send![data, length];
            (!bytes.is_null() && len > 0).then(|| std::slice::from_raw_parts(bytes, len).to_vec())
        };
        let _: () = msg_send![rep, release];
        let _: () = msg_send![key, release];
        out
    }

    /// Watch a new webview for its first paint, and restore WebKit's record of
    /// `tab`'s page into it if there is one (else it loads its URL as usual).
    pub unsafe fn restore(webview: *mut Object, tab: TabId) {
        let saved = STATES.lock().remove(&tab);
        if webview.is_null() {
            return;
        }
        if responds(webview, sel!(_setObservedRenderingProgressEvents:)) {
            // _WKRenderingProgressEvent: FirstVisuallyNonEmptyLayout (1 << 1),
            // FirstPaintWithSignificantArea (1 << 2), FirstMeaningfulPaint (1 << 8).
            let events: usize = (1 << 1) | (1 << 2) | (1 << 8);
            let _: () = msg_send![webview, _setObservedRenderingProgressEvents: events];
        }
        let restored = match saved {
            Some(Saved(state)) if responds(webview, sel!(setInteractionState:)) => {
                let _: () = msg_send![webview, setInteractionState: *state];
                true
            }
            _ => false,
        };
        tracing::info!(target: "flux::sleep", tab, restored, "waking an unloaded tab");
    }

    // libdispatch: the kernel's memory-pressure source.
    #[allow(non_upper_case_globals)]
    extern "C" {
        static _dispatch_source_type_memorypressure: c_void;
        fn dispatch_source_create(
            kind: *const c_void,
            handle: usize,
            mask: usize,
            queue: *mut c_void,
        ) -> *mut c_void;
        fn dispatch_source_set_event_handler(source: *mut c_void, handler: *const c_void);
        fn dispatch_source_get_data(source: *mut c_void) -> usize;
        fn dispatch_resume(object: *mut c_void);
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
    }
    const PRESSURE_NORMAL: usize = 0x1;
    const PRESSURE_WARN: usize = 0x2;
    const PRESSURE_CRITICAL: usize = 0x4;

    pub fn watch_pressure(app: tauri::AppHandle) {
        unsafe {
            let queue = dispatch_get_global_queue(0, 0);
            let source = dispatch_source_create(
                &_dispatch_source_type_memorypressure,
                0,
                PRESSURE_NORMAL | PRESSURE_WARN | PRESSURE_CRITICAL,
                queue,
            );
            if source.is_null() {
                return;
            }
            // Kept for the life of the process, like the source itself.
            let src = source as usize;
            let handler = ConcreteBlock::new(move || {
                let data = dispatch_source_get_data(src as *mut c_void);
                let level = if data & PRESSURE_CRITICAL != 0 {
                    2
                } else if data & PRESSURE_WARN != 0 {
                    1
                } else {
                    0
                };
                super::pressure_changed(&app, level);
            })
            .copy();
            dispatch_source_set_event_handler(
                source,
                &*handler as *const block::Block<(), ()> as *const c_void,
            );
            std::mem::forget(handler);
            dispatch_resume(source);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_are_capped_oldest_first() {
        for tab in 0..(MAX_SNAPSHOTS as TabId + 5) {
            store_snapshot(9_000_000 + tab, vec![tab as u8]);
        }
        let ours = STORE
            .snapshots
            .iter()
            .filter(|e| *e.key() >= 9_000_000)
            .count();
        assert!(ours <= MAX_SNAPSHOTS);
        assert!(
            !STORE.snapshots.contains_key(&9_000_000),
            "the oldest went first"
        );
        let last = 9_000_000 + MAX_SNAPSHOTS as TabId + 4;
        let url = tab_snapshot(last).expect("the newest is kept");
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(tab_snapshot(last).is_none(), "handed over once");
    }

    #[test]
    fn pressure_levels_have_names() {
        assert_eq!(pressure_name(0), "normal");
        assert_eq!(pressure_name(1), "warn");
        assert_eq!(pressure_name(2), "critical");
    }
}
