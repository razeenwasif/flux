/**
 * InkCanvas — the shared vector-ink engine behind both `flux://whiteboard` (an
 * infinite scratch canvas) and `flux://scribe` (paged, per-course notebooks).
 *
 * Every mark is a stroke object (pen/highlighter paths, shapes, text) re-rendered
 * through a camera — so undo/redo is exact, the eraser is object-based (remove a
 * stroke, not smudge pixels), and pan/zoom is free. Pointer events throughout, so
 * mouse, touch and stylus all draw (ADR 0012 rung B).
 *
 * Strokes are **controlled**: the parent owns the array and receives `onChange`.
 * That lets the whiteboard persist to localStorage and Scribe persist each page
 * to disk without this component knowing either. `bounds` switches between the
 * infinite dot-grid surface (`null`) and a fixed-size paper page (`{w,h}`, with a
 * `template` background) that Scribe publishes to Onyx as a PNG.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type Component } from "solid-js";

export type Pt = { x: number; y: number };
export type PathStroke = { t: "pen" | "hi"; color: string; w: number; pts: Pt[] };
export type ShapeStroke = {
  t: "line" | "rect" | "ellipse" | "arrow";
  color: string;
  w: number;
  a: Pt;
  b: Pt;
};
export type TextStyle = "body" | "h2" | "h1";
/** A text block. `at` is the baseline of its FIRST line (unchanged from the
 *  single-line original, so notes written before wrapping existed render
 *  identically). `w` is the wrap width in world units; absent = no wrapping. */
export type TextStroke = {
  t: "text";
  color: string;
  size: number;
  at: Pt;
  text: string;
  /** Wrap width. `#[serde(default)]`-style optional so old strokes still load. */
  w?: number;
  style?: TextStyle;
};
export type Stroke = PathStroke | ShapeStroke | TextStroke;
// TS can't collapse a variant whose discriminant is a union ("pen" | "hi") on
// negative narrowing — an explicit guard keeps the checker honest.
const isPath = (s: Stroke): s is PathStroke => s.t === "pen" || s.t === "hi";

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** Type scale. A notebook wants a document's hierarchy, not arbitrary sizes. */
const TEXT_STYLES: Record<TextStyle, { mult: number; weight: string }> = {
  body: { mult: 1, weight: "400" },
  h2: { mult: 1.5, weight: "600" },
  h1: { mult: 2.05, weight: "700" },
};
export const fontSizeOf = (s: TextStroke): number => Math.round(s.size * TEXT_STYLES[s.style ?? "body"].mult);
const fontOf = (s: TextStroke): string =>
  `${TEXT_STYLES[s.style ?? "body"].weight} ${fontSizeOf(s)}px system-ui, sans-serif`;
/** Leading. Generous enough that handwriting fits between typed lines. */
export const lineHeightOf = (s: TextStroke): number => fontSizeOf(s) * 1.38;

// One offscreen context for text measurement, shared by wrapping, bounds and
// hit-testing so all three agree on where a glyph actually is.
let measureCtx: CanvasRenderingContext2D | null = null;
const measurer = (): CanvasRenderingContext2D => {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx!;
};

/** Lay a text block out into rendered lines: explicit newlines always break,
 *  and each paragraph wraps at `w`. A single word longer than the line is left
 *  to overflow rather than being chopped mid-word. */
export const wrapText = (s: TextStroke): string[] => {
  const ctx = measurer();
  ctx.font = fontOf(s);
  const width = s.w ?? 0;
  const out: string[] = [];
  for (const para of s.text.split("\n")) {
    if (!width) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const cand = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(cand).width <= width) line = cand;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
};
/** Rendered width of the widest line (for bounds when there's no wrap width). */
const textWidth = (s: TextStroke, lines: string[]): number => {
  if (s.w) return s.w;
  const ctx = measurer();
  ctx.font = fontOf(s);
  return lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
};
/** The block's box in world units. */
export const textBox = (s: TextStroke): Box => {
  const lines = wrapText(s);
  const fs = fontSizeOf(s);
  const lh = lineHeightOf(s);
  return {
    x0: s.at.x,
    y0: s.at.y - fs,
    x1: s.at.x + textWidth(s, lines),
    y1: s.at.y + (lines.length - 1) * lh + fs * 0.25,
  };
};

/** Every point that defines a stroke — the basis of bounds, lasso hit-testing
 *  and the writing caret. Text is approximated from its anchor + glyph width. */
const pointsOf = (s: Stroke): Pt[] => {
  if (isPath(s)) return s.pts;
  if (s.t === "text") {
    const b = textBox(s);
    return [
      { x: b.x0, y: b.y0 },
      { x: b.x1, y: b.y1 },
    ];
  }
  return [s.a, s.b];
};

