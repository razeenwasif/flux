# ADR 0008 — Flux mini-extension API & security model

| | |
|---|---|
| **Status** | Accepted — #92 (manifest + loader + registry) implemented; #93–95 pending |
| **Date** | 2026-06-15 |
| **Deciders** | Flux Core Team |
| **Relates to** | BACKLOG #96 (this ADR), #92 (manifest + loader), #93 (content scripts), #94 (API surface), #95 (manager UI). Builds on ADR 0007 (webview injection / with_webview). |

## Context

Flux renders pages in **native webviews** (WebView2 / WebKitGTK), not Chromium,
so **Chrome/WebExtensions cannot run** (no `chrome.*`, no CRX loading, no
isolated-world content-script runtime à la Chromium). We decided (2026-06-15) to
ship Flux's **own** curated, permissioned extension model rather than chase
WebExtensions compat or a raw userscript runtime. It must reuse the substrate we
already have: webview **initialization scripts** + **`with_webview`/eval**
injection (the same path as `capture.js` and the content blocker), and the
Rust-owned IPC surface.

Two native-webview realities shape the whole design:

1. **Isolated worlds are not portable.** WebKitGTK *can* inject a user script
   into a separate script world (`webkit_user_script_new_for_world`); **WebView2
   cannot** — its `AddScriptToExecuteOnDocumentCreated` runs in the page's main
   world. So we cannot assume content scripts are isolated from page JS on every
   backend.
2. **Pages have hostile CSPs.** A page's `connect-src` can block Tauri's
   fetch-based IPC (we hit exactly this with `capture.js` on DuckDuckGo/NYT),
   forcing the `postMessage` transport. Any extension↔Flux bridge must survive
   that, the same way `capture.js` does.

## Decision

A **manifest-declared, capability-gated** extension model where the *powerful
API lives in Rust* (a broker), never in the page. Content scripts are the only
part that runs in the webview, and they are treated as **untrusted relative to
the page** — so security never depends on page-world isolation we can't
guarantee.

### 1. Manifest — `flux.extension.json`

```jsonc
{
  "id": "com.example.reader",          // reverse-DNS, stable
  "name": "Reader",
  "version": "1.0.0",
  "permissions": ["dom:read", "ui:panel", "storage"],   // see §4
  "content_scripts": [
    { "matches": ["https://*/*"], "js": ["reader.js"], "css": ["reader.css"], "run_at": "document_idle" }
  ],
  "background": "bg.js",               // optional; runs in a hidden worker webview
  "ui": { "toolbar_button": { "title": "Reader", "icon": "icon.svg" } }
}
```

Loaded from a folder or zip; the registry persists alongside the session store
(#19). No remote auto-update in v1 — install is an explicit, local act.

### 2. Architecture: content scripts + a Rust broker

- **Content scripts** are injected via the existing init-script / eval path,
  scoped to `matches`. They can read/modify *their* page's DOM — that's their
  whole point and needs no special grant beyond a `dom:*` permission gate on the
  API calls.
- **The privileged API (`flux.*`) is implemented in Rust**, exposed as Tauri
  commands, and reached only through a **broker bridge**: a Flux-controlled init
  script (injected at `document_start`, before page scripts) that relays
  `postMessage` requests from content scripts to the broker and back. Using the
  `postMessage` transport (not direct `fetch` IPC) makes the bridge survive
  hostile page CSPs (the `capture.js` lesson).
- A **background script** (optional) runs in a **hidden Flux-owned webview** (a
  trusted origin we control), *not* in any page — so background logic that holds
  broader grants never shares a world with page JS.

### 3. Trust & isolation model (the crux)

Because content-script isolation isn't guaranteed on WebView2, **we do not trust
the content-script world to be private from the page.** The model is built so
that's acceptable:

- **The broker authenticates the *extension*, not the world.** At
  `document_start` the Flux init script (which runs before any page or extension
  script) mints a per-document, per-extension **capability token** and hands it
  only to that extension's content script, then removes the handshake hook. Each
  broker message must carry the token; the broker maps token → extension id →
  granted permissions. A page that later reads globals can't forge a token it
  never received, and can't widen permissions.
  - On **WebKitGTK** we additionally inject content scripts into a **dedicated
    script world**, so the token never touches the page world at all (defense in
    depth where the platform allows it).
  - On **WebView2** (no isolated world) the token-handshake is the boundary; we
    document this as a weaker guarantee than Chromium and keep the *capable*
    surface in Rust so a worst-case page-world leak still can't exceed the
    extension's own grants.
- **The broker is the only authority.** Content scripts have no ambient power:
  no raw Tauri `invoke`, no access to Flux internals — only `postMessage` to the
  broker, every call permission-checked.

### 4. Permissions (deny-by-default, granted at install)

Manifest `permissions` are shown to the user at install (consent) and enforced
per call by the broker. Initial set:

| Permission | Grants |
|---|---|
| `dom:read` | read the content script's own page DOM via `flux.dom` |
| `dom:write` | mutate it |
| `tabs` | `flux.tabs` query/open/navigate |
| `storage` | `flux.storage` — a per-extension KV namespace |
| `ui:panel` | contribute a side panel |
| `ui:toolbar` | a toolbar button |
| `net:<host>` | broker-mediated fetch to specific hosts (no blanket network) |

No permission ⇒ the call is rejected. Permissions are per-extension and never
transitive.

### 5. API surface (`flux.*`, sketched — detailed in #94)

`flux.tabs` (query/open/navigate, per grant) · `flux.dom` (read/inject in the
*granted* page) · `flux.storage` (per-extension KV) · `flux.ui` (side panel +
toolbar button + context-menu items) · `flux.events` (subscribe to tab/nav
events). Every method is a brokered, permission-checked Rust command.

### 6. Hard boundaries — what an extension can NEVER do

- Touch **another extension's** storage, scripts, or grants.
- Reach the **Flux chrome/shell webview** or call **raw Tauri IPC** (only the
  brokered `flux.*` surface).
- Get **blanket network/filesystem** access — only `net:<host>` grants and no
  filesystem API in v1.
- Act on **tabs/pages it has no grant for** (a content script is confined to
  pages matching its own `matches`).
- **Auto-update or run remote code** outside its installed bundle.

### 7. Storage

Per-extension KV, namespaced by extension id in a Rust-owned store
(`extensions/<id>/storage.json` in the app data dir), quota-capped. One extension
cannot read or enumerate another's keys.

## Consequences

- **+** The capable API is Rust-side and permission-gated, so security does not
  depend on page-world isolation we can't guarantee on WebView2.
- **+** Reuses the proven injection + `postMessage` IPC path (CSP-resilient).
- **+** A clean, reviewable surface — and a curated install flow — instead of an
  unbounded WebExtensions/userscript runtime.
- **−** Content-script isolation is **weaker on WebView2** than Chromium's
  isolated worlds; the token handshake mitigates but doesn't equal it. Documented
  and contained (the worst case is bounded by the extension's own grants).
- **−** Not WebExtensions-compatible — existing Chrome extensions won't run; the
  ecosystem starts from zero (first-party example extension in #95 seeds it).

## Rollout

#96 (this ADR) → **#92** manifest + loader (registry, enable/disable) → **#93**
content-script injection + the broker handshake/bridge → **#94** the permissioned
`flux.*` API → **#95** manager UI + a first-party example (e.g. a reader-mode or
an agent-powered page-summarizer).
