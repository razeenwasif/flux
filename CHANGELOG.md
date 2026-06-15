# Changelog

All notable changes to Flux. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org). Unreleased work lands here in the
same commit as the code (docs-before-commit policy). Pair file: `BACKLOG.md`
(what's NOT done yet).

## [Unreleased]

### Added
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
