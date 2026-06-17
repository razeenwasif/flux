// newtab.js — page-initiated new windows (BACKLOG: new-window/popup handling).
//
// Native child webviews don't honour window.open() / target="_blank" / modified
// clicks, so those silently do nothing. This forwards them to the chrome, which
// opens a real Flux tab (tab + webview lifecycle stays frontend-owned). Injected
// at document-start into every browser tab.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  // Ask Flux to open `url` in a new tab. `background` = don't steal focus.
  // Returns true if we handled it.
  function fluxOpen(url, background) {
    try {
      var abs = new URL(url, document.baseURI).href;
      if (!/^https?:/i.test(abs)) return false; // only real web URLs
      inv("plugin:fluxtab|chrome_open_url", { url: abs, background: !!background });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 1) window.open(url, …) → new tab. Return a minimal stub window so callers
  //    don't mistake the handoff for a blocked popup. (Real popup semantics —
  //    a live opener for OAuth handshakes — are out of scope here.)
  var nativeOpen = window.open;
  window.open = function (url, target, features) {
    if (url && fluxOpen(String(url), false)) {
      return {
        closed: false,
        close: function () {},
        focus: function () {},
        blur: function () {},
        postMessage: function () {},
        location: { href: "", replace: function () {}, assign: function () {} },
        document: null,
      };
    }
    try {
      return nativeOpen.apply(window, arguments);
    } catch (e) {
      return null;
    }
  };

  // 2) Anchor clicks: target="_blank", and middle-click / Ctrl+click / Cmd+click
  //    on any link → open in a (background) tab. Left-clicks on normal links are
  //    left alone so same-tab navigation works as usual.
  function anchorFrom(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === "A" && node.href) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onClick(e) {
    if (e.defaultPrevented) return;
    var a = anchorFrom(e.target);
    if (!a || !/^https?:/i.test(a.href)) return;

    var open = false;
    var background = false;
    if (e.type === "auxclick") {
      if (e.button !== 1) return; // middle-click only
      open = true;
      background = true;
    } else if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
      open = true; // modifier + left-click → new background tab
      background = true;
    } else if (a.target === "_blank") {
      open = true; // explicit new-window link → foreground tab
    }
    if (!open) return;

    if (fluxOpen(a.href, background)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
})();
