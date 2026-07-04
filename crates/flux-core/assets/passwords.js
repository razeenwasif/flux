// Password sentinel (BACKLOG #61 follow-up): registration detection, strong-
// password suggestion, and one-click login autofill — injected into every tab
// webview at document start.
//
// Flow: scan for visible password fields (load + debounced MutationObserver,
// so SPAs count). Classify the form:
//   * REGISTRATION — autocomplete="new-password", two password fields in one
//     form, or signup wording near the form → "✦ Strong password" chip. Click
//     asks the Rust vault for a generated password (vault_suggest_password),
//     fills every password field in the form, and arms a submit hook that
//     saves {username, password} to the vault (vault_save_from_page).
//   * LOGIN — a lone password field → ask vault_page_info; if the vault is
//     unlocked and has a match for this host, show "🔑 Fill · user" which
//     triggers vault_fill_page (Rust injects the credential; it never passes
//     through this script).
//
// Security: top-level document only (no iframes — an embedded third party
// must never see chips or trigger fills); Rust identifies the calling tab
// from the webview label, so nothing here is trusted for identity; the
// suggested password exists here only long enough to fill the field.
(function () {
  "use strict";
  if (window.top !== window) return;
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;
  var call = function (cmd, args) { return inv("plugin:fluxtab|" + cmd, args || {}); };

  var chip = null;        // the single floating chip element
  var chipAnchor = null;  // the password field it's pinned to
  var dismissed = false;  // ✕ hides chips until the next navigation
  var handled = new WeakSet(); // fields we already filled/saved for

  // Set a field's value the framework-visible way (React/Vue track the
  // prototype setter + input/change events) — same trick as autofill.js.
  function setVal(el, v) {
    try {
      var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    var r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 10 && r.bottom > 0 && r.top < innerHeight + 400;
  }

  function pwFields() {
    return Array.prototype.filter.call(
      document.querySelectorAll('input[type="password"]'), visible);
  }

  function formOf(el) { return el.form || el.closest("form"); }

  // Best-guess username input for a password field: nearest preceding
  // text/email field in its form (fall back to the whole document).
  function usernameFieldFor(pw) {
    var scope = formOf(pw) || document;
    var inputs = Array.prototype.slice.call(scope.querySelectorAll("input"));
    var idx = inputs.indexOf(pw), i, t, ac;
    for (i = (idx < 0 ? inputs.length : idx) - 1; i >= 0; i--) {
      t = (inputs[i].type || "text").toLowerCase();
      ac = (inputs[i].autocomplete || "").toLowerCase();
      if (t === "email" || ac === "username" || ac === "email" || t === "text") return inputs[i];
    }
    return null;
  }

  var REG_WORDS = /sign\s*up|register|create\s+(an?\s+)?(new\s+)?account|get\s+started|join\s|registrieren|inscription/i;

  // Is this password field part of a REGISTRATION form (vs a login)?
  function isRegistration(pw) {
    if ((pw.autocomplete || "").toLowerCase() === "new-password") return true;
    var form = formOf(pw);
    var fields = form
      ? Array.prototype.filter.call(form.querySelectorAll('input[type="password"]'), visible)
      : pwFields();
    if (fields.length >= 2) return true; // password + confirm
    var probe = "";
    if (form) {
      probe += " " + (form.action || "") + " " + (form.id || "") + " " + (form.className || "");
      var btn = form.querySelector('button,[type="submit"]');
      if (btn) probe += " " + (btn.textContent || btn.value || "");
      probe += " " + (form.textContent || "").slice(0, 400);
    }
    probe += " " + location.pathname + " " + document.title;
    return REG_WORDS.test(probe);
  }

  // ── Chip UI ────────────────────────────────────────────────────────────────
  function removeChip() {
    if (chip) { chip.remove(); chip = null; chipAnchor = null; }
  }

  function placeChip() {
    if (!chip || !chipAnchor || !document.contains(chipAnchor)) { removeChip(); return; }
    var r = chipAnchor.getBoundingClientRect();
    if (r.width === 0) { chip.style.display = "none"; return; }
    chip.style.display = "flex";
    chip.style.top = Math.round(r.bottom + 4) + "px";
    chip.style.left = Math.round(Math.max(4, Math.min(r.left, innerWidth - 260))) + "px";
  }

  function showChip(anchor, icon, label, onClick) {
    removeChip();
    chipAnchor = anchor;
    chip = document.createElement("div");
    chip.id = "__flux_pw_chip";
    chip.style.cssText =
      "position:fixed;z-index:2147483646;display:flex;align-items:center;gap:7px;" +
      "padding:7px 11px;border-radius:9px;font:12.5px system-ui,sans-serif;" +
      "background:rgba(16,14,28,.96);color:#e8e6f4;border:1px solid rgba(47,243,255,.35);" +
      "box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;user-select:none;";
    var main = document.createElement("span");
    main.textContent = icon + " " + label;
    var x = document.createElement("span");
    x.textContent = "✕";
    x.style.cssText = "opacity:.55;padding-left:2px;";
    x.addEventListener("click", function (e) {
      e.stopPropagation();
      dismissed = true;
      removeChip();
    });
    chip.appendChild(main);
    chip.appendChild(x);
    chip.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep field focus
    main.addEventListener("click", onClick);
    document.documentElement.appendChild(chip);
    placeChip();
  }

  addEventListener("scroll", placeChip, { passive: true, capture: true });
  addEventListener("resize", placeChip, { passive: true });

  // ── Registration: suggest + save on submit ────────────────────────────────
  function offerSuggest(pw) {
    showChip(pw, "✦", "Use a strong password", function () {
      call("vault_suggest_password").then(function (generated) {
        var form = formOf(pw);
        var targets = form
          ? Array.prototype.filter.call(form.querySelectorAll('input[type="password"]'), visible)
          : [pw];
        targets.forEach(function (f) { setVal(f, generated); handled.add(f); });
        var save = function () {
          var userEl = usernameFieldFor(pw);
          call("vault_save_from_page", {
            username: (userEl && userEl.value) || "",
            password: generated,
          }).catch(function () {});
        };
        if (form) {
          // Save when the user actually signs up (username is filled by then).
          form.addEventListener("submit", save, { once: true, capture: true });
          showChip(pw, "✓", "Will be saved to your vault on sign-up", function () {});
        } else {
          save(); // no form to hook — save now; the entry is editable in the vault
          showChip(pw, "✓", "Saved to your vault", function () {});
        }
        setTimeout(removeChip, 4000);
      }).catch(function () {
        // Locked vault (master-password mode) — say why, don't half-work.
        showChip(pw, "🔒", "Unlock the Flux vault to suggest a password", function () {});
        setTimeout(removeChip, 4000);
      });
    });
  }

  // ── Login: one-click fill ──────────────────────────────────────────────────
  function offerFill(pw) {
    call("vault_page_info").then(function (info) {
      if (!info || !info.unlocked || !info.count) return;
      if (dismissed || pw.value) return; // re-check: the probe was async
      var who = info.username || "saved login";
      var extra = info.count > 1 ? " (+" + (info.count - 1) + ")" : "";
      showChip(pw, "🔑", "Fill · " + who + extra, function () {
        handled.add(pw);
        removeChip();
        call("vault_fill_page").catch(function () {});
      });
    }).catch(function () {});
  }

  // ── Scan loop ──────────────────────────────────────────────────────────────
  function scan() {
    if (dismissed) return;
    var fields = pwFields();
    if (!fields.length) { removeChip(); return; }
    var pw = fields[0];
    if (handled.has(pw) || pw.value) return;
    if (chip && chipAnchor === pw) { placeChip(); return; }
    if (isRegistration(pw)) offerSuggest(pw);
    else offerFill(pw);
  }

  var t = 0;
  function queueScan() {
    clearTimeout(t);
    t = setTimeout(scan, 600);
  }

  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "style", "class", "hidden", "disabled"],
  });
  addEventListener("focusin", function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="password"]')) queueScan();
  }, true);
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", queueScan);
  else queueScan();
})();
