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

  // Heartbeat: prove the script is running with a working bridge. Without it,
  // "never reported back" covers three very different things — not injected,
  // returned at the iframe gate, or no Tauri internals on this page — and the
  // diagnostic can't tell you which.
  call("vault_probe_report", { reason: "alive" }).catch(function () {});

  // Sensitive-input trigger (ADR 0013, Pillar 1): tell Rust the moment a
  // password field takes focus, so a wrong-origin warning can be raised BEFORE
  // the first keystroke rather than after the credential is already typed.
  // Fire-and-forget and deliberately answer-less: the page never learns whether
  // Flux is suspicious of it, so a phishing kit can't detect the guard and adapt.
  var focusWarned = false;
  var onSensitiveFocus = function () {
    if (focusWarned) return;   // once per page — this is a warning, not telemetry
    focusWarned = true;
    call("sentinel_input_focus").catch(function () {});
  };
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (t && t.tagName === "INPUT" && (t.type === "password" || t.autocomplete === "one-time-code")) {
      onSensitiveFocus();
    }
  }, true);

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

  // A vertical picker (same anchor/positioning as the chip) listing several
  // matching credentials; `onPick(item)` fires with the chosen {id,username,name}.
  function showMenu(anchor, items, onPick) {
    removeChip();
    chipAnchor = anchor;
    chip = document.createElement("div");
    chip.id = "__flux_pw_chip";
    chip.style.cssText =
      "position:fixed;z-index:2147483646;display:flex;flex-direction:column;gap:2px;" +
      "padding:6px;border-radius:9px;font:12.5px system-ui,sans-serif;min-width:180px;max-width:280px;" +
      "background:rgba(16,14,28,.97);color:#e8e6f4;border:1px solid rgba(47,243,255,.35);" +
      "box-shadow:0 6px 24px rgba(0,0,0,.45);user-select:none;";
    var head = document.createElement("div");
    head.textContent = "🔑 Choose a login";
    head.style.cssText = "opacity:.6;padding:2px 6px 4px;font-size:11.5px;";
    chip.appendChild(head);
    items.forEach(function (it) {
      var row = document.createElement("div");
      row.textContent = it.username || it.name || "saved login";
      row.title = it.name || "";
      row.style.cssText =
        "padding:6px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      row.addEventListener("mouseenter", function () { row.style.background = "rgba(47,243,255,.14)"; });
      row.addEventListener("mouseleave", function () { row.style.background = "transparent"; });
      row.addEventListener("click", function () { removeChip(); onPick(it); });
      chip.appendChild(row);
    });
    chip.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep field focus
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

  // ── Login: one-click fill (picker when >1 credential matches) ───────────────
  function fillFirst(pw) {
    handled.add(pw);
    removeChip();
    call("vault_fill_page").catch(function () {});
  }

  function offerFill(pw) {
    call("vault_page_info").then(function (info) {
      // `vault_page_info` collapses locked / blocked / no-match into one shape on
      // purpose (a hostile page must learn nothing). The chrome-side diagnostic
      // resolves which it was; here we only note that Rust said no.
      if (!info || !info.unlocked || !info.count) { reason("probe-failed"); return; }
      if (dismissed) { reason("dismissed"); return; }
      if (pw.value) { reason("field-prefilled"); return; } // re-check: probe was async
      reason("offered");
      var who = info.username || "saved login";
      var extra = info.count > 1 ? " (+" + (info.count - 1) + ")" : "";
      showChip(pw, "🔑", "Fill · " + who + extra, function () {
        if (info.count <= 1) return fillFirst(pw);
        // Several logins match this host — let the user choose which, rather
        // than silently filling the first. Fall back to the first if the
        // metadata fetch fails.
        call("vault_page_matches").then(function (list) {
          if (!list || list.length <= 1) return fillFirst(pw);
          showMenu(pw, list, function (it) {
            handled.add(pw);
            call("vault_fill_page_id", { id: it.id }).catch(function () {});
          });
        }).catch(function () { fillFirst(pw); });
      });
    }).catch(function () {});
  }

  // ── Manually-typed login → offer to save on submit ──────────────────────────
  // Fires for passwords Flux didn't itself generate or fill (those fields are in
  // `handled`). Rust decides whether it's genuinely new and, if so, raises the
  // chrome "Save password?" bar — so this is a fire-and-forget hint, never a UI
  // action here. Capture phase so a page that stops propagation can't hide it.
  function offerSaveOnSubmit(form) {
    var pw = Array.prototype.filter
      .call(form.querySelectorAll('input[type="password"]'), function (f) { return f.value && !handled.has(f); })[0];
    if (!pw) return;
    var userEl = usernameFieldFor(pw);
    call("vault_offer_save", { username: (userEl && userEl.value) || "", password: pw.value }).catch(function () {});
  }
  addEventListener("submit", function (e) {
    var form = e.target;
    if (form && form.tagName === "FORM") offerSaveOnSubmit(form);
  }, true);

  // ── Scan loop ──────────────────────────────────────────────────────────────
  // Breadcrumb for the chrome's "why didn't autofill offer here?" diagnostic.
  // Fire-and-forget, fixed vocabulary, no page content — Rust records the last
  // one per tab. Without it every bail below is invisible from outside the page.
  var lastReason = "";
  function reason(code) {
    if (code === lastReason) return; // don't spam on every mutation
    lastReason = code;
    call("vault_probe_report", { reason: code }).catch(function () {});
  }

  // The username field of a two-step sign-in (Microsoft/Google/university SSO),
  // where step 1 shows NO password input at all. Without this the offer never
  // fires on those pages — the fill path already handles them.
  function loneUserField() {
    var inputs = Array.prototype.filter.call(document.querySelectorAll("input"), visible);
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var t = (el.type || "text").toLowerCase();
      if (t !== "text" && t !== "email" && t !== "tel") continue;
      var ac = (el.autocomplete || "").toLowerCase();
      var probe = ((el.name || "") + " " + (el.id || "") + " " + ac).toLowerCase();
      if (ac === "username" || ac === "email" || /user|email|login|account|upn/.test(probe)) return el;
    }
    return null;
  }

  function scan() {
    if (dismissed) { reason("dismissed"); return; }
    var fields = pwFields();
    if (!fields.length) {
      removeChip();
      // No password box — but a two-step sign-in still wants the offer on its
      // username field, so try that before giving up.
      var u = loneUserField();
      if (!u) {
        // A login inside a cross-origin iframe is invisible to this script by
        // design (it only runs in the top document), and that's worth naming.
        reason(document.querySelector("iframe") ? "login-in-frame" : "no-login-field");
        return;
      }
      if (handled.has(u)) { reason("already-handled"); return; }
      if (u.value) { reason("field-prefilled"); return; }
      if (chip && chipAnchor === u) { placeChip(); reason("offered"); return; }
      offerFill(u);
      return;
    }
    var pw = fields[0];
    if (handled.has(pw)) { reason("already-handled"); return; }
    if (pw.value) { reason("field-prefilled"); return; }
    if (chip && chipAnchor === pw) { placeChip(); reason("offered"); return; }
    if (isRegistration(pw)) { reason("registration"); offerSuggest(pw); }
    else offerFill(pw);
  }

  // Debounce with a CEILING. A plain debounce starves on pages that mutate
  // faster than the delay — a React SSO form churns class/style constantly, so
  // every mutation cancelled the pending scan and it never ran at all (the
  // autofill chip simply never appeared, with nothing to show why). Wait for
  // quiet, but never defer longer than MAX_DEFER.
  var t = 0;
  var deferredSince = 0;
  var MAX_DEFER = 1800;
  function queueScan() {
    var now = Date.now();
    if (!deferredSince) deferredSince = now;
    clearTimeout(t);
    t = setTimeout(runScan, now - deferredSince > MAX_DEFER ? 0 : 600);
  }
  function runScan() {
    deferredSince = 0;
    scan();
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
