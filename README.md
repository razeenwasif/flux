# Flux

**An AI-native browser with a built-in GPU terminal and a fully local agent.**

Rust + Tauri v2 core · native OS webviews · SolidJS chrome · WGPU terminal ·
llama.cpp (Gemma-class 12B) on-device inference. See
[ADR 0001](docs/adr/0001-architecture-and-performance-budgets.md) for the
architecture rationale and the CI-enforced performance budgets.

## Monorepo layout

```
flux/
├── Cargo.toml                 # Rust workspace root (profiles, shared deps)
├── package.json               # npm workspace root (Tauri CLI, scripts)
├── BACKLOG.md                 # stable-numbered unimplemented work (code refs: BACKLOG #n)
├── CHANGELOG.md               # Keep-a-Changelog; updated in the same commit as code
├── docs/adr/                  # Architecture Decision Records (0001 perf, 0002 UI)
├── apps/
│   └── shell/                 # SolidJS chrome (Arc-style vertical sidebar shell)
└── crates/
    ├── flux-core/             # Tauri daemon: windows, FluxState, zero-copy IPC, CLI entry
    ├── flux-term/             # WGPU terminal (vte grid + instanced renderer)
    ├── flux-agent/            # Local LLM planner → structured DOM actions → JS
    ├── flux-embed/            # Embeddings + greedy clustering for tab groups
    ├── flux-import/           # Chrome import: bookmarks, extension inventory
    └── flux-search/           # Pluggable search backend: engines + URL resolution
```

## Setup

```sh
# 1. Toolchains: Rust ≥ 1.80, Node ≥ 20.
#    Linux additionally needs the Tauri webview deps:
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev

# 2. JS deps (npm workspaces — installs the shell + Tauri CLI)
npm install

# 3. Dev loop: vite + cargo, hot-reload on both sides
npm run dev

# 4. Checks (what CI runs)
cargo test --workspace            # grid/agent/embed unit tests
cargo check --workspace
npm run typecheck --workspace apps/shell

# 5. Release build (LTO, ~10–15 MB binary)
npm run build
```

> **Platform note — don't develop browsing under WSL2.** Launching Flux from
> WSL2 builds a **Linux/WebKitGTK** app (shown via WSLg), even on a Windows
> host. Tauri's multi-webview child positioning — how Flux places each tab's
> page over the content card — is **not reliable on WebKitGTK**: pages render
> mispositioned (stacked at the window bottom). The chrome, terminal, start
> page, search, drag, and resize all work under WSL2, but **per-tab web pages
> need WebView2 (Windows) or WKWebView (macOS)**. For real browsing, build and
> run Flux **natively on Windows/macOS** with that OS's Rust + Node toolchain.

## Mobile — Android (ADR 0012)

### Native APK (recommended) — build here, install on the phone

Flux builds a real installable `.apk` via **Tauri v2 mobile**. It cross-compiles
on your desktop/WSL2 box — the phone never compiles anything, it just downloads
and installs. One command:

```sh
# on the dev box (Linux/WSL2), after the one-time toolchain setup below
bash scripts/build-apk.sh          # → flux-arm64.apk (debug, sideloadable)
adb install -r flux-arm64.apk      # or copy the .apk to the phone and tap it
```

One-time toolchain (no root needed): Android SDK + NDK r27 under `~/Android`, the
Rust android targets (`rustup target add aarch64-linux-android …`), cargo-tauri
v2 (`cargo install tauri-cli --version '^2'`), and a portable Temurin JDK under
`~/jdk` (Gradle needs `javac` — untar the tarball from adoptium.net). The build
script resolves all of these and scaffolds the Gradle project on first run.

Milestone 1 (done): the APK boots the full chrome and every internal page
(Notebook, Trail, whiteboard, Settings). In-tab web browsing (a single system
WebView) and the on-device llama.cpp agent are the next milestones — the desktop
multi-webview/terminal/peek layers are `#[cfg(mobile)]` stubs for now.

