//! Web capture (BACKLOG #54): save the visible page to a PNG via WebView2's
//! `CapturePreview`. Windows/WebView2 only for now; on WebKitGTK it returns an
//! error (a snapshot path there is a follow-up). Full-scrolling-page capture is
//! a follow-up too — this is the visible viewport.

#[cfg(windows)]
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::state::TabId;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Capture the active tab's visible page to a PNG; returns the file path. The
/// write completes asynchronously — `flux://screenshot` is emitted with the path
/// when the image is on disk.
#[tauri::command]
pub async fn webview_capture(app: AppHandle, tab_id: TabId) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("flux-{}.png", now_ms()));
    let path_str = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        win::capture(&app, tab_id, path)?;
        Ok(path_str)
    }
    #[cfg(not(windows))]
    {
        let _ = (tab_id, path, path_str);
        Err("page capture needs the Windows (WebView2) build".into())
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use tauri::Emitter;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{IStream, STGM_CREATE, STGM_WRITE};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;

    pub fn capture(app: &AppHandle, tab_id: TabId, path: PathBuf) -> Result<(), String> {
        let wv = app.get_webview(&format!("tab-{tab_id}")).ok_or("no such tab webview")?;
        let app = app.clone();
        wv.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let wide = HSTRING::from(path.to_string_lossy().as_ref());
            let stream: IStream = match SHCreateStreamOnFileEx(&wide, (STGM_CREATE | STGM_WRITE).0, 0, true, None) {
                Ok(s) => s,
                Err(_) => return,
            };
            // Keep a ref to the stream + emit the path once the write completes.
            let keep = stream.clone();
            let done_path = path.to_string_lossy().to_string();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |_res| {
                let _ = &keep;
                let _ = app.emit("flux://screenshot", done_path.clone());
                Ok(())
            }));
            let _ = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler);
        })
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
