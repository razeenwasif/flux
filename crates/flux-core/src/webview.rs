//! Per-tab web content (BACKLOG #2).
//!
//! Each Browser tab is a **child webview** added to the chrome window and
//! positioned over the content card's screen rect. The SolidJS chrome
//! (sidebar / agent / terminal) is the parent "main" webview; tab webviews
//! float on top of the `#flux-web-area` region. The frontend reports that
//! rect and drives show/hide/navigate; Rust owns the native webviews,
//! addressed by the label `tab-{id}`.
//!
//! Inactive tabs keep their webview (hidden) so switching is instant and
//! pages keep their state. Each tab webview is injected with `capture.js`
//! (BACKLOG #5) so its DOM streams back to `dom_publish`.

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use crate::state::TabId;

/// The chrome window's label (from tauri.conf.json).
const CHROME_WINDOW: &str = "main";

/// capture.js, injected into every tab webview (stamped with its tab id).
const CAPTURE_JS: &str = include_str!("../assets/capture.js");

/// shortcuts.js: forwards Flux's app keyboard chords from a focused page back
/// to the chrome (#18), since a focused child webview eats the keyboard.
const SHORTCUTS_JS: &str = include_str!("../assets/shortcuts.js");

/// hibernate.js: `__fluxCapture()` / `__fluxRestore()` for preserving a tab's
/// scroll + form state across hibernation (#45).
const HIBERNATE_JS: &str = include_str!("../assets/hibernate.js");

/// darkmode.js: `__fluxDark(on)` force-dark for all sites (#40); applied at
/// document_start via the `window.__FLUX_DARK__` flag the init script stamps.
pub(crate) const DARKMODE_JS: &str = include_str!("../assets/darkmode.js");

fn label(tab: TabId) -> String {
    format!("tab-{tab}")
}

fn parse_url(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("bad url {url:?}: {e}"))
}

