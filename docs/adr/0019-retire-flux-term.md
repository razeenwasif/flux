# ADR 0019 — Retire flux-term; the terminal stays on xterm.js

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-04 |
| **Deciders** | Maintainer |
| **Relates to** | [0001](0001-architecture-and-performance-budgets.md) (specified a WGPU terminal), [0003](0003-terminal-pty-xterm.md) (kept this crate as the future native path; reversed here) |

## Context

ADR 0003 put the terminal on xterm.js and kept `crates/flux-term` as a later native
renderer. Five months on, the crate had about 740 lines (a grid, a parser and a basic
renderer), nothing depended on it, and it had last changed in July. It still held two
P0s in the backlog, #3 and #7, which read as urgent but only described finishing it.

Meanwhile xterm.js gained what the crate was meant to bring: GPU rendering (its WebGL
addon), raw-byte throughput with backpressure (#74), and everything ADR 0003 listed as
the long tail. Splits (#75), shell integration (#16) and persistence (#98) were built
on it. What remained missing was ligatures and inline images, and neither needs a new
renderer.

The problem that sent ADR 0003 to xterm.js is unchanged: placing a GPU surface in the
window, correctly ordered under the interface, on three platforms.

## Decision

**xterm.js in the webview is the terminal renderer. `flux-term` is deleted.** Its
history stays in git.

Ligatures and images are added on xterm.js (`termdraw.ts`):

- **Ligatures** use xterm's character joiner directly rather than
  `@xterm/addon-ligatures`, which reads font files from disk and so can't work in a
  webview.
- **Images** use `@xterm/addon-image`, Sixel and iTerm's protocol, loaded when a
  program first needs it, to stay out of the boot budget. The addon decodes with
  WebAssembly, so the app's content security policy gains
  `script-src 'self' 'wasm-unsafe-eval'`, which allows compiling WebAssembly and still
  refuses `eval`. Loaded where WebAssembly is refused, the addon stops the terminal at
  its first image, so a webview that won't run it goes without images instead.

## Consequences

- **Positive:** one terminal to maintain; the backlog says what's actually open; 43
  packages (the GPU stack) leave the lockfile. They were never in the app's binary, as
  the renderer was an opt-in feature of a crate nothing used, so its size doesn't change.
- **Negative:** the terminal's speed is bounded by the webview. ADR 0001's frame-time
  budget named a `flux-term` benchmark and has no measurement now. Reopen this if real
  output bursts become a bottleneck.
- **Known limits:** no Kitty graphics protocol (BACKLOG #14). xterm's WebGL renderer
  painted image, underline and link cells opaque on the transparent background;
  `termdraw.ts` corrects that from outside the addon, which an xterm upgrade could undo.
