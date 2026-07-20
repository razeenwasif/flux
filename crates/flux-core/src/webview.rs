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
//!
//! This is the desktop native multi-webview engine (`Window::add_child`, per-tab
//! positioning). Android has a single system WebView with no child-webview API
//! (ADR 0012), so the module compiles to the `stub` below — same command surface,
//! browsing commands report unavailability, `eval`/`round_window_corners` no-op.
//! Real mobile browsing (a single swapped WebView) is Milestone 2.

#[cfg(desktop)]
mod real {
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

/// panel-badge.js: watches a web panel's title for an unread `(N)` count and
/// reports it via `panel_badge` so the chrome can bubble it on the rail (#48).
const PANEL_BADGE_JS: &str = include_str!("../assets/panel-badge.js");

/// hibernate.js: `__fluxCapture()` / `__fluxRestore()` for preserving a tab's
/// scroll + form state across hibernation (#45).
const HIBERNATE_JS: &str = include_str!("../assets/hibernate.js");

/// reader.js: on-demand article extractor (#41) — posts structured blocks back
/// via the `reader_publish` fluxtab command. Injected only when reader mode opens.
const READER_JS: &str = include_str!("../assets/reader.js");

/// nav.js: Vim link-hints + mouse gestures (#51/#52); inert unless enabled via
/// the `__FLUX_NAV__` flags stamped below.
const NAV_JS: &str = include_str!("../assets/nav.js");

/// newtab.js: routes window.open() / target="_blank" / modified clicks to the
/// chrome so they open as real Flux tabs (native webviews ignore them otherwise).
const NEWTAB_JS: &str = include_str!("../assets/newtab.js");

/// pip.js: video picture-in-picture — a hover button + Alt+P (page-side gestures,
/// since requestPictureInPicture needs in-page user activation) + auto-PiP on
/// tab background (#37).
const PIP_JS: &str = include_str!("../assets/pip.js");

/// macro-record.js: records clicks/inputs while a macro recording is active,
/// gated by the `__FLUX_MACRO_REC__` flag stamped below (#67).
const MACRO_REC_JS: &str = include_str!("../assets/macro-record.js");

/// drafts.js: opt-in typed-draft capture (ADR 0011 final phase). Attaches no
/// listeners unless the backend toggle is on; never reads sensitive fields.
const DRAFTS_JS: &str = include_str!("../assets/drafts.js");

/// darkmode.js: `__fluxDark(on)` force-dark for all sites (#40); applied at
/// document_start via the `window.__FLUX_DARK__` flag the init script stamps.
pub(crate) const DARKMODE_JS: &str = include_str!("../assets/darkmode.js");

/// passwords.js: the password sentinel (#61 follow-up) — detects registration
/// vs login forms, offers a vault-generated strong password (saved on submit)
/// or one-click autofill via the fluxtab vault_* page commands.
const PASSWORDS_JS: &str = include_str!("../assets/passwords.js");

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
    let window = app
        .get_window(CHROME_WINDOW)
        .ok_or("chrome window missing")?;
    let target = parse_url(&url)?;

    // Init script runs before page scripts: stamp the tab id, capture.js, the
    // app keyboard-shortcut forwarder (#18), the hibernation state helpers (#45),
    // and force-dark (#40) — stamping `__FLUX_DARK__` so it applies at start when on.
    let dark = app
        .try_state::<crate::darkmode::DarkState>()
        .map(|s| s.is_on())
        .unwrap_or(false);
    let dark_flag = if dark {
        "window.__FLUX_DARK__ = true;\n"
    } else {
        ""
    };
    let nav_flag = app
        .try_state::<crate::nav::NavState>()
        .map(|s| {
            format!(
                "window.__FLUX_NAV__ = {{hints:{},gestures:{}}};\n",
                s.hints(),
                s.gestures()
            )
        })
        .unwrap_or_default();
    let macro_flag = if app
        .try_state::<crate::macros::MacroState>()
        .map(|s| s.is_recording())
        .unwrap_or(false)
    {
        "window.__FLUX_MACRO_REC__ = true;\n"
    } else {
        ""
    };
    let init = format!(
        "window.__FLUX_TAB_ID__ = {tab_id};\n{dark_flag}{nav_flag}{macro_flag}{CAPTURE_JS}\n{SHORTCUTS_JS}\n{HIBERNATE_JS}\n{DARKMODE_JS}\n{NAV_JS}\n{NEWTAB_JS}\n{PIP_JS}\n{MACRO_REC_JS}\n{PASSWORDS_JS}\n{DRAFTS_JS}"
    );

