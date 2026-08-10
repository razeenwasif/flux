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
  const send = () => {
    if (!invoke) return;
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
  };

  const publish = () => {
    if (!invoke) return;
    clearTimeout(timer);
    timer = setTimeout(send, 400); // debounce: SPA storms → at most ~2 snapshots/s
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
        // Attributes too, or a page that renders "loading…" and then *reveals*
        // its content by flipping a class produces no observed mutation at all
        // — measured: childList and characterData both fire for that page, an
        // attribute flip fires nothing, and `innerText` respects CSS
        // visibility, so the captured text stays "loading…" forever.
        //
        // Filtered rather than blanket: every attribute would make an SPA's
        // hover and focus classes restart the debounce continuously, which is
        // the mutation storm the debounce exists to prevent. These four are the
        // ones that change what is visible.
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
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
    // Snapshot NOW, skipping the debounce. Called from Rust before the agent
    // reads the page: the observer can only react to signals it is given, and
    // a page can also finish rendering in the moment between the last mutation
    // and the question. Asking beats hoping the cache is current.
    recapture: send,
    report(kind, detail) {
      window.__TAURI_INTERNALS__?.postMessage?.({ cmd: "flux-agent-report", tab: TAB_ID, kind, detail });
    },
    deliver(kind, format, payload) {
      window.__TAURI_INTERNALS__?.postMessage?.({ cmd: "flux-agent-deliver", tab: TAB_ID, kind, format, payload });
    },
  });
})();