### Termux/proot (alternative — dev-grade, no cross-build machine needed)

Flux also runs as its *Linux* build inside **Termux + proot-distro + termux-x11**,
built on the phone itself (slower, WebKitGTK class like WSL2). One script sets up
both layers and installs a launcher:

```sh
# inside Termux (install the Termux + Termux:X11 apps from F-Droid first)
pkg install git && git clone https://github.com/razeenwasif/flux && bash flux/scripts/install-termux.sh
flux-mobile         # then open the Termux:X11 app
```

The chrome starts collapsed on narrow screens and grows its touch targets on
touchscreens either way.

## Install (`flux` on your PATH)

Package Flux into a self-contained binary (the SolidJS frontend is embedded at
build time) and install it so `flux` launches from any directory.

**Linux / WSL** — installs to `~/.cargo/bin/flux`:

```sh
scripts/install-linux.sh
```

**Windows** (the WebView2 build — required for real browsing) — installs to
`%USERPROFILE%\.cargo\bin\flux.exe`:

```powershell
# from the repo root, in PowerShell
scripts\install-windows.ps1                # rebuilds the frontend + binary (default)
scripts\install-windows.ps1 -SkipFrontend  # reuse an existing apps\shell\dist (e.g. built under WSL)
```

The Windows script checks prerequisites first. The one most often missing is the
**MSVC C++ build tools** (`link.exe`) — installing only the Windows SDK is *not*
enough. Install the "Desktop development with C++" workload:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

You also need the **WebView2 Runtime** (preinstalled on current Win10/11; else
`winget install Microsoft.EdgeWebView2Runtime`). If the repo lives on the WSL
filesystem, building over the `\\wsl.localhost\...` share works but is slow —
copy it to a local Windows path (e.g. `C:\src\Flux`) for a faster build.

**macOS** (native WKWebView — real browsing works) — installs **both**
`/Applications/Flux.app` (the icon'd, double-clickable app) and `~/.cargo/bin/flux`
(the CLI):

```sh
scripts/install-macos.sh
```

Prerequisites the script checks for: the **Xcode Command Line Tools**
(`xcode-select --install`), **Rust ≥ 1.80** (rustup), and **Node.js** (`brew
install node`). No WebView runtime to install — WKWebView is built into macOS. It
runs `tauri build`, which produces the `.app`/`.dmg` bundle *and* the `flux`
binary in one pass, then copies the app to `/Applications` and the binary to
`~/.cargo/bin`, clearing the Gatekeeper quarantine flag on the local build.
Caveat: Shields' network-level blocking, HTTPS-only, and the download interceptor
are no-ops on macOS (those hooks are Windows/WebView2 + Linux/WebKitGTK only);
cosmetic element-hiding still works.

Then, on any platform:

```sh
flux                       # start page
flux example.com           # open a tab
flux -t                    # open with a terminal tab focused
flux --help
```

### Terminal apps (TUI bar)

Flux's TUI bar launches your terminal apps (Onyx, Scroll, Council, AudioPulse,
…) in a one-click Terminal tab. The chip list is seeded automatically, but the
binaries are separate projects. On a fresh machine, install them all with:

```sh
./tools/setup-tui-apps.sh           # clone (or pull) + build everything
./tools/setup-tui-apps.sh onyx kata # just these
```

