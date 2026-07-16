# ADR 0001 — Core Architecture: Rust + Tauri v2 over Electron / Chromium Fork

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Deciders** | Flux Core Team |
| **Supersedes** | — |

## Context

Flux is an AI-native desktop browser that embeds (a) a GPU-accelerated terminal
emulator and (b) a fully local LLM agent (Gemma-class, ~12B params) into the
browsing surface. The local model alone will claim **8–10 GB of unified
memory/VRAM** at 4-bit quantization. Every megabyte and every millisecond the
*shell* wastes is budget stolen from inference and from the user's tabs.

Three architectures were evaluated:

1. **Electron** (Chromium + Node.js bundled)
2. **Chromium fork** (Brave/Arc model — patch and ship the full engine)
3. **Rust + Tauri v2** (native OS webviews: WebView2 / WKWebView / WebKitGTK)

## Decision

**Rust + Tauri v2.** Rust owns all heavy lifting — window management, the
terminal emulator, LLM inference, embeddings, background I/O — on native
threads. The UI chrome is SolidJS rendered inside the platform webview. Web
content itself is rendered by per-tab child webviews managed from Rust.

### Why not Electron

| Dimension | Electron | Tauri v2 (Flux) |
|---|---|---|
| Shipped binary | 180–250 MB (full Chromium + Node) | **~8–15 MB** (engine is OS-provided) |
| Idle RAM (empty shell) | 250–400 MB across ≥4 mandatory processes | **< 80 MB** single Rust process + webview |
| IPC | `ipcRenderer` → structured-clone → JSON over pipe; every DOM snapshot is serialized **twice** | Tauri v2 raw-body IPC: `ArrayBuffer` in, `tauri::ipc::Response` out — **no JSON encode/decode on the hot path** |
| Background compute | Node.js event loop or worker_threads (still V8, still GC pauses) | Native Rust threads; the terminal's VTE parser and the LLM never touch a GC |
| Memory ceiling | V8 heap fragmentation compounds with model weights | Rust gives deterministic allocation; model weights live in `mmap`'d GGUF, shared, never copied |

The IPC point is decisive for Flux specifically: the Context-Aware Terminal
and the Flux Agent both consume **multi-megabyte DOM snapshots** many times a
minute. Electron's structured-clone tax on a 5 MB snapshot is ~15–40 ms of
main-process CPU per transfer. Tauri v2's raw IPC moves the same bytes as an
`ArrayBuffer` body with a single memcpy at the boundary, and on the Rust side
we keep snapshots as `Arc<[u8]>` so the terminal, the agent, and the embedder
share **one** allocation (see `flux-core/src/state.rs`).

### Why not a Chromium fork

- **Cost:** a fork is a permanent ~30-engineer rebase treadmill (Brave's own
  numbers). Flux's differentiation is the terminal + agent layer, not the
  rendering engine.
- **Size/updates:** shipping Chromium means shipping its security patches.
  Native webviews are patched by the OS vendor, out-of-band, for free.
- **Trade-off accepted:** we give up engine homogeneity (WebKit on macOS vs
  WebView2/Chromium on Windows vs WebKitGTK on Linux). Flux's injected scripts
  are written to the WebExtensions-era DOM baseline, and the agent's action
  compiler (`flux-agent`) emits only universally-supported DOM APIs. This is
  re-evaluated if engine divergence ever blocks a P0 feature (escape hatch:
  CEF as an optional per-tab engine — would be ADR-NNN).

### Frontend framework: SolidJS over Leptos

Both were prototyped. **SolidJS** wins for the chrome layer:

- Fine-grained signals compile to direct DOM writes — no VDOM diff, no WASM
  boundary. Updating one tab title touches one text node.
- Leptos (WASM) pays a serialization/boundary cost for exactly the
  high-frequency, tiny updates (tab titles, agent token stream, terminal
  status) that dominate browser chrome — and inflates the binary by the WASM
  runtime + glue.
- Rust still owns everything performance-critical; the chrome is intentionally
  a thin event-driven skin (< 50 KB gzipped JS budget, enforced in CI).

## Performance Budgets (enforced in CI — regressions block merge)

| Metric | Budget | How measured |
|---|---|---|
| Cold start → first window paint | **< 300 ms** | `hyperfine` + tracing span `flux::boot` |
| Shell Time-to-Interactive (chrome UI) | **< 50 ms** after webview ready | Perf marks in `App.tsx` |
| Idle RAM, shell + daemon (excl. webviews, excl. model) | **< 150 MB** | RSS sampled 60 s post-boot, CI gate |
| IPC round-trip, 1 KB payload (p99) | **< 1 ms** | `criterion` bench `ipc_roundtrip` |
| DOM snapshot transfer, 5 MB (p99) | **< 12 ms** end-to-end | bench `dom_snapshot` |
| Terminal frame time (4k cells dirty) | **< 8 ms** (sustained 120 fps) | `flux-term` GPU timestamp queries |
| Terminal input → glyph latency | **< 15 ms** | photon-to-photon harness |
| Agent first token (Gemma-4-12B Q4, warm) | **< 350 ms** | `flux-agent` bench, reference HW: M3 Pro / RTX 4070 |
| Tab embedding (title + summary) | **< 5 ms/tab** | `flux-embed` bench |
| Shipped JS for chrome (gzip) | **< 65 KB** ¹ | `vite build` size gate |
| Installer size | **< 25 MB** | CI artifact gate |

¹ Re-baselined 50 → 65 KB (2026-07-16 code audit). The 50 KB was set before
~30 chrome features landed (workspaces, split view, groups/folders, containers,
omnibox suggestions, command palette, voice wiring, …). The audit first cut the
genuinely-cold chrome — find bar, reader view, semantic find/history, watch
panel, tracker graph, and app panes are now lazy + store-gated (70.1 → 64.4 KB
measured) — and what remains is load-bearing boot chrome, so the budget moved
to just above the real floor to keep regression pressure. Revisit if the
eager set is ever split further (e.g. per-feature store/ipc modules).

## Consequences

- **Positive:** order-of-magnitude smaller footprint than Electron; native
  threads for terminal/LLM; OS-patched web engine; zero-copy DOM pipeline.
- **Negative:** per-platform webview quirks (mitigated: DOM-baseline action
  compiler + per-platform CI matrix); Linux WebKitGTK lags Chromium on some
  APIs (accepted for v1).
- **Neutral:** contributors need both Rust and TS toolchains — mitigated by
  the monorepo `npm run check` single entry point.
