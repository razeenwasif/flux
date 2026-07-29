/**
 * Trail mini (ADR 0011 follow-up) — this workspace's browsing, in the sidebar.
 *
 * Three states, because one widget can't do all three jobs well at 230px:
 *   • **Graph** — a small force-directed map of the workspace's visits: nav and
 *     semantic edges pull related pages together, so clusters *are* the topics.
 *     Drag a node, drag the background to pan, wheel to zoom, click to open. No
 *     labels (illegible at this size) and the simulation stops once it settles,
 *     so an idle sidebar costs nothing.
 *   • **Expanded** — the list you actually *find* things in: recent visits,
 *     filterable by title/URL. Finding is a search problem, not a graph problem.
 *   • **⤢** — opens `flux://trail`, where the real graph lives.
 *
 * Scoped by workspace id (with a name fallback for visits recorded before ids
 * were stamped), so it only ever shows the research you're currently in.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";

import { TRAIL_URL, traceGraph, type Edge, type Visit } from "./ipc";
import { activeWorkspace, activeWorkspaceName, openTab } from "./store";

/** Simulation tuning. Attraction is deliberately strong relative to repulsion:
 *  at this size a spread-out graph is noise, and clusters are the whole point. */
const REPULSION = 900;
const SPRING = 0.012;
const SPRING_LEN = 34;
/** Pull toward the centre — the "gravitate together" knob. */
const GRAVITY = 0.022;
const DAMPING = 0.86;
/** Below this the layout is settled and the loop stops. */
const ALPHA_MIN = 0.02;

type Node = { id: number; x: number; y: number; vx: number; vy: number; hot: boolean; i: number };

/** Deterministic seed so a graph doesn't reshuffle on every refresh. */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

