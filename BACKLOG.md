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
| 4 | P0 | `flux` CLI *inside* the terminal: `flux extract-json`, `flux dom`, `cd $FLUX_TAB_DIR` — backed by `dom_active_bytes` |
| 76 | P1 | Bundle a Nerd Font (icon glyphs) as a webfont for guaranteed terminal/prompt icon coverage — `customGlyphs` + the fallback chain cover box-drawing/powerline but not Private-Use-Area icons |
| 74 | P2 | Terminal throughput: raw-byte channel transport (avoid `number[]` JSON) and/or route the PTY stream into the `flux-term` WGPU renderer when compositing is solved |
| 75 | P2 | Terminal splits/tabs *within* the column, OSC 133 shell integration, OSC 8 link → open Flux browser tab (supersedes earlier #15–17 once xterm is the renderer) |
| 98 | P2 | Terminal session survival across **reboot** (today's tmux persistence via `FLUX_TERM_PERSIST` survives Flux restarts, but the tmux server dies on `wsl --shutdown`/reboot): a resurrected-tmux-server-on-boot hook, or a small detached PTY-host service. Also: a settings toggle for persistence instead of the env flag |

## Epic: Flux Agent

| # | P | Item |
|---|---|---|
| 1 | P2 | (Optional) in-process `llama-cpp-2` path for a single self-contained binary — the agent ships via Ollama now (ADR 0005), so this is no longer P0; GGUF load + GBNF sampler behind the `llama` feature |
| 81 | P1 | Agent model picker in Settings (currently `FLUX_MODEL` env); persist choice + show which model is active in the agent sidebar |
| 82 | P2 | Agent: schema-constrained output via Ollama `format` = JSON schema (vs current `format:"json"` + prompt) and multi-step plans (#8); stream tokens to the sidebar |
| 8 | P1 | Multi-step plans: action sequences with per-step user confirmation UI (magenta preview → approve → execute) |
| 11 | P2 | Replace hashing embedder with EmbeddingGemma int8 behind `flux-embed/model` |

## Epic: Tabs & Chrome import

| # | P | Item |
|---|---|---|
| 6 | P1 | Glassmorphic command palette (⌘K): fuzzy tab/action/bookmark search |
| 18 | P0 | Keyboard shortcuts: ⌘T (browser tab), ⌘⇧T (terminal tab), ⌃\` (toggle terminal column), ⌃A (toggle agent), ⌘S (toggle sidebar), ⌘K (palette) |
| 28 | P1 | Responsive breakpoints: auto-collapse the terminal then agent then sidebar as window width shrinks (ADR 0002 mitigation) |
| 79 | P0 | **Performance pass** (user priority): profile + cut latency in window resize, pane resize, and general browsing. Candidates — debounce/RAF the webview reposition (partly done), avoid full-window webview churn, reduce backdrop-filter cost (the glass blur is GPU-heavy on weak GPUs; consider toggling blur off while resizing), trim re-renders, measure against the ADR 0001 budgets. Resolve the webview-placement bug here too. |
| 29 | P2 | Address bar does in-place navigation of the active tab (depends on #2); ⌘L focuses it |
| 30 | P2 | Tab drag-and-drop: reorder in the list, drag into/out of the pinned grid |
| 21 | P1 | Favicons: fetch + cache per host; replaces the letter-glyph placeholders in the pinned rail and tab strip |
| 22 | P1 | Flux bookmark store (persisted, folder tree) + import UI consuming `chrome_import_bookmarks`; surface in ⌘K palette |
| 23 | P1 | Chrome **saved tab groups** import: parse the `Saved Tab Groups` SQLite db (needs `rusqlite`; schema is sync-internals, version-fragile — pin per Chrome milestone) |
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
| 31 | P0 | Navigation polish (basics shipped via #2: load/reload/back/forward/navigate): add **stop**, **loading + security/TLS state** in the address bar, and a loading progress affordance | all |
| 32 | P0 | Omnibox **live suggestions** UI: dropdown of typeahead results (fetch each engine's `suggest_template`, BACKLOG #68 backend) + history/bookmark autocomplete. (Search-or-URL resolution + `!bang`/keyword routing already ship via `flux-search`.) | all |
| 33 | P0 | Find-in-page (⌘F) with match highlighting and count | all |
| 34 | P1 | Download manager: progress, pause/resume, open/reveal, history, integrity (hash) | all |
| 35 | P1 | Built-in PDF viewer (+ annotation, fill forms) | all |
| 36 | P1 | Per-site zoom (persisted) and full-page zoom | all |
| 37 | P1 | Picture-in-picture for video, auto-PiP on tab switch | Chrome/Arc/Safari |
| 38 | P1 | Permissions UI: camera/mic/location/notifications prompts + per-site manager | all |
| 39 | P1 | History: full-text searchable, calendar view, clear-browsing-data | all |
| 40 | P2 | Translate page (local model candidate — ties into the Gemma work) | Chrome/Edge/Safari |
| 41 | P2 | Reader mode: declutter + typography + TTS | Safari/FF/Edge |
| 42 | P2 | PWA / "install site as app" with its own window + dock icon | Chrome/Edge |

## Epic: Best-in-class power features

The features that make Arc/Vivaldi/Zen users evangelical.

| # | P | Item | Inspiration |
|---|---|---|---|
| 43 | P1 | **Split view**: 2–4 tabs tiled in the content area, adjustable, saved with the session | Arc, Edge, Vivaldi, Zen |
| 44 | P1 | **Spaces / workspaces**: named tab sets with their own pinned tabs + theme; switch instantly (semantic clustering #14 feeds auto-assignment) | Arc, Opera, Zen, Edge |
| 45 | P1 | **Tab hibernation / sleeping tabs**: unload background tabs, preserve scroll/form state, wake on focus; per-tab + global memory cap | Edge, Vivaldi, Brave |
| 46 | P1 | **Auto-archive** stale tabs after N days (with an easy "archived tabs" view) | Arc |
| 47 | P1 | **Session management**: named, auto-saved, restorable sessions; "reopen everything from yesterday" | Vivaldi, Opera |
| 48 | P1 | **Web panels**: pin a site (chat, docs, music) to a slim side panel beside any tab | Vivaldi, Opera, Edge |
| 49 | P2 | **Boosts / userstyles + userscripts**: per-site CSS/JS injection, no extension needed (the agent can author these) | Arc, Vivaldi, Stylus |
| 50 | P2 | **Peek / glance / little-window**: open a link in a transient overlay without committing to a tab | Arc, Zen |
| 51 | P2 | **Mouse gestures** + rocker gestures, fully rebindable | Vivaldi, Opera |
| 52 | P2 | **Vim-style keyboard navigation** (link hints, scroll, tab nav) built in, not an extension | Vimium users |
| 53 | P2 | **Notes / easels / annotations** tied to pages, local-first | Arc, Vivaldi |
| 54 | P2 | **Web capture**: region + full-scrolling-page screenshot with annotation | Edge, Firefox |
| 55 | P2 | **Compact / focus mode**: hide all chrome, content-only | Zen, Arc |
| 56 | P2 | **Tab stacking** (groups within the vertical list, collapsible) | Vivaldi, Chrome groups |

## Epic: Privacy, security & data

**Active track** (chosen 2026-06-15): #91 → #57/#60, #58, #59, #61. Because Flux
uses *native* webviews (WebView2 / WebKitGTK), not a Chromium network stack, the
implementation path differs from a normal browser — captured per item below.
**#91 is the enabling primitive** the blocker and HTTPS-upgrade both sit on.

| # | P | Item | Inspiration |
|---|---|---|---|
| 91 | P1 | **Request-interception layer** (ADR 0007): engine + policy + the **WebView2 interceptor** are wired and **verified blocking on Windows** (`with_webview` → `WebResourceRequested` → `403`). **Remaining: the WebKitGTK interceptor** (web-process extension) for the Linux/dev backend. Reused for #58's http→https rewrite. | enabling primitive |
| 57 | P1 | **Built-in content blocker** (mostly done): `flux-filter` (Brave's `adblock`) + WebView2 interceptor block at the request level (verified on Windows); **full EasyList + EasyPrivacy fetched/cached**; **shields UI** (footer badge + global/per-site toggle + update). **Remaining: element-hiding cosmetic filters (injected CSS) + user-supplied custom lists.** | Brave, Vivaldi, Opera |
| 58 | P1 | **HTTPS-only mode** (upgrade/lock http→https via #91, interstitial on downgrade) + **granular cookie controls** (WebView2 `CookieManager` / WebKitGTK `WebKitCookieManager`) + per-site permission prompts + clear-on-close. | Brave, Firefox |
| 59 | P1 | **Multi-account containers / profiles**: isolated cookie/storage jars per container — a webview data dir per profile (WebView2 user-data-folder / `WebKitWebsiteDataManager` per `WebKitWebContext`); one-click **ephemeral/private** container = in-memory data manager that's wiped on close. | Firefox, Safari profiles |
| 60 | P2 | **Fingerprint randomization** + tracker-script blocking (script blocking falls out of #57; fingerprint defenses via injected JS shims over canvas/WebGL/audio). | Brave |
| 61 | P1 | **Password manager + autofill + passkeys (WebAuthn)**: OS-keychain-backed vault (Windows Credential Manager/DPAPI, macOS Keychain, libsecret), autofill via Flux's existing JS injection, WebAuthn handled by the native webview; import from Chrome/1Password/Bitwarden. | all |
| 62 | P1 | **E2E-encrypted sync** of tabs/bookmarks/history/sessions across devices — account-optional, local-first (the gap Arc/Chrome leave open). Builds on the session store (#19, done). | under-served |
| 63 | P2 | Built-in proxy / VPN / Tor window hook (bring-your-own provider). | Brave, Opera |

## Epic: Extensions (Flux mini-extension API)

Decision (2026-06-15): Chrome/WebExtensions can't run in native webviews, so Flux
ships its **own** curated, permissioned extension model rather than chasing
WebExtensions compat or a raw userscript runtime. It reuses Flux's existing
JS-injection substrate (capture.js + the agent's injection compiler). **Start
with the ADR (#96)** — the security model gates everything else.

| # | P | Item |
|---|---|---|
| 96 | P0 | **ADR + security model** (do first): isolated worlds for content scripts, a privileged broker for the API, capability gating from the manifest (no ambient authority), install-time consent, and what an extension can NEVER touch (other extensions' storage, raw IPC, tab webview internals beyond its grants). |
| 92 | P1 | **Manifest + loader**: `flux.extension.json` (name, version, requested permissions, `content_scripts` = match globs + js/css, optional background worker, UI contributions). Load from a folder/zip; enable/disable/remove; persist the registry (extends the session store #19). |
| 93 | P1 | **Content-script injection** in a per-extension **isolated world** scoped to `@match` patterns, built on the existing inject path; `postMessage`-style bridge between the content script and the privileged broker, mediated by the manifest's permissions. |
| 94 | P1 | **Permissioned API surface** exposed to extensions: `flux.tabs` (query/open/navigate per grant), `flux.dom` (read/inject in granted tabs), `flux.storage` (per-extension KV), `flux.ui` (side panel + toolbar button + context-menu items), `flux.events`. Every call checks a grant; deny-by-default. |
| 95 | P2 | **Extension manager UI** (fills the settings "extensions" view, #78): installed list, per-extension permission view + toggle, install/remove, update. A first-party **example extension** (e.g. a reader-mode or a page-summarizer that calls the local agent) as the reference. |

## Epic: Under-served — Flux's wedge

Highly requested, poorly served by incumbents. This is where Flux differentiates
beyond "another Chromium skin."

| # | P | Item | The gap |
|---|---|---|---|
| 65 | P0 | **DOM-aware integrated terminal**: a real dev terminal that can read the active page (`flux extract-json`, `cd $FLUX_TAB_DIR`) and that the agent can drive. Nobody ships this | core |
| 66 | P1 | **Semantic everything-search**: one box over open tabs + history + bookmarks + page contents, ranked by local embeddings (#11) — not just title substring | weak everywhere |
| 97 | P2 | **`flux://omni` follow-up** (dashboard + live `/sites` grid shipped): a compact "Omni index" glance widget on the start page (key stats at a glance, link into the full dashboard) | search |
| 67 | P1 | **Scriptable automation / macros**: record-and-replay browsing flows, schedulable, agent-authored. Power users beg for this; only flaky extensions exist | under-served |
| 69 | P2 | **True offline archiving / read-later**: save the *rendered* page (MHTML/SingleFile), full-text indexed, available offline | weak everywhere |
| 70 | P2 | **Per-tab resource governor**: live CPU/RAM/network per tab + hard caps + "what's draining my battery" attribution | requested, absent |
| 71 | P2 | **Start page** — shipped: search hero, clock + real weather, recent, **editable** speed dial (persisted), quick actions, flowing wave. Remaining: drag-reorder widgets, add/remove widgets, agent summaries, custom backgrounds | locked-down elsewhere |
| 77 | P2 | Richer home-page motion: interactive/audio-reactive wave, parallax, per-time-of-day palette — beyond the current subtle SMIL wave |
| 78 | P2 | Real bookmarks UI (#22) + settings panel (appearance, engines, privacy) + extensions/equivalents view behind the new footer icons (currently a search-engine picker + roadmap notes) |
| 72 | P2 | **Native RSS / feed reader** in a web panel | Vivaldi only |

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

## Decisions wanted (not yet scheduled)

- ✅ **Search backend** (#68, done): `flux-search` ships a template-based engine
  config + resolution; the user's own engine drops in via `search_add_engine` +
  `search_set_default`. Remaining: live suggestions UI (#32).
- Terminal multiplexer protocol compat (tmux control mode)? Revisit after #15.
- ✅ **Extension story** (decided 2026-06-15): Chrome/WebExtensions can't run in
  native webviews → Flux ships its **own curated mini-extension API** (new epic,
  #92–96), not WebExtensions compat or built-in-only. Start at the ADR (#96).
- CLI: replace the hand-rolled parser with `clap` once flags exceed ~6 (`cli.rs`).
