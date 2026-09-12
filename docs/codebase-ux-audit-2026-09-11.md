# Flux codebase and UI/UX audit

Reviewed 11 September 2026 using repository inspection and computer use against the running `/Applications/Flux.app` on macOS. This is a sampled architecture and product review, not an exhaustive security audit. The installed app's exact commit was not established; runtime observations and source findings are distinguished below.

## Assessment

Flux has a useful foundation: SolidJS chrome, a Rust/Tauri host, native webviews, separate crates for terminal, agent, embeddings, search, filtering, import and vault functionality. Pure logic is frequently separated into testable TypeScript modules, expensive features use lazy imports, and Rust-generated IPC types have a drift check. Preserve these choices.

The biggest opportunity is consolidation. The browser already has many capabilities; clearer hierarchy, consistent state, and trustworthy settings would improve everyday use more than another feature rail.

## Validation performed

| Check | Result |
| --- | --- |
| TypeScript `tsc --noEmit` | Passed |
| Frontend Vitest suite | 16 files, 107 tests passed |
| Rust `flux-search` and `flux-filter`, locked/offline | 20 unit tests and 1 documentation test passed |
| Production frontend build | Passed |
| Existing performance gate | Passed: eager JS 52.2 KiB / 56 KiB; existing release binary 17.84 MiB / 25 MiB |
| New browser tab and URL entry | Navigated to Example Domain |
| Command palette | Cmd+K, search for Settings, and Enter worked after explicit chrome focus |
| Find in page | Cmd+F reached the field; `domain` reported two matches |
| Link navigation and Back | Example Domain → IANA → Example Domain worked |
| Split view | Created two panes using a new blank tab; closing that tab restored a single pane |
| Settings, start page, sidebar, calendar, launcher rails | Inspected visually and through accessibility state |

Both temporary audit tabs were closed and the original start page/calendar panel restored. No implementation or preference changes were made. Normal browser history may retain the public test-page visits. Full Rust workspace tests, actual tracker-blocking probes, agent execution, terminal execution, restart persistence and other OS backends were not tested. The release binary was measured, not rebuilt.

## Prioritized findings

### 1. Enforce search-suggestion privacy consistently — high priority, source-confirmed

`SearchSpotlight.tsx:64` calls `searchSuggest` for nonempty, non-scheme-prefixed input without checking `searchSuggestOn`. The sidebar checks that preference at `Sidebar.tsx:757`. The backend at `crates/flux-core/src/search.rs:118` performs the network request and assumes the caller has checked consent; the preference currently lives in local storage (`store.ts:1263`). Consequently, disabling suggestions does not prevent the spotlight path from requesting them.

Centralize suggestion policy, preferably enforce it in the backend as well, and reuse the same input classification across the sidebar, spotlight and start page. Exclude navigation input and private-tab queries as appropriate to the stated privacy policy. Add an integration test asserting zero suggestion requests with the preference disabled on every entry point. No preference was changed or network interception performed during this review.

### 2. Synchronize page titles with navigation — high priority, observed

Reproduction: create a tab → open Settings through the palette → navigate to `https://example.com` → follow its IANA link → go Back. The address and page contents updated, but the tab continued displaying **Settings**. A newly opened external page also initially used its URL as the title.

Relevant source: `App.tsx:687` handles URL/loading events but not titles. `crates/flux-core/src/dom.rs:157` updates a backend title during DOM publication; this is a separate path from immediate frontend navigation state. The Android listener at `App.tsx:1193` explicitly handles title changes.

Introduce a single page-metadata event carrying tab ID, navigation generation, URL, title and load phase. Keep title updates independent of semantic capture, preserve intentional custom tab names, and reject events from superseded navigations. Add a native macOS smoke test using the reproduction above. The exact runtime cause still requires tracing the installed build.

### 3. Make controls and dialogs accessible — high priority

The palette appeared visually and accepted typing, but it was absent from the returned native accessibility tree during those interactions. Treat this as a symptom requiring VoiceOver verification, not proof of the underlying cause. Source review shows the palette uses plain containers without dialog semantics or explicit focus trapping (`CommandPalette.tsx:110`). Settings toggles expose repeated **On/Off** buttons without their setting names or switch state (`SettingsPage.tsx:151`).

Build shared dialog and switch components with accessible names, modal semantics, focus containment, Escape dismissal and focus restoration. Associate setting labels/descriptions with controls; expose checked state. Add keyboard and component-level accessibility tests, followed by native VoiceOver checks. Existing pure-logic tests cannot establish that these rendered interactions work.

