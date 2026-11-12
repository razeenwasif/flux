//! Full screen around the notch (⌥⌘F), the way Tachyon does it.
//!
//! macOS's own full screen keeps a window below a MacBook's camera housing,
//! leaving a black band. This instead makes Flux's window borderless and the
//! size of the whole screen, band included, and hides the menu bar and Dock
//! while Flux is in front (they come back with any other app). The shell then
//! lays out around the notch: columns beside it run to the top, and the one it
//! sits over starts below it, with the tab's title and the time either side.
//!
//! Settings can keep the menu bar pinned instead: then the window fills the
//! screen below it, the Dock still hidden, and there's no band to wrap.
//!
//! [`NotchGeometry`] says where the notch is, in the window's CSS pixels:
//! `band` is its height (0 on a screen without one: there it's plain full
//! screen with no menu bar), `gap_x`/`gap_w` the stretch it covers.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct NotchGeometry {
    pub band: f64,
    pub gap_x: f64,
    pub gap_w: f64,
}

/// The notch's stretch from the two areas macOS says are free beside it:
/// it runs from the left one's right edge to the right one's left edge.
/// Nothing when either is missing or they don't leave a gap between them.
pub fn gap_between(left: (f64, f64), right: (f64, f64), screen_x: f64) -> Option<(f64, f64)> {
    let (lx, lw) = left;
    let (rx, _) = right;
    let start = lx + lw;
    (lw > 0.0 && rx > start).then(|| (start - screen_x, rx - start))
}

