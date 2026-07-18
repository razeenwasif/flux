// Draft capture (ADR 0011, opt-in — OFF by default). Watches text inputs and
// textareas and, after you pause typing, sends the field's text to Flux so a
// half-written reply survives a closed tab (it attaches to the page's Visit in
// the Trail). Privacy is structural, enforced BEFORE anything is read:
//   • asks the backend once whether capture is enabled — if not, no listeners
//     are attached at all;
//   • never reads password/hidden/file inputs, cc/OTP autocomplete fields,
//     [data-sensitive] fields, or ANY field inside a form containing a password
//     input (login/sign-up forms wholesale);
//   • the Rust side re-checks independently (field-name blocklist, Luhn card
//     filter, vault-host gate, private-tab gate) — this script is the first
//     gate, not the only one.
(() => {
  "use strict";
  const TAB_ID = window.__FLUX_TAB_ID__;
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke || TAB_ID == null) return;

  const SENSITIVE_NAME =
    /pass|pwd|card|cvv|cvc|otp|2fa|totp|secret|token|ssn|social|iban|routing|pin\b/i;
  const SENSITIVE_AC = /cc-|card|one-time-code|current-password|new-password/i;

  /** May we read this field at all? (Type/shape checks only — no value reads.) */
  const readable = (el) => {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t !== "text" && t !== "search" && t !== "url" && t !== "email") return false;
    }
    const meta = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""}`;
    if (SENSITIVE_NAME.test(meta)) return false;
    if (SENSITIVE_AC.test(el.getAttribute("autocomplete") || "")) return false;
    if (el.closest("[data-sensitive]")) return false;
    // A form with a password input is a credential form — skip it wholesale.
    const form = el.closest("form");
    if (form && form.querySelector('input[type="password"]')) return false;
    return true;
  };

  const label = (el) =>
    (el.name || el.id || el.getAttribute("aria-label") || el.placeholder || "field").slice(0, 60);

  const timers = new Map(); // element → debounce timer
  const send = (el) => {
    const text = el.value || "";
    if (text.trim().length < 12) return; // substantial drafts only
    invoke("plugin:fluxtab|draft_publish", {
      tabId: TAB_ID,
      field: label(el),
      text: text.slice(0, 4096),
    }).catch(() => {});
  };

  const attach = () => {
    document.addEventListener(
      "input",
      (e) => {
        const el = e.target;
        if (!readable(el)) return;
        clearTimeout(timers.get(el));
        timers.set(
          el,
          setTimeout(() => send(el), 1500), // after a pause, not per keystroke
        );
      },
      { capture: true, passive: true },
    );
  };

  // One enablement check at load; the toggle applies to newly-loaded pages.
  invoke("plugin:fluxtab|trace_drafts_enabled", {})
    .then((on) => {
      if (on === true) attach();
    })
    .catch(() => {});
})();
