/**
 * The theme's colours, for surfaces CSS can't reach.
 *
 * Canvas and WebGL don't resolve `var(--accent-rgb)` — they need numbers. Rather
 * than duplicating each theme's palette in TypeScript (which is how the two
 * would drift apart on the first tweak), this reads the *computed* custom
 * properties off `<html>`. `theme.css` stays the single definition of what a
 * theme is; everything else asks.
 *
 * Cached, because `getComputedStyle` forces style resolution and these are read
 * inside draw loops. Invalidated when the theme changes.
 */
import { createEffect } from "solid-js";

import { theme } from "./themes";

export type Rgb = [number, number, number];

/** The channels declared in `theme.css`. Roles, not hues. */
export type Palette = {
  /** Primary interactive. Teal in Velvet, rose in Ember. */
  accent: Rgb;
  /** The agent / "Liquid AI" surfaces. */
  ai: Rgb;
  /** Its softer companion. */
  ai2: Rgb;
  /** Attention, highlights, the aurora's hot band. */
  hot: Rgb;
  /** Borders, thumbs — the cool (or warm) neutral. */
  neutral: Rgb;
  /** The base tone the canvases sit on. */
  bg: Rgb;
  /** Body text, for canvas labels. */
  text: Rgb;
};

const FALLBACK: Palette = {
  accent: [47, 243, 255],
  ai: [123, 97, 255],
  ai2: [157, 141, 241],
  hot: [236, 75, 224],
  neutral: [150, 160, 220],
  bg: [11, 10, 29],
  text: [201, 205, 232],
};

const parseTriplet = (v: string, fallback: Rgb): Rgb => {
  const n = v.split(",").map((x) => Number(x.trim()));
  return n.length === 3 && n.every((x) => Number.isFinite(x)) ? (n as Rgb) : fallback;
};

/** `#rrggbb` → rgb. The base tones are hex, not channels. */
const parseHex = (v: string, fallback: Rgb): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const h = parseInt(m[1]!, 16);
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
};

let cached: Palette | null = null;

export const palette = (): Palette => {
  if (cached) return cached;
  try {
    const cs = getComputedStyle(document.documentElement);
    const ch = (name: string, f: Rgb) => parseTriplet(cs.getPropertyValue(name), f);
    cached = {
      accent: ch("--accent-rgb", FALLBACK.accent),
      ai: ch("--accent-ai-rgb", FALLBACK.ai),
      ai2: ch("--accent-ai2-rgb", FALLBACK.ai2),
      hot: ch("--accent-hot-rgb", FALLBACK.hot),
      neutral: ch("--neutral-rgb", FALLBACK.neutral),
      bg: parseHex(cs.getPropertyValue("--velvet-800"), FALLBACK.bg),
      text: parseHex(cs.getPropertyValue("--flux-text-dim"), FALLBACK.text),
    };
  } catch {
    cached = FALLBACK;
  }
  return cached;
};

/** `rgba(r, g, b, a)` for a canvas fill/stroke. */
export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
/** `#rrggbb` for APIs that only take solid colours (xterm's palette). */
export const hex = (c: Rgb): string =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** 0–1 components, for GLSL uniforms. */
export const unit = (c: Rgb): Rgb => [c[0] / 255, c[1] / 255, c[2] / 255];

/** Bumped on every theme change; draw loops read it to know they're stale. */
let gen = 0;
export const paletteGeneration = (): number => gen;

/** Drop the cache when the theme changes. Call once, at app start. */
export const watchPalette = (): void => {
  createEffect(() => {
    theme();
    cached = null;
    gen++;
  });
};
