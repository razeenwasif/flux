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
  console.log(
    "[flux capture] init tab=" + TAB_ID + " ipc=" + (invoke ? "yes" : "MISSING"),
  );

  let timer = 0;
  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!invoke) {
        console.warn("[flux capture] no __TAURI_INTERNALS__.invoke in this webview");
        return;
      }
      const s = snapshot();
      // Zero-copy raw body: `outerHTML \0 visibleText` as bytes, tab id + url in
      // headers. `dom_publish` is the one command this remote page may call
      // (fluxtab plugin, granted by capabilities/tab.json).
      const body = new TextEncoder().encode(`${s.html}\0${s.text}`);
      invoke("plugin:fluxtab|dom_publish", body, {
        headers: { "x-flux-tab": String(TAB_ID), "x-flux-url": s.url },
      }).then(
        () => console.log("[flux capture] published " + s.text.length + " chars (tab " + TAB_ID + ")"),
        (e) => console.error("[flux capture] dom_publish rejected:", e),
      );
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