/// Create the child webview for a Browser tab at the given rect (logical px,
/// relative to the chrome window's top-left). Idempotent — a second call for
/// an existing tab is a no-op (use `webview_navigate` to change the page).
#[tauri::command]
pub async fn webview_open(
    app: AppHandle,
    tab_id: TabId,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if app.get_webview(&label(tab_id)).is_some() {
        return Ok(());
    }
    let window = app.get_window(CHROME_WINDOW).ok_or("chrome window missing")?;
    let target = parse_url(&url)?;

    // Init script runs before page scripts: stamp the tab id, capture.js, the
    // app keyboard-shortcut forwarder (#18), the hibernation state helpers (#45),
    // and force-dark (#40) — stamping `__FLUX_DARK__` so it applies at start when on.
    let dark = app.try_state::<crate::darkmode::DarkState>().map(|s| s.is_on()).unwrap_or(false);
    let dark_flag = if dark { "window.__FLUX_DARK__ = true;\n" } else { "" };
    let init = format!(
        "window.__FLUX_TAB_ID__ = {tab_id};\n{dark_flag}{CAPTURE_JS}\n{SHORTCUTS_JS}\n{HIBERNATE_JS}\n{DARKMODE_JS}"
    );

    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label(tab_id), WebviewUrl::External(target))
        .initialization_script(&init)
        .on_page_load(move |webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let url = payload.url().to_string();
            // Cosmetic filtering (#57): inject element-hiding CSS for this page,
            // so blocked ad slots / leftover placeholders don't leave gaps. Works
            // on every backend (it's just CSS injection, unlike the network hook).
            let css = app_for_load
                .try_state::<crate::shields::ShieldsState>()
                .map(|s| s.cosmetic_css(&url))
                .unwrap_or_default();
            if !css.is_empty() {
                if let Ok(lit) = serde_json::to_string(&css) {
                    let _ = webview.eval(&format!(
                        "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-cosmetic');\
                         if(!s){{s=d.createElement('style');s.id='flux-cosmetic';}}s.textContent=c;\
                         var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                    ));
                }
            }
            // Extension content scripts (#93/#94): inject the CSS + JS of every
            // enabled extension whose @match patterns hit this URL, at the right
            // phase (document_start vs document_end/idle). With the broker present
            // (#94), the JS gets the callable `flux.*` API shim (+ cap token);
            // otherwise it falls back to the bare identity shim.
            let at_start = matches!(payload.event(), PageLoadEvent::Started);
            let registry = app_for_load.try_state::<crate::extensions::ExtRegistry>();
            let inj = match (registry, app_for_load.try_state::<crate::broker::BrokerState>()) {
                (Some(reg), Some(broker)) => broker.build_injection(&reg, &url, at_start),
                (Some(reg), None) => reg.injection_for(&url, at_start),
                _ => Default::default(),
            };
            if !inj.css.is_empty() {
                if let Ok(lit) = serde_json::to_string(&inj.css) {
                    let _ = webview.eval(&format!(
                        "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-ext-css');\
                         if(!s){{s=d.createElement('style');s.id='flux-ext-css';}}s.textContent=c;\
                         var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                    ));
                }
            }
            if !inj.js.is_empty() {
                let _ = webview.eval(&inj.js);
            }
            // Restore scroll/form state for a waking hibernated tab (#45), once,
            // after the page is laid out. `json` is the captured state as a valid
            // JS object literal; armed only when the tab was actually hibernated.
            if matches!(payload.event(), PageLoadEvent::Finished) {
                if let Some(json) = app_for_load
                    .try_state::<crate::hibernate::HibernateStore>()
                    .and_then(|s| s.take_for_restore(tab_id))
                {
                    let _ = webview.eval(&format!("window.__fluxRestore&&window.__fluxRestore({json})"));
                }
            }
            let _ = app_for_load.emit("flux://tab-loaded", (tab_id, url, phase));
        });

    let scale = window.scale_factor().unwrap_or(1.0);
    let child = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(0.0), height.max(0.0)),
        )
        .map_err(|e| e.to_string())?;
    // Belt-and-suspenders: re-apply geometry + visibility explicitly — some
    // platforms ignore the add_child args, leaving the page wrong/hidden.
    let _ = child.set_position(LogicalPosition::new(x, y));
    let _ = child.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    let _ = child.show();
    let _ = child.set_focus();
    round_webview(&child, width, height, scale); // rounded corners (#center-pane)
    // Install the content-blocker request interceptor (#57/#91, ADR 0007) +
    // native tracking prevention (#58).
    crate::netfilter::install(&app, &child);
    crate::tracking::install(&app, &child);
    crate::permissions::install(&app, &child);
    crate::downloads::install(&app, &child);
    install_tab_accelerators(&app, &child); // Ctrl+Tab cycling (#18)
    tracing::info!(target: "flux::webview", tab_id, %url, x, y, width, height, scale, "opened tab webview");
    Ok(())
}

/// Diagnostic: report the window scale + size and the tab webview's actual
/// (physical) position/size, so a mispositioned page can be debugged.
#[tauri::command]
pub async fn webview_debug(app: AppHandle, tab_id: TabId) -> Result<String, String> {
    let window = app.get_window(CHROME_WINDOW).ok_or("no chrome window")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let wsize = window.inner_size().map_err(|e| e.to_string())?;
    let wv = match app.get_webview(&label(tab_id)) {
        Some(w) => {
            let p = w.position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|e| format!("err:{e}"));
            let s = w.size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|e| format!("err:{e}"));
            format!("webview(phys) pos={p} size={s}")
        }
        None => "no webview for tab".into(),
    };
    Ok(format!("scale={scale} window(phys)={}x{} {wv}", wsize.width, wsize.height))
}

/// Reposition/resize a tab's webview to match the content rect (called on
/// layout changes: resize, sidebar collapse, panel toggles, focus).
#[tauri::command]
pub async fn webview_set_bounds(
    app: AppHandle,
    tab_id: TabId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0))).map_err(|e| e.to_string())?;
        let scale = app.get_window(CHROME_WINDOW).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
        round_webview(&wv, width, height, scale); // keep rounded corners on resize
    }
    Ok(())
}

