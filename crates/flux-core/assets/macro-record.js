// macro-record.js — record clicks + input changes while a macro recording is
// active (BACKLOG #67). Reports each step to Rust via the fluxtab
// `macro_record_step` command; navigations are captured backend-side. Inert
// unless window.__FLUX_MACRO_REC__ is set (stamped at init from the backend
// recording state, flipped live when you press Record). Selectors are
// best-effort (record/replay can't be perfect on changing pages).
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  function recording() {
    return !!window.__FLUX_MACRO_REC__;
  }
  function send(kind, selector, text) {
    try {
      inv("plugin:fluxtab|macro_record_step", { kind: kind, selector: selector, text: text || "" });
    } catch (e) {}
  }

  // Best-effort stable CSS selector: id → stable attribute → nth-of-type path.
  function sel(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var attrs = ["data-testid", "data-test", "aria-label", "name"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) return el.tagName.toLowerCase() + "[" + attrs[i] + '="' + v.replace(/"/g, '\\"') + '"]';
    }
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName !== "BODY" && node.tagName !== "HTML") {
      var s = node.tagName.toLowerCase();
      var parent = node.parentNode;
      if (parent) {
        var sibs = [];
        for (var j = 0; j < parent.children.length; j++) {
          if (parent.children[j].tagName === node.tagName) sibs.push(parent.children[j]);
        }
        if (sibs.length > 1) s += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      path.unshift(s);
      node = parent;
      if (path.length >= 5) break; // cap depth — long paths are brittle anyway
    }
    return path.join(" > ");
  }

  // Climb to a meaningful clickable target (button / link / role=button).
  function clickable(el) {
    var t = el;
    while (t && t.nodeType === 1 && t !== document.body) {
      if (/^(A|BUTTON)$/.test(t.tagName) || (t.getAttribute && t.getAttribute("role") === "button")) return t;
      t = t.parentNode;
    }
    return el;
  }

  document.addEventListener(
    "click",
    function (e) {
      if (!recording() || !e.target) return;
      var s = sel(clickable(e.target));
      if (s) send("click", s, "");
    },
    true,
  );

  document.addEventListener(
    "change",
    function (e) {
      if (!recording() || !e.target) return;
      var el = e.target;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el.type === "password") return; // never record passwords
      var s = sel(el);
      if (s) send("type", s, el.value || "");
    },
    true,
  );
})();
