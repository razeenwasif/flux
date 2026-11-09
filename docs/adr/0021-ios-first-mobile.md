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
`goForward`, `reload`, `stop`, `thumbnail`, `share`) and the same `nav` event, so
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
and the plugin has been handed the shell's webview, the delegate makes a window
for the scene and moves tao's view controller into it. tao's own window stays
alive, hidden and empty. Whichever arrives second does the move. The first
version moved tao's window itself into the scene (`windowScene = …`). That
displayed fine, but sheets presented from it were laid out for the wrong space:
the share sheet came out as a card cut off at the screen's edge. This should
all go once Flux moves to Tauri 2.12, whose tao handles scenes itself.

**Events need a permission.** The shell listens to the plugin's events through
`addPluginListener`, which calls the plugin's built-in `register_listener`.
Like any command, that needs an ACL permission. The plugin declared none, so
every event was refused and no title, address, theme colour or scroll ever
reached the shell. This had probably been broken on Android too. The plugin now
declares `register_listener`, `remove_listener` and `share` (the one command
the shell calls itself) in a `default` set.
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
copies a script into the app's own Caches folder, which only a paired Mac
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
  Actions on the page come first (Forward, Share, New tab, Agent), then
  Flux's destinations in a four-column grid. Share asks the plugin for the
  system share sheet: a half-height sheet on a phone, with the page's title in
  its header, and a popover from ⋯ on an iPad. WebKit's `navigator.share` gave
  a cut-off popover. If the plugin can't share, the link is copied.
- **One set of line icons** (`mobileicons.tsx`) at iOS toolbar weight in
  place of the emoji.
- **Files as a phone page.** The Files popout fills the space between the status
  strip and the bar, which stays usable (`--mc-bar-h`). There's Done to close
  it, and it's in the ⋯ grid too. Inside it's one column:
  - the folder's name with back and up, then the filter;
  - places as chips;
  - 56px rows with an icon tile, the size and date stacked on the right;
  - one tap opens a row, a long press brings up the actions menu.

  Forward, refresh, the preview pane and the column heads are left out.
  `:root.mobile.mobile` in front of these rules outranks the designs' own
  `:root[data-design] .files-…` rules.

  On iOS, Files opens at Flux's Documents ("On My iPhone"). `UIFileSharingEnabled`
  lists that folder in the iOS Files app as On My iPhone › Flux. **Browse…**
  opens iOS's folder picker, and each folder picked there (iCloud Drive,
  another app's folder) becomes a chip. The plugin keeps a security-scoped
  bookmark for each and reopens it at launch, so Rust's ordinary file calls
  work on its path. iOS moves the app's container on every reinstall, so a
  saved folder that's gone falls back to On My iPhone.
- **Share → Flux.** iOS gives no app another browser's tabs: Arc on iPhone has
  no export, and Firefox's tabs leave only through Firefox Sync. So
  `crates/flux-core/ios/ShareExtension` is a share extension. In Firefox,
  Arc, Safari or anything that shares a link, Share → Flux hands the link over
  as `flux-browser://open?url=…`, and Flux opens it in a new tab.
  - The scene delegate catches the link and keeps it in `Opened`.
  - The shell takes the links with `take_opened`: at start, on the `opened`
    event, and whenever Flux comes back to the front.
  - The extension can't call UIApplication's `open`, so it sends
    `openURL:options:completionHandler:` up the responder chain through the
    runtime.
  - `build-ios.sh` adds its target to the generated Xcode spec, since Tauri's
    template doesn't know about it.
  - Its bundle ID (`dev.flux.browser.share`) needs a provisioning profile,
    which Xcode can only make with an Apple ID signed in.

Nothing can float over a page, because each page is a native view laid over
the HTML. So the bar and the strip get their own rows, and anything full screen
(search, the grid, the menu, the agent) hides the page while it's up, as
before. The cost model from 0012 still holds: no backdrop blur on the phone.

## Pages under the shell, and the island (8 Nov)

