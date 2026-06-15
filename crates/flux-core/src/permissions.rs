//! Site permission hardening (BACKLOG #58): a "block site permission requests"
//! switch that auto-denies camera / microphone / geolocation / notifications
//! etc. via WebView2's `PermissionRequested`.
//!
//! Off by default — WebView2 shows its own prompt for the normal case; this is
//! a one-switch privacy hardening (deny everything, no prompt). Per-site
//! remembered prompts are a future refinement.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::Webview;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct PermState {
    block: AtomicBool,
}

impl PermState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn blocking(&self) -> bool {
        self.block.load(Ordering::Relaxed)
    }
}

/// Install the PermissionRequested handler on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(windows)]
    win::install(app.clone(), webview);
    #[cfg(not(windows))]
    {
        let _ = (app, webview);
    }
}

#[tauri::command]
pub fn permissions_status(state: State<'_, PermState>) -> bool {
    state.blocking()
}

#[tauri::command]
pub fn permissions_set_block(state: State<'_, PermState>, on: bool) {
    state.block.store(on, Ordering::Relaxed);
}

#[cfg(windows)]
mod win {
    use tauri::webview::Webview;
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
    use webview2_com::PermissionRequestedEventHandler;

    pub fn install(app: AppHandle, webview: &Webview) {
        let _ = webview.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| unsafe {
                if let Some(args) = args {
                    // Deny only when the switch is on; otherwise leave the state
                    // at default so WebView2 shows its own prompt.
                    let blocking = app
                        .try_state::<super::PermState>()
                        .map(|s| s.blocking())
                        .unwrap_or(false);
                    if blocking {
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                    }
                }
                Ok(())
            }));
            let mut token: i64 = 0;
            let _ = core.add_PermissionRequested(&handler, &mut token);
        });
    }
}