/** Bounding box of some strokes, or null when there are none. */
const bboxOf = (ss: Stroke[]): Box | null => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  let any = false;
  for (const s of ss) {
    for (const p of pointsOf(s)) {
      any = true;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return any ? { x0, y0, x1, y1 } : null;
};

/** Even-odd ray cast — is `p` inside the lasso polygon? */
const inPoly = (p: Pt, poly: Pt[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/** A copy of `s` shifted by (dx, dy) — selections move without mutating history. */
const translated = (s: Stroke, dx: number, dy: number): Stroke => {
  const mv = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
  if (isPath(s)) return { ...s, pts: s.pts.map(mv) };
  if (s.t === "text") return { ...s, at: mv(s.at) };
  return { ...s, a: mv(s.a), b: mv(s.b) };
};

export type InkBounds = { w: number; h: number } | null;
export type InkTemplate = "plain" | "grid" | "lined" | "squared";
/** Imperative handle handed to the parent once on mount (Scribe uses it to
 * render the current page to a PNG for publishing). */
export type InkApi = {
  pageToBlob: () => Promise<Blob | null>;
  /** Multiply the zoom about the viewport centre (1.2 = in, 1/1.2 = out). */
  zoomBy: (f: number) => void;
  /** Re-fit the page to the viewport (the paged surface's "100%"). */
  fit: () => void;
};

const COLORS = ["#f5f4ff", "#2ff3ff", "#7b61ff", "#ec4be0", "#ffc46b", "#7dff8a", "#ff6b6b", "#0a0a14"];
type Tool = "pen" | "hi" | "eraser" | "lasso" | "line" | "rect" | "ellipse" | "arrow" | "text" | "pan";
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "pen", icon: "✏️", label: "Pen", key: "P" },
  { id: "hi", icon: "🖊", label: "Highlighter", key: "H" },
  { id: "eraser", icon: "🧽", label: "Eraser (removes whole strokes)", key: "E" },
  { id: "lasso", icon: "🫧", label: "Lasso — circle writing to select, then drag or Delete", key: "S" },
  { id: "line", icon: "╱", label: "Line", key: "L" },
  { id: "arrow", icon: "➔", label: "Arrow", key: "A" },
  { id: "rect", icon: "▭", label: "Rectangle", key: "R" },
  { id: "ellipse", icon: "◯", label: "Ellipse", key: "O" },
  { id: "text", icon: "T", label: "Text (click to place)", key: "T" },
  { id: "pan", icon: "✋", label: "Pan (or middle/space-drag; wheel zooms)", key: "Space" },
];

/** Right-hand margin a text block wraps against on a bounded page. */
const PAGE_MARGIN = 48;

/** Velvet paper colour for a bounded (Scribe) page. */
const PAGE_BG = "#12101f";
const GRID_INK = "rgba(150,160,220,0.13)";

type Props = {
  strokes: Stroke[];
  onChange: (next: Stroke[]) => void;
  /** null = infinite canvas (whiteboard); {w,h} = fixed paper page (Scribe). */
  bounds?: InkBounds;
  template?: InkTemplate;
  /** Base filename (no extension) for the toolbar's PNG export. */
  exportName?: () => string;
  /** Called once on mount with an imperative handle (PNG, zoom). */
  api?: (a: InkApi) => void;
  /** Current zoom, whenever it changes — so the host can show a percentage. */
  onZoom?: (z: number) => void;
};

/** Draw one stroke in world coordinates. Pure (ctx + stroke only), so the
 *  page thumbnails can reuse the exact renderer the canvas uses — a second
 *  implementation would drift from it. */
const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
  ctx.strokeStyle = s.t === "text" ? "transparent" : s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = s.t === "hi" ? 0.35 : 1;
  if (s.t === "pen" || s.t === "hi") {
    if (s.pts.length < 2) return;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.pts[0]!.x, s.pts[0]!.y);
    // Midpoint smoothing: quadratic through midpoints reads far better than
    // raw polylines for freehand ink.
    for (let i = 1; i < s.pts.length - 1; i++) {
      const p = s.pts[i]!;
      const n = s.pts[i + 1]!;
      ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
    }
    const last = s.pts[s.pts.length - 1]!;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  } else if (s.t === "line" || s.t === "arrow") {
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
    if (s.t === "arrow") {
      const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const len = Math.max(9, s.w * 3.2);
      ctx.beginPath();
      ctx.moveTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - len * Math.cos(ang - 0.45), s.b.y - len * Math.sin(ang - 0.45));
      ctx.moveTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - len * Math.cos(ang + 0.45), s.b.y - len * Math.sin(ang + 0.45));
      ctx.stroke();
    }
  } else if (s.t === "rect") {
    ctx.lineWidth = s.w;
    ctx.strokeRect(s.a.x, s.a.y, s.b.x - s.a.x, s.b.y - s.a.y);
  } else if (s.t === "ellipse") {
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.ellipse(
      (s.a.x + s.b.x) / 2,
      (s.a.y + s.b.y) / 2,
      Math.abs(s.b.x - s.a.x) / 2,
      Math.abs(s.b.y - s.a.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (s.t === "text") {
    ctx.font = fontOf(s);
    const lh = lineHeightOf(s);
    // Line 0 sits on `at`, so a pre-wrapping single-line note is unmoved.
    wrapText(s).forEach((ln, i) => ctx.fillText(ln, s.at.x, s.at.y + i * lh));
  }
  ctx.globalAlpha = 1;
};

/** Render strokes into an arbitrary context, scaled to fit `w`×`h` — the page
 *  thumbnails. Same renderer as the live canvas, so a preview can't lie. */
export const renderStrokesScaled = (
  ctx: CanvasRenderingContext2D,
  ss: Stroke[],
  page: { w: number; h: number },
  w: number,
  h: number,
): void => {
  ctx.save();
  ctx.scale(w / page.w, h / page.h);
  for (const s of ss) drawStroke(ctx, s);
  ctx.restore();
};

const InkCanvas: Component<Props> = (props) => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  let textInput: HTMLTextAreaElement | undefined;

  // A notebook page is for writing, so text is the default there; the infinite
  // whiteboard is for drawing and keeps the pen.
  const [tool, setTool] = createSignal<Tool>(props.bounds ? "text" : "pen");
  const [color, setColor] = createSignal(COLORS[1]!);
  const [width, setWidth] = createSignal(3);
  const [textAt, setTextAt] = createSignal<Pt | null>(null); // world coords of a pending text
  // Index of the text block being edited, or -1 when composing a new one. A
  // notebook needs its typing to be revisable, so clicking existing text reopens
  // it here rather than forcing an erase-and-retype.
  const [editIdx, setEditIdx] = createSignal(-1);
  const [textStyle, setTextStyle] = createSignal<TextStyle>("body");
  // Touch devices (iPad + Apple Pencil, Android tablets): default to "pen/mouse
  // draws, finger pans" so a resting palm or a scrolling finger doesn't
  // scribble. A pencil reports pointerType "pen", a finger reports "touch"; a
  // mouse reports "mouse" and is never treated as a finger, so this is a no-op
  // on desktop (the toggle only gates `pointerType === "touch"`).
  const coarsePrimary = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const [fingerPan, setFingerPan] = createSignal(coarsePrimary);

  const bounds = () => props.bounds ?? null;
  const template = () => props.template ?? (bounds() ? "grid" : "plain");

  // Camera (world → screen: screen = (world - cam) * zoom).
  const cam = { x: 0, y: 0, z: 1 };
  let dpr = 1,
    W = 0,
    H = 0;
  let fitDone = false; // paged mode: fit the page to the viewport once
  // Undo/redo: snapshots of the stroke-array reference (strokes are immutable
  // once committed, so snapshots are cheap ref copies).
  let undoStack: Stroke[][] = [];
  let redoStack: Stroke[][] = [];
  let live: Stroke | null = null; // the stroke being drawn (not yet committed)
  let panning = false;
  let spaceHeld = false;
  let lastX = 0,
    lastY = 0;

  // ── Writing caret ──
  // Scribe is a notebook, so typing flows down the page rather than needing a
  // click per line. The caret is where the next text lands: it advances after
  // each line, and — the point of it — drops *below* anything you draw, so
  // switching pen → text resumes under the diagram instead of on top of it.
  const [caret, setCaret] = createSignal<Pt | null>(null);
  const lineH = () => (10 + width() * 2) * 1.7;
  const homeCaret = (): Pt => {
    const b = bounds();
    return b ? { x: 48, y: 56 } : { x: cam.x + 40, y: cam.y + 60 };
  };
  /** Move the caret below `box`, keeping the left margin it started at. */
  const caretBelow = (box: Box) => {
    const x = caret()?.x ?? homeCaret().x;
    setCaret({ x, y: box.y1 + lineH() });
  };

  const strokes = () => props.strokes;
  // Commit a new stroke array through the parent, recording undo.
  const commit = (next: Stroke[]) => {
    undoStack.push(props.strokes);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    props.onChange(next);
  };

  // Selection (lasso): indices into the stroke array. Kept as indices rather
  // than references so a commit that rebuilds the array can simply clear it.
  const [sel, setSel] = createSignal<number[]>([]);
  let lasso: Pt[] | null = null; // the loop being drawn
  let movingSel = false; // dragging the current selection
  let dragStart: Stroke[] | null = null; // pre-drag array, for one undo entry
  const selBox = (): Box | null => {
    const ids = sel();
    if (!ids.length) return null;
    const ss = strokes();
    return bboxOf(ids.map((i) => ss[i]).filter((s): s is Stroke => !!s));
  };
  const clearSel = () => {
    if (sel().length) setSel([]);
  };
  const deleteSel = () => {
    const ids = new Set(sel());
    if (!ids.size) return;
    setSel([]);
    commit(strokes().filter((_, i) => !ids.has(i)));
  };

  /**
   * Keep the view over your writing. Panning is clamped so the viewport centre
   * stays within the written content plus headroom — you can always reach fresh
   * space to keep writing, but can't lose yourself in the far corner of a blank
   * page.
   */
  const clampCam = () => {
    const pad = 400;
    const b = bboxOf(strokes());
    const pg = bounds();
    let x0: number, y0: number, x1: number, y1: number;
    if (b) {
      x0 = b.x0 - pad;
      y0 = b.y0 - pad;
      x1 = b.x1 + pad;
      y1 = b.y1 + pad;
    } else if (pg) {
      x0 = 0;
      y0 = 0;
      x1 = pg.w;
      y1 = pg.h;
    } else {
      return; // empty infinite canvas — nothing to anchor to
    }
    const vw = W / cam.z / 2;
    const vh = H / cam.z / 2;
    cam.x = Math.max(x0 - vw, Math.min(x1 - vw, cam.x));
    cam.y = Math.max(y0 - vh, Math.min(y1 - vh, cam.y));
  };

  // ── rendering ──
  const toWorld = (px: number, py: number): Pt => ({ x: px / cam.z + cam.x, y: py / cam.z + cam.y });
  const fitPage = () => {
    const b = bounds();
    if (!b) return;
    // Fit the page width to ~92% of the viewport, top-aligned with a small margin.
    const z = Math.max(0.25, Math.min(2, (W * 0.92) / b.w));
    cam.z = z;
    cam.x = (b.w - W / z) / 2; // centre horizontally
    cam.y = -24 / z; // a little breathing room above the page
  };
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    if (bounds() && !fitDone && W > 0) {
      fitPage();
      fitDone = true;
    }
    draw();
  };
  /** Paper + template for a bounded page, drawn in world space (scrolls/zooms). */
  const drawPage = (ctx: CanvasRenderingContext2D, b: { w: number; h: number }) => {
    ctx.fillStyle = PAGE_BG;
    ctx.fillRect(0, 0, b.w, b.h);
    ctx.strokeStyle = "rgba(160,170,230,0.18)";
    ctx.lineWidth = 1 / cam.z;
    ctx.strokeRect(0, 0, b.w, b.h);
    const t = template();
    if (t === "plain") return;
    const step = 32;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, b.w, b.h);
    ctx.clip();
    if (t === "grid") {
      ctx.fillStyle = GRID_INK;
      for (let x = step; x < b.w; x += step)
        for (let y = step; y < b.h; y += step) ctx.fillRect(x, y, 1.4, 1.4);
    } else if (t === "squared") {
      ctx.strokeStyle = GRID_INK;
      ctx.lineWidth = 1 / cam.z;
      ctx.beginPath();
      for (let x = step; x < b.w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, b.h);
      }
      for (let y = step; y < b.h; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(b.w, y);
      }
      ctx.stroke();
    } else if (t === "lined") {
      ctx.strokeStyle = GRID_INK;
      ctx.lineWidth = 1 / cam.z;
      ctx.beginPath();
      for (let y = step * 1.5; y < b.h; y += step * 1.5) {
        ctx.moveTo(0, y);
        ctx.lineTo(b.w, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  };
  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const b = bounds();
    if (!b) {
      // Infinite canvas: dot grid drawn in screen space so it telegraphs zoom.
      const step = 28 * cam.z;
      if (step > 9) {
        ctx.fillStyle = GRID_INK;
        const ox = (-cam.x * cam.z) % step;
        const oy = (-cam.y * cam.z) % step;
        for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) ctx.fillRect(x, y, 1.2, 1.2);
      }
    }
    ctx.save();
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);
    if (b) drawPage(ctx, b);
    const selected = new Set(sel());
    strokes().forEach((s, i) => {
      drawStroke(ctx, s);
      if (selected.has(i)) {
        // Tint each selected stroke's own box, so it's obvious what's picked
        // even when the selection is scattered.
        const b = bboxOf([s]);
        if (b) {
          ctx.save();
          ctx.strokeStyle = "rgba(47,243,255,0.5)";
          ctx.lineWidth = 1 / cam.z;
          ctx.setLineDash([4 / cam.z, 3 / cam.z]);
          ctx.strokeRect(b.x0 - 3, b.y0 - 3, b.x1 - b.x0 + 6, b.y1 - b.y0 + 6);
          ctx.restore();
        }
      }
    });
    if (live) drawStroke(ctx, live);
    // The lasso loop being drawn.
    if (lasso && lasso.length > 1) {
      ctx.save();
      ctx.strokeStyle = "rgba(47,243,255,0.9)";
      ctx.fillStyle = "rgba(47,243,255,0.08)";
      ctx.lineWidth = 1.5 / cam.z;
      ctx.setLineDash([6 / cam.z, 4 / cam.z]);
      ctx.beginPath();
      ctx.moveTo(lasso[0]!.x, lasso[0]!.y);
      for (const p of lasso.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // The selection's overall box — the handle you drag to move it.
    const sb = selBox();
    if (sb && !lasso) {
      ctx.save();
      ctx.strokeStyle = "rgba(47,243,255,0.75)";
      ctx.lineWidth = 1.5 / cam.z;
      ctx.setLineDash([8 / cam.z, 5 / cam.z]);
      ctx.strokeRect(sb.x0 - 8, sb.y0 - 8, sb.x1 - sb.x0 + 16, sb.y1 - sb.y0 + 16);
      ctx.restore();
    }
    ctx.restore();
  };

  // Redraw when the parent swaps the stroke array (external reset, undo) or the
  // template changes.
  createEffect(() => {
    void props.strokes;
    void props.template;
    void sel();
    draw();
  });

  // ── input ──
  const hitStroke = (p: Pt, tol: number): number => {
    const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
    const segNear = (a: Pt, b: Pt) => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 === 0) return near(a, p);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      return near({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, p);
    };
    const ss = strokes();
    for (let i = ss.length - 1; i >= 0; i--) {
      const s = ss[i]!;
      if (s.t === "pen" || s.t === "hi") {
        for (let j = 0; j < s.pts.length - 1; j++) if (segNear(s.pts[j]!, s.pts[j + 1]!)) return i;
      } else if (s.t === "line" || s.t === "arrow") {
        if (segNear(s.a, s.b)) return i;
      } else if (s.t === "rect" || s.t === "ellipse") {
        const x0 = Math.min(s.a.x, s.b.x) - tol,
          x1 = Math.max(s.a.x, s.b.x) + tol;
        const y0 = Math.min(s.a.y, s.b.y) - tol,
          y1 = Math.max(s.a.y, s.b.y) + tol;
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return i;
      } else if (
        s.t === "text" &&
        p.x >= s.at.x - tol &&
        p.x <= s.at.x + s.text.length * s.size * 0.6 + tol &&
        p.y >= s.at.y - s.size &&
        p.y <= s.at.y + tol
      ) {
        return i;
      }
    }
    return -1;
  };

  const onDown = (e: PointerEvent) => {
    if (textAt()) return; // finish the text first
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    lastX = px;
    lastY = py;
    canvas.setPointerCapture(e.pointerId);
    const t = tool();
    // A finger pans (not draws) when finger-pan mode is on — Pencil still draws.
    const fingerScroll = fingerPan() && e.pointerType === "touch";
    if (t === "pan" || e.button === 1 || spaceHeld || fingerScroll) {
      panning = true;
      return;
    }
    const p = toWorld(px, py);
    if (t === "lasso") {
      // Pressing inside an existing selection drags it; otherwise start a loop.
      const box = selBox();
      if (box && p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) {
        movingSel = true;
        dragStart = props.strokes;
        return;
      }
      clearSel();
      lasso = [p];
      draw();
      return;
    }
    clearSel();
    if (t === "text") {
      // Land on existing text → edit that block. This is what makes typed notes
      // revisable rather than write-once.
      const hit = strokes().findIndex((st) => {
        if (st.t !== "text") return false;
        const b = textBox(st);
        return p.x >= b.x0 - 6 && p.x <= b.x1 + 6 && p.y >= b.y0 - 4 && p.y <= b.y1 + 4;
      });
      if (hit >= 0) {
        const st = strokes()[hit] as TextStroke;
        setEditIdx(hit);
        setTextStyle(st.style ?? "body");
        setTextAt(st.at);
        requestAnimationFrame(() => {
          if (!textInput) return;
          textInput.value = st.text;
          textInput.focus();
          textInput.select();
        });
        return;
      }
      setEditIdx(-1);
      setCaret(p);
      setTextAt(p);
      requestAnimationFrame(() => textInput?.focus());
      return;
    }
    if (t === "eraser") {
      const i = hitStroke(p, 8 / cam.z);
      if (i >= 0) commit(strokes().filter((_, j) => j !== i));
      return;
    }
    live =
      t === "pen" || t === "hi"
        ? { t, color: color(), w: width() * (t === "hi" ? 4 : 1), pts: [p] }
        : { t, color: color(), w: width(), a: p, b: p };
    draw();
  };
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    if (panning) {
      cam.x -= (px - lastX) / cam.z;
      cam.y -= (py - lastY) / cam.z;
      clampCam();
      lastX = px;
      lastY = py;
      draw();
      return;
    }
    if (lasso) {
      lasso.push(toWorld(px, py));
      lastX = px;
      lastY = py;
      draw();
      return;
    }
    if (movingSel) {
      const dx = (px - lastX) / cam.z;
      const dy = (py - lastY) / cam.z;
      lastX = px;
      lastY = py;
      const ids = new Set(sel());
      // Live-move without touching undo; the commit lands on pointer-up.
      props.onChange(strokes().map((s, i) => (ids.has(i) ? translated(s, dx, dy) : s)));
      return;
    }
    lastX = px;
    lastY = py;
    if (!live) {
      if (tool() === "eraser" && e.buttons === 1) {
        const i = hitStroke(toWorld(px, py), 8 / cam.z);
        if (i >= 0) commit(strokes().filter((_, j) => j !== i));
      }
      return;
    }
    const p = toWorld(px, py);
    if (isPath(live)) {
      const path = live;
      // Pencils sample at 120–240 Hz; the browser batches those into one move
      // event. Replay the coalesced samples so fast strokes stay smooth instead
      // of polygonal. Falls back to the single event where unsupported.
      const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const samples = coalesced.length ? coalesced : [e];
      for (const ce of samples) {
        const cp = toWorld(ce.clientX - r.left, ce.clientY - r.top);
        const lastPt = path.pts[path.pts.length - 1]!;
        if (Math.hypot(cp.x - lastPt.x, cp.y - lastPt.y) > 1.2 / cam.z) path.pts.push(cp);
      }
    } else if (live.t !== "text") {
      const shp = live; // narrowed const alias (TS loses closure-let narrowing)
      // Shift constrains lines to 45° steps and shapes to squares/circles.
      if (e.shiftKey && (shp.t === "line" || shp.t === "arrow")) {
        const dx = p.x - shp.a.x,
          dy = p.y - shp.a.y;
        const ang = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
        const len = Math.hypot(dx, dy);
        shp.b = { x: shp.a.x + len * Math.cos(ang), y: shp.a.y + len * Math.sin(ang) };
      } else if (e.shiftKey && (shp.t === "rect" || shp.t === "ellipse")) {
        const d = Math.max(Math.abs(p.x - shp.a.x), Math.abs(p.y - shp.a.y));
        shp.b = {
          x: shp.a.x + Math.sign(p.x - shp.a.x || 1) * d,
          y: shp.a.y + Math.sign(p.y - shp.a.y || 1) * d,
        };
      } else {
        shp.b = p;
      }
    }
    draw();
  };
  const onUp = (e: PointerEvent) => {
    panning = false;
    if (lasso) {
      // Select whatever sits inside the loop. A stroke counts as selected when
      // any of its defining points is enclosed, which is what feels right for
      // circling a word or a diagram.
      const loop = lasso;
      lasso = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (loop.length > 2) {
        const picked: number[] = [];
        strokes().forEach((st, i) => {
          if (pointsOf(st).some((pt) => inPoly(pt, loop))) picked.push(i);
        });
        setSel(picked);
      }
      draw();
      return;
    }
    if (movingSel) {
      movingSel = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      // One undo entry for the whole drag: props already hold the moved state,
      // so record the pre-drag array that `commit` would otherwise miss.
      undoStack.push(dragStart ?? props.strokes);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      dragStart = null;
      draw();
      return;
    }
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!live) return;
    const done = live;
    live = null;
    let trivial: boolean;
    if (isPath(done)) trivial = done.pts.length < 2;
    else if (done.t === "text") trivial = false;
    else trivial = Math.hypot(done.b.x - done.a.x, done.b.y - done.a.y) < 2 / cam.z;
    if (!trivial) {
      commit([...strokes(), done]);
      // The pen→text hand-off: whatever you just drew pushes the writing caret
      // below it, so switching back to text resumes under the drawing.
      const box = bboxOf([done]);
      if (box && done.t !== "text") caretBelow(box);
    } else draw();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left,
      py = e.clientY - r.top;
    const before = toWorld(px, py);
    cam.z = Math.max(0.25, Math.min(4, cam.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const after = toWorld(px, py);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    clampCam();
    props.onZoom?.(cam.z);
    draw();
  };

  /** Wrap width for a block starting at `x`: to the page's right margin, so
   *  typing behaves like a document instead of running off the sheet. */
  const wrapWidthAt = (x: number): number | undefined => {
    const b = bounds();
    if (!b) return undefined; // infinite canvas: no margin to wrap against
    return Math.max(120, b.w - PAGE_MARGIN - x);
  };

  const commitText = () => {
    const at = textAt();
    const raw = textInput?.value ?? "";
    const v = raw.replace(/\s+$/, "");
    const idx = editIdx();
    setTextAt(null);
    setEditIdx(-1);
    if (!at) return;
    const size = 10 + width() * 2;
    if (!v) {
      // Emptying an existing block deletes it — the expected editor behaviour.
      if (idx >= 0) commit(strokes().filter((_, i) => i !== idx));
      return;
    }
    const block: TextStroke = {
      t: "text",
      color: color(),
      size,
      at,
      text: v,
      w: wrapWidthAt(at.x),
      style: textStyle(),
    };
    if (idx >= 0) {
      // Keep the original colour/size unless the style changed under it.
      const prev = strokes()[idx] as TextStroke;
      commit(strokes().map((st, i) => (i === idx ? { ...prev, ...block, at: prev.at } : st)));
      const b = textBox({ ...prev, ...block, at: prev.at });
      setCaret({ x: prev.at.x, y: b.y1 + lineHeightOf(block) });
      return;
    }
    commit([...strokes(), block]);
    // Flow down the page: the next block lands under this one.
    setCaret({ x: at.x, y: textBox(block).y1 + lineHeightOf(block) });
  };

  /** Open the text input at the caret (creating one at the page's top-left the
   *  first time), so text mode is type-and-go rather than click-then-type. */
  const openCaret = () => {
    if (textAt()) return;
    const at = caret() ?? homeCaret();
    setCaret(at);
    setTextAt(at);
    requestAnimationFrame(() => textInput?.focus());
  };

  // Selecting the text tool resumes writing where the caret is — including
  // below a drawing you just made. Scoped to `tool` with on(): tracking the
  // caret/textAt reads inside openCaret would make blurring the input (clicking
  // the toolbar) commit → reopen → refocus in a loop.
  createEffect(
    on(tool, (t) => {
      if (t === "text") openCaret();
    }),
  );

  const undo = () => {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(props.strokes);
    props.onChange(prev);
  };
  const redo = () => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(props.strokes);
    props.onChange(next);
  };
  const clearAll = () => {
    if (strokes().length && !window.confirm("Clear this page? (Undo can bring it back.)")) return;
    commit([]);
  };

  /** Render the current content to a PNG blob at 2×. For a bounded page, the
   * whole page rectangle; otherwise the strokes' bounding box (+ margin). */
  const renderBlob = async (): Promise<Blob | null> => {
    const ss = strokes();
    const b = bounds();
    let x0: number, y0: number, w: number, h: number;
    if (b) {
      x0 = 0;
      y0 = 0;
      w = b.w;
      h = b.h;
    } else {
      if (!ss.length) return null;
      let ax = Infinity,
        ay = Infinity,
        bx = -Infinity,
        by = -Infinity;
      const feed = (p: Pt) => {
        ax = Math.min(ax, p.x);
        ay = Math.min(ay, p.y);
        bx = Math.max(bx, p.x);
        by = Math.max(by, p.y);
      };
      for (const s of ss) {
        if (isPath(s)) s.pts.forEach(feed);
        else if (s.t === "text") {
          feed(s.at);
          feed({ x: s.at.x + s.text.length * s.size * 0.6, y: s.at.y - s.size });
        } else {
          feed(s.a);
          feed(s.b);
        }
      }
      const M = 24;
      x0 = ax - M;
      y0 = ay - M;
      w = Math.min(4096, Math.ceil(bx - ax) + M * 2);
      h = Math.min(4096, Math.ceil(by - ay) + M * 2);
    }
    const off = document.createElement("canvas");
    off.width = w * 2;
    off.height = h * 2;
    const ctx = off.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.translate(-x0, -y0);
    if (b) drawPage(ctx, b);
    else {
      ctx.fillStyle = PAGE_BG;
      ctx.fillRect(x0, y0, w, h);
    }
    for (const s of ss) drawStroke(ctx, s);
    return await new Promise((res) => off.toBlob(res, "image/png"));
  };

  const exportPng = async (toClipboard: boolean) => {
    const blob = await renderBlob();
    if (!blob) return;
    if (toClipboard && navigator.clipboard && "write" in navigator.clipboard) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return;
      } catch {
        /* fall through to download */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(props.exportName?.() ?? "ink").replace(/\s+/g, "-").toLowerCase()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // ── lifecycle ──
  let ro: ResizeObserver | undefined;
  onMount(() => {
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(wrap);
    props.api?.({
      pageToBlob: renderBlob,
      zoomBy: (f) => {
        // Zoom about the viewport centre, matching what the wheel does about
        // the cursor.
        const before = toWorld(W / 2, H / 2);
        cam.z = Math.max(0.25, Math.min(4, cam.z * f));
        const after = toWorld(W / 2, H / 2);
        cam.x += before.x - after.x;
        cam.y += before.y - after.y;
        clampCam();
        props.onZoom?.(cam.z);
        draw();
      },
      fit: () => {
        fitPage();
        clampCam();
        props.onZoom?.(cam.z);
        draw();
      },
    });
    props.onZoom?.(cam.z);
    const onKey = (e: KeyboardEvent) => {
      if (textAt()) return; // typing in the text input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel().length) {
        e.preventDefault();
        deleteSel();
      } else if (e.key === "Escape" && sel().length) {
        clearSel();
      } else if (e.key === " ") {
        spaceHeld = true;
      } else if (!e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        const map: Record<string, Tool> = {
          p: "pen",
          h: "hi",
          e: "eraser",
          l: "line",
          a: "arrow",
          r: "rect",
          o: "ellipse",
          t: "text",
          s: "lasso",
        };
        if (map[k]) setTool(map[k]!);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") spaceHeld = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    });
  });
  onCleanup(() => ro?.disconnect());

  /** Place and size the editor exactly where its text will render, at the
   *  current zoom, so typing is WYSIWYG rather than a floating box. */
  const textScreen = () => {
    const at = textAt();
    if (!at) return { left: "0px", top: "0px" };
    const probe: TextStroke = {
      t: "text",
      color: color(),
      size: 10 + width() * 2,
      at,
      text: "",
      w: wrapWidthAt(at.x),
      style: textStyle(),
    };
    const fs = fontSizeOf(probe);
    return {
      left: `${(at.x - cam.x) * cam.z}px`,
      top: `${(at.y - fs - cam.y) * cam.z}px`,
      width: `${(probe.w ?? 260) * cam.z}px`,
      "font-size": `${fs * cam.z}px`,
      "line-height": `${lineHeightOf(probe) * cam.z}px`,
      "font-weight": textStyle() === "body" ? "400" : textStyle() === "h2" ? "600" : "700",
      color: color(),
    };
  };

  return (
    <div class="ink">
      <div class="wb-bar">
        <div class="wb-tools">
          <For each={TOOLS}>
            {(t) => (
              <button
                classList={{ "wb-tool": true, on: tool() === t.id }}
                title={`${t.label} (${t.key})`}
                onClick={() => setTool(t.id)}
              >
                {t.icon}
              </button>
            )}
          </For>
        </div>
        <div class="wb-colors">
          <For each={COLORS}>
            {(c) => (
              <button
                classList={{ "wb-color": true, on: color() === c }}
                style={{ background: c }}
                title={c}
                onClick={() => setColor(c)}
              />
            )}
          </For>
          <input
            class="wb-color-custom"
            type="color"
            title="Custom color"
            value={color()}
            onInput={(e) => setColor(e.currentTarget.value)}
          />
        </div>
        <Show when={tool() === "text"}>
          <div class="wb-styles">
            <For
              each={[
                { id: "body" as TextStyle, label: "Body" },
                { id: "h2" as TextStyle, label: "H2" },
                { id: "h1" as TextStyle, label: "H1" },
              ]}
            >
              {(st) => (
                <button
                  classList={{ "wb-style": true, on: textStyle() === st.id }}
                  title={`${st.label} text`}
                  onClick={() => setTextStyle(st.id)}
                >
                  {st.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <input
          class="wb-width"
          type="range"
          min="1"
          max="16"
          title={`Stroke width: ${width()}`}
          value={width()}
          onInput={(e) => setWidth(Number(e.currentTarget.value))}
        />
        <span style={{ flex: 1 }} />
        <button
          class="wb-btn"
          classList={{ on: fingerPan() }}
          title={
            fingerPan()
              ? "Finger pans · pen/mouse draws (tap to let a finger draw too)"
              : "Everything draws (tap so a finger pans and only the pen/mouse draws)"
          }
          onClick={() => setFingerPan((v) => !v)}
        >
          {fingerPan() ? "✍️" : "👆"}
        </button>
        <button class="wb-btn" title="Undo (Ctrl+Z)" onClick={undo}>
          ↩
        </button>
        <button class="wb-btn" title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          ↪
        </button>
        <button class="wb-btn" title="Copy as PNG" onClick={() => void exportPng(true)}>
          ⧉ PNG
        </button>
        <button class="wb-btn" title="Download PNG" onClick={() => void exportPng(false)}>
          ⬇
        </button>
        <button class="wb-btn danger" title="Clear page" onClick={clearAll}>
          🗑
        </button>
      </div>
      <div class="wb-canvas-wrap" ref={wrap}>
        <canvas
          ref={canvas}
          class="wb-canvas"
          classList={{ panning: tool() === "pan", lasso: tool() === "lasso" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onWheel={onWheel}
        />
        <Show when={textAt()}>
          {/* A textarea, not an input: a document's text wraps and holds
              paragraphs. It's sized and styled to match the rendered block, so
              what you type is what lands on the page. */}
          <textarea
            ref={textInput}
            class="wb-text-input"
            style={textScreen()}
            placeholder="Type — Shift+Enter for a new line, Esc to finish"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                // Enter finishes the block and starts the next one below;
                // Shift+Enter breaks the line inside it.
                e.preventDefault();
                commitText();
                if (tool() === "text") requestAnimationFrame(openCaret);
              } else if (e.key === "Escape") {
                e.preventDefault();
                commitText();
              }
            }}
            onBlur={commitText}
          />
        </Show>
      </div>
    </div>
  );
};

export default InkCanvas;
