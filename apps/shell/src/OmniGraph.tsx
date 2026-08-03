/**
 * Omni graph view (#119) — an Obsidian-style force-directed map of the search
 * index. Nodes are the top documents by PageRank (sized by rank); edges connect
 * each to its nearest neighbours by embedding (Omni's `/graph`). Rendered on a
 * canvas with a small custom force simulation (no heavy dep). Drag nodes, pan,
 * scroll to zoom; click a node to open it.
 */
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { palette as pal, rgba } from "./palette";
import { omniGraph } from "./ipc";

type GNode = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  r: number;
  title: string;
  url: string;
};

const OmniGraph: Component<{ onNavigate: (url: string) => void }> = (props) => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [stats, setStats] = createSignal<{ nodes: number; edges: number }>({ nodes: 0, edges: 0 });
  const [hover, setHover] = createSignal<string | null>(null);

  let nodes: GNode[] = [];
  let edges: { s: number; t: number; w: number }[] = [];
  let raf = 0;
  let alpha = 1;
  let running = false;
  const cam = { x: 0, y: 0, scale: 1 };
  let dragNode: GNode | null = null;
  let panning = false;
  let moved = false;
  let lastX = 0,
    lastY = 0;
  let hoverNode: GNode | null = null;
  let dpr = 1,
    W = 0,
    H = 0;

  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    draw();
  };

  // ── force simulation ──
  const REP = 2400,
    SPRING = 0.05,
    LEN = 64,
    GRAV = 0.02,
    DAMP = 0.84;
  const step = () => {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      nodes[i]!.fx = 0;
      nodes[i]!.fy = 0;
    }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x,
          dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          d2 = 0.01;
          dx = (i - j) * 0.1;
          dy = 0.1;
        }
        const d = Math.sqrt(d2);
        const f = REP / d2;
        const ux = (dx / d) * f,
          uy = (dy / d) * f;
        a.fx += ux;
        a.fy += uy;
        b.fx -= ux;
        b.fy -= uy;
      }
      a.fx -= a.x * GRAV;
      a.fy -= a.y * GRAV; // pull toward origin
    }
    for (const e of edges) {
      const a = nodes[e.s],
        b = nodes[e.t];
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = SPRING * (d - LEN) * (0.6 + e.w);
      const ux = (dx / d) * f,
        uy = (dy / d) * f;
      a.fx += ux;
      a.fy += uy;
      b.fx -= ux;
      b.fy -= uy;
    }
    for (const a of nodes) {
      if (a === dragNode) continue;
      a.vx = (a.vx + a.fx) * DAMP;
      a.vy = (a.vy + a.fy) * DAMP;
      a.x += a.vx * alpha;
      a.y += a.vy * alpha;
    }
    alpha *= 0.99;
  };

  const loop = () => {
    if (alpha > 0.01 || dragNode) step();
    draw();
    if (alpha > 0.01 || dragNode || panning) {
      raf = requestAnimationFrame(loop);
    } else {
      running = false;
    }
  };
  const kick = (a = 0.5) => {
    alpha = Math.max(alpha, a);
    if (!running) {
      running = true;
      raf = requestAnimationFrame(loop);
    }
  };

  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + cam.x, H / 2 + cam.y);
    ctx.scale(cam.scale, cam.scale);
    // edges
    ctx.lineWidth = 1 / cam.scale;
    for (const e of edges) {
      const a = nodes[e.s],
        b = nodes[e.t];
      if (!a || !b) continue;
      const lit = a === hoverNode || b === hoverNode;
      ctx.strokeStyle = lit ? rgba(pal().accent, 0.4 + e.w * 0.4) : rgba(pal().ai, 0.06 + e.w * 0.16);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // nodes
    for (const a of nodes) {
      ctx.fillStyle = rgba(a === hoverNode ? pal().accent : pal().ai, 1);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // labels: off by default — only the hovered node (and its direct neighbours).
    if (hoverNode) {
      ctx.fillStyle = rgba(pal().text, 1);
      ctx.font = `${12 / cam.scale}px system-ui, sans-serif`;
      const lit = new Set<GNode>([hoverNode]);
      for (const e of edges) {
        if (nodes[e.s] === hoverNode && nodes[e.t]) lit.add(nodes[e.t]!);
        if (nodes[e.t] === hoverNode && nodes[e.s]) lit.add(nodes[e.s]!);
      }
      for (const a of lit) {
        const t = a.title.length > 36 ? a.title.slice(0, 35) + "…" : a.title;
        ctx.fillText(t, a.x + a.r + 3 / cam.scale, a.y + 4 / cam.scale);
      }
    }
    ctx.restore();
  };

  // screen → world
  const toWorld = (px: number, py: number) => ({
    x: (px - W / 2 - cam.x) / cam.scale,
    y: (py - H / 2 - cam.y) / cam.scale,
  });
  const hit = (px: number, py: number): GNode | null => {
    const w = toWorld(px, py);
    let best: GNode | null = null,
      bestD = Infinity;
    for (const a of nodes) {
      const dx = a.x - w.x,
        dy = a.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < a.r + 4 / cam.scale && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  };

  const onDown = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    lastX = px;
    lastY = py;
    moved = false;
    const n = hit(px, py);
    if (n) {
      dragNode = n;
    } else {
      panning = true;
    }
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    if (dragNode) {
      const w = toWorld(px, py);
      dragNode.x = w.x;
      dragNode.y = w.y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      moved = true;
      kick(0.3);
    } else if (panning) {
      cam.x += px - lastX;
      cam.y += py - lastY;
      moved = true;
      draw();
    } else {
      const n = hit(px, py);
      if (n !== hoverNode) {
        hoverNode = n;
        setHover(n?.title ?? null);
        draw();
      }
    }
    lastX = px;
    lastY = py;
  };
  const onUp = (e: PointerEvent) => {
    if (dragNode && !moved) props.onNavigate(dragNode.url); // a click, not a drag
    dragNode = null;
    panning = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    const before = toWorld(px, py);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    cam.scale = Math.max(0.2, Math.min(5, cam.scale * factor));
    // keep the point under the cursor fixed
    cam.x = px - W / 2 - before.x * cam.scale;
    cam.y = py - H / 2 - before.y * cam.scale;
    draw();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await omniGraph(300, 6);
      const maxRank = g.nodes.reduce((m, n) => Math.max(m, n.rank), 0) || 1;
      const R = 260;
      nodes = g.nodes.map((d, i) => {
        const ang = (i / g.nodes.length) * Math.PI * 2;
        const rad = R * (0.2 + 0.8 * Math.sqrt((i + 1) / g.nodes.length));
        return {
          x: Math.cos(ang) * rad,
          y: Math.sin(ang) * rad,
          vx: 0,
          vy: 0,
          fx: 0,
          fy: 0,
          r: 3 + Math.sqrt(d.rank / maxRank) * 11,
          title: d.title || d.url,
          url: d.url,
        };
      });
      edges = g.edges.filter((e) => e.s < nodes.length && e.t < nodes.length);
      setStats({ nodes: nodes.length, edges: edges.length });
      setLoading(false);
      alpha = 1;
      kick(1);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  let ro: ResizeObserver | undefined;
  onMount(() => {
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(wrap);
    void load();
  });
  onCleanup(() => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
  });

  return (
    <div class="omni-graph" ref={wrap}>
      <canvas
        ref={canvas}
        class="omni-graph-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
      />
      <div class="omni-graph-hud">
        <Show when={!loading() && !error()}>
          <span>
            {stats().nodes} nodes · {stats().edges} links
          </span>
          <button class="start-card-link" onClick={() => void load()}>
            ↻ Rebuild
          </button>
        </Show>
        <Show when={loading()}>
          <span>Building graph…</span>
        </Show>
        <Show when={error()}>
          <span class="omni-graph-err">{error()}</span>
        </Show>
      </div>
      <Show when={hover()}>
        <div class="omni-graph-tip">{hover()}</div>
      </Show>
    </div>
  );
};

export default OmniGraph;
