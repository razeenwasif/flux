// Autofill injection (BACKLOG #61, ADR 0009). Filled values arrive from the
// Rust vault — they never pass through the chrome's JS. Defines __fluxFill(u,p);
// the caller appends the invocation with the credential as JSON args. Fills the
// page's login form (password + best-guess username) and fires a full event
// sequence so frameworks (React/Vue/Angular/etc.) register the value. Never
// submits. Returns true if a password field was filled (for diagnostics).
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
    if (!pw) return false;
    setVal(pw, p);

    // Username: nearest preceding text/email/username field, else the first one.
    var idx = inputs.indexOf(pw);
    var user = null;
    for (var j = idx - 1; j >= 0; j--) {
      var t = (inputs[j].type || "text").toLowerCase();
      var ac = (inputs[j].autocomplete || "").toLowerCase();
      if (t === "text" || t === "email" || t === "tel" || ac === "username" || ac === "email") {
        user = inputs[j];
        break;
      }
    }
    if (!user) {
      for (var k = 0; k < inputs.length; k++) {
        var t2 = (inputs[k].type || "text").toLowerCase();
        if (t2 === "text" || t2 === "email" || t2 === "tel") { user = inputs[k]; break; }
      }
    }
    if (user && u) setVal(user, u);
    return true;
  } catch (e) {
    return false;
  }
}
