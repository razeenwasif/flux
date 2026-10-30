/**
 * LaTeX in Indexer answers (#109): `$…$` and `$$…$$` set by KaTeX.
 *
 * **The node is the source of truth, not the rendering.** A math node is
 *
 *   <span|div class="sdoc-math" data-tex="\int_0^1 x^2 dx" contenteditable="false">…</span>
 *
 * with the TeX in `data-tex` and KaTeX's output as throwaway children, so a
 * node rendered before KaTeX loaded still knows what it says, and re-rendering
 * is skipped only while the source is unchanged.
 *
 * KaTeX is imported lazily. It's ~280 KB with fonts, and most answers have no
 * maths in them; nothing loads until one does.
 */

export const MATH_CLASS = "sdoc-math";
export const MATH_SEL = `.${MATH_CLASS}`;

/** Only the one call used here, so the module's default-vs-namespace shape
 *  (which differs between katex's types and its actual ESM build) doesn't leak
 *  into every call site. */
type Katex = { renderToString(tex: string, options?: Record<string, unknown>): string };
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

/** Load KaTeX once, on first use. */
export const loadKatex = (): Promise<Katex> => {
  if (katex) return Promise.resolve(katex);
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => {
    const mod = (m as { default?: Katex }).default ?? (m as unknown as Katex);
    katex = mod;
    return mod;
  });
  return loading;
};

/** Build the (unrendered) node. Rendering fills it in once KaTeX is ready. */
export const mathNode = (tex: string, display: boolean): HTMLElement => {
  const el = document.createElement(display ? "div" : "span");
  el.className = MATH_CLASS;
  el.dataset.tex = tex;
  if (display) el.dataset.display = "1";
  el.contentEditable = "false";
  // Shown until KaTeX lands, and the permanent content if it never does.
  el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
  return el;
};

/**
 * Render every math node under `root` that isn't already rendered.
 *
 * Errors are *not* thrown: a model's LaTeX is sometimes malformed, and an
 * answer that blanked (or threw into the console) over one bad formula would be
 * worse than showing it. The node shows its own source in red instead.
 */
export const renderMath = async (root: ParentNode): Promise<void> => {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(MATH_SEL));
  const pending = nodes.filter((n) => n.dataset.rendered !== n.dataset.tex);
  if (!pending.length) return;

  const k = await loadKatex();
  for (const el of pending) {
    const tex = el.dataset.tex ?? "";
    const display = el.dataset.display === "1";
    try {
      el.innerHTML = k.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        // `strict: false` keeps KaTeX from refusing input it merely disapproves
        // of (unicode in maths, \newline).
        strict: false,
        trust: false,
      });
      el.classList.remove("sdoc-math-bad");
    } catch {
      el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
      el.classList.add("sdoc-math-bad");
    }
    // Marks *what* was rendered, so re-rendering is skipped only while the
    // source is unchanged.
    el.dataset.rendered = tex;
  }
};

/**
 * Turn `$$…$$` / `$…$` in plain text into math nodes, leaving other text alone.
 *
 * The bridge from a model's Markdown answer to the nodes `renderMath` sets.
 *
 * A lone `$` is left as a `$`: prices are more common than maths in most prose,
 * and silently eating them would be worse than missing a formula.
 */
export const texToNodes = (text: string): (string | HTMLElement)[] => {
  const out: (string | HTMLElement)[] = [];
  // `$$…$$` first so display maths isn't matched as two inline pairs. Inline
  // maths follows pandoc's rule — no space just inside either `$` — so "between
  // $10 and $20" stays prose. (Lookahead only: older WebKit has no lookbehind.)
  const re = /\$\$([^$]+?)\$\$|\$(?!\s)([^$\n]*?[^\s$])\$/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // The second `$` of a `$$` still being typed isn't an inline opener: one key
    // before the closing `$$`, "$$x^2$" became "$" + inline maths.
    if (m[2] != null && text[m.index - 1] === "$") {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    const display = m[1] != null;
    out.push(mathNode((display ? m[1]! : m[2]!).trim(), display));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};
