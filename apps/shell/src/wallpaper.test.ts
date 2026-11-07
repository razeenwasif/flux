/**
 * Liquid Silk's wallpaper (wallpaper.ts): which stored choices are honoured,
 * and the attributes they put on <html>. `document` and `localStorage` are
 * stubbed (the suite runs in node).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let attrs: Record<string, string>;
let styleVars: Record<string, string>;
let stored: Record<string, string>;

beforeEach(() => {
  vi.resetModules();
  attrs = {};
  styleVars = {};
  stored = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
    removeItem: (k: string) => {
      delete stored[k];
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      removeAttribute: (n: string) => {
        delete attrs[n];
      },
      style: {
        setProperty: (n: string, v: string) => {
          styleVars[n] = v;
        },
        removeProperty: (n: string) => {
          delete styleVars[n];
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stored wallpaper", () => {
  it("is Opal when nothing (or nonsense) is stored", async () => {
    expect((await import("./wallpaper")).storedWallpaper()).toBe("opal");
    stored["flux.wallpaper"] = "velvet";
    vi.resetModules();
    expect((await import("./wallpaper")).storedWallpaper()).toBe("opal");
  });

  it("keeps a custom image only while one is stored", async () => {
    stored["flux.wallpaper"] = "custom";
    expect((await import("./wallpaper")).storedWallpaper()).toBe("opal");
    stored["flux.wallpaper.custom"] = "data:image/jpeg;base64,AAAA";
    vi.resetModules();
    expect((await import("./wallpaper")).storedWallpaper()).toBe("custom");
  });
});

describe("applying it", () => {
  it("marks <html> and carries the custom image as a style variable", async () => {
    stored["flux.wallpaper.custom"] = "data:image/jpeg;base64,AAAA";
    const w = await import("./wallpaper");
    w.setWallpaper("custom");
    expect(attrs["data-wallpaper"]).toBe("custom");
    expect(styleVars["--silk-custom-image"]).toBe('url("data:image/jpeg;base64,AAAA")');

    // Removing the image while it shows falls back to the default silk.
    w.clearCustomWallpaper();
    expect(attrs["data-wallpaper"]).toBe("opal");
    expect(styleVars["--silk-custom-image"]).toBeUndefined();
    expect(stored["flux.wallpaper.custom"]).toBeUndefined();
  });

  it("turns the three switches into attributes", async () => {
    const w = await import("./wallpaper");
    w.setAccentFollows(false);
    w.setStepBack(false);
    w.setDrift(true);
    expect(attrs["data-silk-accent"]).toBe("fixed");
    expect(attrs["data-silk-still"]).toBe("");
    expect(attrs["data-silk-drift"]).toBe("");
    w.setAccentFollows(true);
    expect(attrs["data-silk-accent"]).toBeUndefined();
  });
});
