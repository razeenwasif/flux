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

    // Init script runs before page scripts: stamp the tab id, then capture.js.
    let init = format!("window.__FLUX_TAB_ID__ = {tab_id};\n{CAPTURE_JS}");

    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label(tab_id), WebviewUrl::External(target))
        .initialization_script(&init)
        .on_page_load(move |_webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = app_for_load.emit("flux://tab-loaded", (tab_id, payload.url().to_string(), phase));
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

#[tauri::command]
pub async fn webview_navigate(app: AppHandle, tab_id: TabId, url: String) -> Result<(), String> {
    let wv = app.get_webview(&label(tab_id)).ok_or("no such tab webview")?;
    wv.navigate(parse_url(&url)?).map_err(|e| e.to_string())
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
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn eval(app: &AppHandle, tab_id: TabId, js: &str) -> Result<(), String> {
    let wv = app.get_webview(&label(tab_id)).ok_or("no such tab webview")?;
    wv.eval(js).map_err(|e| e.to_string())
}
