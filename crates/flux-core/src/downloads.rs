//! Download manager (BACKLOG #34). Intercepts WebView2's `DownloadStarting`,
//! tracks each download's progress + state, and exposes a list + controls
//! (cancel / pause / resume / open / reveal) to the chrome's downloads popover.
//!
//! The COM lives behind `#[cfg(windows)]` (WebView2). Live download operations
//! are COM objects bound to the UI thread, so they're held in a UI-thread
//! `thread_local` and controlled via `run_on_main_thread`; the cross-platform
//! `DownloadState` (the serializable model) is what the rest of Flux sees.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::webview::Webview;
use tauri::{AppHandle, State};

#[derive(Clone, Serialize)]
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
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
        self.items.lock().iter().find(|i| i.id == id).map(|i| i.path.clone())
    }

    /// Drop everything that's no longer running.
    pub fn clear_finished(&self) {
        self.items.lock().retain(|i| i.state == "in_progress" || i.state == "paused");
    }
}

/// Install the DownloadStarting interceptor on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(windows)]
    win::install(app.clone(), webview);
    #[cfg(not(windows))]
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
    let parent = std::path::Path::new(&path).parent().ok_or("no parent folder")?;
    open::that(parent).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_cancel(app: AppHandle, id: u64) {
    #[cfg(windows)]
    win::control(&app, id, Action::Cancel);
    #[cfg(not(windows))]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_tracks_and_clears() {
        let s = DownloadState::new();
        let a = s.add("https://x/a.zip".into(), "a.zip".into(), "/d/a.zip".into(), 100);
        let b = s.add("https://x/b.bin".into(), "b.bin".into(), "/d/b.bin".into(), 0);
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
            let handler = DownloadStartingEventHandler::create(Box::new(move |_sender, args| unsafe {
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
        let url = if op.Uri(&mut uri).is_ok() { webview2_com::take_pwstr(uri) } else { String::new() };
        let mut p = PWSTR::null();
        let path = if op.ResultFilePath(&mut p).is_ok() { webview2_com::take_pwstr(p) } else { String::new() };
        let filename = path.rsplit(['\\', '/']).next().unwrap_or("download").to_string();
        let mut total = 0i64;
        let _ = op.TotalBytesToReceive(&mut total);

        // Flux owns the download UI — suppress WebView2's default bubble.
        let _ = args.SetHandled(true);

        let Some(state) = app.try_state::<DownloadState>() else { return };
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
