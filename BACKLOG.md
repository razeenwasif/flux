# Flux Backlog

Single source of truth for unimplemented work. Numbers are stable — code
comments reference them as `BACKLOG #n`. When an item ships: move its entry to
`CHANGELOG.md` (Unreleased → Added) and delete it here, same commit
(docs-before-commit policy).

Priorities: **P0** = blocks the core demo loop · **P1** = v0.1 release · **P2** = post-release.

## Epic: Core / IPC

| # | P | Item |
|---|---|---|
| 10 | P1 | CI perf-budget gates per ADR 0001: binary size, idle RSS, `criterion` IPC benches (`ipc_roundtrip`, `dom_snapshot`), chrome JS ≤ 50 KB gzip |
| 12 | P1 | Generate TS types from Rust structs via `specta` (kill the manual `ipc.ts` mirror — it has already drifted once this week) |
| 20 | P1 | Single-instance forwarding: second `flux <url>` invocation opens a tab in the running window (`tauri-plugin-single-instance`) instead of a second process |
| 26 | P2 | Packaging: `.desktop` entry + icon on Linux, PATH shim on Windows/macOS, auto-update channel |

## Epic: Terminal (kitty/ghostty-class)

The bar is a *modern* terminal, not a VT100 museum piece. flux-term has the
grid/damage/renderer spine; these make it competitive with kitty/ghostty:

