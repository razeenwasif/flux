import { afterEach, describe, expect, it, vi } from "vitest";

import { startPaneResize, type Pos, type ResizeDir, type Size } from "./paneGeometry";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Drag `dir`'s handle from (500, 300) through `moves` and return the final box. */
function resize(dir: ResizeDir, p0: Pos, s0: Size, moves: [number, number][]): Pos & Size {
  const listeners = new Map<string, (e: { clientX: number; clientY: number }) => void>();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: { clientX: number; clientY: number }) => void) =>
      listeners.set(type, fn),
    removeEventListener: () => {},
  });
  let pos = p0;
  let size = s0;
  const ctl = {
    pos: () => pos,
    setPos: (p: Pos) => (pos = p),
    size: () => size,
    setSize: (s: Size) => (size = s),
    setDragging: () => {},
    onFocus: () => {},
  };
  const down = { clientX: 500, clientY: 300, preventDefault() {}, stopPropagation() {} };
  startPaneResize(ctl, down as unknown as PointerEvent, dir);
  for (const [clientX, clientY] of moves) listeners.get("pointermove")!({ clientX, clientY });
  return { ...pos, ...size };
}

describe("pane resize", () => {
  it("stops growing at the window's top and left edges", () => {
    // The bug: dragging the north edge past the top of the window (pointer
    // capture keeps reporting negative clientY) pushed the origin off-screen,
    // taking the title bar, its only move handle and its ✕ with it.
    const box = resize("nw", { x: 100, y: 80 }, { w: 600, h: 400 }, [[-400, -500]]);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    // The opposite edges stay where they were.
    expect(box.x + box.w).toBe(700);
    expect(box.y + box.h).toBe(480);
  });

  it("still resizes normally inside the window", () => {
    const box = resize("n", { x: 100, y: 80 }, { w: 600, h: 400 }, [[500, 260]]);
    expect(box).toEqual({ x: 100, y: 40, w: 600, h: 440 });
  });

  it("keeps the minimum size when shrunk from the north or west", () => {
    const box = resize("nw", { x: 100, y: 80 }, { w: 600, h: 400 }, [[2000, 2000]]);
    expect(box.w).toBe(320);
    expect(box.h).toBe(200);
    expect(box.x + box.w).toBe(700);
    expect(box.y + box.h).toBe(480);
  });
});
