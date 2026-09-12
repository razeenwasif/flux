# Native macOS smoke checks

The UI preview mocks IPC. Use this separate native bundle to check real WKWebView events, native content-rule enforcement, and PTY lifetime without replacing the installed Flux app.

## Build and launch

With the project's dependencies already installed:

```sh
node scripts/native-smoke-build.mjs
node scripts/native-smoke-server.mjs
```

Open `target/debug/bundle/macos/Flux Smoke.app`, then navigate its address bar to `http://127.0.0.1:8851/`. The fixture server binds only to loopback. Stop it with Ctrl+C when finished and quit Flux Smoke normally.

The build uses `native-smoke` and the `dev.flux.smoke` identifier. Its session, preferences, and web data belong to that separate app. Legacy pre-Tauri log/clear-marker paths use a temporary directory, OS credential access uses an in-memory keyring, service autostart and automatic filter refresh are disabled, and the test editor uses a separate socket range with `nvim --clean`. This harness checks browsing and PTYs, not credential persistence or the user's editor plugins. It is a developer test build; do not install it as your everyday browser. The normal build does not enable these overrides. The runtime rejects a smoke build with the production identifier or without the matching frontend build flag.

## Repeatable checks

1. **Title and navigation.** Page A should show the same title in the tab strip. Click **Change title after load**, then **Go to page B**, Back, and Forward. Compare the rendered page, address, and tab title each time. The delayed title must update without navigating.
2. **Native blocking.** In a browser without Flux's synthetic rule, run **Run blocking probe**: both resources must load and reach the server. Then run it in Flux Smoke. The allowed script must reach the server; the blocked script must fail without appearing as a new request in the server log. Both endpoints return successful JavaScript when reached, so a missing blocked request plus the working control distinguishes filtering from an absent resource. The harness adds one synthetic ABP rule through Flux's production filter translator and native attachment code. This does not measure coverage of public filter lists.
3. **Protection UI.** Open Shields on the fixture page. Check **Native blocking rules attached**, unavailable request counters, and disabled unsupported controls. Do not interpret rule attachment alone as proof of blocking; use step 2.
4. **Page and PTY retention.** Type a marker in the fixture input. In a terminal, set a shell variable and print it with the process ID. Apply Browse to hide panels and reopen the terminal. Print the variable and PID again; both must match. Repeat with multiple terminal panes. Type unsaved text into the clean editor, hide it with Browse, and show it again. The text must remain. Check the page input while resizing or toggling panels.
5. **Keyboard and native accessibility.** Open the command palette using Command+K from a page. The native page and background chrome must leave the accessibility tree while the palette is open. Tab and Shift+Tab must stay in the palette; Escape must dismiss it and return focus. In Settings → Terminal, enable **Terminal screen reader support**. Existing editor content and newly printed terminal output must become accessible without restarting their PTYs. The covered page placeholder must not announce perpetual loading. Check named switches and disabled states in Settings and Shields.
6. **VoiceOver.** With VoiceOver working on the test machine, repeat the palette and Settings flows and read terminal output rows. Accessibility-tree checks alone do not verify spoken output, announcement timing, or the quality of full-screen TUI navigation.

## Recorded run — 12 September 2026

Passed on the rebuilt macOS native bundle:

- Delayed title updates and link/Back/Forward title–URL alignment.
- Successful control resources in the in-app browser; only the allowed request reached the local server from Flux Smoke.
- Native attachment status, unavailable counters, and disabled WebKit controls.
- Same shell PID and in-memory variable after hiding/reopening both a single terminal and the second pane of a split; unsaved page input retained across panel changes.
- Unsaved clean-Neovim buffer retained across Browse and editor reopening.
- Command palette Tab containment, Escape dismissal, native-page restoration, and background accessibility isolation.
- Enabling screen-reader support exposed an existing unsaved editor buffer and new terminal output in macOS accessibility; the underlying loading placeholder was absent.

VoiceOver launch timed out. A subsequent app inventory showed VoiceOver was not running. Spoken-output validation remains pending. Native window resizing and full-screen TUI announcement quality were not verified in this run.

The macOS/Windows CI jobs compile and test platform-specific Rust paths. They do not automate these GUI checks and were not executed remotely during this local run.
