// Autofill injection (BACKLOG #61, ADR 0009). Filled values arrive from the
// Rust vault — they never pass through the chrome's JS. Defines __fluxFill(u,p);
// the caller appends the invocation with the credential as JSON args. Fills the
// page's login form (password + best-guess username) and fires input/change so
// frameworks (React/Vue/etc.) register the value. Never submits.
function __fluxFill(u, p) {
  try {
    function setVal(el, v) {
      try {
        var proto = el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, "value");
        if (d && d.set) d.set.call(el, v);
        else el.value = v;
      } catch (e) {
        el.value = v;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    var pw = document.querySelector('input[type=password]:not([disabled])');
    if (!pw) return false;
    setVal(pw, p);
    // Username: nearest preceding text/email/username field, else the first one.
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
    var idx = inputs.indexOf(pw);
    var user = null;
    for (var i = idx - 1; i >= 0; i--) {
      var t = (inputs[i].type || "text").toLowerCase();
      var ac = (inputs[i].autocomplete || "").toLowerCase();
      if (t === "text" || t === "email" || ac === "username" || ac === "email") {
        user = inputs[i];
        break;
      }
    }
    if (!user) {
      for (var j = 0; j < inputs.length; j++) {
        var t2 = (inputs[j].type || "text").toLowerCase();
        if (t2 === "text" || t2 === "email") { user = inputs[j]; break; }
      }
    }
    if (user && u) setVal(user, u);
    return true;
  } catch (e) {
    return false;
  }
}
