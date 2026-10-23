/**
 * Designs — the shape of the interface, as opposed to its colours.
 *
 * A theme (`themes.ts`) recolours Flux; a design re-lays and re-materials it:
 * spacing, card shapes, type, which surfaces float and how titles sit on them.
 * "Classic" is Flux as it looked before the redesign and needs no attribute.
 * Velvet Paper is the default; every design but Classic is a stylesheet in
 * `public/designs/`,
 * keyed on `<html data-design="…">`, so the Classic boot path never downloads it
 * and it stays out of the entry CSS budget (`npm run perf`).
 *
 * **Applied before first paint**, like the theme (see `index.html`): the inline
 * script sets the attribute and adds the stylesheet link, so a Velvet Paper
 * launch never shows one classic frame first.
 *
 * A design brings its own palette. While one is active the theme picker is moot,
 * so Settings says so rather than offering colours that wouldn't show.
 */
import { createSignal } from "solid-js";

export type DesignId = "classic" | "velvet-paper";

export const DESIGNS: { id: DesignId; name: string; blurb: string }[] = [
  { id: "classic", name: "Classic", blurb: "Flux as it has always looked; colours follow the theme" },
  {
    id: "velvet-paper",
    name: "Velvet Paper",
    blurb: "Floating paper cards on plum velvet, titles set in their edges, paper hills behind",
  },
];

const KEY = "flux.design";
const LINK_ID = "flux-design-css";

const isDesign = (v: string | null): v is DesignId => DESIGNS.some((d) => d.id === v);

/** The design a fresh install (or an unreadable store) gets. */
export const DEFAULT_DESIGN: DesignId = "velvet-paper";

/** What's stored, defaulting to Velvet Paper for anything unrecognised. Keep in
 *  step with the pre-paint script in index.html. */
export const storedDesign = (): DesignId => {
  try {
    const v = localStorage.getItem(KEY);
    return isDesign(v) ? v : DEFAULT_DESIGN;
  } catch {
    return DEFAULT_DESIGN;
  }
};

const [design, setDesignSig] = createSignal<DesignId>(storedDesign());
export { design };

/** The stylesheet a design lives in. Classic has none: it is theme.css. */
export const designHref = (id: DesignId): string | null => (id === "classic" ? null : `/designs/${id}.css`);

/**
 * Put the design on <html> and make sure its stylesheet is linked. Resolves once
 * the sheet has loaded, so anything that reads computed colours afterwards (the
 * palette, the terminals) sees the design's and not the previous one's.
 */
export const applyDesign = (id: DesignId): Promise<void> => {
  const root = document.documentElement;
  const href = designHref(id);
  // Leaving the link in place when switching back to Classic is harmless (its
  // rules are all scoped to the attribute) and saves a re-fetch on the way back.
  let loaded: Promise<void> = Promise.resolve();
  if (href && document.getElementById(LINK_ID)?.getAttribute("href") !== href) {
    document.getElementById(LINK_ID)?.remove();
    const link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.href = href;
    loaded = new Promise((done) => {
      link.onload = () => done();
      link.onerror = () => done();
    });
    document.head.appendChild(link);
  }
  return loaded.then(() => {
    if (!href) root.removeAttribute("data-design");
    else root.setAttribute("data-design", id);
  });
};

export const setDesign = async (id: DesignId): Promise<void> => {
  await applyDesign(id);
  setDesignSig(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode / quota — the design still applies for this session */
  }
};
