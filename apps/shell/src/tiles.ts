/**
 * Tiling geometry for split view (#43, generalized to four panes).
 *
 * **One pure function owns the arithmetic.** Native webviews are positioned by
 * `tiling.ts` in viewport pixels, while Flux's internal pages are DOM laid out
 * by `ContentArea` in percentages — two consumers of the same geometry. When it
 * was one hard-coded "left | right at a ratio" they happened to agree; with
 * several layouts and multiple seams, two implementations would drift on the
 * first edit. So both call `tileRects()`, in whatever units they hand it.
 */
export type TileLayout =
  | "cols" // equal columns (│ │ │)
  | "rows" // equal rows (▤)
  | "quad" // 2 × 2
  | "mainLeft" // one large pane left, the rest stacked right
  | "mainRight"
  | "mainTop" // one large pane across the top, the rest side by side below
  | "mainBottom";

export type Rect = { x: number; y: number; width: number; height: number };

/** Most panes a split can hold. Beyond this a pane is too small to use, and the
 *  window is better served by a second window. */
export const MAX_PANES = 4;

/** Layouts that make sense for a given pane count, in menu order. */
export const layoutsFor = (n: number): TileLayout[] => {
  if (n <= 1) return [];
  if (n === 2) return ["cols", "rows"];
  if (n === 3) return ["mainLeft", "mainRight", "mainTop", "mainBottom", "cols", "rows"];
  return ["quad", "mainLeft", "mainRight", "mainTop", "mainBottom", "cols", "rows"];
};

export const LAYOUT_LABEL: Record<TileLayout, string> = {
  cols: "Columns",
  rows: "Rows",
  quad: "Quad",
  mainLeft: "Main left",
  mainRight: "Main right",
  mainTop: "Main top",
  mainBottom: "Main bottom",
};

/** Seams can't be dragged past this, so no pane collapses to nothing. */
const MIN_FRAC = 0.15;
const MAX_FRAC = 0.85;
export const clampFrac = (f: number): number => Math.min(MAX_FRAC, Math.max(MIN_FRAC, f));

/** A draggable seam: which ratio it edits and where it sits, in the same space
 *  as the rects. `axis` is the direction the seam *moves* in. */
export type Seam = { key: "main" | "sec"; axis: "x" | "y"; x: number; y: number; length: number };

type Opts = {
  layout: TileLayout;
  /** Pane count (1–4). */
  n: number;
  /** Primary seam fraction. */
  main: number;
  /** Secondary seam fraction (the stack split, or quad's horizontal seam). */
  sec: number;
  /** Space to lay out in. */
  rect: Rect;
  /** Gutter between panes, in the same units. */
  gap: number;
};

/** Split `total` into `n` equal parts minus gaps, returning [offset, size] pairs. */
const equal = (start: number, total: number, n: number, gap: number): [number, number][] => {
  const each = (total - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => [start + i * (each + gap), each]);
};

/**
 * Lay `n` panes out inside `rect`. Returns exactly `n` rects in slot order —
 * slot 0 is the "main" pane for the main* layouts.
 */
