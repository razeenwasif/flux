/**
 * Tiling geometry and group algebra.
 *
 * These were verified with throwaway scripts when they were written, which meant
 * nothing guarded them afterwards — and the split-view work regressed twice in
 * ways typecheck cannot catch: a `<For>` keyed by reference remounting every
 * pane, and a strip that drew only the *active* group. Both are shape bugs in
 * pure functions, which is exactly what a test suite is for.
 */
import { describe, expect, it } from "vitest";

import {
  claimTabs,
  clampFrac,
  dropTabFromGroups,
  layoutsFor,
  MAX_PANES,
  prunedGroups,
  stripRows,
  tileRects,
  tileSeams,
  type TileLayout,
} from "./tiles";

const RECT = { x: 0, y: 0, width: 1000, height: 800 };
const ALL_LAYOUTS: TileLayout[] = ["cols", "rows", "quad", "mainLeft", "mainRight", "mainTop", "mainBottom"];

describe("tileRects", () => {
  it("returns exactly n panes for every layout and count", () => {
    for (const layout of ALL_LAYOUTS) {
      for (let n = 1; n <= MAX_PANES; n++) {
        const rects = tileRects({ layout, n, main: 0.5, sec: 0.5, rect: RECT, gap: 8 });
        expect(rects, `${layout} × ${n}`).toHaveLength(n);
      }
    }
  });

  it("never collapses a pane or overlaps two", () => {
    const overlaps = (a: (typeof RECT)[], i: number, j: number) => {
      const p = a[i]!;
      const q = a[j]!;
      return p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    };
    for (const layout of ALL_LAYOUTS) {
      for (let n = 2; n <= MAX_PANES; n++) {
        const rects = tileRects({ layout, n, main: 0.5, sec: 0.5, rect: RECT, gap: 8 });
        for (const r of rects) {
          expect(r.width, `${layout} × ${n} width`).toBeGreaterThan(0);
          expect(r.height, `${layout} × ${n} height`).toBeGreaterThan(0);
        }
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            expect(overlaps(rects, i, j), `${layout} × ${n}: pane ${i} overlaps ${j}`).toBe(false);
          }
        }
      }
    }
  });

  it("stays inside its rect even at extreme seam ratios", () => {
    for (const layout of ALL_LAYOUTS) {
      for (const ratio of [-5, 0, 0.01, 0.99, 5]) {
        const rects = tileRects({ layout, n: 4, main: ratio, sec: ratio, rect: RECT, gap: 8 });
        for (const r of rects) {
          expect(r.width).toBeGreaterThan(0);
          expect(r.height).toBeGreaterThan(0);
          expect(r.x).toBeGreaterThanOrEqual(RECT.x - 1);
          expect(r.y).toBeGreaterThanOrEqual(RECT.y - 1);
          expect(r.x + r.width).toBeLessThanOrEqual(RECT.x + RECT.width + 1);
          expect(r.y + r.height).toBeLessThanOrEqual(RECT.y + RECT.height + 1);
        }
      }
    }
  });

  it("agrees between the pixel and percentage consumers", () => {
    // The native webview tiler works in pixels and the DOM panes in percent.
    // They must describe the same layout or the page and its frame drift apart.
    for (const layout of ALL_LAYOUTS) {
      const px = tileRects({ layout, n: 3, main: 0.6, sec: 0.4, rect: RECT, gap: 8 });
      const pc = tileRects({
        layout,
        n: 3,
        main: 0.6,
        sec: 0.4,
        rect: { x: 0, y: 0, width: 100, height: 100 },
        gap: 0.8,
      });
      px.forEach((r, i) => {
        const q = pc[i]!;
        expect(Math.abs(r.x / 10 - q.x), `${layout} pane ${i} x`).toBeLessThan(1);
        expect(Math.abs(r.y / 8 - q.y), `${layout} pane ${i} y`).toBeLessThan(1);
      });
    }
  });
});

describe("clampFrac", () => {
  it("keeps a seam off the edges so no pane can vanish", () => {
    expect(clampFrac(-1)).toBeGreaterThan(0);
    expect(clampFrac(2)).toBeLessThan(1);
    expect(clampFrac(0.5)).toBe(0.5);
  });
});

describe("layoutsFor", () => {
  it("offers nothing below two panes and only fitting layouts above", () => {
    expect(layoutsFor(1)).toHaveLength(0);
    expect(layoutsFor(2)).toEqual(["cols", "rows"]);
    for (const n of [3, 4]) {
      expect(layoutsFor(n).length).toBeGreaterThan(0);
      // Every offered layout must actually produce n usable panes.
      for (const layout of layoutsFor(n)) {
        const rects = tileRects({ layout, n, main: 0.5, sec: 0.5, rect: RECT, gap: 8 });
        expect(rects).toHaveLength(n);
      }
    }
  });
});

