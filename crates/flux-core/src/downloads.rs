//! Download manager (BACKLOG #34). Intercepts the engine's download-start
//! hook, tracks each download's progress + state, and exposes a list +
//! controls (cancel / pause / resume / open / reveal) to the chrome's
//! downloads popover.
//!
//! **Windows:** WebView2 `DownloadStarting` COM events behind `#[cfg(windows)]`.
//! **Linux:** WebKitGTK's `download-started` signal behind
//! `#[cfg(target_os = "linux")]` — same model, same `flux://download-updated`
//! event; pause/resume are Windows-only (WebKitGTK's API has no pause).
//!
//! Live download handles are UI-thread objects on both engines, so they're
//! held in UI-thread `thread_local`s and controlled via `run_on_main_thread`;
//! the cross-platform `DownloadState` (the serializable model) is what the
//! rest of Flux sees.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::webview::Webview;
use tauri::{AppHandle, State};

#[derive(Clone, Serialize, specta::Type)]
pub struct DownloadItem {
    pub id: u64,
    pub url: String,
    pub filename: String,
    pub path: String,
    pub received: u64,
    /// 0 when the server didn't report a length.
    pub total: u64,
    /// "in_progress" | "paused" | "completed" | "interrupted"
    pub state: String,
    pub started_ms: u64,
}

#[derive(Default)]
pub struct DownloadState {
    items: Mutex<Vec<DownloadItem>>,
    next_id: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DownloadState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a starting download; returns its id.
    pub fn add(&self, url: String, filename: String, path: String, total: u64) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.items.lock().push(DownloadItem {
            id,
            url,
            filename,
            path,
            received: 0,
            total,
            state: "in_progress".into(),
            started_ms: now_ms(),
        });
        id
    }

    pub fn update(&self, id: u64, received: u64, total: u64, state: &str) {
        if let Some(it) = self.items.lock().iter_mut().find(|i| i.id == id) {
            it.received = received;
            if total > 0 {
                it.total = total;
            }
            it.state = state.to_string();
        }
    }

    /// Newest first.
    pub fn list(&self) -> Vec<DownloadItem> {
        let mut v = self.items.lock().clone();
        // Newest first; tie-break by id (monotonic) so same-ms starts are stable.
        v.sort_unstable_by(|a, b| b.started_ms.cmp(&a.started_ms).then(b.id.cmp(&a.id)));
        v
    }

    pub fn path_of(&self, id: u64) -> Option<String> {
        self.items
            .lock()
            .iter()
            .find(|i| i.id == id)
            .map(|i| i.path.clone())
    }

    /// Drop everything that's no longer running.
    pub fn clear_finished(&self) {
        self.items
            .lock()
            .retain(|i| i.state == "in_progress" || i.state == "paused");
    }
}

/// Install the download interceptor on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(windows)]
    win::install(app.clone(), webview);
    #[cfg(target_os = "linux")]
    gtk::install(app.clone(), webview);
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, webview);
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn downloads_list(state: State<'_, DownloadState>) -> Vec<DownloadItem> {
    state.list()
}

#[tauri::command]
pub fn downloads_clear(state: State<'_, DownloadState>) {
    state.clear_finished();
}

