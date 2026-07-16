/**
 * flux://trail — the Trail (ADR 0011 step c). A force-directed map of your
 * browsing *as a graph*: nodes are Visits, edges are how you got from one page to
 * the next (the free Nav edges). Click a node to see its provenance ("via …", the
 * workspace task) and its dwell snapshot; a time filter windows the view, and
 * Forget removes a page (or the whole window) — the day-one privacy control.
 *
 * DOM-rendered in the content card (no webview), like flux://notebook. The canvas
 * force-sim is the same small custom one as the Omni/tracker graphs (#119) — no
 * heavy dependency. Colour encodes the research "task" (workspace); a hollow ring
 * means metadata-only (not yet dwell-captured), a filled node has a snapshot.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { traceGraph, traceSnapshotGet, traceForget, traceChat, traceChatSend, type Visit, type Edge, type ChatMsg } from "./ipc";
import { openTab } from "./store";

type GNode = {
  x: number; y: number; vx: number; vy: number; fx: number; fy: number;
  r: number; visit: Visit; color: string;
};

/** Time windows for the scrubber (ms lookback; null = all time). */
const WINDOWS: { label: string; ms: number | null }[] = [
  { label: "All", ms: null },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "7 days", ms: 7 * 24 * 3600_000 },
  { label: "30 days", ms: 30 * 24 * 3600_000 },
];

