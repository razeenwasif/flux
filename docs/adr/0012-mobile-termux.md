# 0012 — Mobile Flux: Termux/proot first, native Android later

Status: accepted (rungs A+B shipped; rung C started — native APK builds + boots,
Milestone 1 done 2026-07-20)
Date: 2026-07-19 (rung C update 2026-07-20)
Relates to: [0001](0001-architecture-and-performance-budgets.md) (budgets),
[0002](0002-ui-architecture-arc-style-shell.md) (multi-webview chrome).

## Context

We want Flux on a phone, "buildable using Termux". Two of Flux's foundations are
exactly what mobile platforms restrict:

- **Multi-webview tabs** (one native child webview per tab, positioned over the
  content card — Tauri's `unstable` feature) exist on desktop only. On mobile,
  Tauri/wry targets `target_os = "android"` and switches to a single-WebView
  JNI/activity model: the app *is* one webview. There is no per-tab native
  webview stack to position.
- **Termux's native Rust toolchain targets `aarch64-linux-android`** — which
  triggers that same Android mode in wry, expecting an Android app context that
  a Termux terminal process doesn't have. A naïve `cargo build` in Termux can
  never produce a working Flux.

What Termux *does* provide (verified against packages.termux.dev):
`rust`, `nodejs` (main repo) and — in the x11 repo — `gtk3` and
**`webkit2gtk-4.1`**, the exact engine the desktop Linux build uses. And
`proot-distro` runs a full aarch64 Ubuntu userland where the Rust target is
`aarch64-unknown-linux-gnu` — the ordinary Linux target, where Tauri takes the
GTK path.

## Decision

A three-rung ladder, cheapest-first, no architecture forks until forced:

**Rung A — Termux + proot-distro + termux-x11 (shipped).** Build the *existing
Linux flavor* unmodified inside a proot Ubuntu, displayed via the termux-x11
app. Verified here: every pure-Rust crate checks clean on
`aarch64-unknown-linux-gnu`; the GTK/WebKit deps come from Ubuntu's arm64
archive. `scripts/install-termux.sh` automates the whole recipe (including the
WebKitGTK-under-proot env: software GL, compositing off, a dbus session).
This is the same **dev-grade** class as the WSL2 build. One honest unknown that
can only be verified on-device: per-tab webview *positioning* fails under WSLg —
if the cause is WSLg's compositor, real X11 (termux-x11) may position fine and
give full browsing; if it's WebKitGTK-general, the Termux build browses via
internal pages/panels only, like WSL2.

**Rung B — responsive chrome (shipped).** Building on the existing pane
shedding (#28 — columns already drop in priority order and the sidebar
collapses to its icon rail when the window narrows): on
narrow screens the sidebar, terminal column, agent panel and connections rail
now start collapsed; paddings compact below 760 px; touch targets grow under
`pointer: coarse`. This serves both the Termux build and any future Android one.

**Rung C — native Android APK (started; the user chose this over rung A after the
on-device Termux build kept failing — npm cache corruption, then OOM compiling on
the phone). The whole point: build the APK *here* and just download+install it —
the phone never compiles anything.**

Contrary to the original assumption above, this **is** startable from the WSL2
dev box: `cargo tauri android build` cross-compiles `aarch64-linux-android` with
the Android NDK and assembles the APK via Gradle, all on Linux. Toolchain: Android
SDK + NDK r27 under `~/Android`, the four Rust android targets, cargo-tauri v2, and
a portable Temurin JDK under `~/jdk` (Gradle needs `javac`; no root required).
`scripts/build-apk.sh` drives the whole thing (frontend build from the repo root,
then the Gradle build with `beforeBuildCommand` emptied so cwd doesn't matter).

Approach **simpler than the parked plan**: Milestone 1 uses Tauri's *default*
single system WebView — no custom Kotlin WebView-stack plugin yet. The desktop
multi-webview tab engine (`webview.rs`), floating peek windows (`peek.rs`), the
PTY terminal (`terminal.rs`), the AudioPulse launcher (`spotify.rs`), and the
Files-tab trash all compile to `#[cfg(mobile)]` **stubs** with identical IPC
signatures — so `lib.rs`'s `generate_handler!` and state management are unchanged
and the internal pages (Notebook, Trail, whiteboard, Settings — all shell HTML)
work. The desktop-only Tauri plugins (`single-instance`, `window-state`) and
`portable-pty`/`trash` crates are moved to a `not(android/ios)` target section.
Entry point: `#[cfg(mobile)] mobile_run()` with `#[tauri::mobile_entry_point]`.

**Milestones:** (1 — *done*) APK cross-compiles here, installs, boots the shell,
internal pages work. (2) real browsing — swap the single WebView's URL for tabs
(mobile-correct: one page at a time), replacing the `webview.rs` stubs. (3) polish
— Android back gesture, notifications, and the optional on-device agent on
**llama.cpp** (Ollama has no Android runtime; a 2–4B quantized Gemma is the
realistic phone model).

## Consequences

- **Positive:** rung A ships mobile Flux *now* with zero architecture forks —
  one codebase, the Linux build, a phone display. Rung B costs ~1 KB of CSS and
  benefits every small window. The aarch64 portability check keeps the codebase
  honest for any future target.
- **Negative:** rung A is dev-grade — proot + software rendering is not fast;
  full-page browsing hinges on the positioning unknown above; battery cost of a
  local model on-phone is real (Ollama's linux-arm64 build does run in proot,
  CPU-only — use a small model, or skip the agent).
- **Neutral:** rung C confirmed the fork is confined as predicted — the SolidJS
  chrome, Rust stores, and IPC surface all carry over unchanged; only the
  native-webview/window/PTY layers needed mobile stubs. The debug APK is large
  (~150 MB: unstripped debug `.so`); a release build with stripping will be far
  smaller. Milestone 2 (a custom Kotlin WebView-stack plugin) is only needed if
  single-WebView URL-swapping proves insufficient for the tab UX.

## Verification ladder (on-device, rung A)

1. `flux://start` renders → GTK/WebKit stack works.
2. Internal pages (Notebook, Trail, Settings) → full chrome works.
3. Open a real page in a tab → **the positioning unknown resolves**: page
   visible = full browser; page invisible = WSL2-class dev build (report back —
   this decides how much of rung C is urgent).
