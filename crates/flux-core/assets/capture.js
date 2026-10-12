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

  // Rust keeps at most 1 MiB of HTML and 256 KiB of text. Cutting here as well
  // (in characters, so Rust's byte caps still apply) keeps a 15 MB DOM from
  // crossing IPC whole only to be thrown away.
  const HTML_CAP = 1048576;
  const TEXT_CAP = 262144;

  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;

  // What was sent last. A page re-renders far more often than it changes what
  // it shows (class churn, re-renders to identical output), and every send costs
  // an outerHTML serialization, a JSON message and Rust-side work.
  let last = null;
  const send = (force) => {
    if (!invoke) return;
    // innerText (not textContent): respects CSS visibility, so the agent and
    // the embedder read what the *user* sees.
    const text = (document.body ? document.body.innerText : "").slice(0, TEXT_CAP);
    const url = location.href;
    const title = document.title;
    // Structure as well as text: a login form can appear without new words.
    const nodes = document.getElementsByTagName("*").length;
    if (
      !force &&
      last &&
      last.url === url &&
      last.title === title &&
      last.nodes === nodes &&
      last.text === text
    ) {
      return;
    }
    last = { url, title, nodes, text };
    // Plain JSON args (NOT a raw body): real pages' CSPs block Tauri's
    // fetch IPC, forcing the postMessage path, which doesn't carry raw
    // bodies. `dom_publish` is the one command this remote page may call
    // (fluxtab plugin, granted by capabilities/tab.json).
    invoke("plugin:fluxtab|dom_publish", {
      tabId: TAB_ID,
      url,
      html: document.documentElement.outerHTML.slice(0, HTML_CAP),
      text,
      title,
    }).catch(() => {});
  };

  // Debounce with a max wait: 1 s of quiet, or at most every 10 s. A pure
  // trailing debounce never fired on a page that mutates more often than its
  // quiet window (JS animations, tickers, progress bars), and the load publish
  // shares the timer, so such a page was never captured at all. Nothing needs
  // these sooner: anything that reads a page asks it for a fresh capture first
  // (`recapture`, via dom::refresh).
  const flush = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = 0;
    send(false);
  };
  let timer = 0;
  let deadline = 0;
  // A background tab captures its first look at a page (history and the Trail
  // record visits from it) but not every change after: those wait until the tab
  // is shown, and then go out once.
  let hiddenChange = false;
  const publish = () => {
    if (!invoke) return;
    if (document.hidden && last && last.url === location.href) {
      hiddenChange = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 1000);
    if (!deadline) deadline = setTimeout(flush, 10000);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && hiddenChange) {
      hiddenChange = false;
      publish();
    }
  });

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
        // ones that change what is visible. (`style` churns on animated pages,
        // but `send` skips a capture whose text and structure didn't change, so
        // that costs a read, not a publish.)
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
    recapture: () => send(true),
    // Through the fluxtab plugin like every other page → Rust call: a raw
    // postMessage with a made-up `cmd` matched no command and was dropped.
    report(kind, detail) {
      if (!invoke) return;
      invoke("plugin:fluxtab|agent_report", {
        kind: String(kind),
        detail: String(detail ?? ""),
        format: "",
        payload: "",
      }).catch(() => {});
    },
    deliver(kind, format, payload) {
      if (!invoke) return;
      invoke("plugin:fluxtab|agent_report", {
        kind: String(kind),
        detail: "",
        format: String(format),
        payload: String(payload),
      }).catch(() => {});
    },
  });
})();
