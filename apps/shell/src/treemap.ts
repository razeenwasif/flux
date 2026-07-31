/**
 * Squarified treemap layout.
 *
 * A sorted table tells you the top consumer; a treemap tells you the *shape* of
 * the problem — whether one process holds the memory or forty small ones do,
 * which a list of numbers makes you compute in your head.
 *
 * Squarified (Bruls, Huizing, van Wijk 2000) rather than naive slice-and-dice:
 * slicing produces slivers for small values, and a 2px-wide rectangle carries no
 * area information a reader can judge. This keeps aspect ratios near 1.
 *
 * Pure and unit-tested — the arithmetic is easy to get subtly wrong (tiles that
 * overlap, or a last row that doesn't reach the edge) and impossible to eyeball.
 */
export type TreeItem<T> = { value: number; datum: T };
export type Tile<T> = { x: number; y: number; width: number; height: number; datum: T };
type Box = { x: number; y: number; w: number; h: number };

/** Worst (largest) aspect ratio in a row, given the row's total and the side it
 *  is laid along. The squarify heuristic: keep adding while this improves. */
const worstRatio = (row: number[], side: number, total: number): number => {
  if (!row.length || side <= 0 || total <= 0) return Infinity;
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = total * total;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
};

/**
 * Lay `items` out inside `rect`, largest first.
 *
 * Items with a non-positive value are dropped: they have no area to occupy, and
 * including them would produce zero-size tiles that still take a click target.
 */
export function squarify<T>(items: TreeItem<T>[], rect: Box): Tile<T>[] {
  const live = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (!live.length || rect.w <= 0 || rect.h <= 0) return [];

  const totalValue = live.reduce((n, i) => n + i.value, 0);
  const area = rect.w * rect.h;
  // Work in area units so a row's total is directly a pixel area.
  const scaled = live.map((i) => ({ ...i, area: (i.value / totalValue) * area }));

  const out: Tile<T>[] = [];
  let box: Box = { ...rect };
  let row: typeof scaled = [];
  let rowTotal = 0;

  /** Place the accumulated row along the box's shorter side and shrink the box. */
  const flushRow = () => {
    if (!row.length) return;
    const horizontal = box.w >= box.h;
    const side = horizontal ? box.h : box.w;
    const thickness = rowTotal / side;
    let offset = 0;
    for (const item of row) {
      const length = item.area / thickness;
      out.push(
        horizontal
          ? { x: box.x, y: box.y + offset, width: thickness, height: length, datum: item.datum }
          : { x: box.x + offset, y: box.y, width: length, height: thickness, datum: item.datum },
      );
      offset += length;
    }
    if (horizontal) {
      box = { x: box.x + thickness, y: box.y, w: box.w - thickness, h: box.h };
    } else {
      box = { x: box.x, y: box.y + thickness, w: box.w, h: box.h - thickness };
    }
    row = [];
    rowTotal = 0;
  };

  for (const item of scaled) {
    const side = Math.min(box.w, box.h);
    const areas = row.map((r) => r.area);
    const current = worstRatio(areas, side, rowTotal);
    const next = worstRatio([...areas, item.area], side, rowTotal + item.area);
    // Adding this item made the row *less* square: close the row first.
    if (row.length && next > current) {
      flushRow();
    }
    row.push(item);
    rowTotal += item.area;
  }
  flushRow();
  return out;
}

/**
 * Collapse processes into named families, summing their memory.
 *
 * A browser or a language runtime is dozens of processes; forty rectangles all
 * called `chrome` say less than one that says `chrome — 4.2 GB`. `keep` limits
 * the tiles and the remainder is gathered into one "other" so the areas still
 * sum to the whole.
 */
export function groupByName<T extends { name: string; mem_mb: number }>(
  procs: T[],
  keep: number,
): { name: string; mem_mb: number; count: number }[] {
  const byName = new Map<string, { name: string; mem_mb: number; count: number }>();
  for (const p of procs) {
    const at = byName.get(p.name);
    if (at) {
      at.mem_mb += p.mem_mb;
      at.count += 1;
    } else {
      byName.set(p.name, { name: p.name, mem_mb: p.mem_mb, count: 1 });
    }
  }
  const all = [...byName.values()].sort((a, b) => b.mem_mb - a.mem_mb);
  if (all.length <= keep) return all;
  const head = all.slice(0, keep);
  const tail = all.slice(keep);
  head.push({
    name: "other",
    mem_mb: tail.reduce((n, g) => n + g.mem_mb, 0),
    count: tail.reduce((n, g) => n + g.count, 0),
  });
  return head;
}