#[tauri::command]
pub fn download_open(state: State<'_, DownloadState>, id: u64) -> Result<(), String> {
    let path = state.path_of(id).ok_or("no such download")?;
    open::that(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_reveal(state: State<'_, DownloadState>, id: u64) -> Result<(), String> {
    let path = state.path_of(id).ok_or("no such download")?;
    let parent = std::path::Path::new(&path)
        .parent()
        .ok_or("no parent folder")?;
    open::that(parent).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_cancel(app: AppHandle, id: u64) {
    #[cfg(windows)]
    win::control(&app, id, Action::Cancel);
    #[cfg(target_os = "linux")]
    gtk::cancel(&app, id);
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, id);
    }
}

#[tauri::command]
pub fn download_pause(app: AppHandle, id: u64) {
    #[cfg(windows)]
    win::control(&app, id, Action::Pause);
    #[cfg(not(windows))]
    {
        let _ = (app, id);
    }
}

#[tauri::command]
pub fn download_resume(app: AppHandle, id: u64) {
    #[cfg(windows)]
    win::control(&app, id, Action::Resume);
    #[cfg(not(windows))]
    {
        let _ = (app, id);
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum Action {
    Cancel,
    Pause,
    Resume,
}

#[cfg(target_os = "linux")]
mod gtk {
    //! WebKitGTK `download-started` hook (#34 follow-up). The signal lives on
    //! the `WebKitWebContext`, which webviews share — so it's connected once
    //! per context (pointer-keyed set) and covers every tab using it. On
    //! `decide-destination` the download routes to the OS Downloads dir with a
    //! numbered dedup, matching wry's convention of passing a plain path to
    //! `set_destination`. Progress / finished / failed update the shared
    //! `DownloadState` and emit `flux://download-updated`, mirroring the
    //! Windows path. All of it runs on the GTK main thread (signals + the
    //! `run_on_main_thread`-marshalled cancel), so the registries are plain
    //! `thread_local`s. WebKitGTK has no pause/resume — those stay no-ops.

    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;

    use glib::object::ObjectType as _;
    use tauri::webview::Webview;
    use tauri::{AppHandle, Emitter, Manager};
    use webkit2gtk::{
        Download, DownloadExt, URIRequestExt, URIResponseExt, WebContextExt, WebViewExt,
    };

    use super::DownloadState;

    thread_local! {
        /// Contexts whose `download-started` is already hooked (ptr-keyed).
        static HOOKED: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
        /// Live downloads by Flux id, for cancel. Removed on finish/fail.
        static OPS: RefCell<HashMap<u64, Download>> = RefCell::new(HashMap::new());
    }

    pub fn install(app: AppHandle, webview: &Webview) {
        let _ = webview.with_webview(move |platform| {
            let wv = platform.inner();
            let Some(ctx) = wv.context() else { return };
            let key = ctx.as_ptr() as usize;
            if !HOOKED.with(|h| h.borrow_mut().insert(key)) {
                return; // this context is already wired (shared across tabs)
            }
            ctx.connect_download_started(move |_ctx, dl| on_started(&app, dl));
            tracing::info!(target: "flux::downloads", "WebKitGTK download hook installed");
        });
    }

    /// Where downloads land: the OS Downloads dir, app-data fallback.
    fn download_dir(app: &AppHandle) -> PathBuf {
        app.path()
            .download_dir()
            .or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads")))
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    /// Keep a suggested filename to one safe path component.
    fn sanitize(name: &str) -> String {
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
        if base.is_empty() {
            "download".into()
        } else {
            base.to_string()
        }
    }

    /// `name.ext` → first free of `name.ext`, `name (1).ext`, `name (2).ext`…
    fn dedup(dir: &std::path::Path, name: &str) -> PathBuf {
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.to_string(), String::new()),
        };
        for n in 1..10_000 {
            let p = dir.join(format!("{stem} ({n}){ext}"));
            if !p.exists() {
                return p;
            }
        }
        candidate
    }

    fn on_started(app: &AppHandle, dl: &Download) {
        let url = dl
            .request()
            .and_then(|r| r.uri())
            .map(|u| u.to_string())
            .unwrap_or_default();
        // Register on decide-destination — that's when the filename is known.
        // id slot shared between the closures below; set exactly once.
        let id_slot = std::rc::Rc::new(std::cell::Cell::new(0u64));

        let app_d = app.clone();
        let url_d = url.clone();
        let id_a = id_slot.clone();
        dl.connect_decide_destination(move |dl, suggested| {
            let dir = download_dir(&app_d);
            let _ = std::fs::create_dir_all(&dir);
            let path = dedup(&dir, &sanitize(suggested));
            dl.set_destination(&path.to_string_lossy());
            if let Some(state) = app_d.try_state::<DownloadState>() {
                let total = dl.response().map(|r| r.content_length()).unwrap_or(0);
                let filename = path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let id = state.add(
                    url_d.clone(),
                    filename,
                    path.to_string_lossy().into_owned(),
                    total,
                );
                id_a.set(id);
                OPS.with(|m| m.borrow_mut().insert(id, dl.clone()));
                let _ = app_d.emit("flux://download-updated", id);
            }
            true // destination handled — don't run the engine default
        });

        let app_p = app.clone();
        let id_b = id_slot.clone();
        dl.connect_received_data(move |dl, _len| {
            let id = id_b.get();
            if id == 0 {
                return;
            }
            if let Some(state) = app_p.try_state::<DownloadState>() {
                let total = dl.response().map(|r| r.content_length()).unwrap_or(0);
                state.update(id, dl.received_data_length(), total, "in_progress");
            }
            let _ = app_p.emit("flux://download-updated", id);
        });

        // `failed` always precedes `finished` on error/cancel — flag it so the
        // finished handler doesn't overwrite "interrupted" with "completed".
        let failed = std::rc::Rc::new(std::cell::Cell::new(false));
        let app_f = app.clone();
        let id_c = id_slot.clone();
        let failed_f = failed.clone();
        dl.connect_failed(move |_dl, _err| {
            failed_f.set(true);
            let id = id_c.get();
            if id == 0 {
                return;
            }
            if let Some(state) = app_f.try_state::<DownloadState>() {
                state.update(id, 0, 0, "interrupted");
            }
            OPS.with(|m| {
                m.borrow_mut().remove(&id);
            });
            let _ = app_f.emit("flux://download-updated", id);
        });

        let app_e = app.clone();
        let id_d = id_slot;
        dl.connect_finished(move |dl| {
            let id = id_d.get();
            if id == 0 {
                return;
            }
            if !failed.get() {
                if let Some(state) = app_e.try_state::<DownloadState>() {
                    let got = dl.received_data_length();
                    state.update(id, got, got, "completed");
                }
            }
            OPS.with(|m| {
                m.borrow_mut().remove(&id);
            });
            let _ = app_e.emit("flux://download-updated", id);
        });
    }

    /// Cancel a live download from a command thread, marshalled to the UI thread.
    pub fn cancel(app: &AppHandle, id: u64) {
        let _ = app.run_on_main_thread(move || {
            OPS.with(|m| {
                if let Some(dl) = m.borrow().get(&id) {
                    dl.cancel();
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_tracks_and_clears() {
        let s = DownloadState::new();
        let a = s.add(
            "https://x/a.zip".into(),
            "a.zip".into(),
            "/d/a.zip".into(),
            100,
        );
        let b = s.add(
            "https://x/b.bin".into(),
            "b.bin".into(),
            "/d/b.bin".into(),
            0,
        );
        assert_ne!(a, b);

        s.update(a, 100, 100, "completed");
        s.update(b, 50, 0, "in_progress");
        let list = s.list();
        assert_eq!(list.len(), 2);
        // newest first (b started after a)
        assert_eq!(list[0].id, b);
        assert_eq!(s.path_of(a).as_deref(), Some("/d/a.zip"));

        // clearing drops finished, keeps running
        s.clear_finished();
        let after = s.list();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, b);
    }
}

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use tauri::webview::Webview;
    use tauri::{AppHandle, Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2DownloadOperation, ICoreWebView2DownloadStartingEventArgs, ICoreWebView2_4,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
        COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
    };
    use webview2_com::{
        BytesReceivedChangedEventHandler, DownloadStartingEventHandler, StateChangedEventHandler,
    };
    use windows::core::{Interface, PWSTR};

    use super::{Action, DownloadState};

    // Live COM operations, keyed by download id — UI thread only.
    thread_local! {
        static OPS: RefCell<HashMap<u64, ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new());
    }

    pub fn install(app: AppHandle, webview: &Webview) {
        let _ = webview.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let core4 = match core.cast::<ICoreWebView2_4>() {
                Ok(c) => c,
                Err(_) => return,
            };
            let handler = DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    on_starting(&app, &args);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core4.add_DownloadStarting(&handler, &mut token);
        });
    }

    unsafe fn on_starting(app: &AppHandle, args: &ICoreWebView2DownloadStartingEventArgs) {
        let op = match args.DownloadOperation() {
            Ok(o) => o,
            Err(_) => return,
        };

        let mut uri = PWSTR::null();
        let url = if op.Uri(&mut uri).is_ok() {
            webview2_com::take_pwstr(uri)
        } else {
            String::new()
        };
        let mut p = PWSTR::null();
        let path = if op.ResultFilePath(&mut p).is_ok() {
            webview2_com::take_pwstr(p)
        } else {
            String::new()
        };
        let filename = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("download")
            .to_string();
        let mut total = 0i64;
        let _ = op.TotalBytesToReceive(&mut total);

        // Flux owns the download UI — suppress WebView2's default bubble.
        let _ = args.SetHandled(true);

        let Some(state) = app.try_state::<DownloadState>() else {
            return;
        };
        let id = state.add(url, filename, path, total.max(0) as u64);
        OPS.with(|m| {
            m.borrow_mut().insert(id, op.clone());
        });

        // Progress + state callbacks read the operation from `sender` (avoids
        // capturing a !Send COM pointer in the closure).
        let app_b = app.clone();
        let bytes = BytesReceivedChangedEventHandler::create(Box::new(move |sender, _| unsafe {
            update(&app_b, id, sender.as_ref());
            Ok(())
        }));
        let mut t1 = 0i64;
        let _ = op.add_BytesReceivedChanged(&bytes, &mut t1);

        let app_s = app.clone();
        let changed = StateChangedEventHandler::create(Box::new(move |sender, _| unsafe {
            update(&app_s, id, sender.as_ref());
            Ok(())
        }));
        let mut t2 = 0i64;
        let _ = op.add_StateChanged(&changed, &mut t2);

        update(app, id, Some(&op));
    }

    unsafe fn update(app: &AppHandle, id: u64, op: Option<&ICoreWebView2DownloadOperation>) {
        let Some(op) = op else { return };
        let mut received = 0i64;
        let _ = op.BytesReceived(&mut received);
        let mut total = 0i64;
        let _ = op.TotalBytesToReceive(&mut total);
        let mut st = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        let _ = op.State(&mut st);
        let state = if st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
            "completed"
        } else if st == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
            "interrupted"
        } else {
            "in_progress"
        };
        if let Some(s) = app.try_state::<DownloadState>() {
            s.update(id, received.max(0) as u64, total.max(0) as u64, state);
        }
        let _ = app.emit("flux://download-updated", id);
        if state != "in_progress" {
            OPS.with(|m| {
                m.borrow_mut().remove(&id);
            });
        }
    }

    /// Control a live download from a command thread, marshalled to the UI thread.
    pub fn control(app: &AppHandle, id: u64, action: Action) {
        let _ = app.run_on_main_thread(move || unsafe {
            OPS.with(|m| {
                if let Some(op) = m.borrow().get(&id) {
                    let _ = match action {
                        Action::Cancel => op.Cancel(),
                        Action::Pause => op.Pause(),
                        Action::Resume => op.Resume(),
                    };
                }
            });
        });
    }
}
