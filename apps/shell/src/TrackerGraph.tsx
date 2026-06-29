/**
 * Tracker graph (BACKLOG #129) — privacy made visual. A force-directed map of
 * which third parties each site you visit talks to; ubiquitous trackers surface
 * as high-degree hubs, edges/nodes tinted red where shields blocked them. Built
 * from the request interceptor's live record (`tracker_graph`). Same small custom
 * force-sim as the Omni graph (#119); drag nodes, scroll to zoom, click to open.
 */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import { trackerGraphOpen, setTrackerGraphOpen, openTab } from "./store";
import { trackerGraph, trackerClear } from "./ipc";

type GNode = {
  x: number; y: number; vx: number; vy: number; fx: number; fy: number;
  r: number; id: string; kind: string; requests: number; blocked: number; color: string;
};

const TrackerGraphView: Component = () => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const [empty, setEmpty] = createSignal(false);
  const [stats, setStats] = createSignal({ nodes: 0, edges: 0, trackers: 0 });
  const [hover, setHover] = createSignal<string | null>(null);

  let nodes: GNode[] = [];
  let edges: { s: number; t: number; w: number; blocked: boolean }[] = [];
  let raf = 0, alpha = 1, running = false;
  const cam = { x: 0, y: 0, scale: 1 };
  let dragNode: GNode | null = null, panning = false, moved = false;
  let lastX = 0, lastY = 0, hoverNode: GNode | null = null;
  let dpr = 1, W = 0, H = 0;

  const thirdColor = (requests: number, blocked: number): string => {
    const ratio = requests > 0 ? blocked / requests : 0;
    if (ratio >= 0.5) return "#f85149";       // mostly blocked → a tracker
    if (ratio > 0) return "#ff9f45";          // partly blocked
    return "#2ff3ff";                          // not blocked (CDN/api/etc.)
  };

  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    draw();
  };

  const REP = 3000, SPRING = 0.05, LEN = 70, GRAV = 0.018, DAMP = 0.84;
  const step = () => {
    const n = nodes.length;
    for (let i = 0; i < n; i++) { nodes[i]!.fx = 0; nodes[i]!.fy = 0; }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = (i - j) * 0.1; dy = 0.1; }
        const d = Math.sqrt(d2), f = REP / d2;
        const ux = (dx / d) * f, uy = (dy / d) * f;
        a.fx += ux; a.fy += uy; b.fx -= ux; b.fy -= uy;
      }
      a.fx -= a.x * GRAV; a.fy -= a.y * GRAV;
    }
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = SPRING * (d - LEN);
      const ux = (dx / d) * f, uy = (dy / d) * f;
      a.fx += ux; a.fy += uy; b.fx -= ux; b.fy -= uy;
    }
    for (const a of nodes) {
      if (a === dragNode) continue;
      a.vx = (a.vx + a.fx) * DAMP; a.vy = (a.vy + a.fy) * DAMP;
      a.x += a.vx * alpha; a.y += a.vy * alpha;
    }
    alpha *= 0.99;
  };

  const loop = () => {
    if (alpha > 0.01 || dragNode) step();
    draw();
    if (alpha > 0.01 || dragNode || panning) raf = requestAnimationFrame(loop);
    else running = false;
  };
  const kick = (a = 0.5) => { alpha = Math.max(alpha, a); if (!running) { running = true; raf = requestAnimationFrame(loop); } };

  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + cam.x, H / 2 + cam.y);
    ctx.scale(cam.scale, cam.scale);
    ctx.lineWidth = 1 / cam.scale;
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t];
      if (!a || !b) continue;
      const lit = a === hoverNode || b === hoverNode;
      ctx.strokeStyle = e.blocked
        ? `rgba(248,81,73,${lit ? 0.7 : 0.22 + e.w * 0.2})`
        : lit ? `rgba(47,243,255,0.6)` : `rgba(123,97,255,${0.05 + e.w * 0.14})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const a of nodes) {
      ctx.fillStyle = a === hoverNode ? "#fff" : a.color;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
    }
    if (hoverNode) {
      ctx.fillStyle = "#e6e9f5";
      ctx.font = `${12 / cam.scale}px system-ui, sans-serif`;
      const lit = new Set<GNode>([hoverNode]);
      for (const e of edges) {
        if (nodes[e.s] === hoverNode && nodes[e.t]) lit.add(nodes[e.t]!);
        if (nodes[e.t] === hoverNode && nodes[e.s]) lit.add(nodes[e.s]!);
      }
      for (const a of lit) ctx.fillText(a.id, a.x + a.r + 3 / cam.scale, a.y + 4 / cam.scale);
    }
    ctx.restore();
  };

  const toWorld = (px: number, py: number) => ({ x: (px - W / 2 - cam.x) / cam.scale, y: (py - H / 2 - cam.y) / cam.scale });
  const hit = (px: number, py: number): GNode | null => {
    const w = toWorld(px, py);
    let best: GNode | null = null, bestD = Infinity;
    for (const a of nodes) {
      const dx = a.x - w.x, dy = a.y - w.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < a.r + 4 / cam.scale && d < bestD) { best = a; bestD = d; }
    }
    return best;
  };
  const onDown = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    lastX = px; lastY = py; moved = false;
    const n = hit(px, py);
    if (n) dragNode = n; else panning = true;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (dragNode) { const w = toWorld(px, py); dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0; moved = true; kick(0.3); }
    else if (panning) { cam.x += px - lastX; cam.y += py - lastY; moved = true; draw(); }
    else { const n = hit(px, py); if (n !== hoverNode) { hoverNode = n; setHover(n ? `${n.id} · ${n.requests} req${n.blocked ? ` · ${n.blocked} blocked` : ""}` : null); draw(); } }
    lastX = px; lastY = py;
  };
  const onUp = (e: PointerEvent) => {
    if (dragNode && !moved) { setTrackerGraphOpen(false); void openTab("browser", `https://${dragNode.id}`); }
    dragNode = null; panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const before = toWorld(px, py);
    cam.scale = Math.max(0.2, Math.min(5, cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    cam.x = px - W / 2 - before.x * cam.scale;
    cam.y = py - H / 2 - before.y * cam.scale;
    draw();
  };

  const load = async () => {
    try {
      const g = await trackerGraph();
      setEmpty(g.nodes.length === 0);
      const maxDeg = g.nodes.reduce((m, n) => Math.max(m, n.degree), 0) || 1;
      const R = 280;
      nodes = g.nodes.map((d, i) => {
        const ang = (i / g.nodes.length) * Math.PI * 2;
        const rad = R * (0.2 + 0.8 * Math.sqrt((i + 1) / g.nodes.length));
        return {
          x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0, fx: 0, fy: 0,
          r: 3 + Math.sqrt(d.degree / maxDeg) * 13,
          id: d.id, kind: d.kind, requests: d.requests, blocked: d.blocked,
          color: d.kind === "site" ? "#7b61ff" : thirdColor(d.requests, d.blocked),
        };
      });
      const maxW = g.edges.reduce((m, e) => Math.max(m, e.requests), 0) || 1;
      edges = g.edges
        .filter((e) => e.source < nodes.length && e.target < nodes.length)
        .map((e) => ({ s: e.source, t: e.target, w: e.requests / maxW, blocked: e.blocked > 0 }));
      setStats({ nodes: nodes.length, edges: edges.length, trackers: g.nodes.filter((n) => n.kind === "third" && n.blocked > 0).length });
      alpha = 1; kick(1);
    } catch { setEmpty(true); }
  };
  const clearAll = async () => { await trackerClear().catch(() => {}); nodes = []; edges = []; setStats({ nodes: 0, edges: 0, trackers: 0 }); setEmpty(true); draw(); };

  let ro: ResizeObserver | undefined;
  onMount(() => {
    resize();
    ro = new ResizeObserver(resize); ro.observe(wrap);
    void load();
  });
  onCleanup(() => { cancelAnimationFrame(raf); ro?.disconnect(); });

  return (
      <Portal>
        <div class="trk-backdrop" onClick={() => setTrackerGraphOpen(false)} onKeyDown={(e) => { if (e.key === "Escape") setTrackerGraphOpen(false); }}>
          <div class="trk-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="trk-head">
              <span class="trk-title">🕸 Tracker graph</span>
              <span class="trk-stats">{stats().nodes} domains · {stats().edges} links · {stats().trackers} blocked trackers</span>
              <span class="trk-legend">
                <span class="trk-key"><i style={{ background: "#7b61ff" }} /> site</span>
                <span class="trk-key"><i style={{ background: "#2ff3ff" }} /> 3rd-party</span>
                <span class="trk-key"><i style={{ background: "#f85149" }} /> tracker (blocked)</span>
              </span>
              <button class="trk-btn" onClick={() => void load()}>↻</button>
              <button class="trk-btn" onClick={() => void clearAll()}>Clear</button>
              <button class="trk-btn" onClick={() => setTrackerGraphOpen(false)}>✕</button>
            </div>
            <div class="trk-canvas-wrap" ref={wrap}>
              <canvas ref={canvas} class="trk-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} />
              <Show when={empty()}>
                <div class="trk-empty">No third-party requests recorded yet.<br />Browse a few sites and reopen — the graph fills as you go.</div>
              </Show>
              <Show when={hover()}><div class="trk-tip">{hover()}</div></Show>
            </div>
          </div>
        </div>
      </Portal>
  );
};

// Only mount the canvas view (and its onMount/ResizeObserver) when actually open,
// so the refs exist — otherwise resize() reads clientWidth on an undefined ref and
// throws on every load, breaking sibling chrome (music bubble, bars, …).
const TrackerGraph: Component = () => (
  <Show when={trackerGraphOpen()}>
    <TrackerGraphView />
  </Show>
);

export default TrackerGraph;
