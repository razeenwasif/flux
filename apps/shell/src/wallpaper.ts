/**
 * Liquid Silk's wallpaper (design.ts) — which silk image sits behind the glass,
 * and the three choices that go with it.
 *
 * Everything here is an attribute on <html>, read by `public/designs/liquid-silk.css`:
 *
 *   data-wallpaper="opal|abyss|ember|aurora"  the image, and the palette that
 *                                             comes with it (accent, glass tint)
 *   data-silk-accent="fixed"                  the accent stays Opal's mint
 *                                             whatever the image ("accent follows
 *                                             the wallpaper" off)
 *   data-silk-still                           don't step the wallpaper back
 *                                             while a web page is open
 *   data-silk-drift                           the home wallpaper drifts slowly
 *                                             (CSS; off under Reduce Motion)
 *
 * The attributes do nothing outside Liquid Silk, so they're applied whatever the
 * design — switching to Silk later then has nothing to catch up on. Like the
 * design, they're set before first paint by index.html; keep the two in step.
 */
import { createSignal } from "solid-js";

export type WallpaperId = "opal" | "abyss" | "ember" | "aurora";

/** `accent` is the swatch Settings shows; the real palette is in the stylesheet. */
export const WALLPAPERS: { id: WallpaperId; name: string; accent: string }[] = [
  { id: "opal", name: "Opal", accent: "#93e8d8" },
  { id: "abyss", name: "Abyss", accent: "#66d3dd" },
  { id: "ember", name: "Ember Tide", accent: "#f39a62" },
  { id: "aurora", name: "Aurora", accent: "#45ddf2" },
];

export const DEFAULT_WALLPAPER: WallpaperId = "opal";

const KEY = "flux.wallpaper";
const ACCENT_KEY = "flux.wallpaper.accent";
const STILL_KEY = "flux.wallpaper.still";
const DRIFT_KEY = "flux.wallpaper.drift";

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode / quota — applies for this session */
  }
};

const isWallpaper = (v: string | null): v is WallpaperId => WALLPAPERS.some((w) => w.id === v);

export const storedWallpaper = (): WallpaperId => {
  const v = read(KEY);
  return isWallpaper(v) ? v : DEFAULT_WALLPAPER;
};

const [wallpaper, setWallpaperSig] = createSignal<WallpaperId>(storedWallpaper());
const [accentFollows, setAccentFollowsSig] = createSignal(read(ACCENT_KEY) !== "fixed");
const [stepBack, setStepBackSig] = createSignal(read(STILL_KEY) !== "1");
const [drift, setDriftSig] = createSignal(read(DRIFT_KEY) === "1");
export { wallpaper, accentFollows, stepBack, drift };

const flag = (name: string, on: boolean, value = ""): void => {
  const root = document.documentElement;
  if (on) root.setAttribute(name, value);
  else root.removeAttribute(name);
};

/** Mirror the current choices onto <html>. */
export const applyWallpaper = (): void => {
  document.documentElement.setAttribute("data-wallpaper", wallpaper());
  flag("data-silk-accent", !accentFollows(), "fixed");
  flag("data-silk-still", !stepBack());
  flag("data-silk-drift", drift());
};

export const setWallpaper = (id: WallpaperId): void => {
  setWallpaperSig(id);
  write(KEY, id);
  applyWallpaper();
};
export const setAccentFollows = (on: boolean): void => {
  setAccentFollowsSig(on);
  write(ACCENT_KEY, on ? "wallpaper" : "fixed");
  applyWallpaper();
};
export const setStepBack = (on: boolean): void => {
  setStepBackSig(on);
  write(STILL_KEY, on ? "0" : "1");
  applyWallpaper();
};
export const setDrift = (on: boolean): void => {
  setDriftSig(on);
  write(DRIFT_KEY, on ? "1" : "0");
  applyWallpaper();
};