    // Private tabs (#59) use an in-memory session; container tabs (#59) use a
    // per-container on-disk data dir → an isolated cookie/storage jar.
    let (private, container) = app
        .try_state::<crate::state::FluxState>()
        .and_then(|s| s.tabs.get(&tab_id).map(|t| (t.private, t.container)))
        .unwrap_or((false, 0));
    let app_for_load = app.clone();
    let mut builder = WebviewBuilder::new(label(tab_id), WebviewUrl::External(target))
        .incognito(private)
        .initialization_script(&init);
    if !private && container != 0 {
        if let Ok(dir) = app.path().app_data_dir() {
            builder = builder.data_directory(dir.join("containers").join(container.to_string()));
        }
    }
    // Outbound proxy (#63), if configured — opt-in, so direct otherwise.
    if let Some(proxy) = app
        .try_state::<crate::proxy::ProxyState>()
        .and_then(|s| s.parsed())
    {
        builder = builder.proxy_url(proxy);
    }
    let builder = builder
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
                    let _ = webview.eval(format!(
                        "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-cosmetic');\
                         if(!s){{s=d.createElement('style');s.id='flux-cosmetic';}}s.textContent=c;\
                         var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                    ));
                }
            }
            // Per-site boosts (#49): the user's saved CSS (and any hand-added JS)
            // for this host. CSS re-applies on every page-load event (idempotent);
            // JS runs once, on finish.
            if let Some(bs) = app_for_load.try_state::<crate::boosts::BoostStore>() {
                let (bcss, bjs) = bs.injection_for(&crate::boosts::host_of(&url));
                if !bcss.is_empty() {
                    if let Ok(lit) = serde_json::to_string(&bcss) {
                        let _ = webview.eval(format!(
                            "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-boost');\
                             if(!s){{s=d.createElement('style');s.id='flux-boost';}}s.textContent=c;\
                             var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
                        ));
                    }
                }
                if !bjs.is_empty() && matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = webview.eval(&bjs);
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
                    let _ = webview.eval(format!(
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
                    let _ = webview.eval(format!("window.__fluxRestore&&window.__fluxRestore({json})"));
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
    install_fullscreen_relayout(&app, &child); // re-tile after video fullscreen exit
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
            let p = w
                .position()
                .map(|p| format!("{},{}", p.x, p.y))
                .unwrap_or_else(|e| format!("err:{e}"));
            let s = w
                .size()
                .map(|s| format!("{}x{}", s.width, s.height))
                .unwrap_or_else(|e| format!("err:{e}"));
            format!("webview(phys) pos={p} size={s}")
        }
        None => "no webview for tab".into(),
    };
    Ok(format!(
        "scale={scale} window(phys)={}x{} {wv}",
        wsize.width, wsize.height
    ))
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
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)))
            .map_err(|e| e.to_string())?;
        let scale = app
            .get_window(CHROME_WINDOW)
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
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

/// Open the devtools inspector for a tab's webview (F12). Requires Tauri's
/// `devtools` feature (enabled in Cargo.toml) so it works in release too.
#[tauri::command]
pub async fn webview_devtools(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.open_devtools();
    }
    Ok(())
}

