// Autofill injection (BACKLOG #61, ADR 0009). Filled values arrive from the
// Rust vault — they never pass through the chrome's JS. Defines __fluxFill(u,p);
// the caller appends the invocation with the credential as JSON args. Fills the
// page's login form (password + best-guess username) and fires a full event
// sequence so frameworks (React/Vue/Angular/etc.) register the value. Never
// submits. Returns "both" | "password" | "username" | "none" (for diagnostics).
//
// Two-step sign-in (Microsoft Entra, Google, most university SSO) shows the
// username field FIRST and the password only on the next screen. Filling only
// when a password field exists meant those pages silently did nothing, so each
// field is filled independently of the other.
function __fluxFill(u, p) {
  try {
    // Set a field's value so a framework's controlled input actually adopts it:
    // use the native prototype setter (React tracks it), temporarily clearing
    // readOnly, then fire the whole key/input/change/blur sequence different
    // frameworks listen on. Focus first — some sites ignore input while blurred.
    function setVal(el, v) {
      try { el.focus(); } catch (e) {}
      var ro = el.readOnly;
      try { el.readOnly = false; } catch (e) {}
      try {
        var proto = el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, "value");
        if (d && d.set) d.set.call(el, v);
        else el.value = v;
      } catch (e) {
        try { el.value = v; } catch (e2) {}
      }
      ["keydown", "keypress", "input", "keyup", "change"].forEach(function (type) {
        try {
          var ev = type === "input"
            ? new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" })
            : new Event(type, { bubbles: true });
          el.dispatchEvent(ev);
        } catch (e) {}
      });
      // Deliberately no blur() — some sites clear/validate on blur; input+change
      // while focused already commits for React/Vue/Angular.
      try { el.readOnly = ro; } catch (e) {}
    }

    // Every <input>, piercing shadow roots — many login widgets are web
    // components whose fields a plain document.querySelector can't see.
    function walk(root, out) {
      if (!root) return;
      var els;
      try { els = root.querySelectorAll("*"); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) {
        if (els[i].tagName === "INPUT") out.push(els[i]);
        if (els[i].shadowRoot) walk(els[i].shadowRoot, out);
      }
    }

    // The top document plus any same-origin (i)frames — cross-origin frames
    // throw on access and are skipped (we can't and shouldn't fill those).
    function collectInputs() {
      var out = [];
      walk(document, out);
      var frames = document.querySelectorAll("iframe, frame");
      for (var i = 0; i < frames.length; i++) {
        try {
          var doc = frames[i].contentDocument;
          if (doc) walk(doc, out);
        } catch (e) {}
      }
      return out;
    }

    var inputs = collectInputs();
    var isPw = function (el) {
      if (el.disabled) return false;
      var t = (el.type || "").toLowerCase();
      var ac = (el.autocomplete || "").toLowerCase();
      return t === "password" || ac === "current-password" || ac === "new-password";
    };
    var pw = null;
    for (var i = 0; i < inputs.length; i++) {
      if (isPw(inputs[i])) { pw = inputs[i]; break; }
    }

    // Username: the nearest field PRECEDING the password when there is one
    // (disambiguates a login form from a search box above it), otherwise the
    // first plausible field on the page — which is the two-step SSO case.
    var visible = function (el) {
      if (el.disabled || el.readOnly) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    var isUser = function (el) {
      var t = (el.type || "text").toLowerCase();
      var ac = (el.autocomplete || "").toLowerCase();
      if (t === "hidden" || t === "password") return false;
      return t === "text" || t === "email" || t === "tel" ||
             ac === "username" || ac === "email";
    };
    var user = null;
    if (pw) {
      for (var j = inputs.indexOf(pw) - 1; j >= 0; j--) {
        if (isUser(inputs[j]) && visible(inputs[j])) { user = inputs[j]; break; }
      }
    }
    if (!user) {
      for (var k = 0; k < inputs.length; k++) {
        if (isUser(inputs[k]) && visible(inputs[k])) { user = inputs[k]; break; }
      }
    }

    // Fill each independently — a page with only one of the two is normal.
    var didPw = false, didUser = false;
    if (pw) { setVal(pw, p); didPw = true; }
    if (user && u) { setVal(user, u); didUser = true; }
    return didPw ? (didUser ? "both" : "password") : (didUser ? "username" : "none");
  } catch (e) {
    return "none";
  }
}