/** Stable hue per task label so a research branch shares a colour. */
function hueOf(task: string | null | undefined): number {
  if (!task) return 245; // untasked → the house violet
  let h = 0;
  for (let i = 0; i < task.length; i++) h = (h * 31 + task.charCodeAt(i)) % 360;
  return h;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const TrailPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const [loading, setLoading] = createSignal(true);
  const [stats, setStats] = createSignal({ nodes: 0, edges: 0, sem: 0, cites: 0 });
  const [windowIdx, setWindowIdx] = createSignal(0);
  // Time-travel scrub (payoff layer): the END of the viewed window. null = live
  // ("now"); dragging back replays what the workspace looked like around then.
  const [endMs, setEndMs] = createSignal<number | null>(null);
  let scrubTimer = 0; // debounce loads while dragging
  const [selected, setSelected] = createSignal<Visit | null>(null);
  const [snapText, setSnapText] = createSignal<string | null>(null);
  const [snapLoading, setSnapLoading] = createSignal(false);
  // Per-page chat (ADR 0011 step d): the selected visit's persistent thread.
  const [chatMsgs, setChatMsgs] = createSignal<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = createSignal("");
  const [chatStream, setChatStream] = createSignal(""); // in-flight reply
  const [chatBusy, setChatBusy] = createSignal(false);
  let chatFor: number | null = null; // guards stale stream frames after reselect

  let nodes: GNode[] = [];
  // style: 0 = nav (solid violet), 1 = semantic (dashed teal), 2 = citation
  // (cites/implements/same — dashed magenta)
  let edges: { s: number; t: number; w: number; style: 0 | 1 | 2 }[] = [];
  let raf = 0, alpha = 1, running = false;
  const cam = { x: 0, y: 0, scale: 1 };
  let dragNode: GNode | null = null, panning = false, moved = false;
  let lastX = 0, lastY = 0, hoverNode: GNode | null = null, selNode: GNode | null = null;
  let dpr = 1, W = 0, H = 0;

  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    draw();
  };

  // ── force simulation (same params as the Omni graph #119) ──
  const REP = 2400, SPRING = 0.05, LEN = 70, GRAV = 0.02, DAMP = 0.84;
  const step = () => {
    const n = nodes.length;
    for (let i = 0; i < n; i++) { nodes[i]!.fx = 0; nodes[i]!.fy = 0; }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = (i - j) * 0.1; dy = 0.1; }
        const d = Math.sqrt(d2);
        const f = REP / d2;
        const ux = (dx / d) * f, uy = (dy / d) * f;
        a.fx += ux; a.fy += uy; b.fx -= ux; b.fy -= uy;
      }
      a.fx -= a.x * GRAV; a.fy -= a.y * GRAV;
    }
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = SPRING * (d - LEN) * (0.6 + e.w);
      const ux = (dx / d) * f, uy = (dy / d) * f;
      a.fx += ux; a.fy += uy; b.fx -= ux; b.fy -= uy;
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
    if (alpha > 0.01 || dragNode || panning) raf = requestAnimationFrame(loop);
    else running = false;
  };
  const kick = (a = 0.5) => {
    alpha = Math.max(alpha, a);
    if (!running) { running = true; raf = requestAnimationFrame(loop); }
  };

  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + cam.x, H / 2 + cam.y);
    ctx.scale(cam.scale, cam.scale);
    // edges — nav solid violet; semantic ("same topic") dashed teal;
    // citations (cites/implements/same-entity) long-dashed magenta
    ctx.lineWidth = 1 / cam.scale;
    for (const e of edges) {
      const a = nodes[e.s], b = nodes[e.t];
      if (!a || !b) continue;
      const lit = a === hoverNode || b === hoverNode || a === selNode || b === selNode;
      if (e.style === 1) {
        ctx.setLineDash([4 / cam.scale, 4 / cam.scale]);
        ctx.strokeStyle = lit ? "rgba(47,243,255,0.7)" : "rgba(47,243,255,0.18)";
      } else if (e.style === 2) {
        ctx.setLineDash([8 / cam.scale, 5 / cam.scale]);
        ctx.strokeStyle = lit ? "rgba(236,75,224,0.75)" : "rgba(236,75,224,0.22)";
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = lit ? "rgba(47,243,255,0.55)" : "rgba(123,97,255,0.14)";
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // nodes
    for (const a of nodes) {
      const hasSnap = a.visit.snapshot_id != null;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      if (hasSnap) {
        ctx.fillStyle = a.color;
        ctx.fill();
      } else {
        // metadata-only → hollow ring
        ctx.fillStyle = "rgba(10,12,24,0.6)";
        ctx.fill();
        ctx.lineWidth = 1.5 / cam.scale;
        ctx.strokeStyle = a.color;
        ctx.stroke();
      }
      if (a === selNode) {
        ctx.lineWidth = 2 / cam.scale;
        ctx.strokeStyle = "#2ff3ff";
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r + 3 / cam.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // labels only around the hovered/selected node
    const focus = hoverNode ?? selNode;
    if (focus) {
      ctx.fillStyle = "#c9cde8";
      ctx.font = `${12 / cam.scale}px system-ui, sans-serif`;
      const lit = new Set<GNode>([focus]);
      for (const e of edges) {
        if (nodes[e.s] === focus && nodes[e.t]) lit.add(nodes[e.t]!);
        if (nodes[e.t] === focus && nodes[e.s]) lit.add(nodes[e.s]!);
      }
      for (const a of lit) {
        const raw = a.visit.title || a.visit.url;
        const t = raw.length > 40 ? raw.slice(0, 39) + "…" : raw;
        ctx.fillText(t, a.x + a.r + 3 / cam.scale, a.y + 4 / cam.scale);
      }
    }
    ctx.restore();
  };

  const toWorld = (px: number, py: number) => ({
    x: (px - W / 2 - cam.x) / cam.scale,
    y: (py - H / 2 - cam.y) / cam.scale,
  });
  const hit = (px: number, py: number): GNode | null => {
    const w = toWorld(px, py);
    let best: GNode | null = null, bestD = Infinity;
    for (const a of nodes) {
      const dx = a.x - w.x, dy = a.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
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
    if (dragNode) {
      const w = toWorld(px, py);
      dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
      moved = true; kick(0.3);
    } else if (panning) {
      cam.x += px - lastX; cam.y += py - lastY; moved = true; draw();
    } else {
      const n = hit(px, py);
      if (n !== hoverNode) { hoverNode = n; draw(); }
    }
    lastX = px; lastY = py;
  };
  const onUp = (e: PointerEvent) => {
    if (dragNode && !moved) selectNode(dragNode); // a click, not a drag → open detail
    dragNode = null; panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const before = toWorld(px, py);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    cam.scale = Math.max(0.2, Math.min(5, cam.scale * factor));
    cam.x = px - W / 2 - before.x * cam.scale;
    cam.y = py - H / 2 - before.y * cam.scale;
    draw();
  };

  const selectNode = (g: GNode) => {
    selNode = g;
    setSelected(g.visit);
    draw();
    void loadSnapshot(g.visit);
    // Load the visit's chat thread; mark it current so a still-streaming reply
    // for the previous node can't leak into this one.
    chatFor = g.visit.id;
    setChatMsgs([]);
    setChatStream("");
    void traceChat(g.visit.id).then((m) => { if (chatFor === g.visit.id) setChatMsgs(m); }).catch(() => {});
  };

  const sendChat = async () => {
    const v = selected();
    const msg = chatDraft().trim();
    if (!v || !msg || chatBusy()) return;
    const vid = v.id;
    setChatDraft("");
    setChatBusy(true);
    setChatMsgs((m) => [...m, { role: "user", text: msg, ms: Date.now() }]);
    let acc = "";
    try {
      await traceChatSend(vid, msg, (e) => {
        if (chatFor !== vid) return; // user selected another node mid-stream
        if (e.kind === "token") { acc += e.text; setChatStream(acc); }
      });
      if (chatFor === vid) {
        setChatMsgs((m) => [...m, { role: "assistant", text: acc, ms: Date.now() }]);
        setChatStream("");
      }
    } catch (err) {
      if (chatFor === vid) {
        setChatStream("");
        setChatMsgs((m) => [...m, { role: "assistant", text: `⚠ ${String(err)}`, ms: Date.now() }]);
      }
    } finally {
      setChatBusy(false);
    }
  };
  const loadSnapshot = async (v: Visit) => {
    setSnapText(null);
    if (v.snapshot_id == null) return;
    setSnapLoading(true);
    try {
      const s = await traceSnapshotGet(v.snapshot_id);
      setSnapText(s?.text ?? null);
    } catch { setSnapText(null); }
    finally { setSnapLoading(false); }
  };

  const load = async () => {
    setLoading(true);
    const win = WINDOWS[windowIdx()]!;
    // Scrubbed back → a closed [end−span, end] window; live → open-ended.
    let after: number | undefined;
    let before: number | undefined;
    if (win.ms != null) {
      const end = endMs() ?? Date.now();
      after = end - win.ms;
      if (endMs() != null) before = end;
    }
    try {
      const g = await traceGraph(after, before);
      // Cap what the O(n²) force-sim chews on: past ~1200 nodes a frame stops
      // being interactive, so render the most recent slice (narrow the time
      // window to explore older branches).
      let vs = g.visits;
      if (vs.length > 1200) vs = [...vs].sort((a, b) => b.last_ms - a.last_ms).slice(0, 1200);
      const idx = new Map<number, number>();
      vs.forEach((v, i) => idx.set(v.id, i));
      const R = 280;
      nodes = vs.map((v, i) => {
        const ang = (i / Math.max(1, vs.length)) * Math.PI * 2;
        const rad = R * (0.2 + 0.8 * Math.sqrt((i + 1) / Math.max(1, vs.length)));
        return {
          x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0, fx: 0, fy: 0,
          r: 4 + Math.sqrt(Math.max(0, v.hits - 1)) * 3,
          visit: v,
          color: `hsl(${hueOf(v.why.task)} 70% 62%)`,
        };
      });
      edges = g.edges
        // Derived links pull related pages toward each other, but gently —
        // the navigation trail should still dominate the layout.
        .map((e: Edge) => {
          const style: 0 | 1 | 2 = e.kind === "nav" ? 0 : e.kind === "semantic" ? 1 : 2;
          const w = style === 0 ? 1 : style === 1 ? 0.35 : 0.2;
          return { s: idx.get(e.from), t: idx.get(e.to), w, style };
        })
        .filter((e): e is { s: number; t: number; w: number; style: 0 | 1 | 2 } => e.s != null && e.t != null);
      setStats({
        nodes: nodes.length,
        edges: edges.length,
        sem: edges.filter((e) => e.style === 1).length,
        cites: edges.filter((e) => e.style === 2).length,
      });
      // Keep a live selection valid across reloads.
      selNode = selected() ? (nodes.find((n) => n.visit.id === selected()!.id) ?? null) : null;
      if (!selNode) setSelected(null);
      setLoading(false);
      alpha = 1; kick(1);
    } catch {
      setLoading(false);
    }
  };

  const forgetPage = async (v: Visit) => {
    await traceForget({ kind: "url", url: v.url }).catch(() => {});
    if (selected()?.id === v.id) { setSelected(null); selNode = null; }
    await load();
  };
  const forgetWindow = async () => {
    const win = WINDOWS[windowIdx()]!;
    if (win.ms == null) {
      if (!window.confirm("Forget your ENTIRE Trail? This can't be undone.")) return;
      await traceForget({ kind: "all" }).catch(() => {});
    } else {
      if (!window.confirm(`Forget everything in the Trail from the last ${win.label}?`)) return;
      await traceForget({ kind: "range", after_ms: Date.now() - win.ms, before_ms: null }).catch(() => {});
    }
    setSelected(null); selNode = null;
    await load();
  };

  // ── time-travel scrub ──
  /** How far back the slider reaches: 8 windows of the chosen span. */
  const scrubMin = createMemo(() => {
    const span = WINDOWS[windowIdx()]!.ms;
    return span != null ? Date.now() - span * 8 : 0;
  });
  const onScrub = (v: number) => {
    // Snap the top of the range back to "live" so dragging fully right clears
    // the scrub instead of pinning a stale "now".
    setEndMs(v >= Date.now() - 30_000 ? null : v);
    window.clearTimeout(scrubTimer);
    scrubTimer = window.setTimeout(() => void load(), 160);
  };
  const fmtT = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const scrubLabel = createMemo(() => {
    const span = WINDOWS[windowIdx()]!.ms;
    if (span == null) return "";
    const end = endMs();
    return end == null ? `now − ${WINDOWS[windowIdx()]!.label}` : `${fmtT(end - span)} → ${fmtT(end)}`;
  });
  /** "Reopen this moment": bring back the window's most recent pages as tabs. */
  const reopenWindow = async () => {
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const n of [...nodes].sort((a, b) => b.visit.last_ms - a.visit.last_ms)) {
      if (seen.has(n.visit.url)) continue;
      seen.add(n.visit.url);
      urls.push(n.visit.url);
      if (urls.length >= 6) break;
    }
    if (urls.length === 0) return;
    if (!window.confirm(`Reopen ${urls.length} page${urls.length === 1 ? "" : "s"} from this window as tabs?`)) return;
    for (const u of urls) await openTab("browser", u).catch(() => {});
  };

  const selWhy = createMemo(() => {
    const v = selected();
    if (!v) return null;
    const bits: string[] = [];
    if (v.why.task) bits.push(v.why.task);
    if (v.why.referrer) bits.push(`via ${hostOf(v.why.referrer)}`);
    return bits.join(" · ") || null;
  });

  let ro: ResizeObserver | undefined;
  onMount(() => {
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(wrap);
    void load();
  });
  onCleanup(() => { cancelAnimationFrame(raf); ro?.disconnect(); });

  return (
    <div class="trail">
      <header class="trail-head">
        <span class="trail-brand"><span class="trail-spark">🧭</span> The Trail <span class="trail-sub">your browsing, as a graph</span></span>
        <div class="trail-controls">
          <div class="trail-window">
            <For each={WINDOWS}>
              {(w, i) => (
                <button
                  class="trail-win-btn"
                  classList={{ on: windowIdx() === i() }}
                  onClick={() => { setWindowIdx(i()); setEndMs(null); void load(); }}
                >{w.label}</button>
              )}
            </For>
          </div>
          <button class="trail-forget" onClick={() => void forgetWindow()} title="Forget the pages in this window">Forget…</button>
          <button class="trail-reload" onClick={() => void load()}>↻</button>
        </div>
      </header>

      {/* Time-travel scrub: drag the window back through your history, then
          bring that moment's pages back as tabs. */}
      <Show when={WINDOWS[windowIdx()]!.ms != null}>
        <div class="trail-scrub">
          <input
            type="range"
            class="trail-scrub-slider"
            min={scrubMin()}
            max={Date.now()}
            value={endMs() ?? Date.now()}
            onInput={(e) => onScrub(Number(e.currentTarget.value))}
          />
          <span class="trail-scrub-label">{scrubLabel()}</span>
          <Show when={endMs() != null}>
            <button class="trail-scrub-now" onClick={() => { setEndMs(null); void load(); }}>Now</button>
          </Show>
          <button
            class="trail-scrub-reopen"
            disabled={stats().nodes === 0}
            title="Reopen this window's most recent pages as tabs"
            onClick={() => void reopenWindow()}
          >⏪ Reopen these pages</button>
        </div>
      </Show>

      <div class="trail-body">
        <div class="trail-graph" ref={wrap}>
          <canvas
            ref={canvas}
            class="trail-canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onWheel={onWheel}
          />
          <div class="trail-hud">
            <Show when={!loading()} fallback={<span>Loading the Trail…</span>}>
              <span>
                {stats().nodes} pages · {stats().edges - stats().sem - stats().cites} steps
                <Show when={stats().sem > 0}> · <span class="trail-hud-sem">{stats().sem} related</span></Show>
                <Show when={stats().cites > 0}> · <span class="trail-hud-cite">{stats().cites} citations</span></Show>
              </span>
            </Show>
          </div>
          <Show when={!loading() && stats().nodes === 0}>
            <div class="trail-empty">
              Nothing captured yet. Browse a few pages (stay ~8s so they’re snapshotted),
              then come back — your path shows up here.
            </div>
          </Show>
        </div>

        <aside class="trail-detail" classList={{ open: !!selected() }}>
          <Show when={selected()} fallback={<div class="trail-detail-hint">Click a page to see how you got there and what it said.</div>}>
            {(v) => (
              <>
                <div class="trail-detail-title">{v().title || hostOf(v().url)}</div>
                <button class="trail-detail-url" onClick={() => props.onNavigate(v().url)} title={v().url}>{hostOf(v().url)} ↗</button>
                <Show when={selWhy()}><div class="trail-detail-why">{selWhy()}</div></Show>
                <div class="trail-detail-meta">
                  {new Date(v().last_ms).toLocaleString()} · {v().hits} visit{v().hits === 1 ? "" : "s"}
                </div>
                {/* Papers / repos / datasets this page is or mentions. */}
                <Show when={(v().entities ?? []).length > 0}>
                  <div class="trail-entities">
                    <For each={v().entities ?? []}>
                      {(en) => (
                        <span class="trail-entity" classList={{ primary: en.primary }} title={en.primary ? "this page IS this" : "mentioned on this page"}>
                          {en.kind === "arxiv" ? `📄 arXiv:${en.value}` : en.kind === "doi" ? `🔗 ${en.value}` : en.kind === "repo" ? `⌨ ${en.value}` : `🗃 ${en.value}`}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="trail-detail-snap">
                  <Show when={v().snapshot_id != null} fallback={<span class="trail-detail-nosnap">No snapshot — this page wasn’t engaged long enough to capture.</span>}>
                    <Show when={!snapLoading()} fallback={<span class="trail-detail-nosnap">Loading snapshot…</span>}>
                      <Show when={snapText()} fallback={<span class="trail-detail-nosnap">Snapshot content was evicted.</span>}>
                        {(t) => <p class="trail-detail-text">{t().slice(0, 1500)}{t().length > 1500 ? "…" : ""}</p>}
                      </Show>
                    </Show>
                  </Show>
                </div>
                {/* Per-page chat (ADR 0011 step d): a persistent conversation
                    attached to THIS page — still here when you return months later. */}
                <div class="trail-chat">
                  <div class="trail-chat-label">✦ Ask about this page</div>
                  <div class="trail-chat-thread">
                    <For each={chatMsgs()}>
                      {(m) => <div class="trail-chat-msg" classList={{ user: m.role === "user" }}>{m.text}</div>}
                    </For>
                    <Show when={chatStream()}>
                      <div class="trail-chat-msg streaming">{chatStream()}</div>
                    </Show>
                    <Show when={chatMsgs().length === 0 && !chatStream()}>
                      <div class="trail-chat-empty">No conversation yet — ask something; the thread stays attached to this page.</div>
                    </Show>
                  </div>
                  <div class="trail-chat-inputrow">
                    <input
                      class="trail-chat-input"
                      placeholder={chatBusy() ? "Thinking…" : "e.g. what was the fix here?"}
                      value={chatDraft()}
                      disabled={chatBusy()}
                      onInput={(e) => setChatDraft(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                    />
                    <button class="trail-chat-send" disabled={chatBusy() || !chatDraft().trim()} onClick={() => void sendChat()}>↑</button>
                  </div>
                </div>
                <div class="trail-detail-actions">
                  <button class="trail-detail-open" onClick={() => props.onNavigate(v().url)}>Open page</button>
                  <button class="trail-detail-forget" onClick={() => void forgetPage(v())}>Forget this page</button>
                </div>
              </>
            )}
          </Show>
        </aside>
      </div>
    </div>
  );
};

export default TrailPage;
