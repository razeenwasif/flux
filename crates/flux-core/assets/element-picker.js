// Shields → "Hide an element" (netfilter.rs, macOS). The body of an async
// function run with WKWebView's callAsyncJavaScript in Flux's own content
// world: it shares the page's DOM but none of its scripts, so the page can't
// see the picker or fake a pick. Resolves with a CSS selector for the element
// the user clicks, or null for Esc / leaving the page.
return await new Promise((resolve) => {
  const doc = document;
  const root = doc.body || doc.documentElement;
  if (!root) return resolve(null);

  const host = doc.createElement("flux-picker");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .box, .tag, .tip { position: fixed; z-index: 2147483647; pointer-events: none; }
    .box { display: none; border: 2px solid #c9b5ff; background: rgba(201, 181, 255, 0.18);
      border-radius: 3px; box-sizing: border-box; }
    .tag { display: none; font: 600 11px/1 ui-monospace, Menlo, monospace; color: #1b1420;
      background: #c9b5ff; border-radius: 4px; padding: 3px 5px; max-width: 60vw;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tip { left: 50%; top: 14px; transform: translateX(-50%);
      font: 500 13px/1.3 -apple-system, system-ui, sans-serif; color: #f4eefc;
      background: #1b1420; border: 1px solid rgba(201, 181, 255, 0.35); border-radius: 10px;
      padding: 8px 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); white-space: nowrap; }
  </style><div class="box"></div><div class="tag"></div>
  <div class="tip">Click what to hide · ↑ takes its container · Esc cancels</div>`;
  const box = shadow.querySelector(".box");
  const tag = shadow.querySelector(".tag");
  root.appendChild(host);

  let current = null;
  const pickable = (el) =>
    !!el && el.nodeType === 1 && el !== host && el !== doc.documentElement && el !== doc.body;
  const show = (el) => {
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    tag.textContent = el.localName + (el.id ? `#${el.id}` : "");
    Object.assign(tag.style, {
      display: "block",
      left: `${Math.max(4, r.left)}px`,
      top: `${Math.max(4, r.top - 20)}px`,
    });
  };

  // A selector that names this element and, ideally, only it: a stable id if
  // there is one, else tag, classes and position up the tree until unique.
  // Ids and classes that look generated (long digit runs, hashes, state words)
  // change from one load to the next, so they're left out.
  const unique = (sel) => {
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const stable = (name) =>
    !/\d{4,}|[0-9a-f]{6,}\d|^(?:is|has)-|active|hover|focus|open|show|visible|selected/i.test(name);
  const selectorFor = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== doc.documentElement; e = e.parentElement) {
      if (e.id && stable(e.id) && unique(`#${CSS.escape(e.id)}`)) {
        parts.unshift(`#${CSS.escape(e.id)}`);
        return parts.join(" > ");
      }
      let part = e.localName;
      const classes = [...e.classList].filter(stable).slice(0, 3);
      if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
      const parent = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === e.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      if (unique(sel)) return sel;
    }
    return parts.join(" > ");
  };

  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onMove = (e) => {
    const el = doc.elementFromPoint(e.clientX, e.clientY);
    if (pickable(el) && el !== current) show(el);
  };
  const onClick = (e) => {
    swallow(e);
    if (!current) return;
    const sel = selectorFor(current);
    current.style.setProperty("display", "none", "important");
    finish(sel);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      swallow(e);
      finish(null);
    } else if (e.key === "ArrowUp" && current && pickable(current.parentElement)) {
      swallow(e);
      show(current.parentElement);
    }
  };
  const onScroll = () => current && show(current);
  const onLeave = () => finish(null);
  const presses = ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "contextmenu"];

  const finish = (sel) => {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("pagehide", onLeave, true);
    for (const t of presses) removeEventListener(t, swallow, true);
    host.remove();
    resolve(sel);
  };

  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", onScroll, true);
  addEventListener("pagehide", onLeave, true);
  for (const t of presses) addEventListener(t, swallow, true);
});
