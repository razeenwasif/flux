// newtab.js — page-initiated new windows + a link context menu (BACKLOG #109).
//
// Native child webviews don't honour window.open() / target="_blank" / modified
// clicks, and the native right-click "open link in new tab" fires a new-window
// request Flux doesn't host — so all of those silently do nothing. This forwards
// them to the chrome, which opens a real Flux tab (tab + webview lifecycle stays
// frontend-owned), and replaces the native menu *for links* with a small Flux
// menu. Injected at document-start into every browser tab.
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

  // 3) Right-click on a link → a small Flux menu (open in new / background tab,
  //    copy link). Real pages get WebView2's native context menu, whose "open
  //    link in new tab" Flux can't host (no NewWindowRequested handler), so it
  //    silently did nothing. This replaces it *for links only* — right-clicking
  //    elsewhere keeps the native menu. Rendered inside a shadow root attached to
  //    the page (not Flux chrome), so page CSS can't restyle it and it doesn't
  //    fight the native-webview overlay.
  var menuHost = null;
  function closeMenu() {
    if (menuHost && menuHost.parentNode) menuHost.parentNode.removeChild(menuHost);
    menuHost = null;
    document.removeEventListener("scroll", closeMenu, true);
  }
  function openMenu(x, y, href) {
    closeMenu();
    menuHost = document.createElement("div");
    menuHost.style.cssText = "all:initial";
    var root = menuHost.attachShadow ? menuHost.attachShadow({ mode: "open" }) : menuHost;
    var box = document.createElement("div");
    box.style.cssText =
      "position:fixed;min-width:210px;padding:6px;border-radius:10px;z-index:2147483647;" +
      "background:rgba(20,20,28,0.96);color:#e8e8f0;font:13px/1.4 system-ui,-apple-system,sans-serif;" +
      "box-shadow:0 10px 34px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1)";
    [
      ["Open in new tab", function () { fluxOpen(href, false); }],
      ["Open in new background tab", function () { fluxOpen(href, true); }],
      ["Copy link", function () { try { navigator.clipboard && navigator.clipboard.writeText(href); } catch (e) {} }],
    ].forEach(function (it) {
      var b = document.createElement("button");
      b.textContent = it[0];
      b.style.cssText =
        "display:block;width:100%;text-align:left;padding:7px 10px;margin:0;border:0;border-radius:6px;" +
        "background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap";
      b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,0.09)"; });
      b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
      b.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); it[1](); closeMenu(); });
      box.appendChild(b);
    });
    root.appendChild(box);
    document.documentElement.appendChild(menuHost);
    // Clamp on-screen now that the box can be measured.
    var w = box.offsetWidth || 210, h = box.offsetHeight || 120;
    box.style.left = Math.max(0, Math.min(x, window.innerWidth - w - 8)) + "px";
    box.style.top = Math.max(0, Math.min(y, window.innerHeight - h - 8)) + "px";
    document.addEventListener("scroll", closeMenu, true);
  }

  function onCtx(e) {
    if (e.defaultPrevented) return; // a page with its own link menu wins
    var a = anchorFrom(e.target);
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); // suppress the native menu for this link
    openMenu(e.clientX, e.clientY, a.href);
  }
  document.addEventListener("contextmenu", onCtx);
  // Dismiss on an outside click (capture-phase, so it must skip clicks that land
  // on the menu — else it would close before the item handler runs) or Esc.
  document.addEventListener("click", function (e) {
    if (menuHost && e.target !== menuHost) closeMenu();
  }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); }, true);
})();
