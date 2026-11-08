# 0021 — Mobile Flux goes iOS-first, with a phone-first chrome

Status: accepted (first milestone: browsing and the new phone chrome, 2026-11-08)
Date: 2026-11-08
Relates to: [0012](0012-mobile-termux.md) (mobile Flux, the Android APK and the
mobile cost model), [0001](0001-architecture-and-performance-budgets.md)
(budgets), [0015](0015-theming.md) (Liquid Silk).

## Context

Mobile Flux has been Android-only (0012, rung C): a Tauri APK whose tabs are
`android.webkit.WebView`s that a Kotlin plugin lays over the shell. Its chrome
was Chrome-for-Android in shape (a top bar, a ⋮ drawer, a switcher grid) and
had aged: a top bar out of the thumb's reach, emoji for icons, a drawer that
slid in from the side, and nothing that felt at home on an iPhone.

We now want Flux on iOS, and built for iOS first.

Three things stood in the way:

- **No per-tab views on iOS.** Tauri's mobile model is one WKWebView for the
  whole app. The Android answer (a plugin that owns a stack of native views
  over the content card) had no iOS half.
- **Tauri's iOS tooling assumes a simulator runtime.** `tauri ios build`
  refuses to start unless `xcrun simctl list runtimes` lists an iOS runtime,
  even when building only for a device. This Mac has Xcode 27.2 and its iOS
  SDK but no simulator runtime (an 8–9 GB download we chose not to take).
- **iOS 27 requires scenes.** An app built with the iOS 27 SDK that doesn't
  declare a scene manifest is stopped at launch (SIGTRAP in
  `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`). Tauri
  2.11's tao makes its window the old way, in the app delegate. tao 0.37 can
  use scenes, but it comes with Tauri 2.12, and Flux pins a patched 2.11.2.
- **Xcode 27's SwiftPM.** It appends the host's `-sdk`/`-target` after the
  iOS flags that swift-rs passes, so Tauri's Swift API compiled against the
  macOS SDK and failed. swift-rs 1.0.9 passes `--triple` instead; the lockfile
  had 1.0.7.

## Decision

**1. The iOS half of `tauri-plugin-flux-webview`.** `ios/` holds a Swift
package whose `FluxWebViewPlugin` is the twin of the Kotlin one: the same
commands (`open`, `setBounds`, `show`, `hide`, `close`, `navigate`, `goBack`,
`goForward`, `reload`, `stop`, `thumbnail`) and the same `nav` event, so
`webview.rs`'s mobile arm drives both unchanged. Each tab is a `WKWebView` in
the shell's superview, placed by converting the shell's CSS-pixel rect (a CSS
pixel is a point under `width=device-width, viewport-fit=cover`). All tabs
share one process pool and the default data store, so sign-ins carry across
tabs as on desktop. iOS-only touches:

- the edge swipe goes back and forward in the page (`allowsBackForwardNavigationGestures`);
- links to other schemes (`mailto:`, `tel:`, App Store) go to iOS;
- a web process killed in the background reloads instead of leaving a blank page;
- closing a tab pauses its media first;
- covers come from `takeSnapshot`, which renders the page itself, so it works
  under an overlay (Android needs `PixelCopy` of the live surface).

It also reports two things the shell didn't have before. A `scroll` event
fires once per change of direction, from KVO on `contentOffset`, because
WebKit owns the scroll view's delegate and taking it breaks zooming. The
`nav` event now carries the page's `theme-color`, plus progress and loading
state.

