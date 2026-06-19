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

  var host = null;
  function promote() {
    try { inv("plugin:fluxtab|peek_promote", { url: location.href }); } catch (e) {}
  }
  function close() {
    try { inv("plugin:fluxtab|peek_close"); } catch (e) {}
  }
  function pin() {
    try { inv("plugin:fluxtab|peek_pin"); } catch (e) {}
    if (host && host.parentNode) host.parentNode.removeChild(host); // kept window → drop the bar
    host = null;
  }

  // Keyboard (capture so the page can't swallow it): Esc dismisses,
  // Ctrl/⌘+Enter promotes to a tab.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); promote(); }
  }, true);

  // A small floating bar, isolated from page CSS in a shadow root.
  function addBar() {
    if (!document.documentElement || host) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;top:10px;right:12px;z-index:2147483647;display:flex;gap:6px;" +
      "padding:5px;border-radius:999px;background:rgba(18,18,26,0.92);" +
      "box-shadow:0 4px 18px rgba(0,0,0,0.45);backdrop-filter:blur(6px);" +
      "font:600 12px/1 system-ui,-apple-system,sans-serif;";
    var mk = function (label, color, title, fn) {
      var b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        "padding:6px 11px;border:0;border-radius:999px;background:transparent;color:" + color +
        ";font:inherit;cursor:pointer;";
      b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,0.08)"; });
      b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
      b.addEventListener("click", fn);
      return b;
    };
    bar.appendChild(mk("⊕ Open as tab", "#7cf5b0", "Promote to a real tab (Ctrl/⌘+Enter)", promote));
    bar.appendChild(mk("📌 Pin", "#9d8df1", "Keep this window (stop floating on top)", pin));
    bar.appendChild(mk("✕", "#e8e8f0", "Close (Esc)", close));
    root.appendChild(bar);
    document.documentElement.appendChild(host);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addBar);
  } else {
    addBar();
  }
})();
