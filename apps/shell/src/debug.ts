// Lets the agent "see" Flux's own UI for debugging (#4): inspect an element's
// computed style/visibility, dump the CSS theme variables, etc. SolidJS signals are
// closures so arbitrary runtime signal reads aren't possible without instrumentation
// — this covers the practical cases (CSS not applying, element hidden/mis-sized).

const STYLE_PROPS = [
  "display",
  "visibility",
  "opacity",
  "position",
  "z-index",
  "pointer-events",
  "width",
  "height",
  "color",
  "background-color",
  "border",
  "border-radius",
  "font-size",
  "font-family",
  "transform",
  "overflow",
  "margin",
  "padding",
];

/** Inspect the first element matching `selector`: visibility, box, computed style. */
export function inspectElement(selector: string): string {
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return `“${selector}” isn't a valid CSS selector.`;
  }
  if (!el) {
    const count = (() => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    })();
    return `No element matches “${selector}” (querySelectorAll → ${count}). It may not be rendered (a <Show>/route that's off) or the selector is wrong.`;
  }
  const all = (() => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 1;
    }
  })();
  const cs = getComputedStyle(el as HTMLElement);
  const rect = (el as HTMLElement).getBoundingClientRect();
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    cs.display !== "none" &&
    cs.visibility !== "hidden" &&
    cs.opacity !== "0";
  const cls =
    typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  const styles = STYLE_PROPS.map((p) => `  ${p}: ${cs.getPropertyValue(p).trim()}`).join("\n");
  const note = !visible
    ? `\nNOT VISIBLE — ${cs.display === "none" ? "display:none" : cs.visibility === "hidden" ? "visibility:hidden" : cs.opacity === "0" ? "opacity:0" : "zero size"}.`
    : "";
  return [
    `Element: ${selector}  (${all} match${all === 1 ? "" : "es"})`,
    `Tag: <${el.tagName.toLowerCase()}>${cls}`,
    `Visible: ${visible}  ·  box: ${Math.round(rect.width)}×${Math.round(rect.height)} at (${Math.round(rect.x)}, ${Math.round(rect.y)})${note}`,
    `Computed style:`,
    styles,
  ].join("\n");
}

/** Enumerate the CSS custom properties declared on :root (+ their resolved values).
 *  If `name` is given, return just that one (with or without the leading --). */
export function themeVarsDump(name?: string): string {
  const root = getComputedStyle(document.documentElement);
  if (name) {
    const v = name.startsWith("--") ? name : `--${name}`;
    const val = root.getPropertyValue(v).trim();
    return val ? `${v} = ${val}` : `${v} is not set on :root (typo? or a local override on an element).`;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    } // cross-origin sheet
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.split(",").some((s) => s.trim() === ":root")) {
        const st = rule.style;
        for (let i = 0; i < st.length; i++) {
          const n = st.item(i);
          if (n.startsWith("--") && !seen.has(n)) {
            seen.add(n);
            out.push(`  ${n}: ${root.getPropertyValue(n).trim()}`);
          }
        }
      }
    }
  }
  out.sort();
  return out.length
    ? `CSS theme variables (:root):\n${out.join("\n")}`
    : "No :root custom properties found (stylesheets may be cross-origin).";
}