const TrailMini: Component = () => {
  const [visits, setVisits] = createSignal<Visit[]>([]);
  const [edges, setEdges] = createSignal<Edge[]>([]);
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);

  const load = () => {
    void traceGraph(undefined, undefined, activeWorkspace(), activeWorkspaceName())
      .then((g) => {
        setVisits([...g.visits].sort((a, b) => b.last_ms - a.last_ms));
        setEdges(g.edges);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  };

  // Refresh on workspace switch and on a slow tick — browsing adds visits while
  // this sits open, but a sidebar widget shouldn't poll hard. An *effect*, not a
  // memo: memos are lazy, so a memo used for a side effect never runs unless
  // something reads it.
  createEffect(() => {
    activeWorkspace();
    load();
  });
  const timer = window.setInterval(load, 30_000);
  onCleanup(() => window.clearInterval(timer));

  const filtered = createMemo(() => {
    const needle = q().trim().toLowerCase();
    const all = visits();
    if (!needle) return all.slice(0, 40);
    return all
      .filter((v) => v.title.toLowerCase().includes(needle) || v.url.toLowerCase().includes(needle))
      .slice(0, 40);
  });

  // ── Force layout ──
  // Canvas, not SVG: this is a live simulation, and 140 nodes of DOM would be
  // heavier than the sim itself.
  let cv: HTMLCanvasElement | undefined;
  let nodes: Node[] = [];
  let links: { a: number; b: number }[] = [];
  let raf = 0;
  let alpha = 1;
  const view = { x: 0, y: 0, z: 1 }; // pan/zoom of the little map
  let dragNode: Node | null = null;
  let panning = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  let W = 0;
  let H = 0;

  const draw = () => {
    const ctx = cv?.getContext("2d");
    if (!ctx || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + view.x, H / 2 + view.y);
    ctx.scale(view.z, view.z);
    ctx.strokeStyle = "rgba(150,140,240,0.28)";
    ctx.lineWidth = 1 / view.z;
    for (const l of links) {
      const a = nodes[l.a];
      const b = nodes[l.b];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.hot ? 4.2 : 3, 0, Math.PI * 2);
      ctx.fillStyle = n.hot ? "#2ff3ff" : "rgba(160,150,255,0.85)";
      ctx.fill();
    }
    ctx.restore();
  };

  const step = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      if (a === dragNode) continue;
      // Repulsion — O(n²), fine at this cap.
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (hash(String(i)) - 0.5) * 2;
          dy = (hash(String(j)) - 0.5) * 2;
          d2 = 1;
        }
        const f = (REPULSION * alpha) / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        if (b !== dragNode) {
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
      }
      // Gravity: what makes related pages cluster instead of drifting apart.
      a.vx -= a.x * GRAVITY * alpha;
      a.vy -= a.y * GRAVITY * alpha;
    }
    for (const l of links) {
      const a = nodes[l.a];
      const b = nodes[l.b];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - SPRING_LEN) * SPRING * alpha;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      if (a !== dragNode) {
        a.vx += ux;
        a.vy += uy;
      }
      if (b !== dragNode) {
        b.vx -= ux;
        b.vy -= uy;
      }
    }
    for (const n of nodes) {
      if (n === dragNode) continue;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }
    alpha *= 0.97;
  };

  /** Fit the settled layout into the box. Raising gravity instead would tighten
   *  the spread but squash the clusters together (measured: gravity 0.022 →
   *  clusters 1.8× apart; 0.03 → 1.4×), so the layout keeps its separation and
   *  the *view* adapts to it. */
  let fitted = false;
  const fitView = () => {
    if (!nodes.length || !W || !H) return;
    let r = 1;
    for (const n of nodes) r = Math.max(r, Math.hypot(n.x, n.y));
    view.x = 0;
    view.y = 0;
    view.z = Math.max(0.4, Math.min(2, Math.min(W, H) / 2 / (r + 8)));
  };

  const loop = () => {
    step();
    if (alpha <= ALPHA_MIN && !dragNode && !fitted) {
      fitted = true;
      fitView();
    }
    draw();
    // Stop once settled: an idle sidebar must not hold a rAF loop open.
    raf = alpha > ALPHA_MIN || dragNode ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => {
    alpha = 1;
    if (!raf) raf = requestAnimationFrame(loop);
  };

  /** Rebuild the node set from the current visits, seeding positions
   *  deterministically so a refresh doesn't scramble the layout. */
  const rebuild = () => {
    const vs = visits().slice(0, 140);
    const index = new Map<number, number>();
    nodes = vs.map((v, i) => {
      index.set(v.id, i);
      const a = hash(v.url) * Math.PI * 2;
      const r = 20 + hash(v.title || v.url) * 60;
      return {
        id: v.id,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        vx: 0,
        vy: 0,
        hot: v.snapshot_id != null,
        i,
      };
    });
    links = edges()
      .map((e) => ({ a: index.get(e.from) ?? -1, b: index.get(e.to) ?? -1 }))
      .filter((l) => l.a >= 0 && l.b >= 0);
    fitted = false;
    kick();
  };
  createEffect(() => {
    void visits();
    void edges();
    if (!open()) rebuild();
  });

  const fitCanvas = () => {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth;
    H = cv.clientHeight;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    draw();
  };
  let ro: ResizeObserver | undefined;
  const mountCanvas = (el: HTMLCanvasElement) => {
    cv = el;
    ro?.disconnect();
    ro = new ResizeObserver(fitCanvas);
    ro.observe(el);
    fitCanvas();
    rebuild();
  };
  onCleanup(() => {
    ro?.disconnect();
    if (raf) cancelAnimationFrame(raf);
  });

  /** Canvas point → simulation space. */
  const toSim = (px: number, py: number) => ({
    x: (px - W / 2 - view.x) / view.z,
    y: (py - H / 2 - view.y) / view.z,
  });
  const nodeAt = (px: number, py: number): Node | null => {
    const p = toSim(px, py);
    let best: Node | null = null;
    let bestD = 10 / view.z; // grab radius in sim units
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  const onDown = (e: PointerEvent) => {
    const r = cv!.getBoundingClientRect();
    lastX = e.clientX - r.left;
    lastY = e.clientY - r.top;
    moved = false;
    cv!.setPointerCapture(e.pointerId);
    const hit = nodeAt(lastX, lastY);
    if (hit) {
      dragNode = hit;
      kick();
    } else {
      panning = true;
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragNode && !panning) return;
    const r = cv!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (Math.abs(px - lastX) + Math.abs(py - lastY) > 2) moved = true;
    if (dragNode) {
      const p = toSim(px, py);
      dragNode.x = p.x;
      dragNode.y = p.y;
      dragNode.vx = 0;
      dragNode.vy = 0;
    } else {
      view.x += px - lastX;
      view.y += py - lastY;
      draw();
    }
    lastX = px;
    lastY = py;
  };
  const onUp = (e: PointerEvent) => {
    try {
      cv?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    // A click (no drag) on a node opens it — the graph is a launcher too.
    if (dragNode && !moved) {
      const v = visits()[dragNode.i];
      if (v) void openTab("browser", v.url);
    }
    dragNode = null;
    panning = false;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = cv!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const before = toSim(px, py);
    view.z = Math.max(0.4, Math.min(4, view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const after = toSim(px, py);
    view.x += (after.x - before.x) * view.z;
    view.y += (after.y - before.y) * view.z;
    draw();
  };

  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };

  return (
    <div class="trailmini" classList={{ open: open() }}>
      <div class="trailmini-head">
        <button
          class="trailmini-toggle"
          title={
            open()
              ? "Collapse"
              : `Browsing in ${activeWorkspaceName() ?? "this workspace"} — click to search it`
          }
          onClick={() => setOpen((v) => !v)}
        >
          <span class="trailmini-spark">🧭</span>
          <span class="trailmini-label">Trail</span>
          <span class="trailmini-count">{visits().length}</span>
        </button>
        <button
          class="trailmini-expand"
          title="Open the full Trail graph"
          onClick={() => void openTab("browser", TRAIL_URL)}
        >
          ⤢
        </button>
      </div>

      {/* Live mini-graph: edges pull related pages together, so clusters are
          topics. Drag a node, drag the background to pan, wheel to zoom, click a
          node to open it. */}
      <Show when={!open()}>
        <div class="trailmini-map">
          <canvas
            ref={mountCanvas}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onWheel={onWheel}
            title="Drag to pan · wheel to zoom · drag a dot to move it · click to open"
          />
          <Show when={loaded() && visits().length === 0}>
            <span class="trailmini-empty">No browsing here yet</span>
          </Show>
        </div>
      </Show>

      {/* Expanded: the part that actually finds a page. */}
      <Show when={open()}>
        <input
          class="trailmini-q"
          placeholder="Find a page you visited…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          autofocus
        />
        <div class="trailmini-list">
          <For
            each={filtered()}
            fallback={
              <div class="trailmini-empty-row">
                {visits().length ? "No match in this workspace." : "No browsing here yet."}
              </div>
            }
          >
            {(v) => (
              <button
                class="trailmini-item"
                title={`${v.title || v.url}\n${v.url}`}
                onClick={() => void openTab("browser", v.url)}
              >
                <span class="trailmini-item-title">{v.title || host(v.url)}</span>
                <span class="trailmini-item-host">{host(v.url)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default TrailMini;
