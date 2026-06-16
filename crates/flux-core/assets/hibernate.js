// Tab-hibernation state preservation (BACKLOG #45 follow-up). Injected into
// every tab webview. Defines:
//   __fluxCapture()        — gather scroll + non-password form state and post it
//                            to Rust (held in RAM only, never written to disk).
//   __fluxRestore(state)   — re-apply it after a hibernated tab reloads.
// Password fields are never captured. The chrome captures a tab's state when you
// switch away from it (the page is frozen while backgrounded), so there's no
// race with the webview being destroyed at hibernation time.
(function () {
  function nativeSet(el, v) {
    try {
      var proto =
        el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, v);
      else el.value = v;
    } catch (e) {
      el.value = v;
    }
  }
  function find(f) {
    if (f.id) {
      var e = document.getElementById(f.id);
      if (e) return e;
    }
    if (f.name) {
      var list = document.getElementsByName(f.name);
      if (f.type === "radio" || f.type === "checkbox") {
        for (var i = 0; i < list.length; i++) if (list[i].value === f.v) return list[i];
      }
      return list[0] || null;
    }
    return null;
  }

  window.__fluxCapture = function () {
    try {
      var skip = { password: 1, hidden: 1, file: 1, submit: 1, button: 1, reset: 1, image: 1 };
      var els = document.querySelectorAll("input, textarea, select");
      var fields = [];
      for (var i = 0; i < els.length && fields.length < 250; i++) {
        var el = els[i];
        var type = (el.type || "text").toLowerCase();
        if (skip[type] || (!el.id && !el.name)) continue;
        var f = { id: el.id || "", name: el.name || "", type: type };
        if (type === "checkbox" || type === "radio") {
          f.v = el.value;
          f.c = !!el.checked;
          fields.push(f);
        } else if (el.value != null && el.value !== "") {
          f.v = el.value;
          fields.push(f);
        }
      }
      var state = JSON.stringify({
        u: location.origin + location.pathname,
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        f: fields,
      });
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (inv) inv("plugin:fluxtab|hibernate_capture", { tabId: window.__FLUX_TAB_ID__, state: state });
    } catch (e) {}
  };

  window.__fluxRestore = function (s) {
    try {
      if (!s) return;
      if (s.u && location.origin + location.pathname !== s.u) return; // different page now
      var f = s.f || [];
      for (var i = 0; i < f.length; i++) {
        var el = find(f[i]);
        if (!el) continue;
        if (f[i].type === "checkbox" || f[i].type === "radio") el.checked = !!f[i].c;
        else nativeSet(el, f[i].v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (typeof s.x === "number" || typeof s.y === "number") window.scrollTo(s.x || 0, s.y || 0);
    } catch (e) {}
  };
})();
