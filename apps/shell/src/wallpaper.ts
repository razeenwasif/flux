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
 *   --silk-custom-image (inline style)        the user's own image, when they
 *                                             picked one ("custom")
 *
 * The attributes do nothing outside Liquid Silk, so they're applied whatever the
 * design — switching to Silk later then has nothing to catch up on. Like the
 * design, they're set before first paint by index.html; keep the two in step.
 */
import { createSignal } from "solid-js";

/** The built-in silks, plus "custom": an image of the user's own. */
export type WallpaperId = "opal" | "abyss" | "ember" | "aurora" | "custom";

/** `accent` is the swatch Settings shows; the real palette is in the stylesheet.
 *  A custom image takes Opal's palette. */
export const WALLPAPERS: { id: Exclude<WallpaperId, "custom">; name: string; accent: string }[] = [
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
const CUSTOM_KEY = "flux.wallpaper.custom";

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

const isWallpaper = (v: string | null): v is WallpaperId =>
  WALLPAPERS.some((w) => w.id === v) || (v === "custom" && !!read(CUSTOM_KEY));

export const storedWallpaper = (): WallpaperId => {
  const v = read(KEY);
  return isWallpaper(v) ? v : DEFAULT_WALLPAPER;
};

const [wallpaper, setWallpaperSig] = createSignal<WallpaperId>(storedWallpaper());
const [accentFollows, setAccentFollowsSig] = createSignal(read(ACCENT_KEY) !== "fixed");
const [stepBack, setStepBackSig] = createSignal(read(STILL_KEY) !== "1");
const [drift, setDriftSig] = createSignal(read(DRIFT_KEY) === "1");
/** The user's own image as a data URL, or null when they haven't picked one. */
const [customImage, setCustomImageSig] = createSignal<string | null>(read(CUSTOM_KEY));
export { wallpaper, accentFollows, stepBack, drift, customImage };

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
  const custom = customImage();
  if (custom) document.documentElement.style.setProperty("--silk-custom-image", `url("${custom}")`);
  else document.documentElement.style.removeProperty("--silk-custom-image");
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

/** Longest side a custom wallpaper is stored at. It sits under blur and glass,
 *  so more pixels buy nothing, and it has to fit in localStorage (read before
 *  first paint, like the rest of these settings). */
const CUSTOM_MAX_SIDE = 1920;

/**
 * Use an image of the user's own: scaled down, stored as a JPEG data URL, and
 * selected. Rejects with a message fit to show when the file isn't an image or
 * the result doesn't fit in storage.
 */
export const setCustomWallpaper = async (file: Blob): Promise<void> => {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't an image Flux can read.");
  }
  const scale = Math.min(1, CUSTOM_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const data = canvas.toDataURL("image/jpeg", 0.82);
  try {
    localStorage.setItem(CUSTOM_KEY, data);
  } catch {
    throw new Error("That image is too large to keep. Try a smaller one.");
  }
  setCustomImageSig(data);
  setWallpaper("custom");
};

/** Forget the custom image; if it was showing, go back to the default silk. */
export const clearCustomWallpaper = (): void => {
  try {
    localStorage.removeItem(CUSTOM_KEY);
  } catch {
    /* nothing stored */
  }
  setCustomImageSig(null);
  if (wallpaper() === "custom") setWallpaper(DEFAULT_WALLPAPER);
  else applyWallpaper();
};