### 4. Prevent stale asynchronous search results — medium priority, source-confirmed

Both `CommandPalette.tsx:28` and `SearchSpotlight.tsx:64` debounce requests, then accept results without checking whether the query has changed. An earlier slow response can overwrite later results, including after the input is cleared. Their pending timers also lack component cleanup. The sidebar already guards result application with a current-query comparison.

Extract a shared cancellable query controller with a generation counter, timer cleanup and explicit idle/loading/error/empty states. Test out-of-order completion and clearing the query while a request is in flight.

### 5. Report platform capabilities and failures honestly — medium priority

The README says macOS network blocking is unavailable, but current source implements `WKContentRuleList` attachment at `crates/flux-core/src/netfilter.rs:83`. Thus the README is stale; this review does **not** conclude Shields is absent on macOS. The declarative backend also differs from Windows' per-request accounting, making a blanket **0 blocked this session** potentially misleading. The macOS compilation callback currently ignores its error argument.

Return a capability/status object covering blocker attachment, counters, HTTPS upgrading and related controls. Distinguish **enabled**, **active on this page**, **unavailable**, and **failed**. Surface a concise recovery action and update the platform documentation. Verify behavior with a controlled request test before claiming protection parity.

Several Settings mutations optimistically update the UI and swallow failures (`SettingsPage.tsx:628`). Roll back failed writes or show a save error so the displayed state remains trustworthy.

### 6. Measure the desktop startup path — medium priority, source-confirmed

The performance gate follows only static manifest imports (`scripts/perf-budget.mjs:109`). `App.tsx:142` immediately preloads four dynamic desktop components. Including those explicit preloads and their static dependencies increases the measured JavaScript from **52.2 KiB to 75.2 KiB gzip**, before other initially rendered lazy components. This is an artifact-based lower bound, not a startup latency measurement.

Keep the existing entry budget, but add separate desktop-first-paint and mobile-first-paint budgets. Record startup traces and account for preloaded chunks, CSS and initial widgets. Do not interpret a passing static-entry gate as a full desktop startup guarantee. Align outdated 50/65 KiB comments with the current 56 KiB gate.

## UI/UX direction

### Give browsing more space

In the observed layout, web content occupied roughly 45% of the window width. Splitting it produced very narrow reading panes while the calendar/mail area, connections, system monitor and launcher rails stayed visible. This describes the user's current configuration, not a measured default-install layout.

Offer saved **Browse**, **Research** and **Develop** arrangements. Browse emphasizes tabs and the page; Research adds a selected notes/agent panel; Develop adds terminal/editor space. Let users pin exceptions. Protect a minimum page width and offer to collapse auxiliary panels when splitting. Provide a visible way to restore the prior arrangement.

### Reduce competing navigation and improve readability

Keep the existing icon assets, but consolidate the pages and TUI launchers into one searchable launcher with a short favorites section. The page rail alone contains 17 destinations (`PagesBar.tsx:40`). Show labels in its expanded state and consistently use macOS shortcut notation on macOS. Settings should have section navigation and search, with advanced setup instructions disclosed on demand.

The current acrylic treatment makes secondary labels and calendar text faint against the exposed background. Increase minimum surface opacity behind text, strengthen muted text colors and provide a comfortable density option. Validate contrast on both light and dark desktop backgrounds. Relevant styling: `theme.css:416` onward.

### Simplify the start page

Lead with search, recent activity and a small set of selected widgets. Put calculators, converters, clocks, maps and other utilities behind an obvious **Customize home** control with previews. Existing widget toggles are a useful starting point. Present a focused next action in empty widgets instead of giving every empty widget equal visual weight.

### Make splitting and new tabs easier

The split picker (`Sidebar.tsx:1221`) showed dozens of tabs in one unsearchable list. Add a search field, recent-first ordering, workspace/group labels, and small layout previews. A new empty split pane should offer **Search or enter a URL** in place, making its next action clear.

The main **New tab** button currently opens a type menu before creating a browser tab. Prefer direct browser-tab creation with an adjacent dropdown for private, terminal and files tabs. Rename internal tab labels such as `flux://start` to friendly names such as **New Tab**.

## Maintainability and delivery sequence

`App.tsx` has 2,165 lines, `Sidebar.tsx` 2,635, `AgentPanel.tsx` 3,661, `store.ts` 1,711 and `theme.css` 17,303. Size alone is not a defect, but navigation, preferences, native geometry and feature behavior are coupled across these files.

