/**
 * Designs (design.ts): stored choice, the attribute + stylesheet they apply, and
 * the promise that makes the Velvet Paper sheet inert in Classic — every rule in
 * it is scoped to its own `data-design`, so leaving it linked after switching
 * back changes nothing.
 *
 * `document` and `localStorage` are stubbed (the suite runs in node).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import liquidSilkCss from "../public/designs/liquid-silk.css?raw";
import velvetPaperCss from "../public/designs/velvet-paper.css?raw";

let attrs: Record<string, string>;
let head: { id: string; href: string; onload?: () => void }[];
let stored: Record<string, string>;

beforeEach(() => {
  vi.resetModules();
  attrs = {};
  head = [];
  stored = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (n: string) => attrs[n] ?? null,
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      removeAttribute: (n: string) => {
        delete attrs[n];
      },
    },
    getElementById: (id: string) => {
      const el = head.find((l) => l.id === id);
      return el
        ? {
            getAttribute: (n: string) => (n === "href" ? el.href : null),
            remove: () => head.splice(head.indexOf(el), 1),
          }
        : null;
    },
    createElement: () => ({ id: "", rel: "", href: "" }),
    head: {
      appendChild: (el: { id: string; href: string; onload?: () => void }) => {
        head.push(el);
        queueMicrotask(() => el.onload?.());
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stored design", () => {
  it("is Liquid Silk when nothing (or nonsense) is stored", async () => {
    expect((await import("./design")).storedDesign()).toBe("liquid-silk");
    stored["flux.design"] = "art-deco";
    vi.resetModules();
    expect((await import("./design")).storedDesign()).toBe("liquid-silk");
  });
  it("keeps Velvet Paper when that was picked", async () => {
    stored["flux.design"] = "velvet-paper";
    expect((await import("./design")).storedDesign()).toBe("velvet-paper");
  });
  it("keeps Classic when that was picked", async () => {
    stored["flux.design"] = "classic";
    expect((await import("./design")).storedDesign()).toBe("classic");
  });
});

describe("applying a design", () => {
  it("links its sheet, then marks <html>, and Classic unmarks it", async () => {
    const { setDesign, design } = await import("./design");
    const pending = setDesign("velvet-paper");
    // The attribute waits for the sheet: computed colours read in between
    // would otherwise be the previous design's.
    expect(attrs["data-design"]).toBeUndefined();
    await pending;
    expect(head.map((l) => l.href)).toEqual(["/designs/velvet-paper.css"]);
    expect(attrs["data-design"]).toBe("velvet-paper");
    expect(design()).toBe("velvet-paper");
    expect(stored["flux.design"]).toBe("velvet-paper");

    await setDesign("classic");
    expect(attrs["data-design"]).toBeUndefined();
    expect(stored["flux.design"]).toBe("classic");
  });

  it("lays Liquid Silk out as Velvet Paper and adds its own sheet and flag", async () => {
    const { setDesign, design, cardLayout } = await import("./design");
    await setDesign("liquid-silk");
    expect(head.map((l) => l.href)).toEqual(["/designs/velvet-paper.css", "/designs/liquid-silk.css"]);
    expect(attrs["data-design"]).toBe("velvet-paper");
    expect(attrs["data-silk"]).toBe("");
    expect(design()).toBe("liquid-silk");
    expect(cardLayout()).toBe(true);

    // Back to Velvet Paper: same layout sheet, the Silk flag goes.
    await setDesign("velvet-paper");
    expect(attrs["data-design"]).toBe("velvet-paper");
    expect(attrs["data-silk"]).toBeUndefined();
    await setDesign("classic");
    expect(cardLayout()).toBe(false);
  });
});

describe("the Liquid Silk sheet", () => {
  it("scopes every page-level rule to Silk, one attribute above Velvet Paper", () => {
    const css = liquidSilkCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@font-face\s*\{[^}]*\}/g, "")
      .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)].flatMap((m) =>
      m[2]!.split(",").map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(20);
    // Silk's own components (.silk-*) only exist in Silk's markup; anything
    // else must be scoped so the sheet is inert once Silk is switched off.
    const unscoped = selectors.filter(
      (s) => !s.startsWith(":root[data-design][data-silk]") && !/^\.silk-/.test(s),
    );
    expect(unscoped).toEqual([]);
  });
});

describe("the Velvet Paper sheet", () => {
  it("scopes every rule to its design, so it is inert in Classic", () => {
    // Strip comments and @font-face blocks (fonts are harmless until used).
    const css = velvetPaperCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\s*\{[^}]*\}/g, "");
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)].flatMap((m) =>
      m[2]!.split(",").map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(20);
    const unscoped = selectors.filter((s) => !s.startsWith(':root[data-design="velvet-paper"]'));
    expect(unscoped).toEqual([]);
  });
});
