// The agent's look at a page (agent.rs → steps.rs): the body of an async
// function run in Flux's own JavaScript world (pagejs.rs), so the page can't
// answer for it. ARGS below is filled in by Rust with {"selector": "…"} or {}.
// Returns PageFacts as JSON: whether a sign-in or CAPTCHA is in the way, a hash
// of the visible text to tell whether the page changed, and facts about the
// step's target, from which Rust decides what kind of step it is.
const ARGS = __ARGS__;
const doc = document;
const shown = (el) => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
};
const text = doc.body ? doc.body.innerText || "" : "";
let hash = 0;
for (let i = 0; i < Math.min(text.length, 60000); i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
const sign_in = [...doc.querySelectorAll("input[type=password]")].some(shown);
const captcha =
  !!doc.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form',
  ) || /verify (that )?you('re| are) (a )?human|are you a robot/i.test(text.slice(0, 6000));

let target = null;
if (ARGS.selector) {
  let el = null;
  // A ref from the accessibility tree (agent-tree.js), or a CSS selector.
  if (/^\d+:e\d+$/.test(ARGS.selector)) {
    el = globalThis.__fluxAx?.peek(ARGS.selector) || null;
  } else {
    try {
      el = doc.querySelector(ARGS.selector);
    } catch (_) {}
  }
  if (!el) {
    target = { found: false };
  } else {
    // The control a click on it would activate, for its name and kind.
    const ctl =
      el.closest(
        "button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [role=option]",
      ) || el;
    const attr = (n, a) => (n.getAttribute(a) || "").trim();
    // Every name it goes by, from the function the click guard uses
    // (__fluxNames, prepended by agent.rs): an icon button named only by its
    // image's alt is "Delete" here too, not unnamed (audit S10).
    const label = (__fluxNames(ctl) || (ctl !== el ? __fluxNames(el) : "") || attr(ctl, "placeholder"))
      .replace(/\s+/g, " ")
      .slice(0, 300);
    const type = attr(ctl, "type").toLowerCase();
    const form = ctl.form || ctl.closest("form");
    const submits =
      !!form &&
      ((ctl.tagName === "BUTTON" && (type === "" || type === "submit")) ||
        (ctl.tagName === "INPUT" && (type === "submit" || type === "image")));
    const rawHref = ctl.tagName === "A" ? attr(ctl, "href") : "";
    const href = rawHref && !/^(javascript:|#)/i.test(rawHref) ? ctl.href : "";
    const field = el.matches("input, textarea, select");
    const value = field
      ? el.type === "password"
        ? ""
        : el.tagName === "SELECT"
          ? String(el.selectedOptions[0]?.text ?? "").trim().slice(0, 500)
          : String(el.value).slice(0, 500)
      : el.isContentEditable
        ? (el.innerText || "").slice(0, 500)
        : "";
    const state =
      ["aria-expanded", "aria-checked", "aria-selected", "aria-pressed"].map((a) => attr(ctl, a)).join("|") +
      "|" +
      (ctl.checked ? "on" : "");
    // What a submit sends, and where (audit S9): the form's action and its
    // visible fields' values, shown on the commit card and part of the
    // fingerprint re-checked after you approve. Never a password's value.
    let form_action = "";
    let form_fields = "";
    if (submits && form) {
      form_action = (ctl.formAction || form.action || "").slice(0, 500);
      form_fields = [...form.elements]
        .filter((f) => f.name && f.type !== "hidden" && f.type !== "submit" && f.type !== "button" && shown(f))
        .slice(0, 12)
        .map((f) => {
          const v =
            f.type === "password"
              ? "••••"
              : f.type === "checkbox" || f.type === "radio"
                ? f.checked
                  ? "✓"
                  : "✗"
                : f.tagName === "SELECT"
                  ? String(f.selectedOptions[0]?.text ?? "")
                  : String(f.value ?? "");
          return `${f.name}=${v.replace(/\s+/g, " ").slice(0, 60)}`;
        })
        .join(", ")
        .slice(0, 600);
    }
    target = {
      found: true,
      form_action,
      form_fields,
      tag: el.tagName.toLowerCase(),
      role: attr(ctl, "role"),
      input_type: attr(el, "type").toLowerCase(),
      autocomplete: attr(el, "autocomplete").toLowerCase(),
      name: [attr(el, "name"), el.id].filter(Boolean).join(" ").slice(0, 200),
      label,
      href,
      submits,
      value,
      disabled: !!ctl.disabled || attr(ctl, "aria-disabled") === "true",
      state,
    };
  }
}
return JSON.stringify({ url: location.href, sign_in, captcha, text_len: text.length, text_hash: String(hash), target });