Extract boundaries incrementally while fixing the issues above: navigation lifecycle; search/palette policy; workspace/tab state; panel layout; preferences; agent sessions. Continue generated IPC types and extend generation to command signatures where practical. Keep one authoritative route/action registry for the palette and launchers.

Recommended order:

1. Fix suggestion policy, title synchronization, accessible switches/dialogs and stale search responses.
2. Add native macOS smoke coverage for those flows. Existing correctness CI runs on Linux; add platform jobs for macOS and Windows-specific code and native smoke coverage where runners permit it.
3. Improve density, acrylic readability, split picking, Settings navigation and new-tab behavior.
4. Extract the affected feature modules and add desktop startup accounting alongside the existing budgets.

Success criteria: a disabled privacy setting is honored everywhere; page title/address/content agree; core flows work by keyboard and assistive technology; split panes remain readable; failed changes are visible; and startup budgets cover the code each platform actually loads.

## Implementation follow-up — 12 September 2026

The first implementation batch adds consent and private-tab checks for suggestions, a shared controller that rejects superseded search responses, native title events, accessible Settings switches and modal focus management. The primary New tab button now creates a browser tab directly, with other types in an adjacent dropdown. Split picking gains search, recent-first ordering, folder/group context and an empty state.

Validation: TypeScript passed; 112 frontend tests passed; 350 `flux-core` unit tests passed; 7 `flux-search` unit tests and its documentation test passed. The production build and existing performance gate passed (entry JS 52.4 KiB / 56 KiB). The binary-size check measured the existing release executable, not a newly packaged app.

Computer use against the rebuilt, mocked browser preview verified direct tab creation, the type dropdown, palette filtering, Tab/Shift+Tab wrapping, Escape dismissal and focus restoration, split filtering and empty results, named switches in both Settings surfaces, and spotlight suggestions absent when disabled and present when enabled. The spotlight receives initial input focus. This preview tests chrome interaction, not native webviews or real suggestion requests; unit tests cover request gating and stale completions. The preview's Connections rail also exposed an unrelated mock-data error when expanded.

Still pending: rebuilt native macOS title-navigation smoke coverage and VoiceOver testing; page-space/layout presets; Settings navigation and density/contrast work; platform capability reporting; and desktop startup accounting. The installed Flux app was not replaced by this batch.

## Second implementation batch — 12 September 2026

- Added Browse, Research, and Develop presets to the sidebar and palette. The current arrangement persists, and a separate restore action reinstates the arrangement from before the last preset. Ordinary panel toggles remain available and produce a Custom arrangement.
- Extracted layout allocation into a pure module. It reserves page space, accounts for editor ratios and content gutters, and gives split pages priority over auxiliary panels. Panels return as the window grows; their requested visibility is retained. Extremely narrow windows still constrain the page to available space.
- Kept editor, terminal, and agent components mounted after first use. Hiding them through presets or responsive layout no longer tears down editor/terminal sessions or terminal split state. This preserves running work rather than releasing its process memory.
- Added Settings search, category navigation, match counts, and an empty state. Filtering hides existing rows without remounting them, preserving form values. Conditional controls are indexed as they appear. Search uses labels/descriptions rather than credential input values.
- Made Settings fill the page, added horizontal category navigation and stacked controls at narrow widths, and strengthened secondary text on a solid surface. Broader theme contrast and density customization remain separate work.

Validation: TypeScript, all 117 frontend tests, production build, and the existing entry-size budget passed (53.5 KiB / 56 KiB). New layout tests cover editor ratios, content gutters, split-page space, shared-column accounting, and invalid saved state. Computer use checked presets and restoration, multiword Settings search, empty results, category selection, retained typed values, and Settings overflow at 1440px, 800px and 520px. In the mocked preview, two terminal panes and the editor stayed mounted through Browse/Develop switches and a narrow resize. A two-page split retained widths above 330px at 1440px; reducing the window to 1100px hid the agent and gave the pages more room. Temporary split-test state was cleared.

Native app installation, real PTY lifecycle smoke tests, VoiceOver, title-navigation coverage, capability reporting, and desktop startup accounting remain pending. No Rust behavior changed in this batch and the installed app was not replaced.


## Third implementation batch — 12 September 2026

