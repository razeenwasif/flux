/**
 * Designs (design.ts): stored choice, the attribute + stylesheet they apply, and
 * the promise that makes the Velvet Paper sheet inert in Classic — every rule in
 * it is scoped to its own `data-design`, so leaving it linked after switching
 * back changes nothing.
 *
 * `document` and `localStorage` are stubbed (the suite runs in node).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it("is Velvet Paper when nothing (or nonsense) is stored", async () => {
    expect((await import("./design")).storedDesign()).toBe("velvet-paper");
    stored["flux.design"] = "art-deco";
    vi.resetModules();
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