It reads `tools/tui-apps.json` (each app's repo + build command) and installs
the binaries onto your PATH. Edit that manifest to add/adjust apps; apps without
a `repo` are local-only and need a git remote (or a manual copy) to travel.

## UI / UX

The shell follows an **Arc-style vertical layout** (ADR 0002) with a
**Royal Velvet × Liquid Glass** aesthetic: a left sidebar owns navigation
(collapsible to an icon rail), the active tab floats in a rounded content card,
the terminal is a **vertical right-side column**, and the Flux Agent docks far
right — all frosted-glass panels over a deep velvet gradient.

**Themes** (Settings → Appearance, ADR 0015): **Velvet** (deep navy-plum, teal
and amethyst) and **Ember** (oxblood, rose and ember orange). A theme is five
base tones plus six role-named RGB channels in `theme.css` — `--accent-rgb` is
"the primary interactive colour", whatever hue that is in a given theme — and
everything downstream resolves through them, including the WebGL shaders, the
Trail/Omni canvases and the terminal palette. Adding one is ~20 lines; adding a
hardcoded colour anywhere is how you break the other theme silently.

**Columns.** Left to right: sidebar, content card, web panel, the **launcher
column** (Flux's own pages over your terminal apps — icon-only, names on hover),
calendar + mail, the shared agent/terminal stack, and the connections rail
(related notes, a system monitor, and the Trail). Each is independently
toggleable, and when the window gets narrow they're shed in priority order
rather than squeezing the page. The sidebar's toolbar and footer fold away when
you want the height for tabs, and stay folded when the sidebar collapses to its
icon rail; workspaces live behind the footer's ▤ button.

To iterate on the UI without a Rust runtime, run the mocked preview and open
`http://localhost:8847`:

```sh
npm run preview:ui --workspace apps/shell
```

## Start page

New tabs open a glassmorphic dashboard (`flux://start`): a central search hero
(routed through the pluggable backend), a live clock, recent tabs, a quick-link
speed dial, and quick actions. It's `apps/shell/src/StartPage.tsx`; a fully
user-owned/scriptable start page with custom widgets is the rest of BACKLOG #71.

## Browsing

Browser tabs render real web pages: each is a native child webview (Tauri
multiwebview) positioned over the floating content card and kept in sync with
it as the layout changes. The address bar navigates the active tab; back /
forward / reload work. Omnibox suggestions, loading/security state, and a
pluggable search backend are on the roadmap (BACKLOG #31/#32/#68). DOM capture
for the agent/terminal (#5) is wired client-side but gated by a Tauri remote-
content security boundary — see BACKLOG #5.

## PDFs (`flux://pdf`)

PDFs open in Flux's own viewer rather than a download, so they render the same
on both engines and the agent can read them. Bytes come from the Rust core, so
there's no CORS to fight.

**Reading.** `⟨ n / N ⟩` in the toolbar jumps to a page — type a number and press
Enter, or step with the arrows. `Ctrl`+wheel and `Ctrl`+`=`/`-`/`0` zoom the
**document** (they're intercepted, so they never scale the Flux window), and
zooming keeps your place instead of snapping to the top. Where you were, how far
you'd zoomed, your bookmarks and your comments are remembered per file — leaving
the tab, closing it, or restarting Flux all bring you back to the same page.

**Notes** (🔖 tab) holds **bookmarks** and per-page **comments**. These are kept
by Flux and are *never* written into the PDF — nothing there dirties the file or
changes what you'd hand to someone else. They're stored on this machine and keyed
to the file's path, so moving the file loses them.

**Editing** (✎ Edit) is the other half and behaves the opposite way: highlight,
pen, text, shapes and arrows are **burned into the bytes** by `Save`, which
writes an edited copy to Downloads. ▦ Pages reorders, rotates, deletes, extracts
and merges; 🖊 Forms fills AcroForm fields in place, with an optional flatten on
save.

**Scanned PDFs** have no text layer, so the agent would otherwise see an empty
document. Ask her to read one and she runs OCR herself (up to 40 pages; longer
scans stay a deliberate act you start from the viewer). The viewer detects the
same thing, says so, and offers **Read with OCR** if a local `tesseract` binary
is installed — recognised text is indexed under its own
`pdf-ocr` source so every citation carries that a machine read it off an image.

## Search

The omnibox runs through a **pluggable search backend** (`flux-search`). Engines
are pure data — a URL template with `{query}`, an optional suggest endpoint, and
an optional keyword — so hooking up your **own** search engine is a config
change, not a code change. Seeded with DuckDuckGo (default), Google, and Bing;
typing routes by `!bang`/keyword (`!g rust`, `g rust`) or falls back to the
default, and anything that looks like a URL/host navigates directly.

To make your engine the default (e.g. once your own search service is live):

```ts
import { searchAddEngine, searchSetDefault } from "./ipc";

await searchAddEngine({
  id: "flux",
  name: "Flux Search",
  keyword: "f",
  search_template: "https://search.example.com/?q={query}",
  suggest_template: "https://search.example.com/ac?q={query}", // optional (BACKLOG #32)
});
await searchSetDefault("flux");
```

The config persists to `search.json` in the app config dir, so you can also edit
it there directly. Live typeahead suggestions (using `suggest_template`) are the
omnibox-suggestions work in BACKLOG #32.

### `flux://omni` — index dashboard

If your engine is the [Omni](https://github.com) index, **`flux://omni`** (from
the omnibox or the start-page "Omni index" quick action) is a native velvet/glass
view of its live health: stat cards (live docs, segments, embeddings, ANN),
per-segment fill bars, an essential-sites grid, and the PageRank authority list,
auto-refreshed every 2.5s. It reads Omni's `/stats` through a Rust proxy
(`omni_stats`) so the shell CSP doesn't block it; the base URL follows your
default engine (`FLUX_OMNI_URL` overrides).

## Flux Agent (local AI)

The agent runs a local **Gemma** model via **Ollama** (ADR 0005) — no cloud, no
token cost. Pull a model and start Ollama:

```sh
ollama pull gemma4:12b-it-qat   # or e4b-it-qat (faster) / e2b-it-qat (fastest)
ollama serve                    # http://localhost:11434
```

The sidebar is **chat-first**: talk to Gemma about anything, with no page
required (if a page is open, its text is added as context so you can ask about
it). Replies **stream in token-by-token** as the model generates them. To make
it **act on the page**, prefix with **`/act`** — e.g. *"/act find the
unsubscribe link and click it"*: the agent reads the page DOM, the model returns
a **JSON-Schema-constrained** structured action, and Flux compiles it to
injection-safe JS run in the tab. (**`/task <goal>`** runs the multi-step loop:
plan → approve → execute → re-plan across pages.)

**Asking for work in plain words is enough** — you don't have to know a slash
command exists. *"In `~/Courses/Optimization/slides/` you'll find some lecture
PDFs; go through all of them and summarise them into my Optimization notebook"*
runs as a multi-step task: it lists the folder, reads each PDF (real text, page
by page — a scan needs OCR first), and drafts the note. One step at a time, each
visible, and **every step that changes anything stops for approval**: commands
get a Run card, edits get a diff, notes show the exact text. Questions stay
questions — *"what's in that folder?"* is answered, not executed.

The loop's tools are `list <dir>`, `read <path>`, `edit <path>: <change>`,
`run <cmd>`, `search <query>` and `note <what to add>`. **`/fix <goal>`** is the
same loop invoked explicitly (*"/fix make the tests in src/foo.rs pass"* → run →
read the failure → edit → re-run).

**Named places.** You don't have to give her paths. `onyx`, `scribe`,
`downloads` and `home` resolve to the real directories, and your Onyx vault's
folders are known by name — so *"summarise these into onyx under
00 - Optimization"* is enough, in chat and in the agent's file tools alike
(`list onyx`, `read onyx/00 - Optimization/duality.md`). They're resolved fresh
each time, so changing your vault path in Settings takes effect immediately.

She can also **write to your notes** (ADR 0016) — ask in plain words (*"save
this into my Convex notebook"*) or use **`/note <what to add>`**. You see the
exact text on a card and approve it before anything is written. She can only
**add**: the action vocabulary has no variant that replaces, rewrites or deletes,
so a model that decides your notes would read better rewritten has no way to say
so, and neither does a prompt injection buried in a page. Config via env: `FLUX_MODEL`
(default `gemma4:12b-it-qat`),
`FLUX_OLLAMA_URL` (default `http://localhost:11434`), or
`FLUX_AGENT_BACKEND=mock` to run the pipeline without a model.

## Research OS — the Trail (in progress)

Flux is growing from a browser into an **external scientific memory**: a local,
private *co-scientist* that turns what you read into a personal knowledge graph.
It builds on the **Knowledge Base** (ADR 0010 — cited retrieval over your own
corpora: Onyx notes, Scroll papers, Council briefs) by making *browsing itself* a
native, cited source.

The foundation is a **provenance spine** (ADR 0011): every page becomes a
**Visit** — url, title, *why* you got there (the page you came from = a free
navigation edge, plus the search query and active workspace), the captured
content, highlights/notes, and an AI conversation attached to that page. Graph,
time-travel ("what did my workspace look like Tuesday?"), per-page chat that
survives months, and context search ("the page with the CUDA error") are all
*views over that one object* rather than separate features.

Privacy is designed in, not bolted on: **private windows are never recorded**,
typed-draft capture is off by default with structural redaction (a half-typed
password can't be stored), and `trace_forget` drops a page, site, or time range.
Capture is lazy — a cheap Visit on navigation, content snapshot + embed only
after you actually *dwell* on a page, idle-scheduled so the browser never
stalls. Everything stays local; the spine is never a network source. Vertical
slice in progress — see `docs/adr/0011-browsing-provenance-spine.md`.

## Scribe — handwritten course notebooks (ADR 0014)

`flux://scribe`. Per-course notebooks of pages you write on: a real document
editor with ink inserted as objects, not a drawing surface with text boxes.

- **Equations** — `Σ Equation`, `Ctrl+M`, or just type `$$x^2$$` mid-sentence.
  The LaTeX lives in the node's `data-tex`, so it survives editing, indexes as
  LaTeX (not as KaTeX's rendered glyph soup), and Gemma writes the same node.
- **Transcription** — handwritten pages are read by the local vision model into
  text + LaTeX under their own `scribe-ocr` KB source, so a citation always
  carries that a machine read it.
- **Publish to Onyx** — a page becomes a markdown note with the ink embedded as
  a PNG, in the course's vault folder.

Notebooks live one JSON file per notebook, in `<app-data>/scribe/`.

## Sync (ADR 0017)

No server and no account: Flux syncs through **a folder you already replicate**
(Syncthing, Dropbox, iCloud Drive, a USB stick). Two transports, chosen by what
the content is:

| What | How |
|---|---|
| Bookmarks, sessions, history, tasks, calendars | one AES-256-GCM blob (`flux-sync.enc`) in the folder |
| Onyx vault, Scribe notebooks | plaintext files — point the sync tool at them directly |

Set it up at **`flux://sync`**: choose the folder, set a passphrase (the same one
on every device), unlock, turn on auto-sync. The key is derived with Argon2id
from your passphrase *and a salt stored in the blob*, so every device deriving
from the same passphrase gets the same key — and whatever replicates the folder
only ever sees ciphertext. The **password vault is never synced.**

Merges are additive with deletion tombstones, keyed by content rather than id
(ids are per-device counters): a task by list+title, a session tab by workspace
*name*, a Scribe page by page id. Restoring a session rebuilds its workspaces.

> **Set up the second device only after the first device's `flux-sync.enc` has
> arrived.** Unlocking into an empty folder mints a *new* salt, so the same
> passphrase yields a different key and the two devices can never read each
> other. Flux warns when it does this, but the fix is to wait for the file.

## Terminal

A real, usable dev terminal (ADR 0003): a Rust PTY (`portable-pty`) running your
`$SHELL` (WSL by default on Windows; `FLUX_SHELL` overrides) with the
`FLUX_TAB_*` context env, rendered by xterm.js. Open it as the **vertical
column** (the persistent dev shell, ⌨ in the sidebar footer) or as a **Terminal
tab** (the new-tab picker). xterm is lazy-loaded so it never weighs down the
browser chrome. Terminal tabs are kept alive across tab switches (the shell
keeps running when you switch away).

**Persist sessions across closing Flux** — Settings → Terminal → *Keep sessions
across restarts*. Off by default. Two independent halves, because they fix
different things and neither covers the other:

| Mode | What survives | How |
| --- | --- | --- |
| **Running processes** | the shell and its children | the shell is handed to `dtach` (preferred) or `tmux`, whose master outlives Flux, so closing detaches and reopening re-attaches |
| **Scrollback** | what was on screen | output is recorded to a capped file (256 KB/session, under Flux's data dir) and replayed on reopen |
| **Both** | both | the recommended pairing |

Why the pair: a broker keeps your `npm run dev` alive but **dtach restores no
earlier output** — it asks the program to redraw, so a shell comes back with a
bare prompt. And a broker dies with the machine, so neither tmux nor dtach
survives `wsl --shutdown` or a reboot. Scrollback needs nothing installed, works
on native Windows, and survives a crash *and* a reboot — but the processes are
gone. Together you get the running work and the history.

`dtach` is preferred over `tmux` because it does only this one thing (~50 KB, no
config, no prefix key) and, since xterm.js is already the terminal emulator,
avoids running the screen through tmux's emulation a second time. Install either
in your WSL distro / on Unix (`apt install dtach`); with neither present the live
half falls back to a plain shell and the scrollback half still works. Force one
with `FLUX_TERM_ENGINE=dtach|tmux`.

`FLUX_TERM_PERSIST` still works as an override for scripted runs and accepts
`off` / `live` / `transcript` / `both` (`1` remains a synonym for `live`).

⚠ **Scrollback writes terminal output to disk**, including anything a command
prints — keys echoed by a careless script, tokens in a log line. That's why it's
off by default and why an explicit tab close deletes that session's file.

## Troubleshooting

**Read the log first.** Release builds on Windows have no console, so this file is
the only place Flux's output appears — including confirmation that a diagnostic
environment variable actually took effect:

```powershell
Get-Content "$env:LOCALAPPDATA\dev.flux.browser\flux.log" -Tail 40
```

**A page dies with `STATUS_ACCESS_VIOLATION` (Windows).** That's the WebView2
renderer crashing. It can be provoked by what Flux injects into the page, so start
there — that's where the one real instance of this turned out to be.

The examples are PowerShell. Set the variable as its own statement (there is no
`VAR=value command` form) and launch Flux from that same window, or it won't reach
the process. Check the log line each time before trusting a result.

1. **Rule out Flux's page scripts** — the highest-yield step. `none` injects
   nothing; a comma-separated list injects only those named, so ten scripts
   bisect in three or four runs. Diagnostic only: it disables real features while
   set, and says so in the log.

   ```powershell
   $env:FLUX_PAGE_SCRIPTS = "none"
   flux
   ```

   If the page loads, halve the list until one name reproduces it
   (`"capture,shortcuts,hibernate,darkmode,nav"`, then narrow).

2. **Compare against Edge**, which is the same engine. If Edge crashes too, it's
   the runtime rather than Flux: `winget install Microsoft.EdgeWebView2Runtime`.
   Check both versions match — they update independently.

3. **Try a private tab.** Private tabs use an in-memory session, so if the page
   loads there and not otherwise, the trigger depends on stored state or on being
   signed in. That narrows it, but note it does *not* prove the profile is corrupt
   — a signed-in page is a different page.

4. **Rule out the GPU** — the standard WebView2 access-violation workaround. A fix
   here points at the graphics driver.

   ```powershell
   $env:FLUX_WEBVIEW2_ARGS = "--disable-gpu"
   flux
   ```

5. **Rule out HTTP/3** (`$env:FLUX_NO_QUIC = "1"`, which passes `--disable-quic` —
   omitting `--enable-quic` isn't enough, since H3 is the WebView2 default) and
   **Shields** for that site (Settings → Privacy & security).

6. **Capture the crash dump.** WebView2 writes Crashpad reports under
   `%LOCALAPPDATA%\dev.flux.browser\EBWebView\Crashpad\reports`, but uploads and
   deletes them within a few minutes — copy one out promptly. The exception record
   and module list name the faulting module, which beats guessing.

**Browsing data has grown large.** Settings → Browsing data → *Measure* shows what
the engine keeps on disk by group, and clears what you select on the next launch.
Nothing evicts these stores on a schedule, so a service-worker cache can reach
hundreds of megabytes. This is housekeeping — an oversized store has not been
shown to break anything.

## Files

A native filesystem explorer, opened as a 📁 **Files tab** from the new-tab
picker (ADR 0006). Rendered in the content card (no webview), backed by
`std::fs` in `flux-core::files`. It's built for speed and the velvet/glass
feel: a **virtualized** columned list (only visible rows hit the DOM — a
10k-entry directory scrolls smoothly), a quick-access rail (home,
Desktop/Documents/Downloads, drive roots), breadcrumb + back/forward/up nav,
live filter, sort (name/size/modified, folders-first), a hidden-file toggle,
and full keyboard nav. The listing call runs off the main thread and returns
compact entries, so even huge directories never block the UI. On Windows the
rail also lists installed **WSL distributions** (a "Linux" section, opened at
`\\wsl.localhost\<distro>`).

**File operations:** new folder/file (inline-named), rename (F2), copy/cut/
paste (⌘/Ctrl-C/X/V), drag-to-move (onto folders, the rail, or breadcrumbs),
and delete — to the **OS trash** by default (recoverable) or permanent with
⇧. Multi-select (click / ⌘-click / ⇧-click / ⌘A, or **marquee** drag on empty
space), a right-click context menu, and a confirm dialog on every destructive
op. The listing **watches the directory** and updates itself on external
changes (no manual refresh), and reversible ops are **undoable** with ⌘/Ctrl-Z
(rename/move/trash → restore).

## Code style

Formatting and lints are pinned, mechanical, and CI-checkable — no style debates:

```sh
cargo fmt --all                      # Rust: default rustfmt, no custom config
cargo clippy --workspace --all-targets   # zero warnings is the bar ([workspace.lints])
npx prettier --write "apps/shell/src/**/*.{ts,tsx,css}"   # frontend (.prettierrc.json)
```

Escapes are per-site `#[allow(...)]` with a reason comment, never a blanket
toggle. The two mechanical adopt-the-formatter commits are listed in
`.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`
keeps `git blame` useful). `apps/shell/src/bindings.gen.ts` is generated
(specta) and excluded from formatting — the drift test byte-compares it.

## Roadmap

`BACKLOG.md` carries the full feature roadmap — table-stakes browser features,
best-in-class power features (split view, spaces, tab hibernation, web panels,
boosts…), privacy/security, and Flux's under-served wedge (local-AI agentic
browsing, the DOM-aware terminal, semantic search, a pluggable custom search
backend). Each item is stable-numbered and referenced from code as `BACKLOG #n`.

## Launching from a terminal

Install the `flux` binary onto your PATH once:

```sh
cargo install --path crates/flux-core
```

Then from any shell:

```sh
flux                          # open Flux with the start page
flux example.com https://b.dev   # one browser tab per URL (https:// inferred)
flux -t                       # open with a terminal tab focused
flux --help | flux --version  # never spawns a window
```

A second invocation while Flux is running currently starts a second instance;
forwarding into the running window is BACKLOG #20. Desktop entry / packaging
is BACKLOG #26.

## App icon

The master artwork is `assets/brand/flux-icon.svg` — a DeepMind-inspired
spiral vortex: three logarithmic-spiral arms (teal→royal→magenta) swirling into
a glowing core on the velvet squircle. Because the local ImageMagick SVG
delegate can't render gradients/glow, rasterize with **headless Chromium**, then
regenerate the platform icons:

```sh
# tune spiral params in the generator, which writes the SVG + an HTML wrapper
python3 assets/brand/flux_logo_gen.py
chrome --headless --screenshot=assets/brand/icon-1024.png --window-size=1024,1024 \
       --default-background-color=00000000 /tmp/flux-icon.html
npx tauri icon assets/brand/icon-1024.png -o crates/flux-core/icons
rm -rf crates/flux-core/icons/{android,ios}   # desktop only
```

## Importing from Chrome

`chrome_import_preview` discovers profiles and reports counts;
`chrome_import_bookmarks` imports the full bookmark tree (folder paths
preserved). Extensions are *inventoried* (they cannot execute in native
webviews — see BACKLOG #24 for the equivalents story); saved tab groups are
detected, import tracked in BACKLOG #23.

## Feature flags

| Flag | Crate | Effect |
|---|---|---|
| `llama` | flux-core / flux-agent | Real llama.cpp inference (needs a GGUF in `models/`, see `FLUX_MODEL_PATH`). Default: deterministic `MockBackend`. |
| `gpu` | flux-term | WGPU renderer. Default off so headless CI checks the grid/parser logic. |
| `model` | flux-embed | EmbeddingGemma-class embedder. Default: hashing embedder. |
| `voice` | flux-core | Push-to-talk + "Hey Gemma" STT via Vosk. Builds without linking to Vosk; at runtime Flux loads `libvosk.dll`/`libvosk.so` from `PATH`, `FLUX_VOSK_LIBRARY`, `FLUX_VOSK_LIB_DIR`, or next to the configured model. `FLUX_VOSK_MODEL` points at a model dir. Default: the 🎤 returns a "not built" stub. |

**Gemma's voice (TTS)** needs no cargo feature. By default Flux speaks with the
webview's `speechSynthesis` (OS voices). For a higher-quality local neural voice,
install [Piper](https://github.com/rhasspy/piper) and set `FLUX_PIPER_MODEL` to a
`.onnx` voice (its `.onnx.json` config must sit beside it; `FLUX_PIPER_BIN` if
`piper` isn't on `PATH`), then pick **Piper** under Settings → Integrations. If
Piper is missing, Flux silently falls back to the system voice. Nothing about the
voice loop touches the network.

**More accurate recognition (Whisper)** is also no-cargo-feature. Vosk handles the
wake word and (by default) the command. For higher accuracy, install
[whisper.cpp](https://github.com/ggerganov/whisper.cpp), set `FLUX_WHISPER_MODEL`
to a ggml model (e.g. `ggml-base.en.bin`; `FLUX_WHISPER_BIN` if `whisper-cli` isn't
on `PATH`), and pick **Whisper** under Settings → Integrations → Recognition. It
runs locally on the command utterance and falls back to Vosk if absent.

**Dedicated wake word (Porcupine)** is optional. By default "hey Gemma" is detected
by Vosk. For far fewer false triggers, pick **Porcupine** under Settings →
Integrations → Wake word: it needs a free [Picovoice](https://console.picovoice.ai)
access key (kept in the OS keyring), a custom `Hey Gemma` `.ppn` you generate on
their console (Web/WASM platform), and `porcupine_params.pv` from the Picovoice
GitHub. Detection runs locally in the browser; if unconfigured it falls back to Vosk.

On Windows, install a voice-enabled `flux.exe` onto PATH with:

```powershell
.\scripts\install-windows.ps1 -Voice
```
