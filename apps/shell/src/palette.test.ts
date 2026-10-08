/**
 * A theme switch runs every `theme()` effect synchronously inside the signal
 * write. The terminals' effect reads the palette right there, so by then the
 * DOM has to carry the new theme, and the palette cache mustn't hand back the
 * old theme's colours just because its invalidation effect hasn't run yet.
 *
 * `document` and `getComputedStyle` are stubbed (the suite runs in node): the
 * stub resolves `--accent-rgb` from whatever `data-theme` is set at the time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VELVET = [47, 243, 255];
const EMBER = [255, 90, 122];
const ACCENT: Record<string, string> = { velvet: VELVET.join(", "), ember: EMBER.join(", ") };

let attr: string | null;

beforeEach(() => {
  vi.resetModules(); // the palette cache is module-level
  attr = null;
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (name: string) => (name === "data-theme" ? attr : null),
      setAttribute: (name: string, value: string) => {
        if (name === "data-theme") attr = value;
      },
      removeAttribute: (name: string) => {
        if (name === "data-theme") attr = null;
      },
    },
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => (name === "--accent-rgb" ? ACCENT[attr ?? "velvet"]! : ""),
  }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Fresh copies, solid-js included, so every module shares one reactive runtime. */
const load = async () => ({
  solid: await import("solid-js"),
  pal: await import("./palette"),
  themes: await import("./themes"),
});

describe("palette across a theme switch", () => {
  for (const consumerFirst of [false, true]) {
    const when = consumerFirst ? "before" : "after";
    it(`gives a theme() effect running ${when} the cache invalidation the new colours`, async () => {
      const { solid, pal, themes } = await load();
      let seen: number[] = [];
      let dispose!: () => void;
      solid.createRoot((d) => {
        dispose = d;
        // The shape of TerminalView's effect: re-read the palette on theme().
        const consumer = () =>
          solid.createEffect(() => {
            themes.theme();
            seen = pal.palette().accent;
          });
        if (consumerFirst) consumer();
        pal.watchPalette();
        if (!consumerFirst) consumer();
      });
      expect(seen).toEqual(VELVET);
      // A draw loop (LiquidBackground, AgentAurora) has read it since, so the
      // cache holds the current theme when the switch comes.
      expect(pal.palette().accent).toEqual(VELVET);

      themes.setTheme("ember");
      expect(seen, "the effect saw the previous theme").toEqual(EMBER);
      expect(pal.palette().accent, "the cache kept the previous theme").toEqual(EMBER);
      dispose();
    });
  }
});
