import { describe, expect, it } from "vitest";

import { groupByName, squarify, type Tile } from "./treemap";

const RECT = { x: 0, y: 0, w: 400, h: 300 };
const items = (...values: number[]) => values.map((value, i) => ({ value, datum: `p${i}` }));

const overlap = <T>(a: Tile<T>, b: Tile<T>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("squarify", () => {
  it("covers the rect exactly, with no overlaps", () => {
    const tiles = squarify(items(50, 30, 12, 5, 3), RECT);
    expect(tiles).toHaveLength(5);
    const covered = tiles.reduce((n, t) => n + t.width * t.height, 0);
    expect(covered).toBeCloseTo(RECT.w * RECT.h, 1);
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        expect(overlap(tiles[i]!, tiles[j]!), `tile ${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  it("gives area in proportion to value", () => {
    // The whole point: a process holding twice the memory gets twice the area.
    const tiles = squarify(items(60, 30, 10), RECT);
    const area = (t: Tile<string>) => t.width * t.height;
    const byDatum = Object.fromEntries(tiles.map((t) => [t.datum, area(t)]));
    expect(byDatum.p0! / byDatum.p1!).toBeCloseTo(2, 1);
    expect(byDatum.p1! / byDatum.p2!).toBeCloseTo(3, 1);
  });

  it("stays inside the rect", () => {
    for (const tile of squarify(items(40, 25, 20, 10, 4, 1), RECT)) {
      expect(tile.x).toBeGreaterThanOrEqual(RECT.x - 0.01);
      expect(tile.y).toBeGreaterThanOrEqual(RECT.y - 0.01);
      expect(tile.x + tile.width).toBeLessThanOrEqual(RECT.x + RECT.w + 0.01);
      expect(tile.y + tile.height).toBeLessThanOrEqual(RECT.y + RECT.h + 0.01);
    }
  });

  it("keeps tiles squarer than slice-and-dice would", () => {
    // The reason for squarifying at all: naive slicing turns small values into
    // slivers whose area a reader can't judge.
    const tiles = squarify(items(50, 25, 12, 8, 5), RECT);
    const worst = Math.max(...tiles.map((t) => Math.max(t.width / t.height, t.height / t.width)));
    const sliced = RECT.w / (RECT.h * (5 / 100)); // same smallest value, sliced full-height
    expect(worst).toBeLessThan(sliced);
    expect(worst).toBeLessThan(8);
  });

  it("handles the degenerate inputs a live process list produces", () => {
    expect(squarify([], RECT)).toEqual([]);
    expect(squarify(items(10), { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
    // A single item takes the whole rect.
    const one = squarify(items(7), RECT);
    expect(one).toHaveLength(1);
    expect(one[0]!.width).toBeCloseTo(RECT.w, 1);
    expect(one[0]!.height).toBeCloseTo(RECT.h, 1);
    // Zero and negative values are dropped rather than becoming invisible tiles
    // that still swallow a click.
    expect(squarify(items(10, 0, -3), RECT)).toHaveLength(1);
  });
});

describe("groupByName", () => {
  const P = (name: string, mem_mb: number) => ({ name, mem_mb });

  it("sums a process family into one entry", () => {
    const out = groupByName([P("chrome", 100), P("chrome", 250), P("node", 80)], 10);
    expect(out[0]).toEqual({ name: "chrome", mem_mb: 350, count: 2 });
    expect(out[1]).toEqual({ name: "node", mem_mb: 80, count: 1 });
  });

  it("gathers the tail into 'other' so the areas still sum to the whole", () => {
    const procs = [P("a", 100), P("b", 50), P("c", 20), P("d", 10), P("e", 5)];
    const out = groupByName(procs, 2);
    expect(out.map((g) => g.name)).toEqual(["a", "b", "other"]);
    const total = procs.reduce((n, p) => n + p.mem_mb, 0);
    expect(out.reduce((n, g) => n + g.mem_mb, 0)).toBe(total);
    expect(out[2]!.count).toBe(3);
  });

  it("doesn't invent an 'other' when everything fits", () => {
    const out = groupByName([P("a", 10), P("b", 5)], 5);
    expect(out.map((g) => g.name)).toEqual(["a", "b"]);
  });
});
