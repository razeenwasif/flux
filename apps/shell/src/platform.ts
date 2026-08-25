/**
 * Platform detection for the shell (ADR 0012). Flux's Android build runs in the
 * system WebView, whose UA contains "Android" — desktop WebView2 / WebKitGTK
 * never do. This is a frontend-only signal (no IPC), used to strip desktop-only
 * chrome (title bar, resize grips, terminal column, split view, …) and switch to
 * a single-pane, drawer-sidebar layout on a phone.
 */
export const isMobile: boolean = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

/**
 * Windows, from the same UA signal (WebView2 always says "Windows NT";
 * WebKitGTK and the Android WebView never do).
 *
 * Also frontend-only and for the same reason: the editor column computes its RPC
 * address the moment it mounts, and an `await` on a platform IPC would race the
 * boot command it has to queue. The address differs by platform — a named pipe
 * on Windows, a Unix socket elsewhere — so this flag has to be readable
 * synchronously (`editorboot.socketPath`).
 */
export const isWindows: boolean = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

/**
 * Mirror the flag onto <html> so CSS can reach surfaces the `.shell.mobile`
 * class can't. Overlays that would be clipped by a backdrop-filtered ancestor
 * are Portal'd to <body>, which puts them outside `.shell` entirely — so a
 * mobile-only custom property set there (notably `--glass-blur: none`) would
 * never reach them. Setting it at the root covers both trees.
 *
 * Done at module scope rather than in a Solid effect: the class has to be on the
 * element before the first paint, or the phone renders one blurred frame.
 */
if (isMobile && typeof document !== "undefined") {
  document.documentElement.classList.add("mobile");
}