#[tauri::command]
pub async fn webview_show(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.show().map_err(|e| e.to_string())?;
        let _ = wv.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn webview_hide(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hibernate a tab (#45): destroy its native webview to free the RAM, while the
/// tab stays in the strip. Unlike `webview_close` this does NOT run clear-on-
/// close — the tab isn't closing, just sleeping — and leaves the tab metadata
/// intact so the shell re-creates the webview (reloading the page) on focus.
#[tauri::command]
pub async fn webview_hibernate(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    // Arm restore (#45) so the captured scroll/form state re-applies on wake.
    if let Some(store) = app.try_state::<crate::hibernate::HibernateStore>() {
        store.mark_wake(tab_id);
    }
    // Drop the cached DOM snapshot (up to ~1.25 MiB/tab) — a sleeping tab isn't
    // being acted on, and it re-captures on the wake reload. Frees real RAM in
    // many-tab sessions (without this, hibernation kept every tab's DOM in core).
    if let Some(state) = app.try_state::<crate::state::FluxState>() {
        state.dom_cache.remove(&tab_id);
    }
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Snapshot a tab's scroll + form state into the hibernation store (#45). Called
/// by the chrome when a tab is backgrounded, so the state is ready well before
/// the tab actually hibernates.
#[tauri::command]
pub async fn webview_capture_state(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, "window.__fluxCapture&&window.__fluxCapture()")
}

#[tauri::command]
pub async fn webview_navigate(app: AppHandle, tab_id: TabId, url: String) -> Result<(), String> {
    let wv = app.get_webview(&label(tab_id)).ok_or("no such tab webview")?;
    wv.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

/// Stop the current page load (#31). Engine-agnostic via the page's own
/// `window.stop()`; the frontend clears the loading state when this fires.
#[tauri::command]
pub async fn webview_stop(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, "window.stop()")
}

/// Find-in-page (#33). Uses the engine's native `window.find()` (Chromium +
/// WebKit both implement it) to highlight + scroll to the next/previous match,
/// counts case-insensitive occurrences in the visible text, and reports
/// `{count, found}` back to the chrome via the `find_result` fluxtab command.
/// An empty `query` clears the current selection/highlight.
#[tauri::command]
pub async fn webview_find(app: AppHandle, tab_id: TabId, query: String, forward: bool) -> Result<(), String> {
    let q = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".into());
    // `window.find(str, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)`
    let js = format!(
        "(function(q,fwd){{try{{\
           var inv=window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke;\
           var sel=window.getSelection&&window.getSelection();\
           if(!q){{if(sel)sel.removeAllRanges();\
             if(inv)inv('plugin:fluxtab|find_result',{{tabId:window.__FLUX_TAB_ID__,count:0,found:false}});return;}}\
           var hay=(document.body&&document.body.innerText)||'';\
           var esc=q.replace(/[.*+?^${{}}()|[\\]\\\\]/g,'\\\\$&');\
           var count=(hay.match(new RegExp(esc,'gi'))||[]).length;\
           var found=window.find?window.find(q,false,!fwd,true,false,true,false):false;\
           if(inv)inv('plugin:fluxtab|find_result',{{tabId:window.__FLUX_TAB_ID__,count:count,found:!!found}});\
         }}catch(e){{}}}})({q},{forward});"
    );
    eval(&app, tab_id, &js)
}

/// Back / forward / reload. Tauri has no direct history API on `Webview`, so
/// these drive the page's own history (works across engines).
#[tauri::command]
pub async fn webview_back(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, "history.back()")
}

#[tauri::command]
pub async fn webview_forward(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, "history.forward()")
}

#[tauri::command]
pub async fn webview_reload(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, "location.reload()")
}

