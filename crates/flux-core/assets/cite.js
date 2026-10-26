// A cited passage, shown on its page (cite.rs): the body of an async function
// run in Flux's own JavaScript world (pagejs.rs), so the page neither sees it
// nor answers for it. ARGS is {"text": "…", "n": 2} to show passage 2, or
// {"clear": true}. Finds the passage whatever its whitespace (it came from
// innerText), highlights it without touching the page's DOM (CSS Custom
// Highlights), badges it with its number and scrolls it to the middle.
// Returns "shown", "not_found" or "cleared".
const ARGS = __ARGS__;
const NAME = "flux-cite";
const doc = document;
doc.getElementById("flux-cite-badge")?.remove();
window.__fluxCiteFollow?.disconnect();
const highlights = window.CSS && CSS.highlights;
if (highlights) highlights.delete(NAME);
if (ARGS.clear) return "cleared";
if (!doc.body) return "not_found";

if (!doc.getElementById("flux-cite-style")) {
  const st = doc.createElement("style");
  st.id = "flux-cite-style";
  st.textContent = `::highlight(${NAME}) { background-color: rgba(209, 0, 209, 0.2); }`;
  (doc.head || doc.documentElement).appendChild(st);
}

// The page's text with whitespace taken out, lowercased (innerText applies
// text-transform), and where each character came from.
const nodes = [];
const offs = [];
const idx = [];
let flat = "";
const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
  acceptNode(n) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
    return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
  },
});
for (let n; (n = walker.nextNode()); ) {
  const k = nodes.push(n) - 1;
  const d = n.data;
  for (let i = 0; i < d.length; i++) {
    if (/\s/.test(d[i])) continue;
    flat += d[i].toLowerCase();
    idx.push(k);
    offs.push(i);
  }
}
const needle = String(ARGS.text || "").replace(/\s+/g, "").toLowerCase();
if (!needle) return "not_found";
let at = flat.indexOf(needle);
let len = needle.length;
// A passage that changed a little since it was read: its opening still places it.
if (at < 0 && needle.length > 80) {
  at = flat.indexOf(needle.slice(0, 80));
  len = 80;
}
if (at < 0) return "not_found";

const range = doc.createRange();
range.setStart(nodes[idx[at]], offs[at]);
range.setEnd(nodes[idx[at + len - 1]], offs[at + len - 1] + 1);
if (highlights && window.Highlight) {
  highlights.set(NAME, new Highlight(range));
} else {
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const first = range.getClientRects()[0] || range.getBoundingClientRect();
scrollTo({ top: Math.max(0, first.top + scrollY - innerHeight / 3), behavior: "smooth" });

// The number, at the passage's start, in a closed shadow root the page's CSS
// can't reach. The range follows the text, so the badge follows the range
// whenever the layout moves (images arriving, a restyle, a resize).
const badge = doc.createElement("div");
badge.id = "flux-cite-badge";
badge.style.cssText = "all:initial;position:absolute;z-index:2147483646;pointer-events:none;";
const place = () => {
  const r = range.getClientRects()[0];
  if (!r) return;
  badge.style.left = `${Math.max(0, r.left + scrollX - 24)}px`;
  badge.style.top = `${r.top + scrollY + (r.height - 18) / 2}px`;
};
place();
// A resize moves it, and so does a change with no resize (a sidebar going
// away, a class or style flip): watched, not polled, so a still page costs
// nothing while the badge is up. One placement per frame at most.
let queued = false;
const soon = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    place();
  });
};
const obs = new ResizeObserver(soon);
obs.observe(doc.body);
const moved = new MutationObserver((records) => {
  // The badge's own moves are style changes too; they don't count.
  if (records.some((r) => r.target !== badge)) soon();
});
moved.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
window.__fluxCiteFollow = {
  disconnect() {
    obs.disconnect();
    moved.disconnect();
  },
};
const root = badge.attachShadow({ mode: "closed" });
const dot = doc.createElement("span");
dot.textContent = String(ARGS.n || "");
dot.style.cssText =
  "display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#d100d1;color:#fff;font:600 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)";
root.appendChild(dot);
doc.body.appendChild(badge);
return "shown";
