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
plan → approve → execute → re-plan across pages.) Config via env: `FLUX_MODEL`
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

## Terminal

A real, usable dev terminal (ADR 0003): a Rust PTY (`portable-pty`) running your
`$SHELL` (WSL by default on Windows; `FLUX_SHELL` overrides) with the
`FLUX_TAB_*` context env, rendered by xterm.js. Open it as the **vertical
column** (the persistent dev shell, ⌨ in the sidebar footer) or as a **Terminal
tab** (the new-tab picker). xterm is lazy-loaded so it never weighs down the
browser chrome. Terminal tabs are kept alive across tab switches (the shell
keeps running when you switch away).

**Persist sessions across closing Flux** — set `FLUX_TERM_PERSIST=1` and each
terminal runs inside a per-tab `tmux` session (`flux-<tab-id>`, attach-or-create).
tmux's server lives outside Flux, so closing Flux detaches and reopening
re-attaches the *live* session (running processes + scrollback intact). Requires
`tmux` in your WSL distro / on Unix (falls back to a plain shell otherwise);
survives Flux restarts but not a `wsl --shutdown` or reboot.

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
