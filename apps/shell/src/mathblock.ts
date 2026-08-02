/**
 * LaTeX blocks for Scribe pages (#109).
 *
 * **The node is the source of truth, not the rendering.** A math block is
 *
 *   <span|div class="sdoc-math" data-tex="\int_0^1 x^2 dx" contenteditable="false">…</span>
 *
 * with the TeX in `data-tex` and KaTeX's output as throwaway children. That
 * shape matters for three reasons: the document round-trips through
 * `innerHTML` (so anything not in an attribute is lost the moment KaTeX
 * re-renders), Rust never has to parse HTML to recover the equation — it reads
 * one attribute — and a page written before KaTeX loaded still knows what it
 * says.
 *
 * `contenteditable="false"` makes the whole block one atom to the caret: you
 * can't land inside a rendered fraction and corrupt it by typing, which is
 * exactly what makes Notion's equation blocks usable.
 *
 * KaTeX is imported lazily. It's ~280 KB with fonts, and most pages have no
 * maths on them; nothing loads until a page actually contains a block or you
 * insert one.
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
 * Errors are *not* thrown: half-typed LaTeX is the normal state of an equation
 * you're still writing, and an editor that blanks the block (or throws into the
 * console) on every keystroke would be unusable. The block shows its own source
 * in red instead, which is both the error message and the thing you need to
 * edit.
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
        // of (unicode in maths, \newline). A student's notes are not a paper.
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
 * This is the bridge for text that didn't come from the editor — pasted
 * markdown, and anything Gemma writes (`notewrite.rs` produces the same node
 * shape server-side, so both paths converge on one representation).
 *
 * A lone `$` is left as a `$`: prices are more common than maths in most prose,
 * and silently eating them would be worse than missing a formula.
 */
export const texToNodes = (text: string): (string | HTMLElement)[] => {
  const out: (string | HTMLElement)[] = [];
  // `$$…$$` first so display maths isn't matched as two inline pairs.
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const display = m[1] != null;
    out.push(mathNode((display ? m[1]! : m[2]!).trim(), display));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

/** The TeX inside `html`, for search and for plain-text export. */
export const mathSources = (html: string): string[] => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return Array.from(d.querySelectorAll<HTMLElement>(MATH_SEL))
    .map((n) => n.dataset.tex ?? "")
    .filter(Boolean);
};
