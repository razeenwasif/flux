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

## Flux Agent (local AI)

The agent runs a local **Gemma** model via **Ollama** (ADR 0005) — no cloud, no
token cost. Pull a model and start Ollama:

```sh
ollama pull gemma4:12b-it-qat   # or e4b-it-qat (faster) / e2b-it-qat (fastest)
ollama serve                    # http://localhost:11434
```

The sidebar is **chat-first**: talk to Gemma about anything, with no page
required (if a page is open, its text is added as context so you can ask about
it). To make it **act on the page**, prefix with **`/act`** — e.g. *"/act find
the unsubscribe link and click it"*: the agent reads the page DOM, the model
returns a structured action, and Flux compiles it to injection-safe JS run in
the tab. Config via env: `FLUX_MODEL` (default `gemma4:12b-it-qat`),
`FLUX_OLLAMA_URL` (default `http://localhost:11434`), or
`FLUX_AGENT_BACKEND=mock` to run the pipeline without a model.

## Terminal

A real, usable dev terminal (ADR 0003): a Rust PTY (`portable-pty`) running your
`$SHELL` with the `FLUX_TAB_*` context env, rendered by xterm.js. Open it as the
**vertical column** (the persistent dev shell, ⌨ in the sidebar footer) or as a
**Terminal tab** (the new-tab picker). xterm is lazy-loaded so it never weighs
down the browser chrome.

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
⇧. Multi-select (click / ⌘-click / ⇧-click / ⌘A), a right-click context menu,
and a confirm dialog on every destructive op. The listing **watches the
directory** and updates itself on external changes (no manual refresh), and
reversible ops are **undoable** with ⌘/Ctrl-Z (rename/move/trash → restore).
Next: marquee selection + native drag-out — see `BACKLOG.md` #90.

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