/// Speculative preconnect (BACKLOG #103): inject `<link rel="preconnect">` tags
/// for the predicted next hosts into the active page, so the engine's own
/// network stack opens DNS+TCP+TLS to them ahead of the likely next navigation.
/// Hosts come from the prefetch model's confidence-gated hints; idempotent
/// (skips a host already preconnected this page).
#[tauri::command]
pub async fn webview_preconnect(
    app: AppHandle,
    tab_id: TabId,
    hosts: Vec<String>,
) -> Result<(), String> {
    if hosts.is_empty() {
        return Ok(());
    }
    let Some(wv) = app.get_webview(&label(tab_id)) else {
        return Ok(());
    };
    // Hosts are JSON-encoded → injection-safe inside the script literal.
    let json = serde_json::to_string(&hosts).map_err(|e| e.to_string())?;
    let js = format!(
        r#"(() => {{
  const seen = (window.__fluxPreconnect ||= new Set());
  for (const h of {json}) {{
    if (!h || seen.has(h)) continue;
    seen.add(h);
    for (const rel of ['preconnect', 'dns-prefetch']) {{
      const l = document.createElement('link');
      l.rel = rel; l.href = 'https://' + h; l.crossOrigin = '';
      document.head.appendChild(l);
    }}
  }}
}})();"#
    );
    wv.eval(&js).map_err(|e| e.to_string())?;
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
    let wv = app
        .get_webview(&label(tab_id))
        .ok_or("no such tab webview")?;
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
pub async fn webview_find(
    app: AppHandle,
    tab_id: TabId,
    query: String,
    forward: bool,
) -> Result<(), String> {
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

/// Inject the reader-mode extractor (#41); it posts blocks back via `reader_publish`.
#[tauri::command]
pub async fn webview_extract_reader(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    eval(&app, tab_id, READER_JS)
}

/// Set the zoom factor of a tab's webview (per-site zoom, #36). 1.0 = 100%.
#[tauri::command]
pub async fn webview_zoom(app: AppHandle, tab_id: TabId, factor: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(tab_id)) {
        wv.set_zoom(factor.clamp(0.25, 5.0))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn webview_close(app: AppHandle, tab_id: TabId) -> Result<(), String> {
    // Clear-on-close (#58): if this tab's host is flagged, wipe its cookies
    // (through the always-alive main webview) before tearing the tab down.
    let host: Option<String> = app.try_state::<crate::state::FluxState>().and_then(|s| {
        s.tabs
            .get(&tab_id)
            .and_then(|t| crate::cookies::host_of(&t.url).map(str::to_string))
    });
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

/// Tab-switcher cover snapshot. Mobile-only (ADR 0012) — desktop shows live
/// webviews, so there's nothing to snapshot; returns "" and the UI falls back.
#[tauri::command]
pub async fn webview_thumbnail(_app: AppHandle, _tab_id: TabId) -> Result<String, String> {
    Ok(String::new())
}

pub(crate) fn eval(app: &AppHandle, tab_id: TabId, js: &str) -> Result<(), String> {
    let wv = app
        .get_webview(&label(tab_id))
        .ok_or("no such tab webview")?;
    wv.eval(js).map_err(|e| e.to_string())
}

// ─── Web panels (BACKLOG #48) ────────────────────────────────────────────────
// A panel is a child webview like a tab, but persistent (not driven by the tab
// lifecycle) and deliberately WITHOUT capture.js — a pinned music/chat/docs panel
// must not stream its DOM into history/clustering. It still gets dark mode + the
// shortcut forwarder, content blocking, and rounded corners.

fn panel_label(id: u32) -> String {
    format!("panel-{id}")
}

#[tauri::command]
pub async fn panel_open(
    app: AppHandle,
    panel_id: u32,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if app.get_webview(&panel_label(panel_id)).is_some() {
        return Ok(());
    }
    let window = app
        .get_window(CHROME_WINDOW)
        .ok_or("chrome window missing")?;
    let target = parse_url(&url)?;
    let dark = app
        .try_state::<crate::darkmode::DarkState>()
        .map(|s| s.is_on())
        .unwrap_or(false);
    let dark_flag = if dark {
        "window.__FLUX_DARK__ = true;\n"
    } else {
        ""
    };
    let init = format!("{dark_flag}{SHORTCUTS_JS}\n{DARKMODE_JS}\n{PANEL_BADGE_JS}");
    let mut builder = WebviewBuilder::new(panel_label(panel_id), WebviewUrl::External(target))
        .initialization_script(&init);
    if let Some(proxy) = app
        .try_state::<crate::proxy::ProxyState>()
        .and_then(|s| s.parsed())
    {
        builder = builder.proxy_url(proxy); // #63
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let child = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(0.0), height.max(0.0)),
        )
        .map_err(|e| e.to_string())?;
    let _ = child.set_position(LogicalPosition::new(x, y));
    let _ = child.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    let _ = child.show();
    round_webview(&child, width, height, scale);
    crate::netfilter::install(&app, &child);
    crate::tracking::install(&app, &child);
    crate::permissions::install(&app, &child);
    install_tab_accelerators(&app, &child);
    install_fullscreen_relayout(&app, &child); // re-tile after video fullscreen exit
    Ok(())
}

/// A web panel reporting its unread count (#48), parsed from the page title by
/// the injected `panel-badge.js`. The panel id comes from the *calling webview's*
/// label (`panel-<id>`), so a page can only badge its own panel. Emits
/// `flux://panel-badge` for the chrome to paint a bubble on the rail icon.
#[tauri::command]
pub fn panel_badge(app: AppHandle, webview: tauri::Webview, count: i64) {
    if let Some(id) = webview
        .label()
        .strip_prefix("panel-")
        .and_then(|s| s.parse::<u32>().ok())
    {
        let _ = app.emit("flux://panel-badge", (id, count.max(0)));
    }
}

#[tauri::command]
pub async fn panel_set_bounds(
    app: AppHandle,
    panel_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&panel_label(panel_id)) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)))
            .map_err(|e| e.to_string())?;
        let scale = app
            .get_window(CHROME_WINDOW)
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        round_webview(&wv, width, height, scale);
    }
    Ok(())
}