#[cfg(target_os = "macos")]
mod mac {
    use super::NotchGeometry;
    use objc::runtime::{Object, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::Mutex;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Size {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct EdgeInsets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }

    // NSWindowStyleMaskBorderless, NSWindowCollectionBehaviorFullScreenPrimary,
    // NSApplicationPresentationHideDock | HideMenuBar.
    const BORDERLESS: u64 = 0;
    const FULL_SCREEN_PRIMARY: u64 = 1 << 7;
    const HIDE_DOCK: u64 = 1 << 1;
    const HIDE_MENU_BAR: u64 = 1 << 3;

    /// The frame, style and behaviour to go back to.
    static SAVED: Mutex<Option<(Rect, u64, u64)>> = Mutex::new(None);

    pub fn active() -> bool {
        SAVED.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    /// Cover the screen around the notch, or go back. With `keep_menu_bar`,
    /// the menu bar stays pinned and the window fills the screen below it (so
    /// there's no band: the menu bar has it). Main thread only.
    pub unsafe fn set(
        ns_window: *mut Object,
        on: bool,
        keep_menu_bar: bool,
    ) -> Option<NotchGeometry> {
        if ns_window.is_null() {
            return None;
        }
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let mut saved = SAVED.lock().ok()?;
        if !on {
            if let Some((frame, style, behaviour)) = saved.take() {
                let _: () = msg_send![app, setPresentationOptions: 0u64];
                let _: () = msg_send![ns_window, setStyleMask: style];
                let _: () = msg_send![ns_window, setCollectionBehavior: behaviour];
                let _: () = msg_send![ns_window, setFrame: frame display: YES];
                let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            }
            return None;
        }
        let screen: *mut Object = msg_send![ns_window, screen];
        let screen = if screen.is_null() {
            msg_send![class!(NSScreen), mainScreen]
        } else {
            screen
        };
        if screen.is_null() {
            return None;
        }
        if saved.is_none() {
            let frame: Rect = msg_send![ns_window, frame];
            let style: u64 = msg_send![ns_window, styleMask];
            let behaviour: u64 = msg_send![ns_window, collectionBehavior];
            *saved = Some((frame, style, behaviour));
            let _: () = msg_send![ns_window, setStyleMask: BORDERLESS];
            // Still a full-screen window to AppKit, so ⌃⌘F and the Window
            // menu behave.
            let _: () =
                msg_send![ns_window, setCollectionBehavior: behaviour | FULL_SCREEN_PRIMARY];
        }
        let screen_frame: Rect = msg_send![screen, frame];
        if keep_menu_bar {
            // The menu bar's height: what the visible frame leaves at the top,
            // read before the Dock goes (it only ever takes a side or the bottom).
            let visible: Rect = msg_send![screen, visibleFrame];
            let top =
                (screen_frame.origin.y + screen_frame.size.h) - (visible.origin.y + visible.size.h);
            let _: () = msg_send![app, setPresentationOptions: HIDE_DOCK];
            let mut below = screen_frame;
            below.size.h -= top.max(0.0);
            let _: () = msg_send![ns_window, setFrame: below display: YES];
            let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            return Some(NotchGeometry::default());
        }
        let _: () = msg_send![app, setPresentationOptions: HIDE_DOCK | HIDE_MENU_BAR];
        let _: () = msg_send![ns_window, setFrame: screen_frame display: YES];
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
        Some(geometry(screen, screen_frame))
    }

    /// Where the notch is on `screen`, from its safe area and the areas macOS
    /// says are free beside it (macOS 12 and later).
    unsafe fn geometry(screen: *mut Object, frame: Rect) -> NotchGeometry {
        let has: BOOL = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
        if has == NO {
            return NotchGeometry::default();
        }
        let insets: EdgeInsets = msg_send![screen, safeAreaInsets];
        if insets.top <= 0.0 {
            return NotchGeometry::default();
        }
        let aux: BOOL = msg_send![screen, respondsToSelector: sel!(auxiliaryTopLeftArea)];
        let gap = if aux == NO {
            None
        } else {
            let left: Rect = msg_send![screen, auxiliaryTopLeftArea];
            let right: Rect = msg_send![screen, auxiliaryTopRightArea];
            super::gap_between(
                (left.origin.x, left.size.w),
                (right.origin.x, right.size.w),
                frame.origin.x,
            )
        };
        let (gap_x, gap_w) = gap.unwrap_or((0.0, 0.0));
        NotchGeometry {
            band: insets.top,
            gap_x,
            gap_w,
        }
    }
}

/// Full screen around the notch, on or off. Returns where the notch is while
/// on, nothing once off (or off macOS).
#[tauri::command]
pub async fn window_notch(
    window: tauri::WebviewWindow,
    on: bool,
    keep_menu_bar: Option<bool>,
) -> Result<Option<NotchGeometry>, String> {
    let keep_menu_bar = keep_menu_bar.unwrap_or(false);
    tracing::info!(target: "flux::notch", on, keep_menu_bar, "full screen around the notch");
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                let ns = w.ns_window();
                if let Err(e) = &ns {
                    tracing::warn!(target: "flux::notch", "no NSWindow: {e}");
                }
                let geom = ns.ok().and_then(|p| unsafe { mac::set(p as _, on, keep_menu_bar) });
                let _ = tx.send(geom);
            })
            .map_err(|e| e.to_string())?;
        let geom = rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string());
        tracing::info!(target: "flux::notch", ?geom, "notch result");
        geom
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, on, keep_menu_bar);
        Ok(None)
    }
}

/// Whether the window is around the notch now.
#[tauri::command]
pub fn window_notch_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::active()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gap_runs_between_the_free_areas() {
        // A 1512-wide MacBook screen: free to 657 on the left, from 855 on the right.
        assert_eq!(
            gap_between((0.0, 657.0), (855.0, 657.0), 0.0),
            Some((657.0, 198.0))
        );
        // On a second screen to the right, in the window's own coordinates.
        assert_eq!(
            gap_between((1512.0, 657.0), (2367.0, 657.0), 1512.0),
            Some((657.0, 198.0))
        );
        // No notch: the areas are empty or meet.
        assert_eq!(gap_between((0.0, 0.0), (0.0, 0.0), 0.0), None);
        assert_eq!(gap_between((0.0, 756.0), (756.0, 756.0), 0.0), None);
    }
}
