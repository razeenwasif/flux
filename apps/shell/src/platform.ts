/**
 * Platform detection for the shell (ADR 0012). Flux's phone builds run in the
 * system WebView: Android's says "Android", iOS's says "iPhone" or "iPad" — and
 * an iPad asking for desktop sites says "Macintosh", so a Mac UA with a touch
 * screen is an iPad too. Desktop WebView2 / WebKitGTK / macOS WKWebView never
 * match. A frontend-only signal (no IPC), used to strip desktop-only chrome
 * (title bar, resize grips, terminal column, split view, …) and switch to the
 * phone layout.
 */
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isAndroid: boolean = /android/i.test(ua);
// A non-empty UA means `navigator` exists, so the second test needs no guard.
export const isIOS: boolean =
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isMobile: boolean = isAndroid || isIOS;

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
export const isWindows: boolean = /windows/i.test(ua);

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
  document.documentElement.classList.add("mobile", isIOS ? "ios" : "android");
}

/** macOS, from the same UA signal: the WebKit-only paths (tab sleep's memory
 *  pressure, for one) key on it. */
export const isMac: boolean = !isIOS && /Macintosh|Mac OS X/i.test(ua);
