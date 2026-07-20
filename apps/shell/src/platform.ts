/**
 * Platform detection for the shell (ADR 0012). Flux's Android build runs in the
 * system WebView, whose UA contains "Android" — desktop WebView2 / WebKitGTK
 * never do. This is a frontend-only signal (no IPC), used to strip desktop-only
 * chrome (title bar, resize grips, terminal column, split view, …) and switch to
 * a single-pane, drawer-sidebar layout on a phone.
 */
export const isMobile: boolean =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
