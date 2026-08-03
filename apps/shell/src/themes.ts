/**
 * Colour themes.
 *
 * A theme is the five base tones plus six palette channels, declared in
 * `theme.css` under `:root[data-theme="…"]`. Everything downstream — 300-odd
 * accent uses, every glass rim, the scrollbars — resolves through those, so
 * adding a theme is a CSS block and one entry here.
 *
 * **Applied before first paint** (see the inline script in `index.html`): doing
 * it from a Solid effect means the app renders one frame in the default palette
 * and then snaps, which looks like a bug every single launch.
 *
 * The default has *no* `data-theme` attribute rather than `data-theme="velvet"`,
 * so a fresh install, an install that has never opened Settings, and a broken
 * localStorage all render identically.
 */
import { createSignal } from "solid-js";

export type ThemeId = "velvet" | "ember";

export const THEMES: { id: ThemeId; name: string; blurb: string; swatch: string[] }[] = [
  {
    id: "velvet",
    name: "Velvet",
    blurb: "Deep navy-plum, teal and amethyst",
    swatch: ["#0b0a1d", "#2ff3ff", "#7b61ff", "#ec4be0"],
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Oxblood, rose and ember orange",
    swatch: ["#16070f", "#ff5a7a", "#d6336c", "#ff8a4c"],
  },
];

const KEY = "flux.theme";

const isTheme = (v: string | null): v is ThemeId => THEMES.some((t) => t.id === v);

/** What's stored, defaulting to Velvet for anything unrecognised. */
export const storedTheme = (): ThemeId => {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : "velvet";
  } catch {
    return "velvet";
  }
};

const [theme, setThemeSig] = createSignal<ThemeId>(storedTheme());
export { theme };

/** Put the theme on <html>. Also exported for the pre-paint bootstrap. */
export const applyTheme = (id: ThemeId): void => {
  const root = document.documentElement;
  if (id === "velvet") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
};

export const setTheme = (id: ThemeId): void => {
  setThemeSig(id);
  applyTheme(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode / quota — the theme still applies for this session */
  }
};