- Added backend capability fields and per-tab attachment reports for native request blocking. The UI distinguishes preparing, attached, failed, and unconfirmed states. macOS compilation errors are now checked and logged. Reports are cleared on close/hibernation, and late callbacks only update their original installation handle.
- WebKit surfaces identify native rules, explain unavailable request counters, and disable unsupported request-policy, tracking-level, HTTPS-only, and Lean controls. Windows keeps its supported controls and session counters. An attached filter is described as attached, not as proof of successful blocking. Updated stale macOS README claims.
- Added acknowledged writes with pending/error/retry feedback for core search/privacy controls in full Settings and the Shields popover. Failed dropdown changes retain the previous selection; retries preserve the intended change. Initial load failures disable these controls and offer a retry. Other integration and credential forms still use their existing save paths.
- Extracted an authoritative registry for the four explicit desktop preloads. The performance gate now walks their static dependencies, deduplicates shared files, and enforces a separate 84 KiB gzip budget alongside the unchanged 56 KiB entry budget. This is an artifact-based startup lower bound; it excludes CSS, conditional lazy features, and native startup latency. A complete first-paint/mobile budget remains future work.

Validation: TypeScript passed, all 122 frontend tests passed, all 351 `flux-core` tests passed (including generated binding drift checks), and both startup-graph tests passed. The production build and performance gates passed: entry **53.6 KiB / 56 KiB**, desktop entry plus explicit preloads **78.4 KiB / 84 KiB**. The binary gate measured the existing release executable (**17.84 MB / 25 MB**), not a rebuilt installer.

Computer use against the rebuilt mocked preview verified WebKit capability messaging and disabled controls, unavailable counters, attachment-failure recovery guidance, a failed search-engine selection retaining DuckDuckGo then applying Google on retry, and a failed HTTPS-only toggle remaining off then turning on after retry. Screenshots were inspected for readable feedback and popover layout. Preview fixtures are opt-in query parameters and do not affect native builds; fixtures were cleared after testing.

Remaining native validation: controlled real network-request blocking, Windows/Linux platform compilation and runtime checks for their updated attachment paths, macOS title-navigation/PTY smoke coverage, and VoiceOver. Passing core tests on macOS does not establish cross-platform request-blocking parity. The installed Flux app and its profile were not replaced by this batch.


## Fourth implementation batch — 12 September 2026

Built and exercised a separate **Flux Smoke** native macOS app with its own app identity and test editor socket range. A loopback fixture checks delayed title changes, navigation, and actual native rule enforcement. The test keyring is in memory, the editor uses `--clean`, and automatic service/filter startup is disabled. The installed Flux app was not replaced.

Native checks passed for title changes, Back/Forward URL–title agreement, a controlled blocked request that never reached the server (with both resources proven successful in the control browser), native attachment reporting, terminal PID/variable retention through hiding, unsaved page input through panel changes, and unsaved editor text through Browse/editor switches. Palette Tab containment and Escape restoration were checked in the native accessibility tree.

The native run exposed two accessibility gaps, now addressed: a covered HTML placeholder still announced loading after its native page had loaded, and xterm exposed its input but no output rows. External-page placeholders are now hidden from assistive technology. Settings adds an optional **Terminal screen reader support** switch, which updates existing sessions and exposes both editor text and new terminal output. The terminal persistence selector also has an accessible name.

Added macOS/Windows CI core tests and native binary compilation alongside existing Linux coverage. These jobs are configured but have not been run remotely. The performance job now exercises startup-graph tests as well as size gates. See [the native smoke procedure](native-smoke.md) for reproduction steps and detailed limits.

VoiceOver itself could not be validated: its launch timed out, and it was not running afterward. Native accessibility-tree output is verified; spoken announcements remain pending. Two real terminal panes also survived Browse/reopening, with the second pane retaining its PID and variable. Zero-size observations from hidden terminals now skip PTY resizing, avoiding needless buffer reflow. Native window resizing was not covered. The prior preview checks cover those layout cases without proving native behavior.


Validation: TypeScript and all 122 frontend tests passed. The native smoke app built successfully from the updated code. All 351 default-feature core tests and both startup-graph tests passed. Production build and budgets passed: entry 53.6 KiB / 56 KiB, desktop preloads 78.5 KiB / 84 KiB. Binary size again measures the existing release executable, not the debug smoke bundle. The macOS/Windows CI additions still require their first remote run. The temporary app and fixture server were closed after testing.


## Fifth implementation batch — 12 September 2026