describe("tileSeams", () => {
  it("draws no seam for a single pane, and puts every seam on a pane edge", () => {
    expect(tileSeams({ layout: "cols", n: 1, main: 0.5, sec: 0.5, rect: RECT, gap: 8 })).toEqual([]);
    for (const layout of ALL_LAYOUTS) {
      const opts = { layout, n: 4, main: 0.5, sec: 0.5, rect: RECT, gap: 8 };
      const rects = tileRects(opts);
      for (const seam of tileSeams(opts)) {
        const onAnEdge = rects.some((r) =>
          seam.axis === "x"
            ? Math.abs(r.x + r.width - seam.x) < 2 || Math.abs(r.x - seam.x) < 2
            : Math.abs(r.y + r.height - seam.y) < 2 || Math.abs(r.y - seam.y) < 2,
        );
        expect(onAnEdge, `${layout}: seam floating free of any pane`).toBe(true);
      }
    }
  });
});

// ─── group algebra ──────────────────────────────────────────────────────────

const G = (tabs: number[]) => ({ tabs });
const shape = (gs: { tabs: number[] }[]) => JSON.stringify(gs.map((g) => g.tabs));

describe("group algebra", () => {
  it("keeps independent tilings side by side", () => {
    // The regression: collapsing to one group at a time, so a second split
    // silently replaced the first.
    const gs = [G([1, 2]), G([3, 4])];
    expect(shape(gs)).toBe("[[1,2],[3,4]]");
    const holder = (id: number) => gs.find((g) => g.tabs.includes(id)) ?? null;
    expect(holder(1)).toBe(gs[0]);
    expect(holder(3)).toBe(gs[1]);
    expect(holder(99)).toBeNull();
  });

  it("moves a claimed tab out of its old group and dissolves what's left", () => {
    const gs = [G([1, 2]), G([3, 4])];
    const rest = claimTabs(gs, [5, 2], null);
    // [1,2] loses 2, leaving one pane — not a split, so it goes.
    expect(rest.every((g) => !g.tabs.includes(2))).toBe(true);
    expect(rest.every((g) => g.tabs.length >= 2)).toBe(true);
    expect(shape(rest)).toBe("[[3,4]]");
  });

  it("replaces the active group without duplicating it", () => {
    const gs = [G([1, 2]), G([3, 4])];
    const rest = claimTabs(gs, [1, 2, 9], gs[0]!);
    expect(rest.filter((g) => g.tabs.includes(1))).toHaveLength(0);
    // The unrelated group survives by identity, which is what lets the store
    // patch a group by reference.
    expect(rest[0]).toBe(gs[1]);
  });

  it("drops a closed tab and only from the group that held it", () => {
    expect(shape(dropTabFromGroups([G([1, 2, 3])], 2))).toBe("[[1,3]]");
    expect(shape(dropTabFromGroups([G([1, 2])], 2))).toBe("[]");
    expect(shape(dropTabFromGroups([G([1, 2]), G([3, 4])], 1))).toBe("[[3,4]]");
    expect(shape(dropTabFromGroups([G([1, 2])], 77))).toBe("[[1,2]]");
    const keep = [G([1, 2]), G([3, 4])];
    expect(dropTabFromGroups(keep, 1)[0]).toBe(keep[1]);
  });

  it("prunes groups that no longer describe a split", () => {
    expect(shape(prunedGroups([G([1]), G([2, 3])]))).toBe("[[2,3]]");
  });
});

// ─── tab strip ──────────────────────────────────────────────────────────────

const T = (id: number) => ({ id });
const rowShape = <T extends { id: number }>(rows: ReturnType<typeof stripRows<T>>) =>
  rows
    .map((r) => (r.kind === "tab" ? String(r.tab.id) : `[${r.members.map((m) => m.id).join(" ")}]`))
    .join(" ");

describe("stripRows", () => {
  const list = [1, 2, 3, 4, 5, 6].map(T);

  it("draws every group, not just the active one", () => {
    // The bug: a split dissolved into loose tabs the moment you focused an
    // unrelated tab, and a second split was never drawn at all.
    expect(rowShape(stripRows(list, [G([1, 3]), G([4, 6])]))).toBe("[1 3] 2 [4 6] 5");
    expect(rowShape(stripRows(list, []))).toBe("1 2 3 4 5 6");
  });

  it("never loses or duplicates a tab", () => {
    for (const groups of [[], [G([2, 3])], [G([1, 3]), G([4, 6])], [G([1, 2, 3, 4])]]) {
      const rows = stripRows(list, groups);
      const seen = rows.flatMap((r) => (r.kind === "tab" ? [r.tab.id] : r.members.map((m) => m.id)));
      expect(seen).toHaveLength(list.length);
      expect(new Set(seen).size).toBe(list.length);
    }
  });

  it("handles a group only partly present in this strip", () => {
    expect(rowShape(stripRows(list, [G([2, 3, 99])]))).toBe("1 [2 3] 4 5 6");
    // One member present is not a split — show it as an ordinary tab.
    expect(rowShape(stripRows(list, [G([3, 99])]))).toBe("1 2 3 4 5 6");
    expect(rowShape(stripRows(list, [G([98, 99])]))).toBe("1 2 3 4 5 6");
  });

  it("orders panes by the group, not by the strip", () => {
    expect(rowShape(stripRows(list, [G([5, 2])]))).toBe("1 [5 2] 3 4 6");
  });
});
