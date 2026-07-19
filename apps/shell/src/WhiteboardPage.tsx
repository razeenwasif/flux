/**
 * flux://whiteboard — a built-in whiteboard / paint surface. DOM-rendered in
 * the content card (no webview), velvet/glass chrome, lazy chunk.
 *
 * Vector model: every mark is a stroke object (pen/highlighter paths, shapes,
 * text), re-rendered through a camera — which makes undo/redo exact, the
 * eraser object-based (remove a stroke, not smudge pixels), and pan/zoom free
 * (same camera pattern as the Trail/Omni graphs). Pointer events throughout,
 * so mouse, touch and stylus all draw (ADR 0012 rung B). Boards persist to
 * localStorage as compact stroke JSON (autosaved, multiple named boards);
 * export goes to PNG (download or clipboard).
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { activeId, updateTabTitle } from "./store";

type Pt = { x: number; y: number };
type PathStroke = { t: "pen" | "hi"; color: string; w: number; pts: Pt[] };
type ShapeStroke = { t: "line" | "rect" | "ellipse" | "arrow"; color: string; w: number; a: Pt; b: Pt };
type TextStroke = { t: "text"; color: string; size: number; at: Pt; text: string };
type Stroke = PathStroke | ShapeStroke | TextStroke;
// TS can't collapse a variant whose discriminant is a union ("pen" | "hi") on
// negative narrowing — an explicit guard keeps the checker honest.
const isPath = (s: Stroke): s is PathStroke => s.t === "pen" || s.t === "hi";

type Board = { id: string; name: string; ts: number; strokes: Stroke[] };

const BOARDS_KEY = "flux.whiteboard.boards";
const loadBoards = (): Board[] => {
  try {
    const v = JSON.parse(localStorage.getItem(BOARDS_KEY) || "[]");
    return Array.isArray(v) && v.length ? v : [{ id: "b1", name: "Board 1", ts: Date.now(), strokes: [] }];
  } catch {
    return [{ id: "b1", name: "Board 1", ts: Date.now(), strokes: [] }];
  }
};

const COLORS = ["#f5f4ff", "#2ff3ff", "#7b61ff", "#ec4be0", "#ffc46b", "#7dff8a", "#ff6b6b", "#0a0a14"];
type Tool = "pen" | "hi" | "eraser" | "line" | "rect" | "ellipse" | "arrow" | "text" | "pan";
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "pen", icon: "✏️", label: "Pen", key: "P" },
  { id: "hi", icon: "🖊", label: "Highlighter", key: "H" },
  { id: "eraser", icon: "🧽", label: "Eraser (removes whole strokes)", key: "E" },
  { id: "line", icon: "╱", label: "Line", key: "L" },
  { id: "arrow", icon: "➔", label: "Arrow", key: "A" },
  { id: "rect", icon: "▭", label: "Rectangle", key: "R" },
  { id: "ellipse", icon: "◯", label: "Ellipse", key: "O" },
  { id: "text", icon: "T", label: "Text (click to place)", key: "T" },
  { id: "pan", icon: "✋", label: "Pan (or middle/space-drag; wheel zooms)", key: "Space" },
];

const WhiteboardPage: Component = () => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  let textInput: HTMLInputElement | undefined;

  const [boards, setBoards] = createSignal<Board[]>(loadBoards());
  const [boardId, setBoardId] = createSignal(boards()[0]!.id);
  const board = () => boards().find((b) => b.id === boardId()) ?? boards()[0]!;

  const [tool, setTool] = createSignal<Tool>("pen");
  const [color, setColor] = createSignal(COLORS[1]!);
  const [width, setWidth] = createSignal(3);
  const [textAt, setTextAt] = createSignal<Pt | null>(null); // world coords of a pending text

  // Camera (world → screen: screen = (world - cam) * zoom).
  const cam = { x: 0, y: 0, z: 1 };
  let dpr = 1,
    W = 0,
    H = 0;
  // Undo/redo: snapshots of the stroke-array reference (strokes are immutable
  // once committed, so snapshots are cheap ref copies).
  let undoStack: Stroke[][] = [];
  let redoStack: Stroke[][] = [];
  let live: Stroke | null = null; // the stroke being drawn (not yet committed)
  let panning = false;
  let spaceHeld = false;
  let lastX = 0,
    lastY = 0;
  let saveTimer = 0;

  const strokes = () => board().strokes;
  const setStrokes = (next: Stroke[], recordUndo = true) => {
    if (recordUndo) {
      undoStack.push(board().strokes);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
    }
    setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, strokes: next, ts: Date.now() } : b)));
    scheduleSave();
    draw();
  };
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(BOARDS_KEY, JSON.stringify(boards()));
      } catch {
        /* full/private — drawing still lives in memory */
      }
    }, 500);
  };

  // ── rendering ──
  const toWorld = (px: number, py: number): Pt => ({ x: px / cam.z + cam.x, y: py / cam.z + cam.y });
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    draw();
  };
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
      ctx.font = `${s.size}px system-ui, sans-serif`;
      ctx.fillText(s.text, s.at.x, s.at.y);
    }
    ctx.globalAlpha = 1;
  };
  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Dot grid, drawn in screen space so it telegraphs the zoom level.
    const step = 28 * cam.z;
    if (step > 9) {
      ctx.fillStyle = "rgba(150,160,220,0.13)";
      const ox = (-cam.x * cam.z) % step;
      const oy = (-cam.y * cam.z) % step;
      for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.save();
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);
    for (const s of strokes()) drawStroke(ctx, s);
    if (live) drawStroke(ctx, live);
    ctx.restore();
  };

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
    if (t === "pan" || e.button === 1 || spaceHeld) {
      panning = true;
      return;
    }
    const p = toWorld(px, py);
    if (t === "text") {
      setTextAt(p);
      requestAnimationFrame(() => textInput?.focus());
      return;
    }
    if (t === "eraser") {
      const i = hitStroke(p, 8 / cam.z);
      if (i >= 0) setStrokes(strokes().filter((_, j) => j !== i));
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
      lastX = px;
      lastY = py;
      draw();
      return;
    }
    lastX = px;
    lastY = py;
    if (!live) {
      if (tool() === "eraser" && e.buttons === 1) {
        const i = hitStroke(toWorld(px, py), 8 / cam.z);
        if (i >= 0) setStrokes(strokes().filter((_, j) => j !== i));
      }
      return;
    }
    const p = toWorld(px, py);
    if (isPath(live)) {
      const lastPt = live.pts[live.pts.length - 1]!;
      if (Math.hypot(p.x - lastPt.x, p.y - lastPt.y) > 1.2 / cam.z) live.pts.push(p);
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
    if (!trivial) setStrokes([...strokes(), done]);
    else draw();
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
    draw();
  };

  const commitText = () => {
    const at = textAt();
    const v = textInput?.value.trim();
    setTextAt(null);
    if (at && v)
      setStrokes([...strokes(), { t: "text", color: color(), size: 10 + width() * 2, at, text: v }]);
  };

  const undo = () => {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(board().strokes);
    setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, strokes: prev } : b)));
    scheduleSave();
    draw();
  };
  const redo = () => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(board().strokes);
    setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, strokes: next } : b)));
    scheduleSave();
    draw();
  };
  const clearBoard = () => {
    if (strokes().length && !window.confirm("Clear this board? (Undo can bring it back.)")) return;
    setStrokes([]);
  };

  // ── boards ──
  const addBoard = () => {
    const id = `b${Date.now().toString(36)}`;
    const b: Board = { id, name: `Board ${boards().length + 1}`, ts: Date.now(), strokes: [] };
    setBoards((bs) => [...bs, b]);
    switchBoard(id);
    scheduleSave();
  };
  const switchBoard = (id: string) => {
    setBoardId(id);
    undoStack = [];
    redoStack = [];
    cam.x = 0;
    cam.y = 0;
    cam.z = 1;
    draw();
  };
  const renameBoard = () => {
    const name = window.prompt("Board name", board().name)?.trim();
    if (name) {
      setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, name } : b)));
      scheduleSave();
    }
  };
  const deleteBoard = () => {
    if (boards().length <= 1) return clearBoard();
    if (!window.confirm(`Delete “${board().name}”?`)) return;
    const gone = boardId();
    setBoards((bs) => bs.filter((b) => b.id !== gone));
    switchBoard(boards()[0]!.id);
    scheduleSave();
  };

  /** Export the strokes' bounding box (plus margin) as a PNG on a velvet bg. */
  const exportPng = async (toClipboard: boolean) => {
    const ss = strokes();
    if (!ss.length) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const feed = (p: Pt) => {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
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
    const w = Math.min(4096, Math.ceil(x1 - x0) + M * 2);
    const h = Math.min(4096, Math.ceil(y1 - y0) + M * 2);
    const off = document.createElement("canvas");
    off.width = w * 2;
    off.height = h * 2;
    const ctx = off.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.fillStyle = "#12101f";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(M - x0, M - y0);
    for (const s of ss) drawStroke(ctx, s);
    const blob: Blob | null = await new Promise((res) => off.toBlob(res, "image/png"));
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
    a.download = `${board().name.replace(/\s+/g, "-").toLowerCase()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // ── lifecycle ──
  let ro: ResizeObserver | undefined;
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Whiteboard");
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(wrap);
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
      window.clearTimeout(saveTimer);
      try {
        localStorage.setItem(BOARDS_KEY, JSON.stringify(boards()));
      } catch {
        /* ignore */
      }
    });
  });
  onCleanup(() => ro?.disconnect());

  const textScreen = () => {
    const at = textAt();
    if (!at) return { left: "0px", top: "0px" };
    return { left: `${(at.x - cam.x) * cam.z}px`, top: `${(at.y - cam.y) * cam.z}px` };
  };

  return (
    <div class="wb">
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
        <button class="wb-btn danger" title="Clear board" onClick={clearBoard}>
          🗑
        </button>
      </div>
      <div class="wb-canvas-wrap" ref={wrap}>
        <canvas
          ref={canvas}
          class="wb-canvas"
          classList={{ panning: tool() === "pan" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onWheel={onWheel}
        />
        <Show when={textAt()}>
          <input
            ref={textInput}
            class="wb-text-input"
            style={textScreen()}
            placeholder="Type, Enter to place"
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              else if (e.key === "Escape") setTextAt(null);
            }}
            onBlur={commitText}
          />
        </Show>
      </div>
      <div class="wb-boards">
        <For each={boards()}>
          {(b) => (
            <button
              classList={{ "wb-board": true, on: b.id === boardId() }}
              title={new Date(b.ts).toLocaleString()}
              onClick={() => switchBoard(b.id)}
              onDblClick={renameBoard}
            >
              {b.name}
            </button>
          )}
        </For>
        <button class="wb-board wb-board-add" title="New board" onClick={addBoard}>
          ＋
        </button>
        <span style={{ flex: 1 }} />
        <button class="wb-board" title="Rename board" onClick={renameBoard}>
          ✎
        </button>
        <button class="wb-board" title="Delete board" onClick={deleteBoard}>
          ✕
        </button>
      </div>
    </div>
  );
};

export default WhiteboardPage;
