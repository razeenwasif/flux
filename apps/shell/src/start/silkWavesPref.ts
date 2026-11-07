/**
 * Whether Opal moves in slow waves on Liquid Silk's home page (SilkWaves.tsx).
 * On unless switched off in Settings → Appearance. Kept out of wallpaper.ts,
 * which loads at startup: only the home page and Settings read this.
 */
import { createSignal } from "solid-js";

const KEY = "flux.wallpaper.waves";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

const [silkWaves, setSig] = createSignal(stored());
export { silkWaves };

export const setSilkWaves = (on: boolean): void => {
  setSig(on);
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode / quota — applies for this session */
  }
};
