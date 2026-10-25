// Form help (Settings → Form help, off by default): the general half of
// Ghostfill. Click or Tab into an empty field and Flux's local model suggests
// what goes in it. A short field shows it as ghost text that Tab accepts; a
// long one (a textarea, a rich-text editor) gets it copied to the clipboard to
// paste. Esc or typing dismisses it, ⌃Space asks for a different one.
//
// formhelp.rs decides whether Flux helps on this page at all, and refuses
// password, card, one-time-code and personal-detail fields again whatever this
// script sends. Until it says yes, nothing here listens to the page.
//
// The clipboard write starts inside the click or keypress that focused the
// field, with its text arriving when the model answers: WebKit allows that and
// nothing else, so form help gives a page no clipboard power it doesn't have.
// Where WebKit says no (the page focused the field itself, or an http page),
// a long answer shows as ghost text instead.
(() => {
  "use strict";
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke || window.__FLUX_TAB_ID__ == null || window.__fluxFormHelp) return;
  window.__fluxFormHelp = true;
  // Taken before the page's own scripts run, so it can't swap them out.
  const clip = navigator.clipboard;
  const clipWrite = clip && clip.write ? clip.write.bind(clip) : null;
  const ClipItem = window.ClipboardItem;
  const NativeBlob = window.Blob;
  const setters = {
    INPUT: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
    TEXTAREA: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
  };

  let cfg = null;

  /* ---------------- which fields ---------------- */

  const BAD_TYPES = new Set([
    "password", "hidden", "checkbox", "radio", "submit", "reset", "button", "file", "image",
    "range", "color", "date", "datetime-local", "month", "week", "time", "number",
  ]);
  const BAD_AUTOCOMPLETE = /(^cc-|\scc-|one-time-code|current-password|new-password|webauthn)/i;
  const PERSONAL =
    /(e-?mail|phone|mobile|^tel$|zip|postcode|postal|address|street|suburb|city|province|country|dob|birth|ssn|tfn|nino|passport|licen[cs]e|credit|card|cvv|cvc|iban|bsb|account.?num|user.?name|first.?name|last.?name|full.?name|surname|given.?name|middle.?name|salary|otp|verification)/i;

  /** "input" | "textarea" | "contenteditable", or false. */
  function eligible(el, answered = false) {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    if (el.getAttribute("aria-readonly") === "true") return false;
    if (el.closest("[data-ghostfill-off], [data-flux-formhelp='off'], [data-sensitive]")) return false;
    let kind;
    if (el.tagName === "TEXTAREA") kind = "textarea";
    else if (el.tagName === "INPUT") {
      if (BAD_TYPES.has((el.getAttribute("type") || "text").toLowerCase())) return false;
      kind = "input";
    } else if (el.isContentEditable) kind = "contenteditable";
    else return false;
    const ac = el.getAttribute("autocomplete") || "";
    if (BAD_AUTOCOMPLETE.test(ac)) return false;
    // A form with a password in it is a sign-in or sign-up form: all of it is yours.
    const form = el.closest("form");
    if (form && form.querySelector('input[type="password"]')) return false;
    if (!answered) {
      const cur = kind === "contenteditable" ? el.textContent : el.value;
      if (cur && cur.trim()) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    if (cfg.skip_personal) {
      const sig = [el.name, el.id, ac, el.getAttribute("placeholder"), el.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ");
      if (PERSONAL.test(sig)) return false;
    }
    return kind;
  }
  const isLong = (kind) => kind === "textarea" || kind === "contenteditable";

  /* ---------------- reading the question ---------------- */

  const squash = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clamp = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const textOf = (node) => (node ? squash(node.innerText || node.textContent || "") : "");

  // Inputs that hold no answer: a hidden state field or a button beside each
  // field would make a question block look crowded and stop the climb early.
  const NON_FIELD = new Set(["hidden", "submit", "reset", "button", "image"]);
  const answerable = (e) =>
    !NON_FIELD.has((e.getAttribute("type") || "").toLowerCase()) && e.getClientRects().length > 0;

  function fieldLabel(el) {
    const byIds = (attr) =>
      squash(
        (el.getAttribute(attr) || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => textOf(document.getElementById(id)))
          .join(" "),
      );
    let t = byIds("aria-labelledby");
    if (t) return clamp(t, 300);
    if (el.id) {
      try {
        t = textOf(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
        if (t) return clamp(t, 300);
      } catch {
        // a malformed id
      }
    }
    t = textOf(el.closest("label"));
    if (t) return clamp(t, 300);
    t = squash(el.getAttribute("aria-label"));
    if (t) return clamp(t, 300);
    t = byIds("aria-describedby");
    if (t) return clamp(t, 300);
    // Form builders (Google Forms, Typeform, Qualtrics) put the question in a
    // plain div above the field, not a <label>.
    t = precedingText(el);
    if (t) return t;
    return clamp(squash(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name")), 300);
  }

  // The text just above the field, in document order, climbing a couple of
  // wrappers: the question is often a sibling of the field's container.
  function precedingText(el) {
    let node = el;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      const prior = [];
      let sib = node.previousElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
        if (sib.matches("input, textarea, select") || sib.querySelector("input, textarea, select")) break;
        const s = textOf(sib);
        if (s) prior.unshift(s);
      }
      if (prior.length) return clamp(prior.join(" — "), 300);
      node = node.parentElement;
    }
    return "";
  }

  // A radio group counts once. Stops at `limit`: the caller only asks "more than one?".
  function fieldCount(node, limit = 2) {
    const groups = new Set();
    let n = 0;
    for (const e of node.querySelectorAll("input, textarea, select")) {
      if (!answerable(e)) continue;
      if ((e.getAttribute("type") || "").toLowerCase() === "radio") {
        if (groups.has(e.name)) continue;
        groups.add(e.name);
      }
      if (++n >= limit) return n;
    }
    return n;
  }

  // The largest ancestor still holding just this one field is the question:
  // past it is the next question's text.
  function questionBlock(el) {
    let node = el.parentElement;
    let chosen = node;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      if (fieldCount(node) > 1) break;
      chosen = node;
      if (textOf(node).length > 900) break;
    }
    return chosen;
  }

  function questionContext(el) {
    const extras = [];
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend) extras.push(textOf(legend));
    // The nearest heading before the field.
    let heading = "";
    for (const h of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) heading = textOf(h);
      else break;
    }
    if (heading) extras.unshift(heading);
    return clamp([...new Set([...extras, textOf(questionBlock(el))])].filter(Boolean).join("\n"), 2500);
  }

  // Answers already on the form, so this one agrees with them.
  function otherAnswers(el) {
    if (!cfg.use_other_answers) return [];
    const scope = el.closest("form") || document.body;
    const out = [];
    const radios = new Set();
    for (const f of scope.querySelectorAll("input, textarea, select")) {
      if (out.length >= 8) break;
      if (f === el) continue;
      const type = (f.getAttribute("type") || "").toLowerCase();
      if (type === "password" || type === "hidden" || type === "file") continue;
      if (BAD_AUTOCOMPLETE.test(f.getAttribute("autocomplete") || "")) continue;
      let label;
      let value;
      if (type === "radio" || type === "checkbox") {
        if (!f.checked) continue;
        if (type === "radio") {
          if (radios.has(f.name)) continue;
          radios.add(f.name);
        }
        // The useful pair: the group's question and the chosen option.
        const legend = f.closest("fieldset")?.querySelector("legend");
        label = textOf(legend) || squash(f.closest('[role="radiogroup"]')?.getAttribute("aria-label")) ||
          precedingText(f.closest("label") || f);
        value = fieldLabel(f) || f.value;
      } else if (f.tagName === "SELECT") {
        const o = f.selectedOptions && f.selectedOptions[0];
        if (!o || (f.selectedIndex === 0 && (o.value === "" || o.disabled))) continue;
        label = fieldLabel(f);
        value = o.text;
      } else {
        label = fieldLabel(f);
        value = f.value;
      }
      value = squash(value);
      label = squash(label);
      if (!value || !label || value.length > 400) continue;
      out.push({ label: clamp(label, 200), value: clamp(value, 400) });
    }
    return out;
  }

  function describe(el, kind) {
    const max = Number(el.getAttribute("maxlength")) || 0;
    const form = el.closest("form");
    let rows = null;
    if (kind === "textarea") {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 20;
      rows = Number(el.getAttribute("rows")) || Math.max(1, Math.round(el.clientHeight / lh));
    } else if (kind === "contenteditable") {
      rows = 8;
    }
    return {
      kind,
      label: fieldLabel(el),
      context: questionContext(el),
      max_length: max > 0 ? max : null,
      rows,
      input_type: kind === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "",
      autocomplete: el.getAttribute("autocomplete") || "",
      name: el.getAttribute("name") || el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      page_title: squash(document.title),
      host: location.hostname,
      form_name: squash(form?.getAttribute("name") || form?.getAttribute("aria-label") || ""),
      siblings: otherAnswers(el),
    };
  }

  const signature = (el, kind) =>
    [kind, el.name || el.id, clamp(fieldLabel(el), 120), questionContext(el)].join("|");

  /* ---------------- the overlay ---------------- */

  const CSS_TEXT = `
    :host { all: initial; }
    .layer { position: fixed; z-index: 2147483646; pointer-events: none; overflow: hidden;
      box-sizing: border-box; contain: layout style paint; }
    .ghost { color: rgba(120,120,130,.62); white-space: pre-wrap; word-break: break-word;
      overflow: hidden; width: 100%; height: 100%; }
    .ghost.single { white-space: nowrap; display: flex; align-items: center; }
    .chip { position: fixed; z-index: 2147483647; pointer-events: none;
      font: 500 10px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: .04em; padding: 3px 6px; border-radius: 4px;
      background: rgba(28,28,32,.86); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
    .chip.error { background: rgba(150,40,40,.92); font-size: 11px; letter-spacing: 0; }
    .chip .dot { display: inline-block; width: 3px; height: 3px; border-radius: 50%;
      background: #fff; margin: 0 1px 1px; animation: p 1s infinite ease-in-out; }
    .chip .dot:nth-child(2) { animation-delay: .15s } .chip .dot:nth-child(3) { animation-delay: .3s }
    @keyframes p { 0%,100% { opacity: .3 } 50% { opacity: 1 } }`;

  let host;
  let layer;
  let ghostEl;
  let chipEl;
  let raf = null;

  function overlay() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-flux", "formhelp");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    layer = document.createElement("div");
    layer.className = "layer";
    ghostEl = document.createElement("div");
    ghostEl.className = "ghost";
    layer.appendChild(ghostEl);
    chipEl = document.createElement("div");
    chipEl.className = "chip";
    root.append(style, layer, chipEl);
    (document.body || document.documentElement).appendChild(host);
  }

  function place() {
    const el = state.field;
    if (!el || !el.isConnected) return dismiss();
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const l = px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const t = px(cs.borderTopWidth) + px(cs.paddingTop);
    const rr = px(cs.borderRightWidth) + px(cs.paddingRight);
    const b = px(cs.borderBottomWidth) + px(cs.paddingBottom);
    layer.style.left = `${r.left + l}px`;
    layer.style.top = `${r.top + t}px`;
    layer.style.width = `${Math.max(0, r.width - l - rr)}px`;
    layer.style.height = `${Math.max(0, r.height - t - b)}px`;
    for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "direction"]) {
      ghostEl.style[k] = cs[k];
    }
    // The chip hugs the right edge: centred on a one-line field, in the bottom
    // corner of a long one so it stays out of the ghost text.
    const w = chipEl.offsetWidth || 26;
    const h = chipEl.offsetHeight || 16;
    chipEl.style.left = `${r.right - px(cs.borderRightWidth) - w - 6}px`;
    chipEl.style.top = isLong(state.kind)
      ? `${r.bottom - px(cs.borderBottomWidth) - h - 6}px`
      : `${r.top + r.height / 2 - h / 2}px`;
  }

  function paint({ ghost = "", chip = "", error = false }) {
    overlay();
    layer.style.display = ghost ? "" : "none";
    ghostEl.className = isLong(state.kind) ? "ghost" : "ghost single";
    ghostEl.textContent = ghost;
    chipEl.className = error ? "chip error" : "chip";
    if (chip === "…") chipEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    else chipEl.textContent = chip;
    chipEl.style.display = chip ? "" : "none";
    if (raf !== null) cancelAnimationFrame(raf);
    const tick = () => {
      place();
      if (raf !== null) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    place();
  }

  function unpaint() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    if (!host || !host.isConnected) return;
    layer.style.display = "none";
    chipEl.style.display = "none";
    ghostEl.textContent = "";
  }

  /* ---------------- the clipboard ---------------- */

  // Begin a copy inside the user's click or keypress; its text comes later.
  // null where WebKit can't (no clipboard API, an insecure page).
  function startCopy() {
    if (!clipWrite || !ClipItem || !window.isSecureContext) return null;
    const c = { give: null, drop: null, refused: false, done: null };
    const text = new Promise((give, drop) => {
      c.give = give;
      c.drop = drop;
    });
    text.catch(() => {});
    try {
      const item = new ClipItem({ "text/plain": text.then((t) => new NativeBlob([t], { type: "text/plain" })) });
      c.done = clipWrite([item]);
    } catch {
      return null;
    }
    c.done.catch((e) => {
      // Not allowed: no click or keypress behind it. Dropped by us: no matter.
      if (e && e.name === "NotAllowedError") c.refused = true;
    });
    return c;
  }

  /* ---------------- what happens ---------------- */

  const state = { field: null, kind: null, status: "idle", text: null, copy: null, token: 0 };
  const cache = new Map();
  let timer = null;
  let errorTimer = null;
  const active = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const current = (el) => el && el.isConnected && document.visibilityState !== "hidden" && active() === el;

  function dismiss() {
    state.token++;
    if (state.copy) state.copy.drop(new Error("dismissed"));
    state.field = null;
    state.kind = null;
    state.status = "idle";
    state.text = null;
    state.copy = null;
    clearTimeout(timer);
    clearTimeout(errorTimer);
    unpaint();
  }

  function fail(msg) {
    state.status = "error";
    if (state.copy) state.copy.drop(new Error("failed"));
    state.copy = null;
    paint({ chip: msg, error: true });
    const token = state.token;
    errorTimer = setTimeout(() => token === state.token && state.status === "error" && dismiss(), 4000);
  }

  // `copy` was started in the gesture that brought us here, for a long field.
  async function request(el, kind, { avoid = null, copy = null } = {}) {
    const token = ++state.token;
    state.field = el;
    state.kind = kind;
    state.status = "loading";
    state.text = null;
    state.copy = copy;
    const sig = signature(el, kind);
    if (!avoid && cache.has(sig)) return show(el, kind, cache.get(sig), token);
    paint({ chip: "…" });
    let reply;
    try {
      reply = await invoke("plugin:fluxtab|formhelp_suggest", { field: describe(el, kind), avoid });
    } catch {
      if (token === state.token) fail("Form help isn't available");
      return;
    }
    if (token !== state.token || !current(el)) return;
    if (reply.status === "ok") {
      if (!avoid) {
        cache.set(sig, reply.text);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
      return show(el, kind, reply.text, token);
    }
    if (reply.status === "error") return fail(`Form help: ${reply.text}`);
    if (reply.status === "busy") return fail("Form help: too many requests, wait a moment");
    // none, refused, off or stale: nothing to show.
    dismiss();
  }

  async function show(el, kind, text, token) {
    const max = Number(el.getAttribute("maxlength")) || 0;
    if (max > 0 && text.length > max) text = text.slice(0, max);
    state.text = text;
    const copy = state.copy;
    if (isLong(kind) && copy && !copy.refused) {
      state.status = "copying";
      paint({ chip: "…" });
      copy.give(text);
      let copied = false;
      try {
        await copy.done;
        copied = true;
      } catch {
        // Refused after all: fall through to ghost text.
      }
      if (token !== state.token || !current(el)) return;
      if (copied) {
        state.status = "copied";
        state.copy = null;
        paint({ chip: navigator.platform.startsWith("Mac") ? "Copied · ⌘V to paste" : "Copied · Ctrl+V to paste" });
        setTimeout(() => token === state.token && state.status === "copied" && unpaint(), 2500);
        return;
      }
    }
    // A short field, or a long one where WebKit wouldn't copy: ghost text, Tab accepts.
    state.copy = null;
    state.status = "ghost";
    paint({ ghost: text, chip: "Tab" });
  }

  function setValue(el, value, kind) {
    if (kind === "contenteditable") {
      el.focus();
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, value);
      } catch {
        ok = false;
      }
      if (!ok) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      }
      return;
    }
    // Through the prototype's setter, so React and friends see the change.
    const d = setters[el.tagName];
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      el.setSelectionRange(value.length, value.length);
    } catch {
      // not every input has a selection
    }
  }

  function onFocusIn(e) {
    focusEpoch++;
    dismiss();
    if (cfg.trigger !== "focus") return;
    const el = e.target;
    const kind = eligible(el);
    if (!kind) return;
    // In the gesture, before the delay: the only moment WebKit allows the copy.
    const copy = isLong(kind) ? startCopy() : null;
    state.copy = copy;
    timer = setTimeout(() => {
      if (active() !== el || !eligible(el)) {
        if (copy) copy.drop(new Error("moved on"));
        return;
      }
      request(el, kind, { copy });
    }, Math.max(0, cfg.delay_ms || 0));
  }

  // A blur followed at once by a focus elsewhere belongs to the new field.
  let focusEpoch = 0;
  function onFocusOut() {
    const epoch = focusEpoch;
    setTimeout(() => {
      if (epoch === focusEpoch && active() !== state.field) dismiss();
    }, 60);
  }

  function onKeyDown(e) {
    // ⌃Space: an answer now, or a different one. Works on a filled field too.
    if (e.code === "Space" && e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = active();
      const kind = eligible(el, true);
      if (!kind) return;
      e.preventDefault();
      e.stopPropagation();
      const avoid = el === state.field && state.text ? state.text : null;
      const copy = isLong(kind) ? startCopy() : null;
      dismiss();
      request(el, kind, { avoid, copy });
      return;
    }
    if (e.key === "Escape" && state.field) {
      e.stopImmediatePropagation();
      dismiss();
      return;
    }
    if (state.status !== "ghost" || !state.text || !current(state.field)) return;
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = state.field;
      const kind = state.kind;
      const text = state.text;
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
      setValue(el, text, kind);
      return;
    }
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter") dismiss();
  }

  function onInput(e) {
    if (state.field && e.target === state.field && state.status !== "copied") {
      const v = state.kind === "contenteditable" ? e.target.textContent : e.target.value;
      if (v && v.trim()) dismiss();
    }
  }

  function attach() {
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && dismiss());
    addEventListener("blur", dismiss);
    addEventListener("pagehide", dismiss);
    // A field focused before we were listening (autofocus) gets its turn.
    const el = active();
    if (el && el !== document.body) onFocusIn({ target: el });
  }

  /** Run `fn` once the document exists. */
  const whenReady = (fn) => {
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  };

  // One question to Flux, once the document exists (the bridge at
  // document-created crashes WebView2; see drafts.js).
  whenReady(() => {
    invoke("plugin:fluxtab|formhelp_page_config", {})
      .then((c) => {
        if (c && typeof c === "object") {
          cfg = c;
          attach();
        }
      })
      .catch(() => {});
  });
})();
