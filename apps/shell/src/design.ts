/**
 * Designs — the shape of the interface, as opposed to its colours.
 *
 * A theme (`themes.ts`) recolours Flux; a design re-lays and re-materials it:
 * spacing, card shapes, type, which surfaces float and how titles sit on them.
 * "Classic" is Flux as it looked before the redesign and needs no attribute.
 * Liquid Silk is the default; every design but Classic is a stylesheet in
 * `public/designs/`,
 * keyed on `<html data-design="…">`, so the Classic boot path never downloads it
 * and it stays out of the entry CSS budget (`npm run perf`).
 *
 * **Liquid Silk is Velvet Paper's layout in another material.** It keeps every
 * floating card, gutter and rail of Velvet Paper and swaps the paper for frosted
 * glass over a silk wallpaper (`wallpaper.ts`). Rather than fork Velvet Paper's
 * 5,000-line sheet, Silk marks <html> as `data-design="velvet-paper"` *and*
 * `data-silk`, links both sheets, and scopes every Silk rule to
 * `:root[data-design][data-silk]` — one attribute more specific than any Velvet
 * Paper rule, so Silk wins wherever they overlap without depending on order.
 * Code that asks "is this the floating-card layout?" uses `cardLayout()`; code
 * that wants Velvet Paper's own look (its home, its paper) checks the id.
 *
 * **Applied before first paint**, like the theme (see `index.html`): an inline
 * script in <head> sets the attributes and one at the top of <body> links the
 * stylesheets (after the theme's, so the design wins the rules they share), so a
 * Velvet Paper launch never shows one classic frame first.
 *
 * A design brings its own palette. While one is active the theme picker is moot,
 * so Settings says so rather than offering colours that wouldn't show.
 */
import { createSignal } from "solid-js";

export type DesignId = "classic" | "velvet-paper" | "liquid-silk";

export const DESIGNS: { id: DesignId; name: string; blurb: string }[] = [
  { id: "classic", name: "Classic", blurb: "Flux as it has always looked; colours follow the theme" },
  {
    id: "velvet-paper",
    name: "Velvet Paper",
    blurb: "Floating paper cards on plum velvet, titles set in their edges, paper hills behind",
  },
  {
    id: "liquid-silk",
    name: "Liquid Silk",
    blurb: "Frosted glass over a silk wallpaper; the accent follows the wallpaper",
  },
];

const KEY = "flux.design";
const LINK_ID = "flux-design-css";
const SILK_LINK_ID = "flux-silk-css";

const isDesign = (v: string | null): v is DesignId => DESIGNS.some((d) => d.id === v);

/** The design a fresh install (or an unreadable store) gets. */
export const DEFAULT_DESIGN: DesignId = "liquid-silk";

/** What's stored, defaulting to Liquid Silk for anything unrecognised. Keep in
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

/** Velvet Paper's floating-card layout — true for both designs built on it. */
export const cardLayout = (): boolean => design() !== "classic";

/** The stylesheet a design's layout lives in. Classic has none: it is theme.css.
 *  Liquid Silk's layout is Velvet Paper's; its material is `silkHref`. */
export const designHref = (id: DesignId): string | null =>
  id === "classic" ? null : "/designs/velvet-paper.css";
export const silkHref = "/designs/liquid-silk.css";

/** Link a stylesheet once (by id); resolves when it has loaded or failed. */
const linkSheet = (id: string, href: string): Promise<void> => {
  if (document.getElementById(id)?.getAttribute("href") === href) return Promise.resolve();
  document.getElementById(id)?.remove();
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  const loaded = new Promise<void>((done) => {
    link.onload = () => done();
    link.onerror = () => done();
  });
  document.head.appendChild(link);
  return loaded;
};

/**
 * Put the design on <html> and make sure its stylesheets are linked. Resolves
 * once they have loaded, so anything that reads computed colours afterwards (the
 * palette, the terminals) sees the design's and not the previous one's.
 */
export const applyDesign = (id: DesignId): Promise<void> => {
  const root = document.documentElement;
  const href = designHref(id);
  // Leaving a link in place when switching away is harmless (its rules are all
  // scoped to the attributes) and saves a re-fetch on the way back.
  const loads: Promise<void>[] = [];
  if (href) loads.push(linkSheet(LINK_ID, href));
  if (id === "liquid-silk") loads.push(linkSheet(SILK_LINK_ID, silkHref));
  return Promise.all(loads).then(() => {
    if (!href) root.removeAttribute("data-design");
    else root.setAttribute("data-design", "velvet-paper");
    if (id === "liquid-silk") root.setAttribute("data-silk", "");
    else root.removeAttribute("data-silk");
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
