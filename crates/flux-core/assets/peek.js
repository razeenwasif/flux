// peek.js — injected into a Peek / glance window (BACKLOG #50).
//
// A peek is a transient, always-on-top floating window showing a link without
// committing it to a tab. This adds the two affordances a peek needs on top of
// the page: an "⊕ Open as tab" pill (promote the current URL to a real Flux tab,
// then close), and Esc to dismiss. Both go through the fluxtab bridge; the Rust
// side guards them so only peek-* windows can act.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  function promote() {
    try { inv("plugin:fluxtab|peek_promote", { url: location.href }); } catch (e) {}
  }
  function close() {
    try { inv("plugin:fluxtab|peek_close"); } catch (e) {}
  }

  // Esc dismisses the peek (capture so the page can't swallow it).
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  }, true);

  // A small floating "open as tab" pill, isolated from page CSS in a shadow root.
  function addPill() {
    if (!document.documentElement) return;
    var host = document.createElement("div");
    host.style.cssText = "all:initial";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var btn = document.createElement("button");
    btn.textContent = "⊕ Open as tab";
    btn.style.cssText =
      "position:fixed;top:10px;right:12px;z-index:2147483647;padding:7px 13px;border:0;" +
      "border-radius:999px;background:rgba(18,18,26,0.92);color:#7cf5b0;" +
      "font:600 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.45);backdrop-filter:blur(6px);";
    btn.addEventListener("click", promote);
    root.appendChild(btn);
    document.documentElement.appendChild(host);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addPill);
  } else {
    addPill();
  }
})();
