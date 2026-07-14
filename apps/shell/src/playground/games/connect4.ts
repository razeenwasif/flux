// Connect Four — drop discs, get four in a row before the AI does. You're
// yellow and move first; the AI (alpha-beta minimax) is red. Win to build a
// streak — score = consecutive wins; a loss or draw ends the run.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

const COLS = 7;
const ROWS = 6;
const CELL = 58;
const OX = (W - COLS * CELL) / 2;
const OY = 70;
type Board = number[][]; // 0 empty, 1 player, 2 AI

export default function connect4(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  let board: Board = fresh();
  let streak = 0;
  let phase: "play" | "aiwait" | "winpause" | "over" = "play";
  let timer = 0;
  let banner = "";
  let hoverCol = -1;
  let reported = false;

  function fresh(): Board { return Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0)); }
  function drop(b: Board, col: number, who: number): number {
    for (let r = ROWS - 1; r >= 0; r--) if (b[r]![col] === 0) { b[r]![col] = who; return r; }
    return -1;
  }
  function full(b: Board) { return b[0]!.every((v) => v !== 0); }

  function winner(b: Board): number {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const v = b[r]![c];
      if (!v) continue;
      for (const [dr, dc] of dirs) {
        let n = 1;
        while (n < 4) { const rr = r + dr! * n, cc = c + dc! * n; if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || b[rr]![cc] !== v) break; n++; }
        if (n === 4) return v;
      }
    }
    return 0;
  }

  function score(b: Board): number {
    // Sum over every length-4 window: reward AI (2) alignments, punish player (1).
    let s = 0;
    const win = (cells: number[]) => {
      const a = cells.filter((x) => x === 2).length, p = cells.filter((x) => x === 1).length;
      if (a && p) return 0;
      if (a === 3) return 50; if (a === 2) return 8; if (a === 1) return 1;
      if (p === 3) return -60; if (p === 2) return -8; if (p === 1) return -1;
      return 0;
    };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const rr = r + dr! * 3, cc = c + dc! * 3;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
        s += win([0, 1, 2, 3].map((i) => b[r + dr! * i]![c + dc! * i]!));
      }
    }
    for (let r = 0; r < ROWS; r++) if (b[r]![3] === 2) s += 3; else if (b[r]![3] === 1) s -= 3;
    return s;
  }

  function minimax(b: Board, depth: number, alpha: number, beta: number, ai: boolean): number {
    const w = winner(b);
    if (w === 2) return 100000 + depth;
    if (w === 1) return -100000 - depth;
    if (depth === 0 || full(b)) return score(b);
    const order = [3, 2, 4, 1, 5, 0, 6];
    if (ai) {
      let best = -Infinity;
      for (const c of order) { if (b[0]![c] !== 0) continue; const nb = b.map((row) => row.slice()); drop(nb, c, 2); best = Math.max(best, minimax(nb, depth - 1, alpha, beta, false)); alpha = Math.max(alpha, best); if (alpha >= beta) break; }
      return best;
    }
    let best = Infinity;
    for (const c of order) { if (b[0]![c] !== 0) continue; const nb = b.map((row) => row.slice()); drop(nb, c, 1); best = Math.min(best, minimax(nb, depth - 1, alpha, beta, true)); beta = Math.min(beta, best); if (alpha >= beta) break; }
    return best;
  }
  function aiPick(): number {
    let best = -Infinity, bc = 3;
    for (const c of [3, 2, 4, 1, 5, 0, 6]) { if (board[0]![c] !== 0) continue; const nb = board.map((row) => row.slice()); drop(nb, c, 2); const v = minimax(nb, 5, -Infinity, Infinity, false); if (v > best) { best = v; bc = c; } }
    return bc;
  }

  function afterMove(who: number) {
    const w = winner(board);
    if (who === 1 && w === 1) { streak++; ctx.setScore(streak); banner = "YOU WIN"; phase = "winpause"; timer = 1300; return; }
    if (who === 2 && w === 2) { banner = "DEFEATED"; phase = "over"; return; }
    if (full(board)) { banner = "DRAW"; phase = "over"; return; }
    phase = who === 1 ? "aiwait" : "play";
    if (phase === "aiwait") timer = 340;
  }

  const onDown = (e: MouseEvent) => {
    if (phase !== "play") return;
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) * (W / rect.width) - OX) / CELL);
    if (c < 0 || c >= COLS || board[0]![c] !== 0) return;
    drop(board, c, 1);
    afterMove(1);
  };
  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    hoverCol = Math.floor(((e.clientX - rect.left) * (W / rect.width) - OX) / CELL);
  };
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("mousemove", onMove);

  function step(dt: number) {
    if (phase === "aiwait") { timer -= dt; if (timer <= 0) { drop(board, aiPick(), 2); afterMove(2); } }
    else if (phase === "winpause") { timer -= dt; if (timer <= 0) { board = fresh(); banner = ""; phase = "play"; } }
  }

  function draw() {
    g.fillStyle = "#0c0a15"; g.fillRect(0, 0, W, H);
    if (phase === "play" && hoverCol >= 0 && hoverCol < COLS && board[0]![hoverCol] === 0) { g.fillStyle = "rgba(255,225,77,0.12)"; g.fillRect(OX + hoverCol * CELL, OY - 10, CELL, ROWS * CELL + 10); }
    g.fillStyle = "#241f4a"; g.fillRect(OX, OY, COLS * CELL, ROWS * CELL);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const v = board[r]![c];
      g.beginPath(); g.arc(OX + c * CELL + CELL / 2, OY + r * CELL + CELL / 2, CELL / 2 - 6, 0, Math.PI * 2);
      if (v) { g.shadowBlur = 10; g.shadowColor = v === 1 ? "#ffe14d" : "#ff4d6d"; g.fillStyle = v === 1 ? "#ffe14d" : "#ff4d6d"; }
      else { g.shadowBlur = 0; g.fillStyle = "#0c0a15"; }
      g.fill(); g.shadowBlur = 0;
    }
    g.fillStyle = "rgba(255,255,255,0.7)"; g.font = "14px ui-monospace, monospace";
    g.fillText(`Streak ${streak}`, OX, OY - 22);
    if (banner) { g.fillStyle = banner === "YOU WIN" ? "#5dff8f" : "#ff6f6f"; g.textAlign = "center"; g.font = "700 22px ui-monospace, monospace"; g.fillText(banner, W / 2, OY - 22); g.textAlign = "left"; }
  }

  const l = loop((dt) => {
    step(dt);
    draw();
    if (phase === "over" && !reported) { reported = true; saveHighScore("connect4", streak); ctx.onGameOver(streak); }
  });

  return { stop() { l.stop(); canvas.removeEventListener("mousedown", onDown); canvas.removeEventListener("mousemove", onMove); } };
}
