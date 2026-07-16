// Bejeweled — click a gem then an adjacent one to swap. Line up 3+ of a colour
// to clear them; gems fall and refill, and chains cascade for combo score. When
// no swap can make a match, it's over.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

const N = 8;
const CELL = 46;
const OX = (W - N * CELL) / 2;
const OY = (H - N * CELL) / 2;
const GEMS = ["#2ff3ff", "#ff4d9d", "#ffe14d", "#5dff8f", "#b07dff", "#ff8a3d"];

export default function bejeweled(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const grid: number[][] = Array.from({ length: N }, () => Array<number>(N).fill(0));
  let sel: [number, number] | null = null;
  let score = 0;
  let over = false;
  let reported = false;

  const rc = () => 1 + ((Math.random() * GEMS.length) | 0);
  // Seed without any immediate 3-in-a-row.
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      do {
        grid[r]![c] = rc();
      } while (
        (c >= 2 && grid[r]![c] === grid[r]![c - 1] && grid[r]![c] === grid[r]![c - 2]) ||
        (r >= 2 && grid[r]![c] === grid[r - 1]![c] && grid[r]![c] === grid[r - 2]![c])
      );
    }

  function matches(): Set<number> {
    const m = new Set<number>();
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N - 2; c++) {
        const v = grid[r]![c];
        if (v && v === grid[r]![c + 1] && v === grid[r]![c + 2]) {
          m.add(r * N + c);
          m.add(r * N + c + 1);
          m.add(r * N + c + 2);
        }
      }
    for (let c = 0; c < N; c++)
      for (let r = 0; r < N - 2; r++) {
        const v = grid[r]![c];
        if (v && v === grid[r + 1]![c] && v === grid[r + 2]![c]) {
          m.add(r * N + c);
          m.add((r + 1) * N + c);
          m.add((r + 2) * N + c);
        }
      }
    return m;
  }

  function resolve() {
    let chain = 1;
    for (;;) {
      const m = matches();
      if (!m.size) break;
      for (const k of m) grid[(k / N) | 0]![k % N] = 0;
      score += m.size * 10 * chain;
      ctx.setScore(score);
      for (let c = 0; c < N; c++) {
        const col: number[] = [];
        for (let r = N - 1; r >= 0; r--) if (grid[r]![c]) col.push(grid[r]![c]!);
        for (let r = N - 1; r >= 0; r--) grid[r]![c] = col[N - 1 - r] ?? rc();
      }
      chain++;
    }
  }

  function swap(a: [number, number], b: [number, number]) {
    const t = grid[a[0]]![a[1]]!;
    grid[a[0]]![a[1]] = grid[b[0]]![b[1]]!;
    grid[b[0]]![b[1]] = t;
  }
  function anyMove(): boolean {
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        for (const [nr, nc] of [
          [r, c + 1],
          [r + 1, c],
        ] as [number, number][]) {
          if (nr >= N || nc >= N) continue;
          swap([r, c], [nr, nc]);
          const ok = matches().size > 0;
          swap([r, c], [nr, nc]);
          if (ok) return true;
        }
      }
    return false;
  }

  const onDown = (e: MouseEvent) => {
    if (over) return;
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) * (W / rect.width) - OX) / CELL);
    const r = Math.floor(((e.clientY - rect.top) * (H / rect.height) - OY) / CELL);
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    if (!sel) {
      sel = [r, c];
      return;
    }
    const adj = Math.abs(sel[0] - r) + Math.abs(sel[1] - c) === 1;
    if (!adj) {
      sel = [r, c];
      return;
    }
    swap(sel, [r, c]);
    if (matches().size) {
      resolve();
      if (!anyMove()) over = true;
    } else swap(sel, [r, c]); // no match → revert
    sel = null;
  };
  canvas.addEventListener("mousedown", onDown);

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#0f0c1a";
    g.fillRect(OX, OY, N * CELL, N * CELL);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const v = grid[r]![c];
        if (!v) continue;
        const x = OX + c * CELL,
          y = OY + r * CELL;
        g.shadowBlur = 6;
        g.shadowColor = GEMS[v - 1]!;
        g.fillStyle = GEMS[v - 1]!;
        g.beginPath();
        g.arc(x + CELL / 2, y + CELL / 2, CELL / 2 - 5, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
      }
    if (sel) {
      g.strokeStyle = "#fff";
      g.lineWidth = 2;
      g.strokeRect(OX + sel[1] * CELL + 2, OY + sel[0] * CELL + 2, CELL - 4, CELL - 4);
      g.lineWidth = 1;
    }
  }

  const l = loop(() => {
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("bejeweled", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      canvas.removeEventListener("mousedown", onDown);
    },
  };
}
