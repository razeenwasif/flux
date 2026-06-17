// Keyboard/mouse navigation (BACKLOG #51/#52): Vim-style link hints + scroll
// keys, and mouse gestures. Injected into every tab webview but INERT unless
// enabled — `window.__FLUX_NAV__ = { hints, gestures }` is stamped by the init
// script, and `window.__fluxNavSet(hints, gestures)` flips it live. Guards: never
// acts while typing in an input/textarea/contenteditable.
(function () {
  var nav = window.__FLUX_NAV__ || { hints: false, gestures: false };
  window.__fluxNavSet = function (hints, gestures) { nav.hints = !!hints; nav.gestures = !!gestures; };

  function editable(el) {
    if (!el) return false;
    var t = (el.tagName || "").toLowerCase();
    return t === "input" || t === "textarea" || t === "select" || el.isContentEditable;
  }
  var CHARS = "asdfghjklqwertyuiopzxcvbnm";
  var hintLayer = null, hints = [], typed = "";

  function clearHints() {
    if (hintLayer) hintLayer.remove();
    hintLayer = null; hints = []; typed = "";
  }
  function showHints() {
    clearHints();
    var sel = "a[href], button, [role=button], input:not([type=hidden]), textarea, select, [onclick], [tabindex]";
    var els = [].slice.call(document.querySelectorAll(sel));
    var vh = innerHeight, vw = innerWidth;
    var vis = els.filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }).slice(0, 200);
    if (!vis.length) return;
    hintLayer = document.createElement("div");
    hintLayer.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    var n = vis.length, len = n > 26 ? 2 : 1;
    vis.forEach(function (el, i) {
      var label = len === 1 ? CHARS[i] : CHARS[Math.floor(i / 26)] + CHARS[i % 26];
      label = label.toUpperCase();
      var r = el.getBoundingClientRect();
      var b = document.createElement("div");
      b.textContent = label;
      b.style.cssText = "position:absolute;left:" + (r.left + scrollX === r.left ? r.left : r.left) + "px;top:" + r.top +
        "px;transform:translate(-2px,-10px);background:#2ff3ff;color:#04121a;font:600 11px ui-monospace,monospace;" +
        "padding:1px 4px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.5);";
      hintLayer.appendChild(b);
      hints.push({ el: el, label: label, badge: b });
    });
    document.documentElement.appendChild(hintLayer);
  }
  function activate(h) {
    clearHints();
    var el = h.el, t = (el.tagName || "").toLowerCase();
    if (t === "input" || t === "textarea" || t === "select" || el.isContentEditable) el.focus();
    else el.click();
  }

  addEventListener("keydown", function (e) {
    if (!nav.hints || e.ctrlKey || e.metaKey || e.altKey) return;
    if (hintLayer) {
      if (e.key === "Escape") { e.preventDefault(); clearHints(); return; }
      if (e.key === "Backspace") { typed = typed.slice(0, -1); }
      else if (/^[a-zA-Z]$/.test(e.key)) { typed += e.key.toUpperCase(); }
      else return;
      e.preventDefault();
      var matches = hints.filter(function (h) { return h.label.indexOf(typed) === 0; });
      hints.forEach(function (h) { h.badge.style.opacity = h.label.indexOf(typed) === 0 ? "1" : "0.25"; });
      var exact = matches.filter(function (h) { return h.label === typed; });
      if (exact.length === 1) activate(exact[0]);
      else if (!matches.length) clearHints();
      return;
    }
    if (editable(document.activeElement)) return;
    var k = e.key;
    if (k === "f") { e.preventDefault(); showHints(); }
    else if (k === "j") { scrollBy(0, 64); }
    else if (k === "k") { scrollBy(0, -64); }
    else if (k === "G") { scrollTo(0, document.body.scrollHeight); }
    else if (k === "g") { // gg → top
      if (window.__fluxLastG && Date.now() - window.__fluxLastG < 400) scrollTo(0, 0);
      window.__fluxLastG = Date.now();
    }
  }, true);

  // ── Mouse gestures: hold right button + drag (L=back, R=forward, Down=reload).
  var gx = 0, gy = 0, gOn = false, gMoved = false;
  addEventListener("mousedown", function (e) {
    if (!nav.gestures || e.button !== 2) return;
    gOn = true; gMoved = false; gx = e.clientX; gy = e.clientY;
  }, true);
  addEventListener("mousemove", function (e) {
    if (gOn && (Math.abs(e.clientX - gx) > 30 || Math.abs(e.clientY - gy) > 30)) gMoved = true;
  }, true);
  addEventListener("mouseup", function (e) {
    if (!gOn || e.button !== 2) return;
    gOn = false;
    if (!gMoved) return;
    var dx = e.clientX - gx, dy = e.clientY - gy;
    if (Math.abs(dx) > Math.abs(dy)) { if (dx < 0) history.back(); else history.forward(); }
    else if (dy > 0) location.reload();
    else scrollTo(0, 0);
  }, true);
  addEventListener("contextmenu", function (e) {
    if (nav.gestures && gMoved) { e.preventDefault(); gMoved = false; }
  }, true);
})();
