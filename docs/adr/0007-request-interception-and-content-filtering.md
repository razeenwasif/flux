# ADR 0007 — Request interception & content filtering

| | |
|---|---|
| **Status** | Accepted (engine + WebView2 interceptor landed; runtime-pending on Windows; WebKitGTK follow-up) |
| **Date** | 2026-06-15 |
| **Deciders** | Flux Core Team |
| **Relates to** | BACKLOG #91 (interception layer), #57 (content blocker), #58 (HTTPS-only), #60 (fingerprint/script blocking) |

## Context

The content blocker (#57) and HTTPS-only mode (#58) both need to **inspect, block,
or redirect network requests per tab**. Flux renders pages in *native* webviews
(WebView2 on Windows, WebKitGTK on Linux), **not** a Chromium network stack — so
there is no `webRequest` / `declarativeNetRequest` API to lean on. We need our
own interception layer, plus a matching engine, shared by #57 and #58.

## Decision

Split into a **portable matching engine** (tested) and a **thin native
interceptor** (per backend), bridged by one Rust call.

### 1. Matching engine — `flux-filter` (landed)

A new crate wrapping Brave's **`adblock`** engine. It parses EasyList/uBO filter
syntax and answers `Filter::should_block(url, source_url, request_type) -> bool`
(plus cosmetic/element-hiding rules later). Pure Rust and deterministic, so the
*decisions* are unit-tested here — independent of any webview. This is the single
source of truth for #57, and the request-rewrite policy for #58 hangs off the
same per-request hook.

### 2. Interception point — native, via `Webview::with_webview`

Tauri v2 exposes the raw platform webview (`Webview::with_webview`), and
`webview2-com` + `webkit2gtk` are already in our dependency tree. Each tab
webview, at creation (`webview_open`), installs a request hook that calls
`flux-filter` and drops/redirects the response:

- **Windows / WebView2 (primary):** `ICoreWebView2::add_WebResourceRequested`
  with `AddWebResourceRequestedFilter("*", ALL)`. In the handler: read the URI +
  resource context → `should_block` → on block, set an empty `403`
  `WebResourceResponse` (`CreateWebResourceResponse`). #58 rewrites `http→https`
  in the same handler.
- **Linux / WebKitGTK (follow-up):** the clean WebKit path is a
  `WebKitUserContentFilter` compiled from rules, but that uses Safari's JSON rule
  format (not adblock's), so it doesn't share the engine; the engine-shared path
  is a web-process extension hooking `WebKitWebPage::send-request`. Deferred —
  WebView2 is the shipped target; WSL/WebKitGTK is the dev shell (see the WSL2
  multiwebview memo).

### Why native, not a local proxy

A local filtering proxy is cross-platform and more testable, **but** to see
HTTPS *URLs* (not just the CONNECT host) it needs TLS MITM — i.e. installing a
local CA cert, which is invasive and a trust footgun. Domain-only proxy blocking
(no MITM) was considered and rejected: no path-level or cosmetic filtering, and
the proxy still needs per-webview config that is itself platform-specific. The
native hook sees full URLs, keeps TLS end-to-end, and reuses one tested engine.

### 3. Policy layer — shields

`ShieldsState` (flux-core) sits in front of the engine: a **global** on/off plus
a **per-site allowlist** (turn shields off for a site), checked before matching,
with a blocked-request counter for the UI badge. Cosmetic (element-hiding) rules
are injected per page through the existing init-script path (the one already used
for `capture.js`).

### Rule sourcing

Ship a small **curated default list** (the major ad/tracker networks) bundled via
`include_str!` so blocking works offline on first run; fetching + caching the full
EasyList/uBO lists (and user-supplied lists) is the next increment.

## Consequences

- **+** The decision engine is fully unit-tested; #57 and #58 share it.
- **+** Full-URL + cosmetic filtering with TLS intact (vs a no-MITM proxy).
- **−** The interceptor shim is **native and per-backend** (WebView2 COM vs
  WebKitGTK), so it can't be unit-tested here — it must be verified on each
  backend at runtime. WebView2 (Windows) ships first; WebKitGTK follows.
- **−** The curated starter list is far smaller than full EasyList until the
  fetch/cache increment lands.
