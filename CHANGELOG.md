# Changelog

All notable changes to Flux. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org). Unreleased work lands here in the
same commit as the code (docs-before-commit policy). Pair file: `BACKLOG.md`
(what's NOT done yet).

## [Unreleased]

### Added
- **Keyboard shortcuts** (BACKLOG #18) — Windows/Linux Ctrl-based bindings
  (Cmd also works on macOS): new browser tab `Ctrl+T`, terminal tab
  `Ctrl+Shift+T`, close tab `Ctrl+W`, next/prev tab `Ctrl+Tab` /
  `Ctrl+Shift+Tab`, jump to tab `Ctrl+1‑9`, toggle terminal `` Ctrl+` ``,
  toggle agent `Ctrl+Shift+A`, toggle sidebar `Ctrl+B`, focus omnibox `Ctrl+L`,
  reload `Ctrl+R`/`F5`, back/forward `Alt+←`/`Alt+→`. The chrome handles these
  via a capture-phase listener; when a page webview has focus (which eats the
  keyboard), an injected `shortcuts.js` forwards the chord to the chrome through
  a new `chrome_key` fluxtab command. A terminal-focus guard leaves
  readline/tmux chords (Ctrl+R/W/L/B) to the shell. (Avoided ⌃A/⌘S from the
  original spec — they collide with select-all / save-page on Win/Linux; the
  `Ctrl+K` command palette waits on #6.)
- **Extension manager UI** (BACKLOG #95). The footer 🧩 panel is now a real
  manager: it lists installed extensions with name/version + permission chips,
  an enable/disable toggle, a remove button, and an **install-from-folder** row
  (point it at a folder with `flux.extension.json` — e.g.
  `examples/extensions/hello` — and validation errors surface inline). Backed by
  the #92 registry commands. This completes the extension epic (#92–95):
  install → inject → grant-checked API → manage. (Still to come: `flux.ui`
  extension-contributed chrome, `flux.events`, and a native folder picker.)
- **Extension `flux.*` API + capability broker** (BACKLOG #94, ADR 0008). A
  privileged Rust broker (`broker.rs`) is the one door extension content scripts
  may call. Each content script gets a JS shim exposing `flux.runtime`
  (id/version/permissions), `flux.storage` (per-extension persisted KV),
  `flux.tabs` (query/open/navigate), and `flux.dom` (read cached snapshot /
  inject JS) — every method forwards to `plugin:fluxtab|ext_broker_call` tagged
  with a per-extension **capability token**. The broker resolves the token →
  extension and checks every call against the manifest's grants:
  **deny-by-default**, so unknown calls and ungranted permissions are rejected.
  Grant model, token mint/resolve, storage round-trip, and the shim are
  unit-tested. (`flux.ui` and `flux.events` land with the manager UI in #95.)
  Security caveat (documented in ADR 0008): on WebView2 the shim runs in the
  page world, so the token isn't hidden from a hostile same-page script —
  WebKitGTK script worlds are the future hardening path.
- **Extension content-script injection** (BACKLOG #93, ADR 0008). On each page
  load, `ExtRegistry::injection_for(url, phase)` assembles the CSS + JS of every
  enabled extension whose `@match` patterns hit the URL — honoring `run_at`
  (document_start vs document_end/idle) — and injects them through the existing
  `on_page_load`/`eval` path (the same one cosmetic filtering uses). Each
  extension's JS runs inside its own IIFE scope guard (WebView2 has no isolated
  worlds) carrying a frozen `flux` identity object. New match-pattern + glob
  engine (`https://*/*`, `*://*.example.com/*`, `<all_urls>`, path globs),
  unit-tested. The callable `flux.*` broker API replaces the identity shim in
  #94.
- **Extension manifest + loader + registry** (BACKLOG #92, ADR 0008) — the
  foundation of Flux's mini-extension model. `flux.extension.json` declares
  id/name/version, deny-by-default `permissions`, `content_scripts`
  (match globs + js/css + run_at), an optional `background` worker, and `ui`
  contributions. `Manifest::parse` validates (id shape, known permissions only,
  non-empty matches); `ExtRegistry` loads an extension folder, verifies its
  content-script files exist, and persists `extensions/registry.json`
  (install / list / enable-disable / remove). New commands
  `ext_install`/`ext_list`/`ext_set_enabled`/`ext_remove` + ipc bindings + mock.
  Ships a reference example at `examples/extensions/hello`. (Content-script
  *injection* is #93, the `flux.*` broker API is #94, the manager UI is #95.)
- **Block site permission requests** (BACKLOG #58, completes it). A Shields-
  popover toggle that auto-denies camera/mic/geolocation/notifications via
  WebView2's `PermissionRequested` (off by default — WebView2's own prompt
  handles the normal case; this is one-switch hardening). COM verified against
  the msvc target. The HTTPS downgrade *interstitial* was deliberately skipped —
  the per-site "Allow HTTP" toggle already recovers from a no-HTTPS site.
- **Clear cookies on close** (BACKLOG #58). A per-site "Clear cookies on close"
  toggle (Shields popover): when a flagged site's tab closes, its cookies are
  wiped. Cookie ops now run through the always-alive **main** webview (shared
  cookie store) instead of a tab webview, avoiding a teardown race with the
  closing tab.
- **Tracking prevention** (BACKLOG #58, third-party trackers/cookies). A
  "Trackers" selector (Off/Basic/Balanced/Strict, default **Balanced**) in the
  Shields popover drives WebView2's native Edge tracking prevention
  (`ICoreWebView2Profile3`) — profile-wide third-party tracker + cookie blocking
  that complements the EasyList content blocker. Applied to each tab webview on
  creation and on change. COM verified against the msvc target.
- **Extension architecture decided — ADR 0008** (BACKLOG #96). Flux's mini-
  extension model: a manifest (`flux.extension.json`), content scripts injected
  via the existing path, and the capable `flux.*` API in a **Rust broker**
  (content scripts treated as untrusted vs the page). A document-start
  **capability-token handshake** authenticates the extension (WebView2 has no
  isolated worlds; WebKitGTK adds a script world where it can), permissions are
  deny-by-default with install consent, and hard boundaries wall off other
  extensions' storage, raw IPC, and blanket net/fs. Implementation is #92–95.
- **Cookie controls** (BACKLOG #58). The Shields popover can now **clear cookies
  for the current site** or **clear all cookies** — WebView2 `CookieManager`
  (`DeleteCookies` / `DeleteAllCookies`), reached through any open tab webview
  since they share one cookie store. COM verified against the msvc target;
  Windows-only for now. (Clear-on-close + third-party-cookie blocking are next.)
- **HTTPS-only mode** (BACKLOG #58). Opt-in (Shields popover toggle): Flux
  upgrades `http://` navigations + subresources to `https://` via a 307 from the
  **same WebView2 interceptor** as the content blocker (ADR 0007) — the request
  hook now returns allow/block/**redirect**. Skips loopback/`.local` and a
  per-site "allow HTTP" allowlist (also in the popover) for sites with no HTTPS.
  COM verified against the msvc target; runtime needs a Windows smoke test.
  (Cookie/permission controls + a downgrade interstitial are the next #58 steps.)
- **Content blocker — cosmetic (element-hiding) filtering** (BACKLOG #57,
  completes it). On each page load Flux injects the filter lists' element-hiding
  CSS for that URL (`Filter::cosmetic_css` → one `{ display: none !important }`
  rule over the matched selectors), so blocked ad slots + leftover placeholders
  are *hidden*, not just emptied. It's plain CSS injection, so it works on
  **every** backend — including the WebKitGTK/WSL build where the network hook
  isn't wired yet. Respects the global + per-site shields toggle.
- **Content blocker — full EasyList + shields UI** (BACKLOG #57). On top of the
  bundled starter list, Flux now **fetches + caches EasyList + EasyPrivacy**
  (in the background on boot, re-fetched when older than 5 days; `tls`/`gzip`
  ureq) and hot-swaps them into the live filter — a big jump in coverage. A new
  **Shields control** in the sidebar footer shows a live blocked-count badge and
  a popover to toggle blocking **globally or per-site**, plus an "update filter
  lists" action. Commands: `shields_refresh` (+ the existing status/toggles).
- **Content-blocker engine + shields** (BACKLOG #91/#57, ADR 0007) — the
  foundation of the security pass. New `flux-filter` crate wraps Brave's
  `adblock` engine (EasyList/uBO syntax → per-request block decisions); it's made
  `Send + Sync` via serialize-once + thread-local deserialize so it can live in
  shared state and be called from the native request interceptor. A `shields`
  policy layer adds a global on/off + per-site allowlist + blocked-request count
  (commands `shields_status` / `_set_enabled` / `_set_site` / `_check`), seeded
  with a bundled curated starter list of the major ad/tracker networks. Fully
  unit-tested (blocks trackers, honors `@@` exceptions + the toggles).
- **Content blocker — WebView2 interceptor wired** (BACKLOG #91/#57). Each tab
  webview now installs a `WebResourceRequested` hook (via `with_webview` → raw
  `ICoreWebView2`) that asks `ShieldsState` per request and answers blocked ones
  with a bodyless `403`, so trackers/ads never download. The COM code is
  compile-verified against the `x86_64-pc-windows-msvc` target (webview2-com 0.38
  / windows 0.61, pinned to match wry so the types unify); its *runtime* blocking
  needs a Windows smoke test. WebKitGTK interceptor + full EasyList fetch follow.
- **Terminal sessions survive tab switches** (BACKLOG #73). Terminal tabs are
  now kept mounted in a keep-alive layer (only the active one is shown), so
  switching to another tab and back no longer kills the shell — the PTY,
  scrollback, and any running process persist. A terminal's PTY is now torn down
  only when its tab is actually closed.
- **Terminal sessions survive *closing Flux*** — opt-in, via `tmux`. Set
  `FLUX_TERM_PERSIST=1` and each terminal runs inside a per-tab tmux session
  (attach-or-create, `flux-<tab-id>`). Because tmux's server lives outside Flux
  (in WSL / on Unix), closing Flux only *detaches* — reopening re-attaches the
  **live** session: running processes, scrollback, cwd, all intact (tab ids
  persist via session restore #19, so re-attach is automatic). Falls back to a
  plain shell if tmux isn't installed (cached check); an explicit tab-close
  kills the tmux session so nothing leaks. Persists across Flux restarts, not a
  `wsl --shutdown` / reboot. WSL/Unix only — native Windows shells have no tmux.
- **`flux://omni` — native Omni index dashboard.** A velvet/glass view of the
  Omni search index's live health, reachable from the omnibox (`flux://omni`) or
  a start-page quick action: stat cards (live docs, segments, tombstones,
  embeddings, ANN, avg length), per-segment fill bars, a live essential-sites
  grid (from Omni's `/sites` bang table), and the PageRank authority list —
  clickable, auto-refreshed every 2.5s. Data comes from Omni's `/stats` +
  `/sites` via the `omni_stats` / `omni_sites` Rust commands (proxied through
  Rust because the shell CSP blocks a direct `http://localhost:8080` fetch); the
  Omni base URL follows the configured search engine, with `FLUX_OMNI_URL` as an
  override.
- **Session restore** (BACKLOG #19). Open tabs now survive a restart. Flux
  persists the tab strip — url, title, `pinned`, `kind`, order, and the active
  tab — to `session.json` in the app data dir on every change, and repopulates
  `FluxState` on boot ("continue where you left off"). The backend is now the
  source of truth: a new `tab_set_url` syncs in-webview navigation so restored
  tabs reopen *where you left them*, not at their start page; `tab_list` is
  ordered by id (creation order) so the strip is stable across reads/restores;
  the id counter is bumped past every restored id. Pages load lazily (only the
  focused tab opens a webview). **Fixes pinned tabs vanishing on relaunch.**
- **Files tab — marquee (rubber-band) selection** (BACKLOG #90).
  Click-drag on empty space to sweep a selection rectangle over rows; ⇧/⌘/Ctrl
  while dragging adds to the existing selection. Works with the virtualized list
  (coordinates are in scroll-independent content space) and **auto-scrolls** when
  the pointer nears the top/bottom edge.
- **Files tab — WSL distros in the rail.** On Windows the quick-access rail now
  lists installed **WSL distributions** under a "Linux" section (e.g.
  `Ubuntu-24.04`), enumerated via `wsl.exe -l -q` and opened at
  `\\wsl.localhost\<distro>`. `clean()` now folds the `\\?\UNC\…` form
  `canonicalize` returns back to a navigable `\\server\share\…` path.
- **Files tab — live directory watch + undo** (BACKLOG #85/#89, ADR 0006).
  The listing now **updates itself** when the shown directory changes on disk
  (the `notify` crate — inotify/ReadDirectoryChangesW — one watcher per Files
  tab, emitting `flux://fs-changed`; the UI re-lists, debounced, preserving
  scroll + selection). And file ops are now **undoable** (⌘/Ctrl-Z, or the
  context menu): rename, move, and trash reverse cleanly — undo only ever puts
  files *back* (rename→rename, move→move, trash→restore via the `trash` crate's
  `os_limited` API on Windows/Linux), never deletes. The undo stack is
  backend-owned (so the platform-specific restore handle never crosses IPC).
- **Files tab — file operations** (BACKLOG #83/#84, ADR 0006). The explorer is
  now read-*write*: **new folder/file** (inline-named), **rename** (inline,
  F2), **copy/cut/paste** (⌘/Ctrl-C/X/V — paste duplicates as "name copy" on
  collision), **drag-to-move** (onto folder rows, the quick-access rail, or
  breadcrumbs), and **delete** — to the **OS trash** by default (recoverable;
  the new `trash` dep) or permanent with ⇧. **Multi-select** via click /
  ⌘-click (toggle) / ⇧-click (range) / ⌘A, a right-click **context menu**, and
  a glass **confirm dialog** on every destructive op. Backend commands
  (`fs_create_dir/_file`, `fs_rename`, `fs_move`, `fs_copy`, `fs_trash`,
  `fs_delete`) all run off the main thread; `fs_move` falls back to copy+delete
  across filesystems, `fs_copy` recurses directories.
- **Files tab — a native filesystem explorer** (ADR 0006). Open a 📁 **Files
  tab** like the terminal: an explorer rendered in the content card (no
  webview), backed by `std::fs`. Toolbar with back/forward/up + breadcrumb +
  live filter, a quick-access rail (home, Desktop/Documents/Downloads, drive
  roots), and a **virtualized** columned list — only the visible rows are in the
  DOM, so a 10k-entry directory scrolls smoothly. Sortable (name/size/modified,
  folders-first), hidden-file toggle, full keyboard nav (↑↓ select, Enter open,
  Backspace up); files open with the OS default app. The listing call
  (`fs_list`) runs off the main thread (`spawn_blocking`) and returns **compact**
  entries, so even huge directories never freeze the UI.
- **Agent chat mode.** The agent sidebar is now a **chat-first** interface — talk
  to your local Gemma with no page required (`agent_chat`); if a page is open its
  text is passed as context so you can ask *about* it. Page actions still work via
  an explicit **`/act …`** prefix (e.g. `/act click the login button`). New typed
  chat feed (user / assistant / action / error bubbles) with auto-scroll.
- **Flux Agent is live — local Gemma via Ollama** (BACKLOG #1/#64, ADR 0005).
  `flux_agent::OllamaBackend` POSTs to a local Ollama server (`/api/generate`,
  `format:"json"`, temp 0.1) and the planner parses the reply into an
  `AgentAction`, which the (injection-safe) compiler turns into JS injected
  into the active tab. Default model `gemma4:12b-it-qat` (`FLUX_MODEL` to
  switch to `e4b`/`e2b` for speed); endpoint via `FLUX_OLLAMA_URL`. Backend is
  selectable: Ollama (default), `FLUX_AGENT_BACKEND=mock` (dev), or `llama`
  (in-process, feature-gated). No FFI/GGUF — pure Rust, unit-tested.

### Fixed
- **Files tab drag-to-move did nothing.** The main window left `dragDropEnabled`
  at its default `true`, so Tauri's native OS drop handler claimed drag events
  and **suppressed the webview's HTML5 drag-and-drop**. Set
  `dragDropEnabled: false` on the window so in-app DnD works.
- **Opening/closing a tab reset other tabs to the home page.** The backend only
  stores each tab's *creation* url (in-webview navigation is frontend state), so
  `refreshTabs()`'s `setTabs(await tabList())` clobbered every open tab's live
  url back to its start page — the affected tab then rendered the dashboard
  instead of its page on next focus. `refreshTabs` now *merges*: it preserves
  the live url/title of tabs it already holds and takes only structural fields
  (kind/pinned/cluster) + add/remove from the backend.
- **Files tab froze the app.** ContentArea keyed the Files `<Show>` on the tab
  *object*; `onPathChange` rebuilds that object (`{ ...t, url }`) on every load,
  so the keyed Show remounted FilesView → reload → onPathChange → an infinite
  remount loop (UI pinned, listing never settled). Keyed on the stable tab *id*
  instead.
- **Files list wouldn't scroll** with more entries than fit the viewport. The
  whole content-card height chain was unbounded: `.content` lacked
  `min-height: 0` (so the shell's `1fr` content row grew to the list's full
  height) and `.card` (a `place-items: center` grid) sized its cell to content,
  so a child's `height: 100%` resolved to content height — nothing to scroll.
  Bounded `.content` (`min-height: 0`) and `.card`
  (`grid-template: minmax(0,1fr) / minmax(0,1fr)`), plus the `.files-body` row
  (`minmax(0, 1fr)`); the list's `overflow-y:auto` now actually has a bounded
  height. (Fixes the card for the terminal/start tabs too.)
- **DOM capture on non-default ports** (e.g. a local search engine at
  `http://localhost:8080`). The `tab.json` capability used `http://*` /
  `https://*`, whose URLPattern port is unspecified and so only matches the
  scheme's *default* port (80/443) — capture was ACL-rejected on `:8080`.
  Changed to `http://*:*` / `https://*:*` (any port), verified against the
  `urlpattern` matcher.
- **DOM capture now works on real pages** (the agent's "no page content" error).
  Real sites set restrictive CSPs (e.g. DuckDuckGo's `connect-src`) that block
  Tauri's fetch-based IPC, forcing the `postMessage` path — which **doesn't
  carry a raw request body**, so the zero-copy `dom_publish` rejected every
  capture. Switched `dom_publish` + `capture.js` to **plain JSON args** (survive
  both IPC paths). Also fixed a `MutationObserver` crash (`documentElement` null
  at injection time) by deferring it to `DOMContentLoaded`.
- **Browsing on Windows — webview commands are now `async`.** `webview_open`
  (and friends) call `Window::add_child`, which blocks on the main thread; as
  *sync* commands they ran on the main thread on Windows → **deadlock**, so the
  command never returned, the page never rendered, and the UI froze. Async runs
  them off-main. (This was the real "stuck on loading" + freeze cause; the
  transparency fix below was also necessary.)
- **Browsing on Windows**: turned the window **opaque** (`transparent: false`).
  WebView2 can't composite per-tab child webviews on a transparent host, so
  pages were positioned correctly but invisible. **Native Win11 rounded corners**
  restored via the DWM `DWMWA_WINDOW_CORNER_PREFERENCE` API (windows-sys,
  cross-verified against the Windows target) — no transparency needed.
- **Close button** now force-closes via `destroy()` (the red light's `close()`
  only emitted `closeRequested`, which wasn't closing the borderless window).
- **Terminal on Windows**: default to **WSL** (`wsl.exe` — the user's dev env),
  starting in the **Linux home** (`--cd ~`) rather than the translated Windows
  cwd (`/mnt/c/Users/...`), forwarding Flux context vars into the distro via
  `WSLENV`; overridable with `$FLUX_SHELL` (powershell.exe / cmd.exe / pwsh.exe). Earlier: only set an
  existing cwd (an invalid cwd made spawn fail silently), and **surface spawn
  failures + process exit in the terminal** with the shell + cwd in the error.
- **CSP**: allow the chrome to `connect-src`/`img-src` over `https:` so the
  home-page weather (and future suggestion/favicon fetches) aren't blocked.
- **Webview**: explicitly `show()` + focus a tab's page after `add_child`, and
  log page-load events — diagnostics for the "search stuck on loading" report.
- **Window dragging**: added a full-width draggable **title bar** (own grid row,
  traffic lights + centered tab title) using `data-tauri-drag-region="deep"`.
  The old sidebar-only drag sliver was too small and everywhere else along the
  top was the resize edge or the page; the title bar gives a generous grab area
  that a tab's webview can never cover (it renders in the row below). `deep` is
  required because Tauri's drag script only honors a *bare* attribute on the
  exact element clicked, which the header's children always cover.
- **Search bar** had a second border inside the pill while typing — the global
  `input:focus` ring; suppressed it on the start-page search input.
- **Pane-resize latency**: dragging a splitter now disables the grid transition
  (1:1 pointer tracking) and coalesces webview bounds updates to one IPC per
  frame instead of one per pointer move.
- **Terminal special characters**: enabled xterm `customGlyphs` (box-drawing,
  block, and powerline glyphs are drawn by xterm itself) and broadened the
  monospace fallback chain. Full icon-font (Nerd Font) coverage is BACKLOG #76.
- **Webview positioning** (search showing "loading…" with the page in the wrong
  place): the active tab's bounds are now measured fresh from the DOM, re-applied
  on the next frame and again on load-finished, and webview command failures are
  logged to the console. *Needs live confirmation* — see Known issues.

### Known issues
- **Per-tab web pages don't render under WSL2** (root cause identified):
  launching from WSL2 produces a **Linux/WebKitGTK** build (via WSLg), where
  Tauri's multi-webview child positioning doesn't work — pages render stacked at
  the window bottom instead of over the content card. Everything else works
  there. **Fix: build/run natively on Windows (WebView2) or macOS (WKWebView).**
  Diagnostics retained for confirmation: the `webview_debug` command + the
  `[flux webview]` console logs.

### Added
- **Rounded window corners**: the velvet surface moved to `.shell` (12px radius,
  transparent body) so the window corners clip cleanly.
- **Resizable panes** (BACKLOG #27): drag the splitters between the sidebar,
  terminal column, and agent panel; widths persist to `localStorage`.
- **Sidebar footer**: bookmarks, extensions, and settings icons join the
  terminal/agent toggles. Settings opens a working default-search-engine picker;
  bookmarks/extensions show their roadmap status.
- **Home page**: real weather (Open-Meteo + IP geolocation, graceful offline
  fallback), **editable shortcuts** (add/remove, persisted to `localStorage`),
  and a subtle flowing **wave animation** for the "flux" feel.
- **Start page / new-tab dashboard** (BACKLOG #71): `flux://start` tabs render a
  glassmorphic dashboard in the content card (no webview) — a central search
  hero wired to the pluggable backend (#68), a live clock + greeting, recent
  tabs, a quick-link speed dial, and quick actions (new terminal / ask the
  agent). New browser tabs and fresh sessions land here; typing a query or
  clicking a shortcut transparently opens the tab's webview.
- **Pluggable search backend** (BACKLOG #68): new `flux-search` crate — engines
  are pure data (name + URL template + optional suggest template + keyword), and
  `resolve()` decides navigate-vs-search, applies `!bang`/keyword routing, and
  percent-encodes the query. `flux-core` persists the config to the app config
  dir and exposes `search_resolve/engines/default/set_default/add_engine/
  remove_engine`; the omnibox now routes through it. Seeded with DuckDuckGo
  (default), Google, Bing — and a custom engine (e.g. your own) drops in by
  `search_add_engine` + `search_set_default`, no code change.
- **DOM capture** (BACKLOG #5, ADR 0004): `capture.js` streams the active
  page's DOM to the `dom_publish` command, which now lives in an **inlined
  `fluxtab` plugin** so remote tab pages can call it (Tauri blocks remote→app
  commands). Tab webviews are granted exactly one capability —
  `fluxtab:dom_publish` via `capabilities/tab.json` — and nothing else; the
  local chrome's other ~26 commands stay unrestricted. Compile-time validated;
  end-to-end delivery pending live verification.
- **Real web pages** (BACKLOG #2): each Browser tab is now a native child
  webview (`flux-core::webview`, `add_child` over the content-card rect),
  with `webview_open/set_bounds/show/hide/navigate/back/forward/reload/close`
  commands. The frontend tracks the card rect with a `ResizeObserver` and keeps
  the active tab's page positioned over it (hiding the rest); the address bar
  navigates the active tab and the back/forward/reload buttons work. Page-load
  events stream via `flux://tab-loaded`. `capture.js` is injected into every
  tab webview as an init script (stamped with the tab id).
- **New brand logo** — a DeepMind-inspired spiral vortex: three logarithmic-
  spiral arms (teal→royal→magenta) swirling into a glowing core on the velvet
  squircle. Master at `assets/brand/flux-icon.svg`, rasterized via headless
  Chromium (gradients/glow) and regenerated across all desktop icon formats.
- **Custom window chrome**: macOS-style traffic lights (close/minimize/zoom)
  in the sidebar header, a draggable title region, and borderless-window
  **edge/corner resize** via Tauri `startResizeDragging`. Min window size
  lowered to 720×480.
- **Working embedded terminal** (ADR 0003): real PTY sessions via
  `portable-pty` in `flux-core::terminal` (spawn `$SHELL` with the `FLUX_TAB_*`
  context env, background reader thread, `terminal_spawn`/`write`/`resize`/
  `kill` commands streaming over a Tauri `Channel`), rendered by **xterm.js**
  in `TerminalView.tsx`. xterm + addons are **lazy-loaded** (~72 KB-gzip chunk,
  off the base bundle which stays ~9.6 KB gzip). The vertical terminal column
  hosts a persistent dev shell; Terminal tabs each get their own session.

### Changed
- **Premium UI pass — Royal Velvet × Liquid Glass**: richer layered velvet
  background (deep plum-navy + teal/royal/magenta light pools + faint grain),
  Apple-style frosted **liquid glass** panels (sidebar, agent, popovers) with
  specular top rim, inner highlights, and depth shadows; smoother premium
  easing on every interactive state; refined glass scrollbars, focus rings, and
  pin/tab treatments. Dark Deep Space Blue identity deepened toward royal
  velvet — same brand, far more premium feel.
- **Shell redesigned to an Arc-style vertical layout** (ADR 0002). The top tab
  strip and bottom terminal pane are gone. Navigation now lives in a **left
  sidebar** (window controls, address pill, pinned-tab grid, vertical tab
  list with cluster-color accents, footer tool toggles) that **collapses to an
  icon rail**. The active tab renders into a **floating rounded content card**
  on a subtle gradient frame. Dark Deep Space Blue identity preserved — only
  the structure changed.
- **The terminal is now a vertical right-side column**, not a bottom strip;
  toggleable and collapsible to 0 width. With the agent open the order is
  `sidebar | content | terminal | agent`.
- Tab selection is seeded on load so a tab is always active (address bar +
  highlight reflect it); tab rows gained hover close buttons.

### Added
- **UI preview harness**: `npm run preview:ui --workspace apps/shell` builds
  the shell with mocked Tauri IPC (`src/mock/`, `vite.preview.config.ts`) and
  serves it for inspection/screenshots without a Rust runtime.

### Added (0.1 scaffold)
- **Monorepo scaffold**: Cargo workspace (`flux-core`, `flux-term`, `flux-agent`,
  `flux-embed`, `flux-import`) + npm workspace (`apps/shell`), fat-LTO release
  profile, ADR 0001 with CI-enforceable performance budgets.
- **flux-core**: `FluxState` (DashMap tab table, `Arc<DomSnapshot>` zero-copy
  cache, atomic active-tab), raw-ArrayBuffer IPC (`dom_publish` /
  `dom_active_bytes`), `terminal_env` context bridge, `agent_execute`
  plan→compile→inject pipeline, per-tab `capture.js` bridge script.
- **flux-agent**: GBNF-constrained planner over a closed `AgentAction` enum,
  injection-safe JS compile templates (tested), `MockBackend` for weight-free
  dev/CI, feature-gated llama.cpp backend skeleton.
- **flux-term**: vte-backed grid with per-row damage tracking (SGR colors,
  CUP/ED, wrap/scroll), feature-gated WGPU instanced renderer + WGSL cell shader.
- **flux-embed**: hashing embedder + greedy cosine clustering with the Flux
  cluster palette.
- **Shell (SolidJS)**: CSS-grid layout (tab strip / content / terminal pane /
  agent sidebar / status bar), full "Tactile Brutalism × Liquid AI" theme
  (`#0B132B` / `#00E5FF` / `#D100D1`, kinetic gradients, glassmorphism),
  agent sidebar with live status states, typed IPC layer.
- **CLI launch**: `flux [URL]... [-t|--terminal]` from any terminal —
  parsed pre-GUI (`--help`/`--version` never flash a window), materialized as
  tabs on shell mount via the `launch_intent` command.
- **Tab kinds**: tabs are first-class Browser *or* Terminal; the new-tab “+”
  opens a glass picker offering both. Terminal tabs fill the content cell and
  suppress the bottom terminal pane.
- **Pinned tabs (Arc-style)**: right-click pins/unpins; pinned tabs render as
  squares in a left rail, are excluded from semantic clustering, and drop
  their cluster tag on pin.
- **flux-import**: Chrome profile discovery (`ProfilePreview` per profile),
  full bookmarks import (folder paths preserved, tested), extension
  *inventory* from manifests, Saved-Tab-Groups detection. Exposed as
  `chrome_import_preview` / `chrome_import_bookmarks` commands.
- **App icon**: master SVG (`assets/brand/flux-icon.svg`) — three slanted
  flux lines forming an abstract italic F (stepped teal→violet) plus a
  magenta terminal-cursor block on the Deep Space Blue tile; all desktop
  platform formats (`.icns`, `.ico`, PNGs) generated via `tauri icon` and
  wired into `tauri.conf.json`.
- **Docs**: this `CHANGELOG.md`, `BACKLOG.md` (stable-numbered, referenced
  from code comments), README setup/layout/flags.

[Unreleased]: https://github.com/flux-browser/flux/commits/main
