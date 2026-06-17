# Changelog

All notable changes to Flux. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org). Unreleased work lands here in the
same commit as the code (docs-before-commit policy). Pair file: `BACKLOG.md`
(what's NOT done yet).

## [Unreleased]

### Added
- **Resource monitor** (BACKLOG #70, partial) — **📊** `flux://resources` (+ ⌘K)
  shows overall Flux/free RAM and a per-tab list (captured-page weight + live /
  💤 sleeping), with one-click **💤 Sleep background tabs** to reclaim RAM. (True
  per-tab CPU isn't shown — browser engines share processes across tabs, so it
  isn't cleanly attributable; payload weight + sleep is what's actionable.)
- **Web capture / screenshot** (BACKLOG #54) — **📸** in the address row (or ⌘K
  "Capture page") saves the visible page to a PNG in the app's `screenshots`
  folder, with a toast on completion. (WebView2 `CapturePreview`, COM-verified vs
  msvc; Windows for now. Full-scrolling-page, region select, and annotation are
  follow-ups.)
- **Named multi-account containers** (BACKLOG #59) — create containers in Settings
  (name + color); **"Open in container ▸"** in the new-tab picker opens a tab with
  an **isolated cookie/storage jar** (a per-webview `data_directory`), so you can
  be logged into two accounts of the same site at once. The container's color
  marks the tab's rail; containers persist. (Completes #59 alongside the earlier
  private/incognito tabs.)
- **Reader mode + text-to-speech** (BACKLOG #41) — **📖** in the address row (or
  ⌘K "Reader mode") declutters the current article into a clean, typographic view
  over the page, and **🔊 Listen** reads it aloud (Web Speech API). The article is
  extracted into structured blocks (headings/paragraphs/lists/quotes/images) and
  rendered as **text + image src only** — never raw HTML, so there's no injection
  surface. Esc, ✕, or switching tabs closes it.
- **Per-site zoom** (BACKLOG #36) — **Ctrl +/−/0** zoom the active page; the level
  is **remembered per site** and re-applied automatically on every visit. A `%`
  pill appears in the address row when zoom ≠ 100% (click to reset), and zoom
  in/out/reset are in ⌘K. (`webview.set_zoom`; persisted in the shell.)
- **Private tabs** (BACKLOG #59) — "🕶 Private tab" (new-tab picker + ⌘K "New
  private tab") opens a tab on an **in-memory session** (`incognito` webview): no
  cookies/storage persisted, wiped on close, **never recorded in history or
  Omni**, and never restored across restart. A violet rail/tint marks it. (The
  ephemeral half of multi-account containers; named persistent containers via
  per-webview `data_directory` are the documented follow-up.)
- **Agent actions are now preview-and-approve** (BACKLOG #8) — `/act` plans the
  action and shows it as a **preview with Approve / Skip** instead of touching the
  page immediately. Approve runs it (with the magenta highlight); Skip discards it;
  a refusal shows as a note. (`agent_plan` + `agent_run_action`.) Autonomous
  multi-action sequences from one prompt are a follow-up (#82); for now you
  confirm each step.
- **Named sessions** (BACKLOG #47) — save the current set of tabs as a named
  session and restore it later (reopens every tab) from a new `flux://sessions`
  page, ⌘K "Open Sessions", or the Library popover. Persisted separately from the
  always-on "continue where you left off" session.
- **Semantic everything-search** (BACKLOG #66) — ⌘K now searches *everything* in
  one ranked list: open tabs **by page content** (not just title), bookmarks, and
  history, scored by the local embedder (`omni_search`). Large corpora are
  lexically pre-filtered then embedding-reranked, so it stays fast per keystroke;
  an empty query still browses your open tabs. (Searching open-tab *contents* is
  the part that's weak in other browsers; true synonym-level semantics arrive
  with the stronger embedder, #11.)
- **Chat with this page / your tabs** — the Flux Agent now has a **scope toggle**
  (📄 This page · 🗂 All tabs) and one-tap prompts (**Summarize · Key points ·
  Explain**). "This page" grounds the local Gemma in the active tab's captured
  text (already the default); "All tabs" feeds it every open browser tab in the
  workspace (`agent_chat_tabs`, per-tab-capped). Fully local — no page text
  leaves the machine.
- **Web panels** (BACKLOG #48) — pin a site (chat, docs, music, claude.ai) to a
  slim pane on the right of the content card that **persists across tab
  switches**. Manage from the footer **◨** popover: "Pin this page", toggle a
  panel open/closed, unpin (all persisted across restart). Draggable divider to
  resize; a small DOM toolbar (title / reload / close) sits above the pane. Each
  panel is its own native webview, deliberately **without** the DOM-capture
  script — a pinned panel never pollutes history or tab clustering — and only the
  open panel holds a live webview (inactive pins are just metadata).
- **Bookmarks** (BACKLOG #22) — a persisted, folder-aware bookmark store with a
  `flux://bookmarks` page (search, folder grouping, delete, clear), a footer 🔖
  popover (**★ Bookmark this page**, All bookmarks, History), and a ⌘K "Open
  Bookmarks" action. **Chrome import** pulls every bookmark from a chosen profile
  (de-duped, under an "Imported" folder). Each folder has **"⊞ Open as group"**,
  which opens its bookmarks as tabs in a new Flux tab group (capped at 20) — the
  practical bridge for bringing Chrome tab groups over. (Chrome's *saved* tab
  groups live in a separate SQLite db, parsed in #23; live/unsaved groups are an
  undocumented session blob — your profile had none.)
- **Split tabs show as one combined unit in the strip** (BACKLOG #43) — like
  Chrome's paired split tabs: the two tiled tabs render together inside a teal
  "◧◨ Split" bracket with a ⤢ merge (un-split) button, instead of as two
  scattered rows. (Replaces the earlier separate "Merge" bar.)
- **Install scripts — `flux` on your PATH.** `scripts/install-linux.sh` and
  `scripts/install-windows.ps1` build a self-contained binary (the frontend is
  embedded) and install it to `~/.cargo/bin` (`%USERPROFILE%\.cargo\bin` on
  Windows), so `flux` launches from any directory. The Windows script checks
  prerequisites (Rust msvc, the MSVC C++ build tools / `link.exe`, Node) and
  prints exact fixes. README gains an **Install** section.
- **Split view** (BACKLOG #43) — two browser tabs tiled side by side in the
  content card. Start one by **right-clicking a tab → "Split with current tab"**
  or by **dragging a tab onto the right edge of another**. A draggable seam
  resizes the panes (double-click to even out); the split pauses when you focus a
  third tab and resumes when you return to a pair member. Both panes stay live
  (neither hibernates) and re-tile across resizes. Built over the existing
  child-webview model: the seam is a DOM splitter in the gap the OS webview
  layers don't cover, and dragging briefly hides the panes so the chrome can
  track the pointer (a native webview captures the mouse otherwise). **Merge**:
  a "⤢ Merge" control appears in the sidebar while split — it lives in the chrome
  because the webviews cover the page — and un-splits back to a single tab.
- **Send a tab or a whole group to another workspace** (BACKLOG #44) —
  right-click a tab or a group header → "Send to workspace …". Moving a group
  carries all its tabs; the moved webviews are torn down (they left the active
  space), and if you sent the active tab away, focus falls back to a remaining
  tab in the current space.
- **Dark mode for all sites** — a Settings toggle that force-darkens every page
  by injecting a CSS "smart invert" (invert the page, re-invert images/video so
  media looks normal). Engine-agnostic — works on both WebView2 (Windows) and
  WebKitGTK (Linux) and on every site regardless of `prefers-color-scheme`
  support. Toggles live on all open tabs; new tabs apply it at document-start.
  Persists across launches. (An earlier attempt used WebView2's profile-level
  `PreferredColorScheme`, which only darkened opt-in sites and was a no-op on the
  WebKitGTK build — replaced by this.)
- **Drag a tab onto a group to join it** (BACKLOG #56) — drop a tab on a group
  header (or onto the middle of another tab) to add it to that group; dropping
  on an ungrouped tab's middle starts a new group with both. Tab-row edges still
  reorder.
- **Workspaces** (BACKLOG #44) — Arc-style named, colored tab spaces. Each tab
  belongs to a workspace; the strip (pinned + groups + tabs) shows only the
  active one. A switcher above the sidebar tools: click a pill to switch, **+**
  to create, double-click to rename, click the dot to recolor, right-click to
  delete (closes its tabs). **Highly RAM-optimized**: switching away **destroys
  the leaving workspace's webviews**, so inactive workspaces cost only their
  tab metadata (kilobytes) — and tabs are created lazily anyway, so an unvisited
  workspace holds no webviews at all. Workspaces + per-tab membership + the
  active one persist across restart.

### Changed
- **History: deferred load + precomputed search keys.** `history.json` is now
  loaded on a background thread after the window shows instead of being parsed
  synchronously on the boot path (a large history no longer delays first paint).
  Each entry carries a precomputed lowercased search key (skipped on disk/IPC,
  recomputed on load), so omnibox search no longer re-lowercases every entry on
  every keystroke — it matches against the cached key.
- **Favicons are fine-grained reactive.** Moved the favicon cache from one big
  object signal to a per-host store, so loading one site's icon only re-renders
  the rows showing that host — not every favicon consumer (it was ~O(rows²) when
  many tabs fetched icons at once on session restore). `activeTab()` is now
  memoized too (it's read in many reactive scopes per render).
- **Dropped per-event work that shipped in release.** Removed debug `console.log`s
  that fired on every DOM capture (~every 400ms on active pages), every page-load,
  and every tab-open — plus a `webview_debug` IPC round-trip that ran on every tab
  open purely to log diagnostics. capture.js no longer builds/logs a string per
  publish. History `record` now takes a read-only fast path for a URL seen within
  the dedup window: it no longer write-locks or marks the store dirty for a page
  you're just sitting on, so an actively-mutating tab stops rewriting the whole
  ~2 MB `history.json` every 60s.
- **Responsiveness: cheaper sidebar renders + no resize IPC spam.** The tab-list
  derivations (pinned/unpinned tabs, per-group members, ungrouped remainder, the
  split fold) are now memoized instead of re-filtering `tabs()` once per tab row —
  was O(tabs²) per render, now one pass per change. The native-webview layout
  effect issues show/hide IPC only on visibility transitions (tracked in a `shown`
  set): a window resize now triggers just the throttled bounds update, not a
  hide-every-tab sweep each frame. Redundant `refreshGroups` calls (already done
  inside `refreshTabs`) were dropped from 8 mutation paths.
- **Binary: cold-path crates built for size.** PGP/zip/csv (import) and `image`
  (favicon transcode) now compile at `opt-level="z"` — they're one-shot/occasional
  operations where latency is irrelevant — while the hot browsing/render path
  stays at `opt-level=3`. Trims ~98 KB off the release binary with no runtime
  cost. (The binary was already lean: fat-LTO + strip + `panic=abort`; further
  cuts would require sizing the whole build, which would regress the speed work.)
- **RAM: hibernated tabs release their DOM snapshot.** Sleeping a tab now drops
  its cached DOM (up to ~1.25 MiB/tab) instead of keeping it resident; it
  re-captures on the wake reload. In a many-tab session this is the main Rust-side
  retained-memory win (the process RSS is otherwise dominated by the webview
  engine itself, which is already managed by hibernation + workspaces).
- **Startup: smaller boot bundle.** The flux:// pages (Vault, History, Bookmarks,
  Omni), the file manager, the command palette, and the extensions panel are now
  lazy-loaded — none of them show on a fresh window, so they no longer sit in the
  initial parse. The boot JS bundle dropped ~157 KB → ~112 KB (gz 49.8 → 36.3);
  the deferred chunks load on first use, which is instant since assets are local.
  (xterm was already lazy — only loaded when a terminal tab opens.)
- **CPU/battery: idle is now near-silent.** Several always-on polling timers that
  woke every 2–3s regardless of whether their UI was open are now event-driven /
  open-gated: the Settings RAM readout (2.5s), Shields status (2s × 5 IPCs →
  badge refreshes on navigation, full poll only while open), Passwords matches
  (2.5s → only while open), and Downloads (3s → only while open or a download is
  in flight). The hibernation sweep moved 30s→60s and now skips the `sysinfo`
  memory scan entirely when there are no background tabs to evict; the history
  autosave moved 15s→60s. Net: a fully idle window goes from ~sub-second
  aggregate wakeups to a handful per minute.

### Fixed
- **Built `flux`/`flux.exe` showed `ERR_CONNECTION_REFUSED` (localhost:1420).**
  A plain `cargo build --release` doesn't enable Tauri's `custom-protocol`
  feature, so the app served the dev-server URL instead of the embedded
  frontend. Added a `custom-protocol` feature and both install scripts now build
  with `--features custom-protocol`. A boot log prints `dev=<bool>` so the mode
  is visible from the terminal (a release binary must show `dev=false`).
- **ICO favicons: self-heal stale cache.** Favicons cached as `data:image/x-icon`
  before the ICO→PNG transcode landed were served straight from disk (still
  unrenderable on WebKitGTK); those entries are now skipped on read, forcing a
  fresh fetch that transcodes to PNG.
- **ICO favicons now render** (e.g. medium.com). WebKitGTK doesn't decode
  `data:image/x-icon` in `<img>`, so ICO-only sites showed no icon; favicons are
  now transcoded to PNG in Rust (and fetched with a browser User-Agent, so
  Cloudflare-fronted sites don't serve a challenge page instead of the icon).
- **Tab/group right-click menu no longer clips off-screen** — the menu is bounded
  to the viewport height (scrolls if taller) in addition to the Portal + clamp, so
  it can't run past the bottom of the panel.
- **Ctrl+Tab / Ctrl+Shift+Tab cycle only non-pinned tabs** (and stay within the
  active workspace) — previously the cycle wrapped through pinned tabs (and, in
  principle, other workspaces). If a pinned tab is active, the cycle enters at the
  first/last non-pinned tab.
- **The tab/group right-click menu is no longer clipped** by the sidebar edges or
  its bottom. The sidebar's `backdrop-filter` made it the containing block for the
  `position:fixed` menu, and its `overflow:hidden` cropped it — the menus now
  render through a Portal to `<body>` and clamp to stay on-screen.
- **Ctrl+Tab / Ctrl+Shift+Tab cycle tabs.** A focused page webview ate the chord
  before the injected forwarder ran (WebView2 treats it as a built-in browser
  accelerator), so cycling never fired. Now intercepted natively at the
  controller's `AcceleratorKeyPressed` event and forwarded to the chrome as
  next/prev-tab. COM verified vs msvc.
- **Sidebar popovers are opaque.** Shields / Settings / Passwords / Downloads /
  Extensions menus float over the native webview — a separate OS layer the
  backdrop-blur can't sample — so glass translucency read as see-through. They're
  now solid (keeping the glass rim + sheen).
- **Group + workspace rename now work.** They used `window.prompt`, which is a
  no-op in the webview — replaced with inline editing (double-click the name,
  Enter/blur to commit, Esc to cancel).
- **New tabs focus the address bar** so you can type immediately — now works
  when opened with **Ctrl+T** from a focused page too. A focused page webview
  holds OS keyboard focus (it's a separate child window), so focusing the chrome
  omnibox was a no-op; the chrome now reclaims OS focus (`chrome_focus`) first.
  Same fix applies to Ctrl+L.
- **Tab groups** (BACKLOG #56) — named, colored, collapsible groups in the tab
  strip. Right-click a tab for: pin, **new group**, **add to** an existing group,
  **remove from group**, close. Group headers collapse/expand, rename
  (double-click), recolor (click the dot), and ungroup (✕). A **"⊞ Group"** button
  by the Tabs header runs **group-by-topic**, seeding groups from Flux's existing
  semantic clusters (flux-embed). Groups + per-tab membership persist across
  restart. Backend model is `TabGroup` + commands; the UI reuses one drag-aware
  `TabRow` for grouped and ungrouped tabs.
- **Drag-and-drop tab reordering** (BACKLOG #30). Tabs in the strip are now
  draggable — drop above/below another tab to reposition (the drop point follows
  the cursor's half of the target row). The order is an explicit, persisted
  sequence in the backend (`tab_reorder`), so a drag-reordered strip survives
  restart. Reorder within the pinned grid + dragging into/out of it are
  follow-ups.

### Changed
- **Window remembers its size + position** across launches
  (`tauri-plugin-window-state`) — Flux reopens exactly as you left it instead of
  resetting to the default size.
- **Content card: padding on all sides + rounded page corners.** The page area
  now floats with even padding (previously it was flush against the sidebar).
  Internal pages (start, history, passwords, omni) get the card's rounded
  corners for free; live web pages are a separate OS layer, so on Windows their
  host window is clipped to a matching rounded region (`SetWindowRgn`,
  re-applied on resize; harmless square fallback if the engine doesn't honor
  it). COM verified against the msvc target.

### Added
- **Download manager** (BACKLOG #34) — Flux now intercepts WebView2's
  `DownloadStarting`, tracks each download's live progress + state, and owns the
  UI (the default WebView2 bubble is suppressed). A footer ⬇ popover (with an
  active-count badge) shows downloads with progress bars and controls:
  pause/resume/cancel while running, open / show-in-folder when done. Live COM
  operations are held on the UI thread and driven via `run_on_main_thread`; the
  serializable model is unit-tested and the WebView2 COM was compile-verified
  against the msvc target. (Windows/WebView2 for now; the WebKitGTK download
  hook is a follow-up.)
- **Command palette** (BACKLOG #6) — **Ctrl+K** opens a centered fuzzy search over
  open tabs (switch to), actions (new tab/terminal/files, toggle terminal/agent/
  sidebar, open History/Passwords/Omni, find, reload, close tab), and browsing
  history (as you type). Arrow keys + Enter + Esc; click/hover too. This also
  wires up the one shortcut that was previously blocked on this feature. Because
  it's a centered modal and the native webview is a separate OS layer over the
  content card, the active page is hidden while the palette is open and restored
  on close.
- **Omnibox live suggestions** (BACKLOG #32) — as you type in the address bar, a
  dropdown shows local **history matches** (with favicons) followed by **search
  suggestions** from the default engine's suggest endpoint (OpenSearch JSON, as
  DuckDuckGo/Google/Bing return). Arrow keys move the selection, Enter opens it,
  Esc dismisses, click/hover work. The dropdown lives in the sidebar (never under
  the native webview). A **"Search suggestions" toggle** (Settings ⚙, on by
  default) gates the remote fetch — turn it off and only local history is used,
  so your keystrokes never leave the machine.
- **Browsing history** (BACKLOG #39) — a persisted, searchable history at
  `flux://history`. Visits are recorded automatically from the DOM-capture pipe
  (real navigated URL + page `<title>`), deduped per visit and ranked by a
  simple frecency (recency + visit count); the store is capped + saved on a
  debounced background timer. The full-page view (DOM-rendered, like
  `flux://passwords`) shows recents grouped by day, live search, per-row
  favicons (#21), click-to-open, remove-one, and clear-all. Reachable from the
  Start page and the 🔖 Library popover. Store logic is unit-tested. Local-only.
- **Favicons** (BACKLOG #21) — the tab strip + pinned rail now show each site's
  real favicon instead of a letter glyph. Fetched **directly from the site and
  without cookies** (a plain `<img>` would send them) — never a third-party
  favicon service, in keeping with Flux's privacy stance — by a Rust command
  that tries `/favicon.ico`, falls back to the page's declared
  `<link rel="…icon">`, validates the bytes are actually an image (filtering
  soft-404 HTML), and caches the result **per host on disk** as a `data:` URL.
  The letter glyph remains as the fallback while loading or when a site has no
  usable icon. Image-type detection, HTML attribute parsing, and URL resolution
  are unit-tested.
- **Full-page password manager** at `flux://passwords` (BACKLOG #61). The sidebar
  popover was too cramped for a real vault (narrow + lots of scrolling), so the
  management UI moved to a roomy in-content page (DOM-rendered like
  `flux://omni`, no webview): a **searchable two-pane** layout — login list with
  avatars on the left, a detail pane on the right (reveal/copy username +
  password, open websites, delete) — plus **New login**, **Import from Proton
  Pass** (CSV/ZIP/PGP), and **Security** (master password + auto-lock) as tabs.
  The footer 🔑 popover is now lean and *contextual* (Proton-extension-style):
  logins that match the current site with one-click **Fill**, unlock/lock, and
  an "Open Passwords manager" link to the full page.
- **Tab hibernation / sleeping tabs** (BACKLOG #45) — the RAM win. Background
  browser tabs idle past a timeout have their **native webview destroyed**,
  freeing its memory; the tab stays in the strip (dimmed, with a 💤) and the
  page **reloads when you click back to it** (Flux's lazy-webview path re-creates
  it). On by default with a 30-minute timeout, configurable in Settings (⚙ →
  Memory: on/off + 5 min / 15 min / 30 min / 1 hour). The active tab and
  start/terminal/files tabs are never slept; hibernating does **not** run
  clear-on-close (the tab isn't closing).
- **Memory-pressure tab eviction** (BACKLOG #45). Beyond the idle timer, Flux now
  reads actual system + process memory (`sysinfo`) and, when free RAM is
  genuinely low (<12%, more aggressively under 6%), sleeps the
  least-recently-used background tabs early to relieve pressure. Adaptive to the
  machine — it stays quiet while there's headroom — and on by default. Settings
  (⚙ → Memory) gains the toggle plus a live readout of Flux's RSS and free RAM.
- **Sleeping tabs keep their scroll position + form input** (BACKLOG #45).
  Switching away from a tab snapshots its scroll offset and non-password form
  fields (text/select/checkbox/radio) into a **RAM-only** store; when the tab
  later wakes and reloads, Flux re-applies them once (matched to the same URL).
  **Password fields are never captured** and nothing is written to disk.
  (_Follow-up left:_ memory-pressure-based eviction.)
- **Vault master password + auto-lock** (BACKLOG #61, ADR 0009). Optional
  hardening that seals the vault even from the logged-in OS user. Setting a
  master password derives an **Argon2id** key (19 MiB / t=2) that wraps the data
  key on disk (`keywrap.json`) and **removes the key from the OS keychain**, so
  the data key is recoverable only with the password. The vault then boots
  **locked**; `vault_unlock` decrypts it into memory, **idle auto-lock**
  (configurable Off/1/5/15/30 min) and a "Lock now" button clear the decrypted
  vault + key from memory, and the master password can be changed or removed
  (which moves the key back to the keychain). The 🔑 footer button shows 🔒 +
  an unlock prompt when locked, and a Security section manages it all. Argon2id
  wrap/unwrap is unit-tested. (Default stays keychain-mode — no password — so
  nothing changes unless you opt in.)
- **Password manager + autofill** (BACKLOG #61, ADR 0009). A local-first vault
  with a **Proton Pass importer** — since Proton Pass ships only a WebExtension
  (which can't run in native webviews) and has no public API, Flux owns the data
  and autofills via injection.
  - New `flux-vault` crate: credential model, **AES-256-GCM** seal/open (random
    nonce per write, decrypted plaintext in `Zeroizing` buffers), conservative
    host matching, and a **Proton Pass importer** for every format Proton
    actually exports — **CSV**, **ZIP** (JSON/CSV inside), **PGP-encrypted**
    (decrypted with a passphrase via the pure-rust `pgp` crate), and raw JSON;
    format auto-detected from magic bytes + filename. The JSON/CSV parsers
    tolerate Proton's schema quirks (the `username` vs `itemUsername`/`itemEmail`
    split, header-name column mapping), skip trashed + non-login items, and
    dedupe. Unit-tested (incl. a real gpg-made PGP fixture).
  - **OS-keychain data key** (`keyring`: Windows Credential Manager, macOS
    Keychain, Linux Secret Service) with a file-backed fallback when no store is
    available; the encrypted vault lives at `app_data/vault/vault.bin`.
  - **Autofill** (`vault_fill`): fills the active page's login form on explicit
    user action, **same-origin enforced**, injected straight into the page — the
    password never passes through the chrome's JS.
  - **Vault UI**: a footer 🔑 popover — lists logins (matches for the current
    site float to the top with a **Fill** button), copy/reveal/delete, **Import
    from Proton Pass** (point it at the `.csv`/`.zip`/`.pgp`/`.json` export — a
    passphrase field appears for `.pgp`), and add a login.
  - ADR 0009 sets the security model (threat model, local-first/no auto-sync,
    same-origin user-initiated autofill, passkeys left to the native webview,
    future master-password option). _Follow-ups:_ save-password prompt on login,
    Chrome/1Password/Bitwarden importers, optional master password + auto-lock.

### Fixed
- **Shields popover clipped by the sidebar.** The footer popovers (shields,
  bookmarks, extensions, settings) carried fixed min-widths (226–300px) wider
  than the narrow sidebar, so they overflowed — clipped by the sidebar's
  `overflow:hidden` and, worse, the overflow fell *behind* the native webview
  (a separate OS layer over the content card). They now anchor to the sidebar
  footer and span its width with small side margins (`.footer-pop`), so the box
  always fits and is fully visible without widening the sidebar.

### Changed
- **Bounded the per-tab DOM snapshot cache** (BACKLOG #79 — RAM). Each tab's
  captured page (`dom_publish`) is now capped at 1 MiB of HTML + 256 KiB of
  text before caching. A page's outerHTML is often several MB; cached across
  many open tabs that was the dominant chunk of Flux-controlled heap. The caps
  are generous for the real consumers (agent, embedder, `flux extract-json`),
  turning unbounded growth into O(tabs × cap).

### Added
- **Find-in-page** (BACKLOG #33) — `Ctrl+F` opens a find bar. Typing drives the
  engine's native `window.find()` (works on both the Chromium-based WebView2 and
  WebKitGTK) to highlight + scroll to matches; Enter / Shift+Enter (and the
  ‹ › buttons) step forward/back, and a case-insensitive **match count** is
  reported back to the bar over a new `find_result` event. Esc closes it. Like
  the loading bar, the find bar lives in the sidebar — the native webview is a
  separate OS layer over the content card. (Follow-up: precise current/total
  index + highlight-all; `window.find` only gives a single native highlight.)
- **Navigation polish** (BACKLOG #31) — **stop** (a `webview_stop` command;
  the reload button becomes ✕ while a page loads, and `Esc` stops the active
  tab), per-tab **loading state** driven by the page-load events, a
  **security/TLS badge** left of the omnibox (🔒 for HTTPS, ⚠ for plain HTTP),
  and an indeterminate **loading bar** under the omnibox. (The progress bar
  lives in the sidebar, not the content card: the native webview is a separate
  OS layer that overlays the card and would hide an in-card bar.)
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
