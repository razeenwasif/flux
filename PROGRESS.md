# Flux Progress

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
