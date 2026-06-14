# ADR 0003 — Embedded Terminal: PTY + xterm.js now, WGPU later

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Deciders** | Flux Core Team |
| **Relates to** | ADR 0001 (which specified a custom WGPU/Alacritty-style terminal) |

## Context

The 0.1 scaffold shipped `flux-term`: a WGPU-accelerated terminal (vte grid +
damage tracking + an instanced glyph renderer). ADR 0001 chose that for SOTA
performance and a small binary.

The immediate product goal changed: **a terminal usable for real development,
now.** Two things make the pure-WGPU path expensive to get there:

1. **Compositing.** Flux's UI is a Tauri webview. Putting a raw `wgpu` surface
   *inside* that webview window — correctly z-ordered beneath the SolidJS
   chrome, resizing with the grid cell, on Windows/macOS/Linux — is an
   unsolved, multi-week problem (separate native child surface, raw window
   handles, per-platform quirks). It may not even land cleanly on WebKitGTK.
2. **Terminal completeness.** A daily-driver terminal needs the long tail:
   reflow, scrollback, selection, clipboard, hyperlinks (OSC 8), bracketed
   paste, IME, ligatures, true-color, mouse reporting. `flux-term`'s grid
   handles a subset; the rest is months of VT work that xterm.js already ships.

## Decision

**Render the terminal with xterm.js in the webview, backed by a real PTY in
Rust (`portable-pty`), streamed over a Tauri `Channel`.** This is the same
architecture every shipping Tauri/Electron terminal uses (Tabby, Wave, VS Code).

- **Rust (`flux-core::terminal`)** owns the PTY: spawns the user's `$SHELL`
  with the Flux context env (`FLUX_TAB_*`), a background thread streams output
  bytes to the frontend, and commands handle stdin / resize / kill. Sessions
  are keyed by `u64` (a Terminal tab's `TabId`, or `PANE_SESSION = 0` for the
  vertical column).
- **Frontend (`TerminalView.tsx`)** renders with xterm.js + fit + web-links
  addons, **dynamically imported** so the ~72 KB-gzip xterm chunk loads only
  when a terminal first opens — the base chrome bundle stays ~9.6 KB gzip,
  protecting the ADR 0001 TTI/JS budget.

### `flux-term` is not deleted

The WGPU crate stays. It remains the **future native-render path**: the PTY
backend in this ADR produces the byte stream that *either* xterm.js or a
matured `flux-term` surface can consume. When the webview/GPU compositing story
is solved (or the terminal moves to its own surface/window), we can swap the
renderer behind the unchanged PTY layer. This ADR is therefore additive and
reversible, not a repudiation of ADR 0001 — it's a sequencing decision:
usable first, native-fast later.

## Consequences

- **Positive:** a real, complete terminal *now* (scrollback, selection,
  clipboard, links, true-color, IME — all from xterm); standard, low-risk
  architecture; PTY layer is renderer-agnostic.
- **Negative:** xterm.js is ~72 KB gzip and canvas/DOM-rendered, not GPU —
  slower than the WGPU aspiration on huge output bursts. Mitigated by lazy
  loading (off the base bundle) and 8 KB read batching; revisited if it ever
  bottlenecks.
- **Known limitation:** terminal *tab* sessions are torn down when you switch
  away from the tab (the content card only mounts the active tab). The vertical
  **column** session persists while open and is the intended always-on dev
  terminal. Persisting tab sessions across switches (hidden keep-alive mounts)
  is BACKLOG #73.
