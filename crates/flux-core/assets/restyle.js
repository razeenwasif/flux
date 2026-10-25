// A drafted restyle, checked against its page and previewed (boosts.rs): the
// body of an async function run in Flux's own JavaScript world (pagejs.rs).
// ARGS is {"css": "…"} to check and preview, or {"clear": true}.
// WebKit's own CSS parser reads the draft (anything it can't parse is gone),
// rules whose selector matches nothing on the page are dropped, and what's
// left goes into a preview <style> until it's applied or discarded.
// Returns {"css": "…", "kept": n, "dropped": n} as JSON, or "cleared".
const ARGS = __ARGS__;
const doc = document;
const PREVIEW = "flux-boost-preview";
if (ARGS.clear) {
  doc.getElementById(PREVIEW)?.remove();
  return "cleared";
}
const sheet = new CSSStyleSheet();
sheet.replaceSync(String(ARGS.css || ""));
const kept = [];
let dropped = 0;
const matches = (sel) => {
  try {
    return doc.querySelector(sel) !== null;
  } catch {
    return false;
  }
};
for (const rule of sheet.cssRules) {
  if (rule instanceof CSSStyleRule) {
    if (rule.style.length && matches(rule.selectorText)) kept.push(rule.cssText);
    else dropped++;
  } else if (rule instanceof CSSMediaRule) {
    // A rule for some widths: kept when any of its rules finds something.
    const inner = [...rule.cssRules].filter((r) => r instanceof CSSStyleRule && matches(r.selectorText));
    if (inner.length) kept.push(rule.cssText);
    else dropped++;
  } else {
    dropped++;
  }
}
const css = kept.join("\n");
let st = doc.getElementById(PREVIEW);
if (!st) {
  st = doc.createElement("style");
  st.id = PREVIEW;
  (doc.head || doc.documentElement).appendChild(st);
}
st.textContent = css;
return JSON.stringify({ css, kept: kept.length, dropped });
