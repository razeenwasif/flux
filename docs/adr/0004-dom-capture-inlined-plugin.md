# ADR 0004 — DOM Capture from Remote Pages via an Inlined Plugin

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-14 |
| **Deciders** | Flux Core Team |
| **Relates to** | BACKLOG #5 (DOM capture), ADR 0001 (zero-copy DOM pipeline) |

## Context

The Flux Agent and the DOM-aware terminal need the active page's DOM, captured
by `capture.js` (injected into every tab webview) and sent to the Rust
`dom_publish` command, which stores it in the `Arc<DomSnapshot>` cache.

But tab webviews load **remote** content (`https://…`). Tauri 2 **deliberately
blocks remote origins from invoking application commands** unless an explicit
`remote` capability grants them — confirmed in the Tauri source: *"This ensures
remote content can never reach custom commands unless an explicit `remote`
capability has been configured for them."* There is no auto-generated permission
for app commands, and declaring an app-level `AppManifest` to create one flips
ACL enforcement on for **all** ~27 app commands at once (each would then need an
`allow-<cmd>` permission, including the local chrome's).

## Decision

Expose **only** `dom_publish` through an **inlined plugin** named `fluxtab`
(`build.rs` → `InlinedPlugin::commands(&["dom_publish"]).default_permission(AllowAllCommands)`),
register it via `tauri::plugin::Builder::<Wry>::new("fluxtab")`, and grant it to
remote tab webviews with a scoped capability:

```json
// capabilities/tab.json
{ "webviews": ["tab-*"], "remote": { "urls": ["http://*", "https://*"] },
  "permissions": ["fluxtab:default"] }
```

`capture.js` calls `invoke("plugin:fluxtab|dom_publish", …)`. The command is
namespaced under the plugin, so it's grantable to remote origins without
declaring an app manifest.

### Why this over the alternative

The alternative (an app `AppManifest` listing every command) would force every
one of the ~26 other commands to be enumerated and permissioned, and impose a
"register each new command in three places" tax forever. The inlined plugin
touches exactly one command and leaves the local chrome's app commands
unrestricted (they remain local-origin-only, which Tauri allows by default).

## Security properties

- Tab webviews (arbitrary remote pages) are granted **exactly one** capability:
  `fluxtab:dom_publish`. They get **no** `core:window`, `core:webview`, or any
  other API — a hostile page cannot close the window, read the filesystem, or
  reach any other Flux command.
- `dom_publish` is write-only into the snapshot cache and validates its input
  (UTF-8, NUL-split). It returns nothing exploitable.
- The local chrome (the SolidJS shell) keeps calling its app commands freely
  (local origin, no manifest) — unchanged.

## Consequences

- **Positive:** minimal, auditable remote-command surface; the rest of the
  command set stays friction-free; compile-time validated (the capability
  resolves `fluxtab:default` at build).
- **Caveat:** the end-to-end path (remote page → `invoke` → `dom_publish` →
  cache) can only be confirmed in a running window; it builds and the ACL
  resolves, but runtime delivery needs `npm run dev` verification.
- Future capture-side commands (e.g. the agent's action-result channel) should
  join the `fluxtab` plugin so the remote surface stays in one audited place.
