/**
 * Shared floating-pane geometry (move + resize) for `AppPane` and `TuiPane`.
 *
 * Both panes are real windows: draggable by their title bar and resizable from
 * any edge or corner. Resizing from the top/left edges has to move the origin
 * as well as change the size (anchor the opposite edge), which is the part that
 * is easy to get subtly wrong — so it lives here once rather than twice.
 */

export type Pos = { x: number; y: number };
export type Size = { w: number; h: number };
/** Which edges the gesture moves; "se" = bottom-right corner, etc. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Every resize handle a pane renders, with the cursor it should show. */
export const RESIZE_HANDLES: { dir: ResizeDir; cursor: string }[] = [
  { dir: "n", cursor: "ns-resize" },
  { dir: "s", cursor: "ns-resize" },
  { dir: "e", cursor: "ew-resize" },
  { dir: "w", cursor: "ew-resize" },
  { dir: "ne", cursor: "nesw-resize" },
  { dir: "nw", cursor: "nwse-resize" },
  { dir: "se", cursor: "nwse-resize" },
  { dir: "sw", cursor: "nesw-resize" },
];

const MIN_W = 320;
const MIN_H = 200;

type Ctl = {
  pos: () => Pos;
  setPos: (p: Pos) => void;
  size: () => Size;
  setSize: (s: Size) => void;
  /** Suspends pointer events inside the pane body during a gesture, so a fast
   *  drag can't get captured by the iframe/terminal under the cursor. */
  setDragging: (v: boolean) => void;
  onFocus: () => void;
};

/** Run `move` on pointermove until pointerup, with the body inert meanwhile. */
function gesture(ctl: Ctl, e: PointerEvent, move: (me: PointerEvent) => void): void {
  ctl.onFocus();
  e.preventDefault();
  ctl.setDragging(true);
  const up = () => {
    ctl.setDragging(false);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Drag the title bar to move the pane (kept fully on-screen enough to grab). */
export function startPaneDrag(ctl: Ctl, e: PointerEvent): void {
  if ((e.target as HTMLElement).closest(".apppane-btn")) return; // let buttons click
  const sx = e.clientX,
    sy = e.clientY,
    p0 = ctl.pos();
  gesture(ctl, e, (me) => {
    ctl.setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, p0.x + me.clientX - sx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, p0.y + me.clientY - sy)),
    });
  });
}

/**
 * Drag an edge/corner to resize. North and west edges move the origin by the
 * same amount they shrink the box, so the opposite edge stays put; both are
 * clamped at the minimum size so the pane can't invert or creep.
 */
export function startPaneResize(ctl: Ctl, e: PointerEvent, dir: ResizeDir): void {
  e.stopPropagation();
  const sx = e.clientX,
    sy = e.clientY,
    p0 = ctl.pos(),
    s0 = ctl.size();
  gesture(ctl, e, (me) => {
    const dx = me.clientX - sx;
    const dy = me.clientY - sy;
    let { x, y } = p0;
    let { w, h } = s0;
    if (dir.includes("e")) w = Math.max(MIN_W, s0.w + dx);
    if (dir.includes("s")) h = Math.max(MIN_H, s0.h + dy);
    if (dir.includes("w")) {
      w = Math.max(MIN_W, s0.w - dx);
      x = p0.x + (s0.w - w); // anchor the right edge
    }
    if (dir.includes("n")) {
      h = Math.max(MIN_H, s0.h - dy);
      y = p0.y + (s0.h - h); // anchor the bottom edge
    }
    ctl.setPos({ x, y });
    ctl.setSize({ w, h });
  });
}
