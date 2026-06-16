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

  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;

  let timer = 0;
  const publish = () => {
    if (!invoke) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = snapshot();
      // Plain JSON args (NOT a raw body): real pages' CSPs block Tauri's
      // fetch IPC, forcing the postMessage path, which doesn't carry raw
      // bodies. `dom_publish` is the one command this remote page may call
      // (fluxtab plugin, granted by capabilities/tab.json).
      invoke("plugin:fluxtab|dom_publish", {
        tabId: TAB_ID,
        url: s.url,
        html: s.html,
        text: s.text,
        title: s.title,
      }).catch(() => {});
    }, 400); // debounce: SPA mutation storms → at most ~2 snapshots/s
  };

  // Capture on load + history navigation. The MutationObserver needs a DOM
  // root, which doesn't exist yet at injection time (document_start).
  addEventListener("load", publish);
  addEventListener("popstate", publish);
  const startObserver = () => {
    if (document.documentElement) {
      new MutationObserver(publish).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  };
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }

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