#[tauri::command]
pub async fn panel_show(app: AppHandle, panel_id: u32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&panel_label(panel_id)) {
        wv.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn panel_hide(app: AppHandle, panel_id: u32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&panel_label(panel_id)) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn panel_navigate(app: AppHandle, panel_id: u32, url: String) -> Result<(), String> {
    let wv = app
        .get_webview(&panel_label(panel_id))
        .ok_or("no such panel webview")?;
    wv.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn panel_close(app: AppHandle, panel_id: u32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&panel_label(panel_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
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
            let handler =
                AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
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
                    let action = if down(VK_SHIFT.0 as i32) {
                        "prev-tab"
                    } else {
                        "next-tab"
                    };
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

/// When a page leaves HTML5 fullscreen (e.g. a video player), WebView2 (via wry)
/// restores the child webview to fill the *parent window* — which covers Flux's
/// chrome (bookmark bar / footer), because Flux tiles webview bounds itself rather
/// than letting wry own them. No DOM event in the chrome's own webview observes
/// this (the fullscreen happens in a separate page webview), so we hook the page
/// webview's `ContainsFullScreenElementChanged` and, on *exit only* (re-tiling on
/// enter would shrink the video back out of fullscreen), emit
/// `flux://fullscreen-changed` — the frontend re-applies the tiled bounds. No-op
/// off Windows.
fn install_fullscreen_relayout(app: &AppHandle, wv: &tauri::webview::Webview) {
    #[cfg(windows)]
    {
        let app = app.clone();
        let _ = wv.with_webview(move |platform| unsafe {
            use std::sync::atomic::{AtomicBool, Ordering};
            use tauri::Emitter;
            use webview2_com::ContainsFullScreenElementChangedEventHandler;

            let controller = platform.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            // The event strictly *alternates* (no-fullscreen → fullscreen → …), so we
            // track state with a flip instead of querying ContainsFullScreenElement —
            // that getter wants webview2-com-sys's own `windows_core::BOOL`, a
            // different version from the `windows` crate this file otherwise uses.
            // Only act when fullscreen has just been *left*; re-tiling on enter would
            // shrink the video straight back out of fullscreen.
            let is_full = AtomicBool::new(false);
            let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(
                move |_sender, _args| {
                    let now_full = !is_full.fetch_xor(true, Ordering::Relaxed);
                    if !now_full {
                        let _ = app.emit("flux://fullscreen-changed", false);
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            let _ = core.add_ContainsFullScreenElementChanged(&handler, &mut token);
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

/// macOS: the window is borderless (`decorations: false`), so it has square
/// corners. Round the content view's layer and let the window go non-opaque so
/// the rounded corners (and a rounded shadow) show instead of a square fill.
/// Best-effort (null-checked, failures ignored) — cosmetic only.
#[cfg(target_os = "macos")]
pub fn round_window_corners(window: &tauri::WebviewWindow) {
    use objc::runtime::{Object, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};

    let Ok(ptr) = window.ns_window() else { return };
    let ns_window = ptr as *mut Object;
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let content: *mut Object = msg_send![ns_window, contentView];
        if content.is_null() {
            return;
        }
        let _: () = msg_send![content, setWantsLayer: YES];
        let layer: *mut Object = msg_send![content, layer];
        if !layer.is_null() {
            let radius: f64 = 10.0;
            let _: () = msg_send![layer, setCornerRadius: radius];
            let _: () = msg_send![layer, setMasksToBounds: YES];
        }
        // Without this the opaque window fills the corner triangles square.
        let clear: *mut Object = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setOpaque: NO];
        let _: () = msg_send![ns_window, setBackgroundColor: clear];
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn round_window_corners(_window: &tauri::WebviewWindow) {}
} // mod real
#[cfg(desktop)]
pub use real::*;

/// Mobile stub (ADR 0012): Android's single system WebView has no child-webview
/// API, so the per-tab browsing engine can't exist. The command surface is kept
/// identical (so `lib.rs`'s `generate_handler!` is unchanged); browsing commands
/// return an error, and the two internal helpers no-op so their callers compile.
#[cfg(mobile)]
mod stub {
    use crate::state::TabId;
    use tauri::AppHandle;
    use tauri_plugin_flux_webview::{BoundsArgs, FluxWebviewExt, OpenArgs};

    const NB: &str = "web panels aren't available on mobile";

    /// Internal JS eval (called by dom/agent/find). No `evaluateJavascript` bridge
    /// to the native tab WebView yet (Milestone 2 first cut), so it no-ops.
    pub(crate) fn eval(_app: &AppHandle, _tab_id: TabId, _js: &str) -> Result<(), String> {
        Ok(())
    }

    /// Window corner rounding is a desktop cosmetic; nothing to do on mobile.
    pub fn round_window_corners(_window: &tauri::WebviewWindow) {}

    /// Panel/tab badge overlay — no native panel webview on mobile.
    #[tauri::command]
    pub fn panel_badge(_app: AppHandle, _webview: tauri::Webview, _count: i64) {}

    // ── Browser tabs → the native WebView-stack plugin (ADR 0012, Milestone 2) ──
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
        app.flux_webview()
            .open(OpenArgs {
                id: tab_id as i32,
                url,
                x,
                y,
                width,
                height,
            })
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn webview_set_bounds(
        app: AppHandle,
        tab_id: TabId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        app.flux_webview()
            .set_bounds(BoundsArgs {
                id: tab_id as i32,
                x,
                y,
                width,
                height,
            })
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn webview_navigate(app: AppHandle, tab_id: TabId, url: String) -> Result<(), String> {
        app.flux_webview()
            .navigate(tab_id as i32, url)
            .map_err(|e| e.to_string())
    }

    /// Commands that take just a tab id and forward to a plugin method of the
    /// same shape (show/hide/close/back/forward/reload).
    macro_rules! id_cmd {
        ($name:ident => $method:ident) => {
            #[tauri::command]
            pub async fn $name(app: AppHandle, tab_id: TabId) -> Result<(), String> {
                app.flux_webview()
                    .$method(tab_id as i32)
                    .map_err(|e| e.to_string())
            }
        };
    }
    id_cmd!(webview_show => show);
    id_cmd!(webview_hide => hide);
    id_cmd!(webview_close => close);
    id_cmd!(webview_back => back);
    id_cmd!(webview_forward => forward);
    id_cmd!(webview_reload => reload);

    /// Not wired to the native WebView yet — accepted as no-ops so the shell's
    /// routine calls during browsing don't error (Milestone 2 follow-ons).
    macro_rules! noop_cmd {
        ($name:ident ( $($arg:ident : $ty:ty),* $(,)? )) => {
            #[tauri::command]
            pub async fn $name(_app: AppHandle, $($arg: $ty),*) -> Result<(), String> {
                $( let _ = $arg; )*
                Ok(())
            }
        };
    }
    noop_cmd!(webview_preconnect(tab_id: TabId, hosts: Vec<String>));
    noop_cmd!(webview_devtools(tab_id: TabId));
    noop_cmd!(webview_hibernate(tab_id: TabId));
    noop_cmd!(webview_capture_state(tab_id: TabId));
    noop_cmd!(webview_stop(tab_id: TabId));
    noop_cmd!(webview_find(tab_id: TabId, query: String, forward: bool));
    noop_cmd!(webview_extract_reader(tab_id: TabId));
    noop_cmd!(webview_zoom(tab_id: TabId, factor: f64));

    /// Web panels (pinned side apps) have no mobile equivalent yet.
    macro_rules! panel_stub {
        ($name:ident ( $($arg:ident : $ty:ty),* $(,)? )) => {
            #[tauri::command]
            pub async fn $name(_app: AppHandle, $($arg: $ty),*) -> Result<(), String> {
                $( let _ = $arg; )*
                Err(NB.into())
            }
        };
    }
    panel_stub!(panel_open(panel_id: u32, url: String, x: f64, y: f64, width: f64, height: f64));
    panel_stub!(panel_set_bounds(panel_id: u32, x: f64, y: f64, width: f64, height: f64));
    panel_stub!(panel_show(panel_id: u32));
    panel_stub!(panel_hide(panel_id: u32));
    panel_stub!(panel_navigate(panel_id: u32, url: String));
    panel_stub!(panel_close(panel_id: u32));

    #[tauri::command]
    pub async fn webview_debug(_app: AppHandle, _tab_id: TabId) -> Result<String, String> {
        Ok("native Android WebView (Milestone 2)".into())
    }

    /// Pull a tab's cached cover snapshot for the switcher. Images are too large
    /// for the plugin event channel, so the shell fetches them over normal IPC.
    #[tauri::command]
    pub async fn webview_thumbnail(app: AppHandle, tab_id: TabId) -> Result<String, String> {
        app.flux_webview()
            .thumbnail(tab_id as i32)
            .map_err(|e| e.to_string())
    }
}
#[cfg(mobile)]
pub use stub::*;