**Scenes without upgrading Tauri.** `crates/flux-core/Info.ios.plist` (Tauri
merges it into the app's Info.plist) declares one window scene whose delegate
is `FluxSceneDelegate`, in the plugin's Swift package. When the scene connects
and the plugin has been handed the shell's webview, the delegate moves the
webview's window into the scene and makes it key. Whichever arrives second does
the move. This is what tao 0.37 does for windows created before the first
scene, and it should go once Flux moves to Tauri 2.12.

**Events need a permission.** The shell listens to the plugin's events through
`addPluginListener`, which calls the plugin's built-in `register_listener`.
Like any command, that needs an ACL permission. The plugin declared none, so
every event was refused and no title, address, theme colour or scroll ever
reached the shell. This had probably been broken on Android too. The plugin now
declares `register_listener` and `remove_listener` in a `default` set.
`capabilities/mobile.json` grants that set to the chrome window, for phones
only (`"platforms": ["iOS", "android"]`; tauri-build skips other platforms'
capabilities, so desktop doesn't need the plugin). Tab webviews get nothing,
as before.

**2. `scripts/build-ios.sh`.** It builds the shell, scaffolds `gen/apple` on a
fresh checkout, runs `tauri ios build`, and installs on a paired iPhone with
`devicectl`. The team comes from the Apple Development certificate, so it's
never written into the repo. If no iOS simulator runtime is installed, the
script puts a stand-in `xcrun` first on `PATH` that answers that one query,
`simctl list runtimes --json`; every other call goes to the real `xcrun`. The
minimum iOS version is 16 (`tauri.conf.json`; Xcode 27 rejects anything below
15). The root `package.json` gains a `tauri` script, which the Xcode build
phase calls.

**Driving the phone from the Mac.** Debug builds carry `DebugDrive` (the
plugin's Swift package, `#if DEBUG` only). `scripts/ios-drive.sh js <file>`
copies a script into the app's own Documents folder, which only a paired Mac
can write to, over `devicectl`. It then posts a Darwin notification. The app
runs the script in the shell, or in a tab if the first line is `//tab:<id>`,
and writes the result back for the script to copy off. `ios-drive.sh shot`
takes a screenshot. Release builds don't contain the hook.

**3. A phone-first chrome, shared by iOS and Android.** `platform.ts` reports
`isIOS` and `isAndroid`; `isMobile` is either. On `<html>`, `ios` or `android`
sits next to `mobile`. The chrome is built for iOS first:

- **A bottom bar** in its own grid row under the card: back, an address
  capsule, the tab count, and ⋯. The capsule shows the site centred and opens
  search when tapped. Swipe it sideways to step through tabs, or up to open
  the tab grid. While the page scrolls down the bar shrinks to a strip showing
  just the site, and the native page eases into the space (`setBounds`
  animates when only the bottom edge moves).
- **A status-bar strip** in its own row above the card, tinted with the page's
  theme colour when it's dark enough for white status text.
- **Search** fills the screen over the hidden page, with the field resting on
  the keyboard (from `visualViewport`). Suggestions stack upward from the
  field, nearest first: the search itself, open tabs ("Switch to tab"), then
  history. With an empty field it shows recently visited pages. The field is
  focused inside the tap's own handler, because iOS raises the keyboard only
  then. It uses 17px text, because iOS zooms the page in on any input under 16px.
- **A tab grid**: page covers in two columns. Tap a cover to open it; tap ×
  or swipe the card away to close it. New and Done sit in a bottom bar.
- **The ⋯ menu as a bottom sheet** with a grabber that drags it down to close.
  Actions on the page come first (Forward, Share through the system share
  sheet or copying the link, New tab, Agent), then Flux's destinations in a
  four-column grid.
- **One set of line icons** (`mobileicons.tsx`) at iOS toolbar weight in
  place of the emoji.

Nothing can float over a page, because each page is a native view laid over
the HTML. So the bar and the strip get their own rows, and anything full screen
(search, the grid, the menu, the agent) hides the page while it's up, as
before. The cost model from 0012 still holds: no backdrop blur on the phone.

## Consequences

- iOS and Android share one shell and one plugin interface. A command added
  for one platform needs its twin, or the other platform rejects it ("No
  command … found").
- The phone chrome's CSS (`MobileChrome.css`, `MobileMenu.css`) loads only
  with the phone chrome. The old drawer's rules left `theme.css`, so the
  desktop's startup stylesheet got slightly smaller.
- The stand-in `xcrun` is a workaround for a Tauri CLI check. Installing a
  simulator runtime makes it step aside on its own.
- Not yet on iOS:
  - Shields. Android filters each request through JNI; iOS needs the filter
    lists compiled to `WKContentRuleList`.
  - Fingerprint defences and other page scripts, which need `WKUserScript`s.
  - `eval` into a page, so no agent DOM or Reader yet.
  - Find in page and zoom.
  - Opening `target=_blank` in a new tab; such links load in the same tab
    for now.
  - Phone layouts for Files, Settings, Notebook and Trail (BACKLOG #185).
  - The start page's dock, which still offers Terminal and Editor.

## Verification

On the iPhone 11 Pro Max (iOS 18.7), driven with `ios-drive.sh`:
- the start page under a 44px status strip, with a 90px bar (56px plus the
  home-indicator inset);
- searching opens Wikipedia in a native view, and the capsule shows the lock
  and the host;
- the page fills the card edge to edge, 414×762 from the status strip down,
  after making `theme.css`'s phone rule outrank the design sheets' 16px card
  padding;
- a second tab from the grid's +, with live covers and real titles once
  events were permitted;
- switching tabs from the grid;
- the ⋯ sheet opens with the page's title and URL and closes on a tap
  outside, and the page comes back.

Gestures and the keyboard need a finger, so they're for checking by hand:
the sideways and upward swipes on the bar, the bar shrinking on scroll, the
edge swipe back, search resting on the keyboard, and the share sheet.

Earlier, in the simulated view:

Typecheck and format checks pass locally, and `tauri ios build` produces a
signed `Flux.ipa`. The UI was checked in a 390×844 WKWebView with an iPhone
user agent: start page, a site tab, the tab grid, the menu sheet and search
with suggestions. It was installed on an iPhone 11 Pro Max with
`build-ios.sh`; on-device checks are in the plan.
