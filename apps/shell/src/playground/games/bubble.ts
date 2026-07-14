// Bubble Shooter — aim with the mouse, click to fire. Land 3+ of a colour
// together to pop them (and anything they cut loose drops too). Every few shots
// the ceiling drops a fresh row; if the bubbles reach the launcher, it's over.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

const COLS = 12;
const ROWS = 12;
const D = 40;
const OX = (W - COLS * D) / 2;
const OY = 20;
const R = D / 2 - 2;
const COLORS = ["#2ff3ff", "#ff4d9d", "#ffe14d", "#5dff8f", "#b07dff"];
const MAXROW = 10;

export default function bubble(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const grid: number[][] = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
  const cx = (c: number) => OX + c * D + D / 2;
  const cy = (r: number) => OY + r * D + D / 2;
  const SX = W / 2, SY = H - 26;
  let cur = rc(), next = rc();
  let fly: { x: number; y: number; vx: number; vy: number; col: number } | null = null;
  let aim = -Math.PI / 2;
  let shots = 0;
  let score = 0;
  let over = false;
  let reported = false;

  function rc() { return 1 + ((Math.random() * COLORS.length) | 0); }
  for (let r = 0; r < 4; r++) for (let c = 0; c < COLS; c++) grid[r]![c] = rc();

  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width), my = (e.clientY - rect.top) * (H / rect.height);
    aim = Math.atan2(my - SY, mx - SX);
    if (aim > -0.15) aim = my < SY ? aim : (mx < SX ? -Math.PI + 0.15 : -0.15);
    aim = Math.max(-Math.PI + 0.15, Math.min(-0.15, aim));
  };
  const onDown = () => { if (!fly && !over) fly = { x: SX, y: SY, vx: Math.cos(aim) * 0.7, vy: Math.sin(aim) * 0.7, col: cur }; };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mousedown", onDown);

  const neighbors = (r: number, c: number): [number, number][] => [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([rr, cc]) => rr! >= 0 && rr! < ROWS && cc! >= 0 && cc! < COLS) as [number, number][];

  function group(r: number, c: number, col: number): [number, number][] {
    const seen = new Set<number>([r * COLS + c]);
    const stack: [number, number][] = [[r, c]];
    const out: [number, number][] = [];
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      out.push([cr, cc]);
      for (const [nr, nc] of neighbors(cr, cc)) if (!seen.has(nr * COLS + nc) && grid[nr]![nc] === col) { seen.add(nr * COLS + nc); stack.push([nr, nc]); }
    }
    return out;
  }

  function settle(fx: number, fy: number, col: number) {
    let r = Math.round((fy - OY - D / 2) / D), c = Math.round((fx - OX - D / 2) / D);
    r = Math.max(0, Math.min(ROWS - 1, r)); c = Math.max(0, Math.min(COLS - 1, c));
    if (grid[r]![c] !== 0) { // pick nearest empty neighbor
      const empt = neighbors(r, c).filter(([rr, cc]) => grid[rr]![cc] === 0);
      empt.sort((a, b) => Math.hypot(cx(a[1]) - fx, cy(a[0]) - fy) - Math.hypot(cx(b[1]) - fx, cy(b[0]) - fy));
      if (empt.length) { r = empt[0]![0]; c = empt[0]![1]; } else return;
    }
    grid[r]![c] = col;
    const grp = group(r, c, col);
    if (grp.length >= 3) { for (const [gr, gc] of grp) grid[gr]![gc] = 0; score += grp.length * 10; dropFloating(); ctx.setScore(score); }
    for (let cc = 0; cc < COLS; cc++) if (grid[MAXROW]![cc]) { over = true; return; }
  }

  function dropFloating() {
    const anchored = new Set<number>();
    const stack: [number, number][] = [];
    for (let c = 0; c < COLS; c++) if (grid[0]![c]) { stack.push([0, c]); anchored.add(c); }
    while (stack.length) {
      const [r, c] = stack.pop()!;
      for (const [nr, nc] of neighbors(r, c)) if (grid[nr]![nc] && !anchored.has(nr * COLS + nc)) { anchored.add(nr * COLS + nc); stack.push([nr, nc]); }
    }
    let dropped = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r]![c] && !anchored.has(r * COLS + c)) { grid[r]![c] = 0; dropped++; }
    if (dropped) { score += dropped * 20; ctx.setScore(score); }
  }

  function pushRow() {
    for (let r = ROWS - 1; r > 0; r--) for (let c = 0; c < COLS; c++) grid[r]![c] = grid[r - 1]![c]!;
    for (let c = 0; c < COLS; c++) grid[0]![c] = rc();
    for (let c = 0; c < COLS; c++) if (grid[MAXROW]![c]) over = true;
  }

  function step(dt: number) {
    if (!fly) return;
    fly.x += fly.vx * dt; fly.y += fly.vy * dt;
    if (fly.x < OX + R || fly.x > OX + COLS * D - R) fly.vx = -fly.vx;
    let hit = fly.y <= OY + R;
    if (!hit) for (let r = 0; r < ROWS && !hit; r++) for (let c = 0; c < COLS; c++) if (grid[r]![c] && Math.hypot(fly.x - cx(c), fly.y - cy(r)) < D - 4) { hit = true; break; }
    if (hit) {
      settle(fly.x, fly.y, fly.col);
      fly = null; cur = next; next = rc(); shots++;
      if (shots % 6 === 0 && !over) pushRow();
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,77,109,0.35)"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(OX, cy(MAXROW) + D / 2); g.lineTo(OX + COLS * D, cy(MAXROW) + D / 2); g.stroke(); g.setLineDash([]);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r]![c]) bub(cx(c), cy(r), grid[r]![c]!);
    // Aim guide.
    g.strokeStyle = "rgba(255,255,255,0.25)"; g.beginPath(); g.moveTo(SX, SY); g.lineTo(SX + Math.cos(aim) * 90, SY + Math.sin(aim) * 90); g.stroke();
    bub(SX, SY, cur); bub(SX + 34, SY + 6, next);
    if (fly) bub(fly.x, fly.y, fly.col);
  }
  function bub(x: number, y: number, col: number) { g.shadowBlur = 6; g.shadowColor = COLORS[col - 1]!; g.fillStyle = COLORS[col - 1]!; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0; }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) { reported = true; saveHighScore("bubble", score); ctx.onGameOver(score); }
  });

  return { stop() { l.stop(); canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mousedown", onDown); } };
}