export function tileRects(o: Opts): Rect[] {
  const { layout, main, sec, rect, gap } = o;
  const n = Math.max(1, Math.min(MAX_PANES, o.n));
  const { x, y, width: w, height: h } = rect;
  if (n === 1) return [rect];
  const m = clampFrac(main);
  const s = clampFrac(sec);

  switch (layout) {
    case "cols": {
      // Two panes get an adjustable seam; three or four divide equally, where an
      // even split is what's actually wanted.
      if (n === 2) {
        const lw = Math.round(w * m - gap / 2);
        return [
          { x, y, width: lw, height: h },
          { x: x + lw + gap, y, width: w - lw - gap, height: h },
        ];
      }
      return equal(x, w, n, gap).map(([px, pw]) => ({ x: px, y, width: pw, height: h }));
    }
    case "rows": {
      if (n === 2) {
        const th = Math.round(h * m - gap / 2);
        return [
          { x, y, width: w, height: th },
          { x, y: y + th + gap, width: w, height: h - th - gap },
        ];
      }
      return equal(y, h, n, gap).map(([py, ph]) => ({ x, y: py, width: w, height: ph }));
    }
    case "quad": {
      const lw = Math.round(w * m - gap / 2);
      const th = Math.round(h * s - gap / 2);
      const rw = w - lw - gap;
      const bh = h - th - gap;
      const cells: Rect[] = [
        { x, y, width: lw, height: th },
        { x: x + lw + gap, y, width: rw, height: th },
        { x, y: y + th + gap, width: lw, height: bh },
        { x: x + lw + gap, y: y + th + gap, width: rw, height: bh },
      ];
      return cells.slice(0, n);
    }
    case "mainLeft":
    case "mainRight": {
      const mainW = Math.round(w * (layout === "mainLeft" ? m : 1 - m) - gap / 2);
      const restW = w - mainW - gap;
      const mainX = layout === "mainLeft" ? x : x + restW + gap;
      const restX = layout === "mainLeft" ? x + mainW + gap : x;
      const stack = n - 1;
      // With exactly two in the stack the split is adjustable; with three it's
      // even, which is the only sane default at that size.
      const parts: [number, number][] =
        stack === 2
          ? (() => {
              const t = Math.round(h * s - gap / 2);
              return [
                [y, t],
                [y + t + gap, h - t - gap],
              ];
            })()
          : equal(y, h, stack, gap);
      return [
        { x: mainX, y, width: mainW, height: h },
        ...parts.map(([py, ph]) => ({ x: restX, y: py, width: restW, height: ph })),
      ];
    }
    case "mainTop":
    case "mainBottom": {
      const mainH = Math.round(h * (layout === "mainTop" ? m : 1 - m) - gap / 2);
      const restH = h - mainH - gap;
      const mainY = layout === "mainTop" ? y : y + restH + gap;
      const restY = layout === "mainTop" ? y + mainH + gap : y;
      const stack = n - 1;
      const parts: [number, number][] =
        stack === 2
          ? (() => {
              const t = Math.round(w * s - gap / 2);
              return [
                [x, t],
                [x + t + gap, w - t - gap],
              ];
            })()
          : equal(x, w, stack, gap);
      return [
        { x, y: mainY, width: w, height: mainH },
        ...parts.map(([px, pw]) => ({ x: px, y: restY, width: pw, height: restH })),
      ];
    }
  }
}

/** The seams a layout exposes for dragging, positioned in `rect`'s space. */
export function tileSeams(o: Opts): Seam[] {
  const { layout, rect, gap } = o;
  const n = Math.max(1, Math.min(MAX_PANES, o.n));
  if (n < 2) return [];
  const r = tileRects(o);
  const out: Seam[] = [];
  const vert = (afterPane: number, key: Seam["key"], top: number, len: number) => {
    const p = r[afterPane];
    if (p) out.push({ key, axis: "x", x: p.x + p.width, y: top, length: len });
  };
  const horiz = (afterPane: number, key: Seam["key"], left: number, len: number) => {
    const p = r[afterPane];
    if (p) out.push({ key, axis: "y", x: left, y: p.y + p.height, length: len });
  };
  switch (layout) {
    case "cols":
      if (n === 2) vert(0, "main", rect.y, rect.height);
      break;
    case "rows":
      if (n === 2) horiz(0, "main", rect.x, rect.width);
      break;
    case "quad":
      vert(0, "main", rect.y, rect.height);
      horiz(0, "sec", rect.x, rect.width);
      break;
    case "mainLeft":
      vert(0, "main", rect.y, rect.height);
      if (n === 3) horiz(1, "sec", r[1]?.x ?? rect.x, r[1]?.width ?? 0);
      break;
    case "mainRight":
      if (r[1]) out.push({ key: "main", axis: "x", x: r[1].x + r[1].width, y: rect.y, length: rect.height });
      if (n === 3) horiz(1, "sec", r[1]?.x ?? rect.x, r[1]?.width ?? 0);
      break;
    case "mainTop":
      horiz(0, "main", rect.x, rect.width);
      if (n === 3) vert(1, "sec", r[1]?.y ?? rect.y, r[1]?.height ?? 0);
      break;
    case "mainBottom":
      if (r[1]) out.push({ key: "main", axis: "y", x: rect.x, y: r[1].y + r[1].height, length: rect.width });
      if (n === 3) vert(1, "sec", r[1]?.y ?? rect.y, r[1]?.height ?? 0);
      break;
  }
  return out;
}
