// Flux capture bridge — injected into every TAB webview (not the chrome) as
// a Tauri initialization script. It is the ONLY code Flux runs in page
// context besides compiled agent actions, and it exposes exactly two
// callbacks under window.__FLUX__.
//
// Snapshots flow: page → postMessage to the chrome webview → ipc.domPublish()
// (raw ArrayBuffer) → Rust dom_cache. Debounced: mutation storms on SPAs must
// not saturate IPC.
(() => {
  "use strict";
  const TAB_ID = window.__FLUX_TAB_ID__; // stamped by flux-core at injection

  const snapshot = () => ({
    html: document.documentElement.outerHTML,
    // innerText (not textContent): respects CSS visibility, so the agent and
    // the embedder read what the *user* sees.
    text: document.body ? document.body.innerText : "",
    url: location.href,
    title: document.title,
  });

  let timer = 0;
  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = snapshot();
      // Zero-copy raw body: `outerHTML \0 visibleText` as an ArrayBuffer, tab
      // id + url in headers (matches the dom_publish command signature).
      // `dom_publish` is exposed via the inlined `fluxtab` plugin so this
      // remote page is allowed to call it (capabilities/tab.json grants
      // fluxtab:default to tab-* webviews); no other command is reachable.
      const body = new TextEncoder().encode(`${s.html}\0${s.text}`);
      window.__TAURI_INTERNALS__?.invoke?.("plugin:fluxtab|dom_publish", body, {
        headers: { "x-flux-tab": String(TAB_ID), "x-flux-url": s.url },
      });
    }, 400); // debounce: SPA mutation storms → at most ~2 snapshots/s
  };

  // Capture on load, on history navigation, and on meaningful DOM mutation.
  addEventListener("load", publish);
  addEventListener("popstate", publish);
  new MutationObserver(publish).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Feedback channel for compiled agent actions (see flux-agent/src/compile.rs).
  window.__FLUX__ = Object.freeze({
    report(kind, detail) {
      window.__TAURI_INTERNALS__?.postMessage?.({ cmd: "flux-agent-report", tab: TAB_ID, kind, detail });
    },
    deliver(kind, format, payload) {
      window.__TAURI_INTERNALS__?.postMessage?.({ cmd: "flux-agent-deliver", tab: TAB_ID, kind, format, payload });
    },
  });
})();
