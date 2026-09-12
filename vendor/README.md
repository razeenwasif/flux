# Tauri browser-content marker patch

`tauri/` is the published MIT/Apache-2.0 Tauri 2.11.2 crate. Its licenses are retained.
Only `src/manager/webview.rs` differs from the published source: do not inject
`window.isTauri` in Flux's `tab-*` and `panel-*` browser views. Keep the marker
in the shell. The IPC initialization and native capability enforcement are unchanged.

Proton's web client uses this generic marker to detect its own Tauri desktop
application, sending ordinary Flux web pages through desktop-only flows.
A page initialization script cannot remove the upstream non-configurable marker.
This small framework patch is applied before document scripts run and survives
navigation; it does not modify Proton code, subscriptions, or API responses.

When upgrading Tauri, rebase this one change and test shell/tab/panel markers,
keyboard IPC, Gmail, and Proton Mail. Cargo.lock pins the patched package.

Source diagnosis:
- https://github.com/ProtonMail/WebClients/blob/main/packages/shared/lib/helpers/desktop.ts
- https://github.com/ProtonMail/WebClients/blob/main/packages/shared/lib/apps/helper.ts

The first detects `window.isTauri`; the second chooses a platform desktop client
ID when that flag is present. Flux must allow the web client to retain its web ID.
