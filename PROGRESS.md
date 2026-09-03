# Flux Progress

## 2026-09-03: Acrylic frosted styling for Agent, Terminal, and Rails + Flowing Liquid Glass animations

### Request
Apply frosted acrylic styling to the Agent panel, Terminal panel, and the TUI apps / Flux pages launcher rail, and convert the animations in the Agent panel and Terminal to flowing, colorless "liquid glass".

### Work Done
1. **Flowing Liquid Glass Animations (Colorless Specular Caustics):**
   - **Agent Panel ([`AgentAurora.tsx`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/AgentAurora.tsx)):** Replaced the multi-colored gradient bands (`u_c1`, `u_c2`, `u_c3`, `u_c4`) with pure specular light caustics (`vec3(0.94, 0.97, 1.0) * caustic`), preserving the organic 3D simplex noise ribbons, orbital swirl, and busy acceleration, but rendering them as refracting, translucent liquid glass.
   - **Terminal Panel ([`LiquidBackground.tsx`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/LiquidBackground.tsx) & [`TerminalView.tsx`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/TerminalView.tsx)):**
     - Enabled WebGL alpha blending (`alpha: true`) and added a dedicated `u_glass` shader mode that renders the 3D simplex wave folds as pure silver/white liquid glass caustics (`vec3(0.92, 0.96, 1.0) * caustic`) with translucent alpha instead of the opaque purple background and neon aurora colors.
     - Switched `TerminalView`'s container background from opaque `var(--velvet-800)` to `transparent`, letting the underlying `.terminal-surface` frosted glass and liquid caustics shine through cleanly.
2. **Frosted Acrylic Glass Chrome Styling ([`theme.css`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/theme.css)):**
   - **Agent Panel (`.shell.window-acrylic .agent-inner`):** Styled with frosted liquid glass (`rgba(15, 15, 18, 0.28)`, `backdrop-filter: blur(24px)`, soft specular rim `1px solid rgba(255, 255, 255, 0.08)`).
   - **Terminal Panel (`.shell.window-acrylic .terminal-surface`):** Styled with matching frosted liquid glass (`rgba(15, 15, 18, 0.28)`, `backdrop-filter: blur(24px)`, soft specular rim `1px solid rgba(255, 255, 255, 0.08)`).
   - **Launcher Rails (`.shell.window-acrylic .pages-bar`, `.shell.window-acrylic .tui-apps-bar`):** Frosted translucent liquid glass (`rgba(15, 15, 18, 0.28)`, `backdrop-filter: blur(20px)`).
   - **Dock Cards & Column (`.shell.window-acrylic .dock-card`, `.dock-col`, `.rightstack`):** Fully integrated with transparent containers and frosted translucent glass cards.
   - Neutralized base non-acrylic styles for `.agent-inner` and `.terminal-surface` to remove all leftover purple tints.
3. **Rebuilt & Deployed:**
   - Compiled with `npx tauri build --no-bundle` and replaced the installed executable at `AppData/Local/Programs/Flux/flux.exe`.

### Files Changed
- `apps/shell/src/AgentAurora.tsx`
- `apps/shell/src/LiquidBackground.tsx`
- `apps/shell/src/TerminalView.tsx`
- `apps/shell/src/theme.css`
- `PROGRESS.md`

## 2026-09-03: Fix blackish window background in acrylic mode (DWM client extension + WebView2 transparency)

### Problem
When the purple color schemes were removed, enabling Acrylic resulted in an opaque blackish window background instead of visible frosted translucency.

### Root Cause
1. In Windows 11 DWM, setting `DWMWA_SYSTEMBACKDROP_TYPE` alone only configures the backdrop material on the window frame, but does NOT extend the backdrop into the window client area unless `DwmExtendFrameIntoClientArea` is called with negative margins (`{-1, -1, -1, -1}`).
2. WebView2's controller defaults to an opaque black background (`DefaultBackgroundColor` alpha = 255) when the host window is opaque (`transparent: false`). Transparent CSS alone simply revealed WebView2's opaque black controller surface.

### Fix
1. **Extend DWM Frame into Client Area (`crates/flux-core/src/webview.rs`):**
   - Invoked `DwmExtendFrameIntoClientArea` with `MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 }` when acrylic is enabled (and `{0, 0, 0, 0}` when disabled).
   - Triggered `SetWindowPos` with `SWP_FRAMECHANGED` to re-composite the DWM backdrop across the client area immediately.