#[tauri::command]
pub async fn webview_close(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    // Clear-on-close (#58): if this tab's host is flagged, wipe its cookies
    // (through the always-alive main webview) before tearing the tab down.
    let host: Option<String> = app
        .try_state::<crate::state::FluxState>()
        .and_then(|s| s.tabs.get(&tab_id).and_then(|t| crate::cookies::host_of(&t.url).map(str::to_string)));
    if let Some(host) = host {
        let flagged = app
            .try_state::<crate::cookies::CookieState>()
            .map(|c| c.should_clear_on_close(&host))
            .unwrap_or(false);
        if flagged {
            crate::cookies::clear_for_host(&app, &host);
        }
    }
    // Drop any preserved hibernation state — the tab is gone for good (#45).
    if let Some(store) = app.try_state::<crate::hibernate::HibernateStore>() {
        store.remove(tab_id);
    }
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn eval(app: &AppHandle, tab_id: TabId, js: &str) -> Result<(), String> {
    let wv = app.get_webview(&label(tab_id)).ok_or("no such tab webview")?;
    wv.eval(js).map_err(|e| e.to_string())
}

/// Forward Ctrl+Tab / Ctrl+Shift+Tab from a focused tab webview to the chrome
/// as `next-tab` / `prev-tab` (#18). A focused native webview eats these chords
/// before our injected `shortcuts.js` keydown listener runs, because WebView2
/// treats them as built-in browser accelerators — so we intercept them at the
/// controller's `AcceleratorKeyPressed` event (which fires regardless) and emit
/// the same `flux://shortcut` event `chrome_key` uses. No-op off Windows.
fn install_tab_accelerators(app: &AppHandle, wv: &tauri::webview::Webview) {
    #[cfg(windows)]
    {
        let app = app.clone();
        let _ = wv.with_webview(move |platform| unsafe {
            use tauri::Emitter;
            use webview2_com::AcceleratorKeyPressedEventHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
            };
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                GetKeyState, VK_CONTROL, VK_SHIFT, VK_TAB,
            };

            let controller = platform.controller();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                let _ = args.KeyEventKind(&mut kind);
                // Only act on key-down (the event also fires on key-up).
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                {
                    return Ok(());
                }
                let mut vk = 0u32;
                let _ = args.VirtualKey(&mut vk);
                if vk != VK_TAB.0 as u32 {
                    return Ok(());
                }
                // High bit of GetKeyState → the modifier is currently down.
                let down = |k: i32| (GetKeyState(k) as u16 & 0x8000) != 0;
                if !down(VK_CONTROL.0 as i32) {
                    return Ok(());
                }
                let _ = args.SetHandled(true); // swallow the browser default
                let action = if down(VK_SHIFT.0 as i32) { "prev-tab" } else { "next-tab" };
                let _ = app.emit("flux://shortcut", action);
                Ok(())
            }));
            let mut token = 0i64;
            let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, wv);
    }
}

/// Clip a tab's native webview to rounded corners (Windows). The page is a
/// separate OS layer that CSS can't round, so we set a rounded window region on
/// its host HWND. No-op elsewhere; harmless square fallback if it can't apply.
fn round_webview(wv: &tauri::webview::Webview, width: f64, height: f64, scale: f64) {
    #[cfg(windows)]
    {
        // Corner radius matches the CSS `--flux-radius-card` (18px); GDI's
        // rounded-rect ellipse dimension is 2×the radius.
        let wp = (width * scale).round() as i32;
        let hp = (height * scale).round() as i32;
        let ellipse = (18.0 * scale * 2.0).round() as i32;
        if wp <= 1 || hp <= 1 {
            return;
        }
        let _ = wv.with_webview(move |platform| unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
            let mut hwnd = HWND::default();
            if platform.controller().ParentWindow(&mut hwnd).is_err() {
                return;
            }
            let rgn = CreateRoundRectRgn(0, 0, wp + 1, hp + 1, ellipse, ellipse);
            let _ = SetWindowRgn(hwnd, Some(rgn), true);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (wv, width, height, scale);
    }
}

/// Round the window's corners on Windows 11 (DWM). The window is opaque
/// (transparency breaks WebView2 child webviews), so CSS can't round it.
/// No-op on non-Windows and pre-Win11 (the DWM call just errors, ignored).
#[cfg(windows)]
pub fn round_window_corners(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    if let Ok(hwnd) = window.hwnd() {
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd.0 as isize as HWND,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &pref as *const _ as *const core::ffi::c_void,
                core::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn round_window_corners(_window: &tauri::WebviewWindow) {}
