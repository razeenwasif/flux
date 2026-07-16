// Reversi / Othello — flank the AI's discs to flip them; most discs when the
// board fills wins. You're light and move first; the AI is dark (weighted
// 3-ply minimax that values corners). Win to build a streak = score.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

const N = 8;
const CELL = 46;
const OX = (W - N * CELL) / 2;
const OY = (H - N * CELL) / 2;
type Board = number[][]; // 0 empty, 1 player(light), 2 AI(dark)

const WT = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];
const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export default function reversi(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  let board = fresh();
  let streak = 0;
  let phase: "play" | "aiwait" | "winpause" | "over" = "play";
  let timer = 0;
  let banner = "";
  let reported = false;

  function fresh(): Board {
    const b = Array.from({ length: N }, () => Array<number>(N).fill(0));
    b[3]![3] = 2;
    b[3]![4] = 1;
    b[4]![3] = 1;
    b[4]![4] = 2;
    return b;
  }
  function flips(b: Board, r: number, c: number, who: number): [number, number][] {
    if (b[r]![c] !== 0) return [];
    const other = 3 - who;
    const out: [number, number][] = [];
    for (const [dr, dc] of DIRS) {
      const line: [number, number][] = [];
      let rr = r + dr,
        cc = c + dc;
      while (rr >= 0 && rr < N && cc >= 0 && cc < N && b[rr]![cc] === other) {
        line.push([rr, cc]);
        rr += dr;
        cc += dc;
      }
      if (line.length && rr >= 0 && rr < N && cc >= 0 && cc < N && b[rr]![cc] === who) out.push(...line);
    }
    return out;
  }
  function moves(b: Board, who: number): [number, number][] {
    const out: [number, number][] = [];
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) if (b[r]![c] === 0 && flips(b, r, c, who).length) out.push([r, c]);
    return out;
  }
  function apply(b: Board, r: number, c: number, who: number): Board {
    const nb = b.map((row) => row.slice());
    nb[r]![c] = who;
    for (const [fr, fc] of flips(b, r, c, who)) nb[fr]![fc] = who;
    return nb;
  }
  function count(b: Board, who: number) {
    let n = 0;
    for (const row of b) for (const v of row) if (v === who) n++;
    return n;
  }

  function evalB(b: Board): number {
    let s = 0;
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        if (b[r]![c] === 2) s += WT[r]![c]!;
        else if (b[r]![c] === 1) s -= WT[r]![c]!;
      }
    return s + (moves(b, 2).length - moves(b, 1).length) * 3;
  }
  function minimax(b: Board, depth: number, alpha: number, beta: number, ai: boolean): number {
    if (depth === 0) return evalB(b);
    const who = ai ? 2 : 1;
    const ms = moves(b, who);
    if (!ms.length) {
      if (!moves(b, 3 - who).length) return (count(b, 2) - count(b, 1)) * 1000;
      return minimax(b, depth - 1, alpha, beta, !ai);
    }
    if (ai) {
      let best = -Infinity;
      for (const [r, c] of ms) {
        best = Math.max(best, minimax(apply(b, r, c, 2), depth - 1, alpha, beta, false));
        alpha = Math.max(alpha, best);
        if (alpha >= beta) break;
      }
      return best;
    }
    let best = Infinity;
    for (const [r, c] of ms) {
      best = Math.min(best, minimax(apply(b, r, c, 1), depth - 1, alpha, beta, true));
      beta = Math.min(beta, best);
      if (alpha >= beta) break;
    }
    return best;
  }
  function aiPick(): [number, number] | null {
    const ms = moves(board, 2);
    if (!ms.length) return null;
    let best = -Infinity,
      bm = ms[0]!;
    for (const [r, c] of ms) {
      const v = minimax(apply(board, r, c, 2), 3, -Infinity, Infinity, false);
      if (v > best) {
        best = v;
        bm = [r, c];
      }
    }
    return bm;
  }

  function resolve(who: number) {
    const other = 3 - who;
    if (moves(board, other).length) {
      phase = other === 2 ? "aiwait" : "play";
      if (phase === "aiwait") timer = 350;
      return;
    }
    if (moves(board, who).length) {
      phase = who === 2 ? "aiwait" : "play";
      if (phase === "aiwait") timer = 350;
      return;
    }
    // Neither can move → match over.
    const p = count(board, 1),
      a = count(board, 2);
    if (p > a) {
      streak++;
      ctx.setScore(streak);
      banner = "YOU WIN";
      phase = "winpause";
      timer = 1500;
    } else {
      banner = a > p ? "DEFEATED" : "DRAW";
      phase = "over";
    }
  }

  const onDown = (e: MouseEvent) => {
    if (phase !== "play") return;
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) * (W / rect.width) - OX) / CELL);
    const r = Math.floor(((e.clientY - rect.top) * (H / rect.height) - OY) / CELL);
    if (r < 0 || r >= N || c < 0 || c >= N || !flips(board, r, c, 1).length) return;
    board = apply(board, r, c, 1);
    resolve(1);
  };
  canvas.addEventListener("mousedown", onDown);

  function step(dt: number) {
    if (phase === "aiwait") {
      timer -= dt;
      if (timer <= 0) {
        const m = aiPick();
        if (m) board = apply(board, m[0], m[1], 2);
        resolve(2);
      }
    } else if (phase === "winpause") {
      timer -= dt;
      if (timer <= 0) {
        board = fresh();
        banner = "";
        phase = "play";
      }
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#14401f";
    g.fillRect(OX, OY, N * CELL, N * CELL);
    g.strokeStyle = "rgba(0,0,0,0.4)";
    for (let i = 0; i <= N; i++) {
      g.beginPath();
      g.moveTo(OX + i * CELL, OY);
      g.lineTo(OX + i * CELL, OY + N * CELL);
      g.stroke();
      g.beginPath();
      g.moveTo(OX, OY + i * CELL);
      g.lineTo(OX + N * CELL, OY + i * CELL);
      g.stroke();
    }
    const legal = phase === "play" ? moves(board, 1) : [];
    for (const [r, c] of legal) {
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.beginPath();
      g.arc(OX + c * CELL + CELL / 2, OY + r * CELL + CELL / 2, 5, 0, Math.PI * 2);
      g.fill();
    }
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const v = board[r]![c];
        if (!v) continue;
        g.shadowBlur = 6;
        g.shadowColor = v === 1 ? "#ffffff" : "#000";
        g.fillStyle = v === 1 ? "#f0eefe" : "#20202a";
        g.beginPath();
        g.arc(OX + c * CELL + CELL / 2, OY + r * CELL + CELL / 2, CELL / 2 - 5, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
      }
    g.fillStyle = "rgba(255,255,255,0.75)";
    g.font = "13px ui-monospace, monospace";
    g.fillText(`You ${count(board, 1)}  ·  AI ${count(board, 2)}  ·  Streak ${streak}`, OX, OY - 12);
    if (banner) {
      g.fillStyle = banner === "YOU WIN" ? "#5dff8f" : "#ff6f6f";
      g.textAlign = "center";
      g.font = "700 20px ui-monospace, monospace";
      g.fillText(banner, W / 2, OY - 12);
      g.textAlign = "left";
    }
  }

  const l = loop((dt) => {
    step(dt);
    draw();
    if (phase === "over" && !reported) {
      reported = true;
      saveHighScore("reversi", streak);
      ctx.onGameOver(streak);
    }
  });

  return {
    stop() {
      l.stop();
      canvas.removeEventListener("mousedown", onDown);
    },
  };
}