| # | P | Item |
|---|---|---|
| 3 | P0 | PTY spawn + I/O loop in flux-core (`portable-pty`), env from `terminal_env`; one session per Terminal *tab* and one for the split *pane*; route bytes to `Terminal::advance` |
| 7 | P0 | Glyph atlas: `swash` rasterization, subpixel positioning, theme color resolve, uniform-driven cell metrics (replaces shader constants) |
| 9 | P1 | Scrollback ring buffer + reflow-preserving resize |
| 13 | P1 | Font shaping: ligatures + programming-font features via `swash`/`rustybuzz` (kitty parity) |
| 14 | P2 | Kitty graphics protocol — inline images in the terminal (the agent can render charts into the shell) |
| 15 | P1 | Splits and tabs *within* the terminal pane (ghostty-style), keyboard-driven |
| 16 | P1 | Shell integration: OSC 133 prompt marks → jump-between-prompts, per-command exit-status coloring, "copy last output" |
| 17 | P1 | OSC 8 hyperlinks + URL detection; clicking a URL in the terminal opens a Flux browser tab (the loop closes both ways) |
| 4 | ✅ | **`flux` CLI inside the terminal** (done): `flux url|title|dom|links|extract-json` read the active page (`extract-json` → JSON for `jq`). Flux writes the active browser tab's context to `$FLUX_RPC_DIR/active.json` (`rpc.rs`, refreshed on dom_publish + tab switch; private tabs withheld); the CLI (`cli.rs`) reads it. File-based (not a socket) so it crosses the WSL↔Windows boundary via `WSLENV …/p`. _Remaining:_ the `flux` binary must be on the terminal's PATH (Linux build in WSL); native-Windows-console stdout needs AttachConsole (`windows_subsystem` swallows it). |
| 76 | P1 | Bundle a Nerd Font (icon glyphs) as a webfont for guaranteed terminal/prompt icon coverage — `customGlyphs` + the fallback chain cover box-drawing/powerline but not Private-Use-Area icons |
| 74 | P2 | Terminal throughput: raw-byte channel transport (avoid `number[]` JSON) and/or route the PTY stream into the `flux-term` WGPU renderer when compositing is solved |
| 75 | P2 | Terminal splits/tabs *within* the column, OSC 133 shell integration, OSC 8 link → open Flux browser tab (supersedes earlier #15–17 once xterm is the renderer) |
| 98 | P2 | Terminal session survival across **reboot** (today's tmux persistence via `FLUX_TERM_PERSIST` survives Flux restarts, but the tmux server dies on `wsl --shutdown`/reboot): a resurrected-tmux-server-on-boot hook, or a small detached PTY-host service. Also: a settings toggle for persistence instead of the env flag |

## Epic: Flux Agent

| # | P | Item |
|---|---|---|
| 1 | P2 | (Optional) in-process `llama-cpp-2` path for a single self-contained binary — the agent ships via Ollama now (ADR 0005), so this is no longer P0; GGUF load + GBNF sampler behind the `llama` feature |
| 81 | ✅ | **Agent model picker** (done): the agent-sidebar header shows the active model and opens a dropdown of locally-pulled Ollama models (`/api/tags`); picking one switches the agent live (runtime override over `FLUX_MODEL`) and persists. _Follow-up:_ show which model is active in the sidebar per-message; per-task model routing. |
| 82 | P2 | Agent: schema-constrained output via Ollama `format` = JSON schema (vs current `format:"json"` + prompt) and multi-step plans (#8); stream tokens to the sidebar |
| 8 | ✅ | **Agent action confirmation** (done): `/act` now **plans then previews** the action (agent_plan) and waits for **Approve / Skip** before anything touches the page (agent_run_action injects the magenta-highlight + action). Refusals show as a note. _Follow-up:_ autonomous **multi-action sequences** from one prompt need structured multi-step output (#82); today you confirm each `/act` step. |
| 11 | ◐ | **Real embeddings (EmbeddingGemma)** (done for search): `embedding.rs` prefers Ollama `/api/embed` (`embeddinggemma`, `FLUX_EMBED_MODEL`) with the hashing embedder as automatic fallback (search never breaks offline). Vectors persisted + embedder-tagged; an embedder change triggers a background re-embed (`migrate`). Wired into the **archive** (#69). _Remaining:_ Omni (#66) + clustering (#14) still use hashing — they embed per-keystroke / on every dom_publish, so they need a vector cache first; archive_save/search are sync (brief network block when the model path is active) — make async; int8/quantized model guidance. |

## Epic: Tabs & Chrome import

| # | P | Item |
|---|---|---|
| 6 | ✅ | **Command palette** (done): `Ctrl+K` glass modal — fuzzy search over open tabs (switch), actions (new tab/term/files, toggles, open History/Passwords/Omni, find, reload, close), and history. Keyboard-driven (↑/↓/Enter/Esc). Hides the active webview while open (OS-layer overlay). Completes the #18 keymap. _Follow-up:_ bookmark search once #22 lands. |
| 18 | ✅ | **Keyboard shortcuts** (done): Win/Linux Ctrl-based (Cmd accepted on macOS). New browser tab `Ctrl+T`, terminal tab `Ctrl+Shift+T`, close tab `Ctrl+W`, next/prev tab `Ctrl+Tab`/`Ctrl+Shift+Tab`, jump to tab `Ctrl+1‑9`, toggle terminal `` Ctrl+` ``, toggle agent `Ctrl+Shift+A`, toggle sidebar `Ctrl+B`, focus omnibox `Ctrl+L`, reload `Ctrl+R`/`F5`, back/forward `Alt+←`/`Alt+→`. (Deviated from the original ⌃A/⌘S spec to avoid the Ctrl+A select-all / Ctrl+S save-page collisions on Win/Linux.) Works both when the chrome is focused (capture-phase listener) and when a page webview is focused (injected `shortcuts.js` forwards chords via the `chrome_key` fluxtab command). Terminal-focus guard leaves readline/tmux chords (Ctrl+R/W/L/B) to the shell. `Ctrl+K` opens the command palette (#6). |
| 28 | P1 | Responsive breakpoints: auto-collapse the terminal then agent then sidebar as window width shrinks (ADR 0002 mitigation) |
| 79 | ◐ | **Performance pass** (user priority — esp. **low RAM** vs Chrome). _Done:_ hardened release profile (`lto=fat`/`codegen-units=1`/`panic=abort`/`strip`); **lazy webviews**; **DOM snapshot cache capped** (1 MiB/256 KiB); **tab hibernation #45**; idle RAM poll gated to when Settings is open (was an always-on 2.5 s timer); **glass `backdrop-filter` dropped during resize/drag** (`body.resizing`/`.busy` → `--glass-blur:none`; pane-resize, window-resize, split/panel-drag) — the GPU-heavy per-frame re-sample is the main resize jank. _Adblock engine verified:_ `shields_check` is unused (no IPC-pool spread); the serialized rules are one shared `Arc`, only the deserialized `Engine` is per-thread, bounded to ~2 (WebView2 interceptor + page-load cosmetic). _Remaining:_ collapse those two to one engine via a worker thread (needs the request hot path measured — deferred); runtime latency profiling on the user's machine; measure vs ADR 0001 budgets; the webview-placement bug. |
| 29 | P2 | Address bar does in-place navigation of the active tab (depends on #2); ⌘L focuses it |
| 30 | ✅ | **Tab drag-and-drop reorder** (done): drag tabs in the strip to reposition (drop above/below by cursor half); order is an explicit **persisted** backend sequence (`tab_reorder`), survives restart. _Follow-up:_ reorder within the pinned grid + drag into/out of it. |
| 21 | ✅ | **Favicons** (done): the tab strip + pinned rail show each site's real favicon. Fetched **cookielessly, directly from the site** (never a 3rd-party favicon service) by a Rust command — `/favicon.ico` then the declared `<link rel="…icon">`, with magic-byte image validation (rejects soft-404 HTML) — and cached **per host on disk** as a `data:` URL. Letter glyph remains the fallback. Unit-tested. _Follow-up:_ surface favicons in history/omnibox once those land. |
| 22 | ✅ | **Bookmarks** (done): persisted folder-aware store (`bookmarks.rs`), `flux://bookmarks` page (search + folder grouping + delete + clear), footer 🔖 popover ("★ Bookmark this page", All bookmarks, history), ⌘K "Open Bookmarks". **Chrome import** pulls every bookmark from a chosen profile under an "Imported" folder (de-duped). Each folder can be **"⊞ Open as group"** → opens its bookmarks as tabs in a new Flux tab group (capped at 20) — the practical bridge for Chrome tab groups. _Follow-ups:_ folder tree editing, omnibox bookmark autocomplete (#32), drag-to-reorder. |
| 23 | P1 | Chrome **saved tab groups** import: parse the `Saved Tab Groups` SQLite db (needs `rusqlite`; schema is sync-internals, version-fragile — pin per Chrome milestone). _Note:_ only present when the user uses Chrome's *saved* groups; live (unsaved) groups are in the undocumented SNSS session blob. The #22 "open folder as group" covers the common case meanwhile. |
| 24 | P2 | Extension import UX: resolve `__MSG_` locale names from `_locales/`, map common extensions to Flux built-ins (uBlock → native content blocking, dark-reader → theme override). Chrome extensions **cannot run** in native webviews — this is inventory + equivalents, never execution |
| 25 | P2 | Import from Chromium variants: Chromium, Brave, Edge (same formats, different user-data roots) |

---

# Feature roadmap — competitive parity & differentiation

Surveyed against Chrome, Edge, Safari, Firefox, Arc, Zen, Vivaldi, Brave, and
Opera (2025–26). Split into three buckets: **table stakes** (a browser is not
credible without these), **best-in-class** (the features that make power users
switch), and **under-served** (highly requested, poorly served by the
incumbents — Flux's wedge). Numbers continue the stable sequence.

## Epic: Browser core — table stakes

Flux currently has tab *chrome* but no actual web engine wired (BACKLOG #2).
These are the non-negotiables before Flux is a usable daily browser.

| # | P | Item | Who has it |
|---|---|---|---|
| 31 | ✅ | **Navigation polish** (done): **stop** (`webview_stop` → `window.stop()`; reload button swaps to ✕ while loading + `Esc`); **loading state** tracked from the page-load events (started/finished) per tab; **security/TLS badge** left of the omnibox (🔒 HTTPS / ⚠ HTTP); **progress affordance** — an indeterminate bar under the omnibox (in the sidebar, since the native webview overlays the content card and would hide an in-card bar). | all |
| 32 | ✅ | **Omnibox live suggestions** (done): type-ahead dropdown — local **history** matches (with favicons) + **search suggestions** from the default engine's `suggest_template` (`search_suggest` fetches + parses OpenSearch JSON). Keyboard-navigable (↑/↓/Enter/Esc), sidebar-resident. A Settings toggle (default on) gates the remote fetch for privacy; history suggestions stay local regardless. _Follow-up:_ bookmark autocomplete once #22 lands. | all |
| 33 | ✅ | **Find-in-page** (done): `Ctrl+F` opens a find bar (sidebar-resident — the native webview overlays the content card); typing drives the engine's native `window.find()` (Chromium + WebKit) for highlight + scroll, Enter/Shift+Enter (and ‹ ›) step next/prev, and a case-insensitive **match count** is reported back over `flux://find-result`. Esc closes. _Follow-up:_ precise current/total index + highlight-all (window.find gives native single-match highlight only). | all |
| 34 | ✅ | **Download manager** (done): WebView2 `DownloadStarting` interception → live progress + state, Flux-owned UI (footer ⬇ popover w/ active badge, progress bars). Controls: pause / resume / cancel (live COM ops via `run_on_main_thread`), open / show-in-folder. Model unit-tested; COM compile-verified vs msvc. _Follow-ups:_ WebKitGTK download hook (Linux dev backend), integrity hash. | all |
| 35 | ◐ | **Built-in PDF viewer** (done): PDFs open in a Flux-owned PDF.js viewer (`flux://pdf`) — continuous pages, zoom, page count, download — cross-engine (WebKitGTK has no native viewer). `.pdf` addresses, ⌘K, `target="_blank"` PDF links, and opening a PDF in the file explorer route here; bytes fetched by `pdf_fetch` (server-side, CORS-free, base64, 32 MB cap; http(s)/file://); PDF.js lazy-loaded so the chrome bundle stays lean. _Remaining:_ annotation + form-fill; in-page link clicks to PDFs still use the engine's native viewer on WebView2 (would need request interception to reroute). | all |
| 36 | ✅ | **Per-site zoom** (done): `Ctrl +/-/0` zoom the active page (`webview.set_zoom`); the factor is **persisted per host** (localStorage) and re-applied on every load. A `%` pill in the address row appears when ≠ 100% (click to reset); also in ⌘K. | all |
| 37 | ◐ | **Picture-in-picture** (done): hover a sizable `<video>` for a ⧉ PiP button or press Alt+P to pop it into a floating window (toggle to exit); best-effort auto-PiP when the tab is backgrounded. Injected `pip.js` triggers from in-page gestures because `requestPictureInPicture` needs in-page user activation (a chrome button/eval gets `NotAllowedError`). _Remaining:_ a Settings toggle; reliable auto-PiP (needs the engine to fire `visibilitychange` on a hidden child webview + live transient activation); WebKitGTK PiP support. | Chrome/Arc/Safari |
| 38 | ◐ | **Permissions UI** (done): **`flux://permissions`** (+ ⌘K, Shields "Manage site permissions…") — a per-site, per-kind manager for camera / microphone / location / notifications / clipboard. Allow / Block / Ask per site or add a rule manually; persisted (`permissions.json`). A remembered Allow/Block is applied automatically on WebView2 (`PermissionRequested`, reading kind + host), short-circuiting the native prompt; Ask leaves the engine prompt; the global block (#58) overrides. Policy resolution is unit-tested. _Remaining:_ a Flux-styled prompt for the Ask case (WebView2 deferral) + the WebKitGTK `permission-request` signal on the Linux backend. | all |
| 39 | ✅ | **History** (done): persisted, searchable browsing history at `flux://history` — auto-recorded from the DOM-capture pipe (URL + page title), frecency-ranked, capped + debounced-save. Full-page view: recents grouped by day, live search, per-row favicons (#21), open / remove-one / clear-all; reachable from Start page + 🔖 Library. Store unit-tested. _Follow-up:_ a calendar view. | all |
| 40 | ◐ | **Translate page** (done): 🌐 page-action (+ ⌘K "Translate page → …") translates the active page with the **local model** (`AgentPlanner::translate` → Ollama; private, no cloud), shown in the reader overlay as paragraphs. 🌐 → your own language (`navigator.language`); ⌘K offers common targets. _Remaining:_ translates only the leading visible text (model context cap) and renders as clean text, not layout-preserving in-place. | Chrome/Edge/Safari |
| 41 | ✅ | **Reader mode** (done): 📖 in the address row (+ ⌘K) extracts the article (injected `reader.js` density heuristic → structured blocks posted via `reader_publish`) and renders a decluttered, typographic view over the hidden webview. **Text-to-speech** via the Web Speech API (🔊 Listen). Blocks render as text + `<img src>` only — no raw HTML, no XSS. Esc/✕/tab-switch closes it. _Follow-up:_ richer extraction (Readability-grade), per-paragraph TTS highlight, font/width controls. | Safari/FF/Edge |
| 42 | ◐ | **Install site as app / PWAs** (done): ⌘K "Install this site as app" opens the site in its own Tauri `WebviewWindow` (just the page); installed apps persist (`pwa.rs`) and live at **`flux://apps`** (relaunch focuses the existing window, remove). _Remaining:_ a real dock/taskbar icon per app (favicon → window icon) + a `.desktop`/Start-menu shortcut (ties into packaging #26); chrome-less custom title bar. | Chrome/Edge |
| 110 | ✅ | **Devtools (F12)** (done): F12 opens the inspector for the active tab's webview, whether the chrome or the page is focused (Tauri `devtools` feature + `webview_devtools` command + `shortcuts.{ts,js}` mapping). | all |
| 109 | ✅ | **New windows / "open in new tab"** (done): `window.open()`, `target="_blank"` links, and middle-click / Ctrl-(⌘-)click on any link open as new Flux tabs — previously a silent no-op since native child webviews ignore page-initiated windows. Injected `newtab.js` → `chrome_open_url` (fluxtab cmd) → `flux://open-url` → frontend `openTab` (background for middle/modifier clicks, foreground for explicit `_blank`). _Follow-up:_ a *connected* popup window with a live opener (OAuth / `postMessage` handshakes) needs WebView2 `NewWindowRequested` / WRY new-window hosting — separate, larger, and Google blocks embedded-webview OAuth regardless. | all |

## Epic: Best-in-class power features

The features that make Arc/Vivaldi/Zen users evangelical.

| # | P | Item | Inspiration |
|---|---|---|---|
| 43 | ✅ | **Split view** (done): two browser tabs tiled side by side in the content card, with a draggable seam (clamped 20–80%, double-click to even). Start via right-click → "Split with current tab" or drag a tab onto another's right edge. Pauses when a third tab is focused, resumes on return; both panes stay live (excluded from hibernation) and re-tile on resize. Built on the child-webview model — the seam is a DOM splitter in the inter-pane gap, and dragging hides the panes so the chrome can read the pointer. _Follow-ups:_ 3–4 panes, persist the split with the session. | Arc, Edge, Vivaldi, Zen |
| 44 | ✅ | **Workspaces** (done): Arc-style named/colored tab spaces, each with its own tabs (+ pinned + groups, filtered to the active space). Switcher above the tools (switch / + / rename / recolor / delete). **RAM-optimized**: switching away destroys the leaving space's webviews + lazy creation → inactive spaces cost only KB of metadata. Persisted (`Workspace` model, per-tab `workspace`, active). **Send a tab or a whole group to another space** via right-click. _Follow-ups:_ per-space theme tint, cluster-based auto-assignment. | Arc, Opera, Zen, Edge |
| 45 | ✅ | **Tab hibernation / sleeping tabs** (done): background browser tabs idle past a timeout have their **native webview destroyed** (RAM freed); the tab stays in the strip (dimmed + 💤) and the page reloads when re-activated (reuses the lazy-webview path). On by default, 30 min, configurable in Settings (on/off + 5/15/30/60 min). Active + start/terminal/files tabs never sleep; no clear-on-close on hibernate. **Scroll position + non-password form state preserved** across sleep (captured on switch-away to a RAM-only store, re-applied on the wake reload; passwords never captured, nothing on disk). **Memory-pressure eviction**: reads actual system memory (`sysinfo`) and sleeps the LRU background tabs when free RAM is low (<12%), adapting to the machine; Settings shows a live RSS/free-RAM readout. | Edge, Vivaldi, Brave |
| 46 | P1 | **Auto-archive** stale tabs after N days (with an easy "archived tabs" view) | Arc |
| 47 | ✅ | **Session management** (done): save the current tabs as a **named session**, then restore (reopens every tab) from `flux://sessions` (+ ⌘K "Open Sessions", Library popover link). Persisted separate from the always-on session (#19). _Follow-up:_ automatic daily snapshots ("reopen yesterday"); restore into a fresh workspace. | Vivaldi, Opera |
| 48 | ✅ | **Web panels** (done): pin a site (chat, docs, music) to a slim pane on the right of the content card, persistent across tab switches. Footer ◨ popover: pin this page / toggle / unpin (persisted). Draggable divider; DOM toolbar (title / reload / close). Its own native webview (no capture.js → never pollutes history/clustering); only the open panel is live (RAM-conscious). _Follow-ups:_ multiple concurrent panels, left-side option, per-panel zoom. | Vivaldi, Opera, Edge |
| 49 | ◐ | **Agent boosts** (done): footer **✨ Boosts** popover — describe a change and the local agent writes per-site CSS (`AgentPlanner::author_css`), saved per host (`boosts.rs`) and injected on every page-load (+ live re-inject on author/toggle). Toggle/delete per site. CSS-only authoring (safe to inject; JS can't be agent-written). _Remaining:_ hand-editable JS/CSS textareas + a manage-all page; subdomain/wildcard host matching. | Arc, Vivaldi, Stylus |
| 50 | P2 | **Peek / glance / little-window**: open a link in a transient overlay without committing to a tab | Arc, Zen |
| 113 | ◐ | **Advanced PDF editing** — markup + page-ops (#112) and **AcroForm form fill + flatten/save** shipped (🖊 Forms mode). _Remaining:_ **in-place WYSIWYG field widgets** (fill on the page, not a side panel), true **in-place text editing** (reconstruct text runs — inherently fragile), **OCR** for scanned PDFs (Tesseract/wasm), cryptographic **digital signatures**, redaction-with-guarantees | Adobe Acrobat |
| 51 | ✅ | **Mouse gestures** (done): hold right button + drag — left = back, right = forward, down = reload, up = top; suppresses the context menu after a gesture. Settings toggle (off by default). _Follow-up:_ rocker gestures + rebindable. | Vivaldi, Opera |
| 52 | ✅ | **Vim link-hints + scroll** (done): `f` labels clickable elements (type the label to click), `j`/`k` scroll, `gg`/`G` top/bottom; never fires while typing in a field. Injected `nav.js` gated by a Settings toggle (off by default). _Follow-up:_ `F` open-in-new-tab, visual-mode, more motions. | Vimium users |
| 53 | ◐ | **Per-page notes** (done): a footer 📝 popover holds a note tied to the current page's URL, auto-saved locally (`notes.json`) and restored on revisit (blank clears it). _Follow-up:_ a notes index page, host-level notes, on-page highlight/annotation anchors. | Arc, Vivaldi |
| 54 | ✅ | **Web capture** (done): 📸 in the address row (+ ⌘K "Capture page") saves the visible page to a PNG in `app_data/screenshots` via WebView2 `CapturePreview` (COM verified vs msvc); a toast confirms when written. _Remaining:_ full-scrolling-page stitch, region select, annotation, and a WebKitGTK snapshot path (Windows/WebView2 only today). | Edge, Firefox |
| 55 | ✅ | **Focus / compact mode** (done): `Ctrl+Shift+F` (or ⌘K "Focus mode") hides the sidebar, terminal, and agent — content only. `Esc` or the chord exits (a toast reminds you on enter). | Zen, Arc |
| 56 | ✅ | **Tab groups** (done): named/colored/collapsible groups in the strip. Right-click → pin / new group / add-to / remove / close; headers collapse, rename (dblclick), recolor (dot), ungroup (✕). **"⊞ Group"** = group-by-topic, seeded from the semantic clusters (#14). Persisted (`TabGroup` model + commands). _Follow-up:_ drag tabs between groups (today grouping is via the menu; drag only reorders). | Vivaldi, Chrome groups |
| 111 | ✅ | **Tab folders** (done): a collapsible **Folders** section above the footer parks tabs that are kept **hibernated (≈0 RAM)** — distinct from groups (strip-resident, colored). Right-click a tab → *Move to folder* / *+ New folder with tab*; members leave the strip and sleep. Clicking a folder tab wakes + views it; switching away re-sleeps it (a `createEffect` keeps every non-active folder tab hibernated). `TabFolder` model + `folder` tab field + commands; persisted. _Follow-up:_ drag tabs into folders; per-folder "wake all". | Arc folders |

## Epic: Privacy, security & data

**Active track** (chosen 2026-06-15): #91 → #57/#60, #58, #59, #61. Because Flux
uses *native* webviews (WebView2 / WebKitGTK), not a Chromium network stack, the
implementation path differs from a normal browser — captured per item below.
**#91 is the enabling primitive** the blocker and HTTPS-upgrade both sit on.

| # | P | Item | Inspiration |
|---|---|---|---|
| 91 | P1 | **Request-interception layer** (ADR 0007): engine + policy + the **WebView2 interceptor** are wired and **verified blocking on Windows** (`with_webview` → `WebResourceRequested` → `403`). **Remaining: the WebKitGTK interceptor** (web-process extension) for the Linux/dev backend. Reused for #58's http→https rewrite. | enabling primitive |
| 57 | ✅ | **Built-in content blocker** (done): `flux-filter` (Brave's `adblock`) + WebView2 interceptor block at the request level (verified on Windows); full EasyList + EasyPrivacy fetched/cached; shields UI (footer badge + global/per-site toggle + update); **cosmetic element-hiding** (per-page injected CSS, all backends). Minor follow-up: user-supplied custom filter lists. | Brave, Vivaldi, Opera |
| 58 | ✅ | **HTTPS-only + cookie controls** (done): http→https upgrade + per-site allow-HTTP; cookie clear (site/all) + clear-on-close; native tracking prevention (Off/Basic/Balanced/Strict); block camera/mic/geo toggle. All via the #91 interceptor / WebView2 profile, Shields-popover controls, COM verified vs msvc. (Skipped: a downgrade interstitial — Allow-HTTP recovers — and Flux-styled *remembered* permission prompts — WebView2 prompts by default.) | Brave, Firefox |
| 59 | ✅ | **Multi-account containers / profiles** (done): **private/incognito tabs** (`incognito` webview — in-memory, no history, ephemeral) **and named persistent containers** — each container gets an isolated cookie/storage jar via a per-webview `data_directory`, so you can be logged into two accounts of the same site. Create/rename/recolor/delete in Settings; "Open in container ▸" in the new-tab picker; container color marks the tab's rail; persisted. _Follow-up:_ move an existing tab to a container (needs webview recreation). | Firefox, Safari profiles |
| 60 | P2 | **Fingerprint randomization** + tracker-script blocking (script blocking falls out of #57; fingerprint defenses via injected JS shims over canvas/WebGL/audio). | Brave |
| 61 | ✅ | **Password manager + autofill** (done; ADR 0009). `flux-vault` (AES-256-GCM, Zeroizing, host matching, **Proton Pass importer** — CSV/ZIP/PGP/JSON, format-detected, unit-tested) + OS-keychain data key (`keyring`, file fallback) + persistence; flux-core commands (status/list/for-host/reveal/add/remove/import-proton/fill); **autofill** injected straight into the page (same-origin enforced; password never touches chrome JS); footer 🔑 vault UI (list + per-site Fill + copy/reveal/delete + Proton import + add). **optional master password** (Argon2id-wrapped data key, removed from the keychain) + **idle auto-lock** + manual lock. Passkeys/WebAuthn handled by the native webview. _Note:_ Proton ships only a WebExtension + no public API → import is a snapshot (re-export to resync). _Follow-ups:_ save-password prompt on login, Chrome/1Password/Bitwarden importers. | all |
| 62 | ◐ | **E2E-encrypted sync** (done): **`flux://sync`** — bookmarks + sessions across devices, account-optional + local-first via a **bring-your-own synced folder** (Dropbox/Syncthing/iCloud/USB); no Flux server. `sync.rs` writes one AES-256-GCM blob (key = Argon2id(passphrase, salt-in-blob)); the sync service only sees ciphertext. Additive-union merge (`BookmarkStore::merge` by url+folder, `SessionStore::merge` by name). 5 crypto/merge tests. _Remaining:_ history + open tabs; deletion propagation (tombstones); auto-sync timer; conflict UI. | under-served |
| 63 | P2 | Built-in proxy / VPN / Tor window hook (bring-your-own provider). | Brave, Opera |

## Epic: Extensions (Flux mini-extension API)

Decision (2026-06-15): Chrome/WebExtensions can't run in native webviews, so Flux
ships its **own** curated, permissioned extension model rather than chasing
WebExtensions compat or a raw userscript runtime. It reuses Flux's existing
JS-injection substrate (capture.js + the agent's injection compiler). The
architecture + security model are decided in **ADR 0008** (#96 ✅); #92–95 build
it out, starting with the manifest + loader (#92).

| # | P | Item |
|---|---|---|
| 96 | ✅ | **ADR + security model** — written: ADR 0008. Manifest-declared, capability-gated model; the powerful `flux.*` API lives in a **Rust broker** (content scripts are untrusted vs the page); a document-start **capability-token handshake** authenticates the extension (+ WebKitGTK script worlds where available, since WebView2 lacks isolated worlds); deny-by-default permissions w/ install consent; hard boundaries (no other-extension storage, no raw IPC, no blanket net/fs). |
| 92 | ✅ | **Manifest + loader** (done): `flux.extension.json` (id/name/version, deny-by-default `permissions`, `content_scripts` = match globs + js/css + run_at, optional `background`, `ui` contributions). `Manifest::parse` validates (id shape, known permissions, non-empty matches); `ExtRegistry` loads a folder, checks content-script files exist, and persists `extensions/registry.json` (install/list/enable/remove). Commands `ext_install/_list/_set_enabled/_remove` + ipc bindings. Shipped reference example `examples/extensions/hello`. (Folder-only for now; zip import + the install *dialog* come with the manager UI #95.) |
| 93 | ✅ | **Content-script injection** (done): on each page load `ExtRegistry::injection_for(url, phase)` assembles the CSS + JS of every *enabled* extension whose `@match` patterns hit, honoring `run_at` (document_start vs end/idle); injected via the existing `on_page_load`/`eval` path. Each extension's JS runs in its own **IIFE scope guard** (WebView2 has no isolated worlds — ADR 0008) carrying a frozen `flux` identity object (id/version/permissions). Match-pattern + glob engine is unit-tested. (The *callable* `flux.*` broker bridge — postMessage → Rust broker, grant-checked — lands with the API surface in #94, which replaces the identity shim.) |
| 94 | ✅ | **Permissioned API surface** (core done): a privileged Rust **broker** (`broker.rs`) backs `flux.runtime` (id/version/permissions), `flux.storage` (per-extension persisted KV), `flux.tabs` (query/open/navigate), `flux.dom` (read cached snapshot / inject JS). Each content script gets a JS shim that forwards calls to `plugin:fluxtab\|ext_broker_call` tagged with a per-extension **capability token**; the broker resolves the token → extension and checks every call against the manifest grants — **deny-by-default** (unknown calls + ungranted perms rejected). Grant model + tokens + storage + shim are unit-tested. (Deferred: `flux.ui` — side panel/toolbar/context-menu — lands with the manager UI #95; `flux.events` push subscriptions are a small follow-up under #95.) |
| 95 | ✅ | **Extension manager UI** (done): the footer 🧩 panel now lists installed extensions with name/version + permission chips, an enable/disable toggle, remove, and **install from a folder** (path input → `ext_install`, surfaces validation errors). Backed by the #92 registry commands. Reference example shipped at `examples/extensions/hello` (exercises `flux.storage`). _Remaining follow-up:_ `flux.ui` (extension-contributed toolbar button / side panel) + `flux.events` push subscriptions, and a native folder-picker dialog (currently a path input). |

## Epic: Under-served — Flux's wedge

Highly requested, poorly served by incumbents. This is where Flux differentiates
beyond "another Chromium skin."

| # | P | Item | The gap |
|---|---|---|---|
| 65 | ◐ | **DOM-aware integrated terminal**: the read-the-active-page half is done (#4) — `flux extract-json` / `flux dom` / `flux links` pipe the live page into the shell via the `$FLUX_RPC_DIR/active.json` bridge. _Remaining:_ the **agent driving the terminal** (run/inspect commands as agent actions), and `cd $FLUX_TAB_DIR` into per-page artifact dirs. Nobody ships this. | core |
| 66 | ✅ | **Semantic everything-search** (done): ⌘K now ranks one list across open tabs (by title **+ captured page content**), bookmarks, and history via the local embedder (`omni_search`); large corpora are lexically pre-filtered then embedding-reranked so it's cheap per keystroke. Empty query = browse open tabs. _Follow-up:_ true synonymy needs the stronger embedder (#11); index history page text for offline content search (#69). | weak everywhere |
| 97 | P2 | **`flux://omni` follow-up** (dashboard + live `/sites` grid shipped): a compact "Omni index" glance widget on the start page (key stats at a glance, link into the full dashboard) | search |
| 67 | ◐ | **Scriptable macros** (done): footer **⏺** popover — record a flow (navigations + clicks + typing) into a named macro, then replay it. `macros.rs` (Macro/Step model, record buffer, async replay engine) + `macro-record.js` (selector-generating recorder, gated by `__FLUX_MACRO_REC__`) + nav capture from `dom_publish`. Passwords never recorded; persisted. _Remaining:_ **agent-authored** macros (NL → steps), **scheduling**, conditional/wait-for-element steps, and selector robustness (record/replay is best-effort on changed pages). | under-served |
| 69 | ◐ | **Offline archive + semantic search** (done): "Save page for offline" (⌘K / 📚) stores the page text locally (`archive.rs`); **`flux://archive`** semantically searches saved pages and reads them **fully offline** via the local `flux-embed` embedder (no network/service, unlike Omni #66; embeddings recomputed in memory, not persisted). Re-saving a URL updates in place; private pages skipped. _Remaining:_ full *rendered*-page (MHTML/SingleFile) capture for fidelity; fold the archive into Omni search as a source. | weak everywhere |
| 70 | ◐ | **Per-tab resource governor** (partial): `flux://resources` (📊, + ⌘K) shows overall process/free RAM and a per-tab payload (captured-DOM weight) + live/sleeping list, with one-click **Sleep background tabs** to reclaim RAM. _Honest gap:_ true per-tab CPU/RAM/network isn't shown — browser engines share processes across tabs, so it isn't cleanly attributable without deep renderer-process mapping; hard per-tab caps likewise need process control. Weight + sleep is the actionable part today. | requested, absent |
| 71 | P2 | **Start page** — shipped: search hero, clock + real weather, recent, **editable** speed dial (persisted), quick actions, flowing wave. Remaining: drag-reorder widgets, add/remove widgets, agent summaries, custom backgrounds | locked-down elsewhere |
| 77 | P2 | Richer home-page motion: interactive/audio-reactive wave, parallax, per-time-of-day palette — beyond the current subtle SMIL wave |
| 78 | P2 | Real bookmarks UI (#22) + settings panel (appearance, engines, privacy) + extensions/equivalents view behind the new footer icons (currently a search-engine picker + roadmap notes) |
| 107 | ✅ | **Built-in task manager** (complements #70). `taskmgr.rs` + **`flux://tasks`** (⌘K "Open Task manager"): a system-wide process monitor (sortable name / CPU% / resident MiB; `tasks_kill` ends a process), marking **Flux's own process tree** by walking parent pids to our own (accurate, not name-matched) and confirming before ending the main process. Real per-*process* CPU/RAM, which #70's per-tab weight can't give (shared engine processes). _Follow-up:_ a Shift+Esc shortcut. | Chrome task mgr |
| 108 | ✅ | **Network speed test** (Ookla-style). `netspeed.rs` + **`flux://speedtest`** (⌘K "Network speed test"): download / upload / latency + jitter against Cloudflare's public speedtest backend (`speed.cloudflare.com`, no API key); live phase progress over `flux://netspeed-progress`; throughput math unit-tested. _Follow-up:_ a history of past runs. | under-served |

## Epic: Files explorer

The Files tab shipped (ADR 0006): virtualized list, quick-access rail,
breadcrumb nav, sort/filter, open-with-default, **file operations**
(new/rename/copy/cut/paste/drag-move/delete-to-trash, multi-select, context
menu, confirm-on-destructive), **live directory watch**, **undo** for reversible
ops, and **marquee selection** (BACKLOG #83/#84/#85/#89, done). These take it
further:

| # | P | Item |
|---|---|---|
| 90 | P2 | **OS-native drag-out** (drag a file into Explorer/mail/an editor). Attempted via `tauri-plugin-drag` then removed: on Windows the gesture fired and the OS returned `DRAGDROP_S_DROP`, but the file didn't land — the transfer is inside the crate's native OLE code, unreproducible from the Linux dev box. Revisit with a Windows debug loop; may need a custom CF_HDROP data object. In-app drag + cut/paste cover moving files meanwhile. |
| 86 | P2 | **Stream/paginate pathological dirs** (100k+ entries): chunked `fs_list` instead of one JSON payload (the v1 acceptable-tradeoff noted in ADR 0006) |
| 87 | P2 | **Flux cross-links**: "Open terminal here" (new Terminal tab at cwd), "Open in browser", agent file actions (summarize/rename-by-content); preview pane (text/image/pdf) |
| 88 | P2 | **Search within tree** (recursive, ranked by `flux-embed` #11) + fuzzy filename jump |

## Epic: Research-driven optimization

Top priorities distilled from a 40-paper survey of web-application + compiler
optimization (synthesis in `research/RESEARCH.md`, index in
`research/curated.json`). Framing constraint: Flux embeds the OS webview engine
(V8 / JavaScriptCore) and **cannot patch its register allocator / JIT / GC**, so
the shippable wins are at the network, blocking, caching, agent, and Rust-core
layers — not inside the engine. Each item cites its paper(s) and the existing
BACKLOG item it extends.

Status: implemented + unit-tested for all eight and **wired into the UI**; the
only remaining pieces are engine-gated (noted per item).

| # | P | Item |
|---|---|---|
| 99 | ✅ | **Hot/cold filter tiering** (extends #57, arXiv 1810.09160). The tokenized engine is already fast, so the win is **not re-running it** — verdicts are memoized per `(url, source-host, type)` in a bounded TTL/LRU decision cache (`shields.rs`, cleared on rule rebuild), and firing rules are recorded into a **hot set**; the Shields popover shows cache hit-% + active-rule count (`shields_hot_rules` exposes the full list). _Follow-up:_ persist the hot set across sessions to seed a sync/async split. |
| 100 | ◐ | **HTTP/3 + QUIC** (network, arXiv 2102.12358, 2306.11643). _Done:_ `enable_http3()` makes the **WebView2** engine negotiate QUIC explicitly (`--enable-quic`, merged into `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; `FLUX_WEBVIEW2_ARGS` to add more); no-op on WebKitGTK (limited H3). _Remaining:_ DoQ-over-DoH + connection coalescing + 0-RTT are governed by the engine's network stack and aren't directly configurable through Tauri — revisit if/when a custom resolver lands. |
| 101 | ✅ | **TTL/LRU cache utility** (core, arXiv 2602.06074). Done: bounded `TtlCache<K,V>` (`cache.rs`, LRU + per-entry TTL, hit/miss stats, 7 tests), in use by shields (#99) and available for favicon/metadata/settings/LLM-response caching. _Follow-up:_ adopt it in those other call sites + on-disk persistence for durable entries. |
| 102 | ◐ | **Agent latency levers** (extends #82, arXiv 2203.16487). _Done:_ the model is kept warm (`keep_alive`, default 30 m → no per-call reload), context is capped (`num_ctx`), and an options passthrough (`FLUX_OLLAMA_OPTIONS`, merged over defaults) is the hook for speculative-decoding/draft-model knobs when the local Ollama exposes them. _Remaining:_ true draft-model speculative decoding + INT8/INT4 quantization depend on Ollama-side support; document a recommended setup. |
| 103 | ✅ | **Confidence-gated predictive prefetch** (ties #70, #45, arXiv 1906.00877). `prefetch.rs` — per-origin Markov chain (LFU decay, confidence + min-sample thresholds). The chrome records each navigation transition on page-load-finished and **preconnects** (`webview_preconnect` → `<link rel=preconnect>`) to the predicted next hosts; the pressure gate is driven by the resource governor's memory poll (#70). _Follow-up:_ persist the model across sessions; scale prefetch depth by hit-rate. |
| 104 | ◐ | **Agent safety guards** (extends #8, #82, arXiv 2511.19477). _Done:_ a **destructive-action guard** enforced in the execution layer — every agent click's compiled JS reads the element's *real* accessible name and aborts on a Rust-defined deny-list (delete/pay/place-order/refund…), never trusting the model (`flux-agent`: `is_destructive` + `DESTRUCTIVE_TERMS` + the injected guard); destructive intent is flagged in the activity feed. _Remaining:_ accessibility-tree primary context + versioned element refs (`snapshot_ver:elem_ref`) + batched actions — the larger agent-architecture work. |
| 105 | ◐ | **Per-site lean mode** (perf, arXiv 2106.08948, 2308.16729). _Done:_ `leanmode.rs` — opt-in per host via the **Shields popover** ("Lean mode here"); when on, a curated performance filter list (`assets/lean-filters.txt`: tag managers, analytics, A/B, session replay, chat/social widgets) blocks heavy third-party scripts on top of shields, wired into the request interceptor. _Remaining:_ the **dynamic per-function dead-JS elimination** (coverage trace → empty-body/lazy-load with a screenshot-diff oracle) needs a webview coverage hook the native engines don't expose through Tauri. |
| 106 | ✅ | **Smarter hibernation eviction** (ties #45, #70, arXiv 1202.5539). The memory-pressure path now calls `hibernate_rank` to sleep tabs **Belady-style** — least likely to be needed next, discounting idle time by the #103 prediction and keeping predicted-return tabs — with a plain-LRU fallback. _Follow-up:_ surface dark-mode/shields/hibernation as measured **battery** features (arXiv 2205.11399); rematerialization policy. |

## Decisions wanted (not yet scheduled)

- ✅ **Search backend** (#68, done): `flux-search` ships a template-based engine
  config + resolution; the user's own engine drops in via `search_add_engine` +
  `search_set_default`. Remaining: live suggestions UI (#32).
- Terminal multiplexer protocol compat (tmux control mode)? Revisit after #15.
- ✅ **Extension story** (decided 2026-06-15): Chrome/WebExtensions can't run in
  native webviews → Flux ships its **own curated mini-extension API** (new epic,
  #92–96), not WebExtensions compat or built-in-only. Start at the ADR (#96).
- CLI: replace the hand-rolled parser with `clap` once flags exceed ~6 (`cli.rs`).