Rebuilt the normal release successfully before starting this batch, as requested. The app bundle is in `target/release/bundle/macos/Flux.app`; the installed application was not replaced.

The launcher now combines all 17 native pages with configured terminal apps. It supports category filters, multiword name/command search, keyboard navigation, explicit pane/full-tab launch mode, and six persisted favorites. A compact favorites rail replaces the two long icon lists. Launcher entry points are also available in the expanded and collapsed sidebar and in the existing command palette. The dialog participates in native webview hiding and shared focus containment/restoration.

Terminal-app management remains available inside the launcher. Required name/command fields are validated, scans report errors or no additional results, and writes only close the editor after acknowledgment. Failed writes retain the draft for retry. Stable input nodes keep keyboard focus during typing. Removing an app reconciles the favorites list.

Home defaults to open tabs, shortcuts, and scratchpad only when the saved visibility preference is absent or malformed. Explicit saved arrays, including show-all, are preserved. The customization dialog adds focused/all presets, one-step preset undo, labeled controls, and duplicate/unknown-key repair. Time/date/weather now share a compact strip beneath search. Home cards and helper text use theme-aware solid surfaces and clearer secondary text.

Appearance settings now offer compact and comfortable chrome density. Shortcut labels in sidebar navigation, the address field, find, and footer adapt to macOS modifiers without changing shortcut handling.

Browser computer-use checks used the rebuilt standalone preview, whose IPC calls are mocked. Verified: multiword search; empty results; favorites after reload; arrow-key/Enter launching; Escape and focus restoration; a simulated failed terminal-app save followed by successful retry; required-field validation; uninterrupted typing; density after reload; preset undo; and custom widget visibility/order after reload. Inspected the launcher, editor, and home customization at 1440px, 800px, and 520px. The narrow check exposed a missing collapsed-sidebar entry point, which was added and retested. These checks do not establish native command execution or new cross-platform runtime coverage.

Validation: TypeScript, all 128 frontend tests, both startup-graph tests, and `git diff --check` passed. Production startup gates passed at **54.0 KiB / 56 KiB** for the entry and **79.0 KiB / 84 KiB** for the entry plus explicit desktop preloads. Browser checks also confirmed the six-favorite cap and reclaiming a favorite slot when an app is removed. A second normal release rebuild includes the completed fifth batch. Existing Rust dead-code warnings remain; no Rust source was changed for this batch.


## Mail compatibility fixes — 12 September 2026

Reproduced Gmail's unsupported-browser banner and Proton Mail's paid-plan error
in native web panels. A loopback diagnostic confirmed the original WKWebView
user agent omitted Safari's browser/version tokens and exposed `window.isTauri`.
Proton's public `helpers/desktop.ts` uses that marker for desktop detection, and
`apps/helper.ts` switches the API client identifier to the desktop variant.

Added a macOS compatibility user agent based on the installed Safari version,
validated and cached once per process. It is set before the first navigation on
both tab and panel builders, so HTTP and JavaScript identification agree. If
Safari metadata cannot be read, the engine default is retained. Other platforms
keep their existing user agents.

A one-file patch to the pinned Tauri 2.11.2 source omits its non-configurable app
marker in `tab-*` and `panel-*` views while retaining it in the Flux shell. Page
scripts cannot remove the upstream marker after injection. IPC initialization
and capability enforcement are unchanged. The published crate is retained with
its licenses under `vendor/tauri`; `vendor/README.md` records the exact patch and
upgrade procedure. Verified that only `src/manager/webview.rs` differs from the
published crate source. This fixes client classification without altering Proton
code, account permissions, subscription checks, or API responses.

Validation: all 353 core tests passed, including two browser-identity tests;
locked/offline release build, both startup-graph tests, size gates, and diff
whitespace checks passed. Entry 54.0 KiB/56 KiB, explicit desktop startup
79.0 KiB/84 KiB, rebuilt executable 17.88 MB/25 MB. The installed bundle was
replaced with byte-for-byte verification and a previous-app backup.

Native computer use after relaunch confirmed HTTP and JavaScript UA both contain
`Version/26.6.2 Safari/605.1.15`, the remote app marker is absent, and the IPC bridge
still exists. Gmail loaded its inbox without the unsupported-browser banner.
Proton loaded its inbox in the existing panel without the paid-plan error. No
mail was sent, account settings changed, or cookies cleared. The optional live
protected-IPC probe was interrupted by user navigation, so no new runtime
permission-enforcement claim is made. The loopback fixture was stopped.