The bar had sat in its own grid row under the page, since nothing in the
shell can draw over a native view. To make it a frosted-glass island floating
over the page, the layers swap:
- **Pages underneath.** The tab views now live in a `PagesController` (a child
  of tao's view controller) under the shell.
- **Touches pass through.** The shell's WKWebView moves into a `ChromeHost`
  above them, transparent. Its `hitTest` returns nil outside the bars while a
  page shows, so touches go through to the page.
- **The bars are insets.** Pages take the full screen. The bars reach WebKit
  as `additionalSafeAreaInsets` on the controller (`set_chrome`, from the
  shell's ResizeObserver), with the page scroll view on `.automatic`. Content
  and fixed headers stay clear of the bars and scroll under them, and the
  island's frosted glass shows the page blurred. Shrinking the bar on scroll
  changes the insets, not the page's frame.
- **The shell goes see-through.** While a page shows, the plugin's `page`
  event sets `html.native-page`. That clears the shell's backgrounds, Liquid
  Silk's softened wallpaper (`body::before`) and the card's fill.

**The notch.** WebKit draws nothing in the strip behind the status bar: not
the shell, not a page. Probing showed it's transparent there wherever the web
view sits, and a native view underneath shows through. So Flux colours that
native layer instead, the way Safari tints its bar:
- Over a page, the page view's background is the page's
  `underPageBackgroundColor`.
- Over Flux's own pages, it's the colour along the top edge of the wallpaper,
  sampled by the shell and sent with `set_chrome`.
- The status bar's text goes dark over a light page and light otherwise.
  Tao's view controller can't be subclassed, so its `preferredStatusBarStyle`
  is replaced at runtime (`StatusBar`).

**Gestures.** The bar no longer has a Back button: the edge swipe goes back
(iOS), as does the system back (Android). Swiping up on the bar no longer opens
the tab grid, because it fought iOS's swipe up to go home.

## Performance on an older phone (audit, 8 Nov)

Measured on the iPhone 11 Pro Max (A13, 4 GB, iOS 18.7, 60 Hz) with `ios-drive.sh`.

**What was fine and stayed as it was.**
- **Startup:** the shell's DOMContentLoaded comes at about 170 ms.
- **At rest:** Flux's code schedules nothing on a page or on home. No frame
  callbacks, timers or running animations in 3 s.
- **DOM size:** 156 elements on a page, 483 on home.
- **Liquid Silk's blur on home:** 16 elements with `blur(36px)` over a still
  wallpaper scroll the card carousel at 60 fps (median frame 17 ms, 95th
  percentile 17–18 ms). That's the same with the blur forced off, so it stays,
  despite 0012's no-blur rule.
- **Sheets:** the ⋯ sheet opens in about 22 ms, and Files in 36–61 ms.

**What changed.**
- **Tabs really unload.** `webview_hibernate` was a no-op on mobile. The shell's
  tab sleep forgot a tab's view and later "reopened" it, which only reloaded a
  page whose view had stayed alive, so it cost a reload and freed nothing. It
  now drops the native view and keeps the cover (`hibernate` on iOS and
  Android). Checked by forcing the cap: live views fell to the warm set, and an
  unloaded tab came back as a new view with its page.
- **Fewer loaded tabs by default:** 4 on a phone instead of 8
  (`DEFAULT_MAX_LIVE`; Settings still changes it).
- **Memory warnings count.** iOS's memory warning reaches the shell as
  `flux://memory-pressure` "critical", then "normal" 5 s later. The phone
  chrome re-sends the plugin's `memory` event, so the sleep pass unloads idle
  background tabs at once.
- **A killed page waits.** When iOS kills a hidden tab's web process, the tab
  reloads when it's shown, not straight away, which would take the memory
  back.
- **No Opal waves on a phone.** The web view never reports focus, so the waves
  never ran there. The full-screen WebGL canvas (621×1344) still cost a
  context and a shader compile on every visit to home, for a still image
  already underneath.
- **The tab grid stays mounted** after its first open, and pulls only the covers
  that can have changed. Opening it went from 50–141 ms to about 41 ms, with 9
  tabs.

**Left as is.** The first search of a session takes about 257 ms (36 ms after
that). The phone-only logic lives in the phone chrome's lazy chunk, not
App.tsx, because desktop preloads sit exactly at their 72 KB budget.

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
  outside, and the page comes back;
- Flux opens `flux-browser://open?url=https://www.rust-lang.org/` (sent with
  `devicectl … --payload-url`, as the share extension would) in a new tab, and
  `FluxShare.appex` is embedded in the app;
- ⋯ → Share opens the system share sheet with the page's title and site,
  after the scene got its own window. `//native:present` reports a page
  sheet at 414 points wide, below the status bar.

Gestures and the keyboard need a finger, so they're for checking by hand:
the sideways and upward swipes on the bar, the bar shrinking on scroll, the
edge swipe back, and search resting on the keyboard. The swipes and the
bar's shrinking were confirmed by hand on 8 Nov.

Earlier, in the simulated view:

Typecheck and format checks pass locally, and `tauri ios build` produces a
signed `Flux.ipa`. The UI was checked in a 390×844 WKWebView with an iPhone
user agent: start page, a site tab, the tab grid, the menu sheet and search
with suggestions. It was installed on an iPhone 11 Pro Max with
`build-ios.sh`; on-device checks are in the plan.