2. **WebView2 Dynamic & Early Transparency:**
   - In `set_window_acrylic`, dynamically updated the window background: `win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))` when enabled, restoring opaque `(15, 15, 18, 255)` when disabled.
   - Initialized `WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0` in `run()` in [`crates/flux-core/src/lib.rs`](file:///C:/Users/Razeen/Projects/flux/crates/flux-core/src/lib.rs) before Tauri/WebView2 creates the controller to prevent opaque black startup flashes.
3. **Pre-Paint Class Bootstrap (`apps/shell/index.html`):**
   - Added pre-paint check for `flux.window.acrylic` in `index.html` to avoid layout flashes.
4. **Rebuilt & Deployed:**
   - Rebuilt with `npx tauri build --no-bundle` and replaced the installed binary at `AppData/Local/Programs/Flux/flux.exe`.

### Files Changed
- `crates/flux-core/src/webview.rs`
- `crates/flux-core/src/lib.rs`
- `crates/flux-core/Cargo.toml`
- `apps/shell/index.html`
- `apps/shell/src/theme.css`
- `PROGRESS.md`

## 2026-09-03: Remove purple color scheme and neutralize acrylic frosted window background

### Problem
Turning on the Acrylic window setting produced an intense purple background due to layered royal-violet/plum gradients (`var(--accent-ai-rgb)`, `velvet-700`, `velvet-900`) and the default "Velvet" theme's purple undertones.

### Fix
1. **Neutral Dark Palette:**
   - Switched the base `--velvet-*` color tokens from purple/plum (`#07050f`, `#0b0a1d`, `#12102e`, `#1a1640`) to clean, neutral dark slate/charcoal tones (`#09090b`, `#0f0f12`, `#16161a`, `#1e1e24`, `#27272e`).
   - Converted `--glass-fill` and `--flux-popover-fill` to neutral dark glass (`rgba(22, 22, 26, 0.6)` / `#16161a`).
   - Updated the default theme label and swatch in [`themes.ts`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/themes.ts) to "Default (Neutral Dark)".
2. **Removed Colored Radial Gradients:**
   - Removed purple/magenta radial gradients (`rgba(accent-ai-rgb, ...)`, `rgba(accent-hot-rgb, ...)`) from `body` and `.shell` in [`theme.css`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/theme.css).
3. **Pure Acrylic Window Transparency:**
   - Set `body.window-acrylic`, `html.window-acrylic`, and `.shell.window-acrylic` to `background: transparent !important; background-image: none !important;` so the native DWM acrylic backdrop shines through cleanly without any colored wash or artificial saturation.
   - Refined chrome elements (titlebar, sidebar, rightstack) to neutral frosted translucency.
   - Ensured `.shell.window-acrylic .card` remains a solid, clean, neutral dark opaque surface (`#121215`).
4. **DWM Dark Mode Attribute:**
   - Added `DWMWA_USE_IMMERSIVE_DARK_MODE` (attribute 20) in `set_window_acrylic` in [`webview.rs`](file:///C:/Users/Razeen/Projects/flux/crates/flux-core/src/webview.rs) to prevent DWM from applying user system accent coloring.
5. **Rebuilt & Updated Installed Application:**
   - Rebuilt with `npx tauri build --no-bundle` and deployed the new binary to `AppData/Local/Programs/Flux/flux.exe`.

### Files Changed
- `apps/shell/src/theme.css`
- `apps/shell/src/themes.ts`
- `crates/flux-core/src/webview.rs`
- `PROGRESS.md`

## 2026-09-03: Update application icon to custom flux-icon.ico and perform full rebuild

### Problem
Update the application icon across platforms to the user-provided icon at `~/Downloads/flux-icon.ico` and execute a full rebuild of the application.

### Fix
1. **Icon Integration:**
   - Replaced `crates/flux-core/icons/icon.ico` with the user's custom `~/Downloads/flux-icon.ico` (verified via SHA256).
   - Extracted and regenerated matching platform icon assets (`icon.png`, `128x128.png`, `128x128@2x.png`, `32x32.png`, `64x64.png`, `Square*Logo.png`, `icon.icns`) via `npx tauri icon` so all icon manifests and targets stay synchronized.
2. **Full Application Rebuild & Installation Update:**
   - Compiled debug executable: `cargo build -p flux-core --bin flux` (`target/debug/flux.exe`).
   - Performed complete production build: `npx tauri build --no-bundle` (`target/release/flux.exe`), bundling the frontend distribution into the release binary with the new embedded Windows resource icon.
   - Updated the installed version at `AppData/Local/Programs/Flux/flux.exe` with backup (`flux.exe.bak`) and refreshed the Start Menu shortcut icon.
   - Verified icon extraction from `target/release/flux.exe` and the installed binary.

### Files Changed
- `crates/flux-core/icons/icon.ico`
- `crates/flux-core/icons/icon.png`
- `crates/flux-core/icons/icon.icns`
- `crates/flux-core/icons/*.png`
- `PROGRESS.md`

## 2026-09-03: Acrylic / Frosted translucent window setting with opaque main page

### Problem
Users wanted an acrylic, translucent, and frosted appearance for the Flux window frame/chrome while strictly preserving 100% opacity for the main page content card and webviews to avoid background interference or readability issues.

### Fix
1. **DWM Window Backdrop Control (Backend):**
   - Implemented `set_window_acrylic(app: AppHandle, enabled: bool)` in [`webview.rs`](file:///C:/Users/Razeen/Projects/flux/crates/flux-core/src/webview.rs).
   - Utilizes Windows 11 DWM backdrop API (`DwmSetWindowAttribute` with `DWMWA_SYSTEMBACKDROP_TYPE` set to `DWMSBT_TRANSIENTWINDOW = 3` for acrylic, or `DWMSBT_NONE = 1` for solid/default).
   - Included cross-platform/mobile no-op stubs and registered the command in `invoke_handler!` in [`lib.rs`](file:///C:/Users/Razeen/Projects/flux/crates/flux-core/src/lib.rs).
2. **Frontend IPC & Store Persistence:**
   - Added `win.setAcrylic(enabled: boolean)` in [`ipc.ts`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/ipc.ts) and mock in [`mock/tauri-core.ts`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/mock/tauri-core.ts).
   - Added `windowAcrylic` and `setWindowAcrylic` signals persisted to `localStorage` (`flux.window.acrylic`) in [`store.ts`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/store.ts).
3. **Reactive Window Shell & Class Management:**
   - Added reactive sync in [`App.tsx`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/App.tsx) toggling `.window-acrylic` on `document.documentElement`, `document.body`, and `.shell`, while dispatching `win.setAcrylic()`.
4. **Frosted Acrylic Glass Theme Styling:**
   - Added `.window-acrylic` styling rules in [`theme.css`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/theme.css):
     - `body.window-acrylic` and `html.window-acrylic` receive translucent backgrounds with `backdrop-filter: blur(...) saturate(...)`.
     - `.shell.window-acrylic`, `.titlebar`, `.sidebar`, and stack backgrounds become translucent and frosted.
     - **Constraint Enforcement:** `.shell.window-acrylic .card` explicitly maintains `background-color: var(--velvet-800) !important`, opaque gradients, and `opacity: 1 !important` so web pages and content cards stay completely solid and readable.
5. **Appearance Settings Toggle:**
   - Added a toggle row `"Acrylic / Frosted window"` under the Appearance section in [`SettingsPage.tsx`](file:///C:/Users/Razeen/Projects/flux/apps/shell/src/SettingsPage.tsx).

### Files Changed
- `crates/flux-core/src/webview.rs`
- `crates/flux-core/src/lib.rs`
- `apps/shell/src/ipc.ts`
- `apps/shell/src/mock/tauri-core.ts`
- `apps/shell/src/store.ts`
- `apps/shell/src/App.tsx`
- `apps/shell/src/SettingsPage.tsx`
- `apps/shell/src/theme.css`
- `PROGRESS.md`

## 2026-08-16: Add toggles and shortcuts for the nvim workspace / editor column

### Problem
Users needed convenient ways to toggle on/off the persistent nvim workspace / editor column beside the main page. While a command existed in the Command Palette, there was no keyboard shortcut, no dedicated sidebar footer button, and no entry in the Settings page.

### Fix
1. **Sidebar Footer Toggle:** Added a dedicated `<Icon name="editor" />` button to the sidebar footer (between Terminal and Agent buttons) that reflects active state and toggles `editorColOpen`.
2. **Keyboard Shortcut (`Ctrl+Shift+E` / `Cmd+Shift+E`):**
   - Added `"toggle-editor"` to `ShortcutAction` in `apps/shell/src/shortcuts.ts`.
   - Mirrored the chord in `crates/flux-core/assets/shortcuts.js` for native webviews.
   - Added `"toggle-editor"` to `terminalSafe` in `App.tsx` and handled the action in the `dispatch` loop.
3. **Settings Page:** Added a toggle row under the Appearance section in `SettingsPage.tsx`.
4. **Icons:** Added SVG geometry for `editor` icon adhering to the 24x24 grid in `Icon.tsx`.

### Files Changed
- `apps/shell/src/shortcuts.ts`
- `crates/flux-core/assets/shortcuts.js`
- `apps/shell/src/Icon.tsx`
- `apps/shell/src/Sidebar.tsx`
- `apps/shell/src/App.tsx`
- `apps/shell/src/SettingsPage.tsx`
- `PROGRESS.md`

## 2026-06-19: Fix file explorer hangs from blocking filesystem work

### Problem
Opening the built-in file explorer could still hang the app on Windows even
after the native-webview overlay fix. The symptom was not only click occlusion:
the app could stall while the Files view mounted.

### Root Cause
The Files mount path immediately did several filesystem operations that are
risky on Windows:

1. `fs_list` called `metadata()` for every directory entry, creating a per-entry
   stat storm. Cloud, shell, network, removable, or OneDrive-backed folders can
   block on those stats.
2. `fs_quick_locations` synchronously probed common folders, every drive letter,
   and WSL distributions.
3. `fs_watch` synchronously created and registered a native directory watcher.

### Fix
- Made the initial directory listing fast name/type data only. File size and
  modified time are now `null` until a future background metadata pass exists.
- Moved quick-location discovery onto the blocking runtime.
- Moved directory watcher creation onto the blocking runtime.
- Updated the frontend file-entry type and size rendering so unknown sizes show
  as `—` instead of fake `0 B`.

### Files Changed
- `crates/flux-core/src/files.rs`
- `apps/shell/src/FilesView.tsx`
- `apps/shell/src/ipc.ts`

## 2026-06-19: Move vault auto-unlock off the startup path

### Problem
Launching the Windows executable had noticeable startup latency.

### Root Cause
The password vault initialization synchronously contacted the OS keychain and
decrypted the vault during Tauri setup. On Windows this means Credential Manager
latency can delay the app becoming usable.

### Fix
- `VaultState::load` now reads only small metadata during setup.
- Keychain-mode auto-unlock and vault decrypt now run on a background thread.
- The backend emits `flux://vault-ready` when hydration finishes.
- Password UI surfaces refresh when the ready event arrives.

### Files Changed
- `crates/flux-core/src/vault.rs`
- `crates/flux-core/src/lib.rs`
- `apps/shell/src/ipc.ts`
- `apps/shell/src/Passwords.tsx`
- `apps/shell/src/VaultPage.tsx`

## 2025-06-19: Fix frozen file explorer panel

### Problem
The file explorer panel (files popout) appeared frozen/unresponsive when opened over a browser tab. The native webview (a separate OS layer) was staying on top of the DOM panel and eating all mouse clicks.

### Root Cause
The files panel relied on the `paneLayout` reactive path to hide the webview — returning `[]` from `paneLayout()` when `filesPanelOpen()` was true. But this doesn't work reliably: the show-effect that manages webview visibility could re-show the webview via other reactive triggers (e.g., `contentRect()` changes), and the webview would pop back on top.

### Fix
Mirrored the proven **command palette pattern** — imperative `webviewHide`/`webviewShow` calls:

1. **Added `openFilesPanel()` / `closeFilesPanel()` functions** that imperatively hide/show the active tab's native webview, matching the existing `openPalette()` / `closePalette()` pattern exactly.
2. **Guarded the show-effect** (line ~614) so it won't re-show a webview while `filesPanelOpen()` is true.
3. **Guarded `closePalette`** so it won't re-show the webview if the files panel is still covering it.
4. **Replaced all bare `setFilesPanelOpen()` calls** with the imperative wrappers (Esc handler, backdrop click, close button, onOpenInTab callback, sidebar toggle button).
5. **Threaded `onToggleFilesPanel` as a prop** to the `Sidebar` component since `openFilesPanel`/`closeFilesPanel` are local to `App`.
6. **Removed `filesPanelOpen()` from `paneLayout()`** (done in previous session) — the reactive approach was the wrong abstraction for native webview management.

### Files Changed
- `apps/shell/src/App.tsx`
