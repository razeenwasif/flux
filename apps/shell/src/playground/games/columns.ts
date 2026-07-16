// Columns — a falling stack of three gems. ←/→ move, ↑ cycles the trio's
// colours, ↓ soft-drops, Space hard-drops. Line up 3+ of a colour in any
// direction (incl. diagonals) to clear them; clears cascade for combo score.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

const COLS = 6;
const ROWS = 13;
const CELL = 32;
const OX = (W - COLS * CELL) / 2;
const OY = (H - ROWS * CELL) / 2;
const GEMS = ["#2ff3ff", "#ff4d9d", "#ffe14d", "#5dff8f", "#b07dff"];

export default function columns(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const board: number[][] = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
  let colr = [rc(), rc(), rc()]; // three gem colours, top→bottom
  let col = COLS >> 1;
  let row = 0;
  let score = 0;
  let over = false;
  let reported = false;
  let acc = 0;
  let stepMs = 520;

  function rc() {
    return 1 + ((Math.random() * GEMS.length) | 0);
  }

  function canFall() {
    return row + 2 + 1 < ROWS && board[row + 3]![col] === 0;
  }
  function cellsFree(c: number) {
    return board[row]![c] === 0 && board[row + 1]![c] === 0 && board[row + 2]![c] === 0;
  }

  function spawn() {
    colr = [rc(), rc(), rc()];
    col = COLS >> 1;
    row = 0;
    if (!cellsFree(col)) over = true;
  }

  function lock() {
    board[row]![col] = colr[0]!;
    board[row + 1]![col] = colr[1]!;
    board[row + 2]![col] = colr[2]!;
    resolve();
    spawn();
  }

  function resolve() {
    let chain = 1;
    for (;;) {
      const marked = new Set<number>();
      const dirs = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ];
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
          const v = board[r]![c];
          if (!v) continue;
          for (const [dr, dc] of dirs) {
            const run = [r * COLS + c];
            let rr = r + dr!,
              cc = c + dc!;
            while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr]![cc] === v) {
              run.push(rr * COLS + cc);
              rr += dr!;
              cc += dc!;
            }
            if (run.length >= 3) for (const k of run) marked.add(k);
          }
        }
      if (!marked.size) break;
      for (const key of marked) board[(key / COLS) | 0]![key % COLS] = 0;
      score += marked.size * 10 * chain;
      ctx.setScore(score);
      // Gravity: compact each column downward.
      for (let c = 0; c < COLS; c++) {
        const stack: number[] = [];
        for (let r = ROWS - 1; r >= 0; r--) if (board[r]![c]) stack.push(board[r]![c]!);
        for (let r = ROWS - 1; r >= 0; r--) board[r]![c] = stack[ROWS - 1 - r] ?? 0;
      }
      chain++;
    }
  }

  const k = keys((key) => {
    if (over) return;
    if (key === "ArrowLeft" || key === "a") {
      if (col > 0 && cellsFree(col - 1)) col--;
    } else if (key === "ArrowRight" || key === "d") {
      if (col < COLS - 1 && cellsFree(col + 1)) col++;
    } else if (key === "ArrowUp" || key === "w") colr = [colr[2]!, colr[0]!, colr[1]!];
    else if (key === "ArrowDown" || key === "s") {
      if (canFall()) {
        row++;
        acc = 0;
      } else lock();
    } else if (key === " " || key === "Spacebar") {
      while (canFall()) row++;
      lock();
      acc = 0;
    }
  });

  function gem(c: number, x: number, y: number, glow: boolean) {
    g.shadowBlur = glow ? 10 : 4;
    g.shadowColor = GEMS[c - 1]!;
    g.fillStyle = GEMS[c - 1]!;
    g.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
    g.shadowBlur = 0;
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#07060d";
    g.fillRect(OX, OY, COLS * CELL, ROWS * CELL);
    g.strokeStyle = "rgba(255,255,255,0.05)";
    for (let c = 0; c <= COLS; c++) {
      g.beginPath();
      g.moveTo(OX + c * CELL, OY);
      g.lineTo(OX + c * CELL, OY + ROWS * CELL);
      g.stroke();
    }
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (board[r]![c]) gem(board[r]![c]!, OX + c * CELL, OY + r * CELL, false);
    for (let i = 0; i < 3; i++) gem(colr[i]!, OX + col * CELL, OY + (row + i) * CELL, true);
  }

  const l = loop((dt) => {
    if (!over) {
      acc += dt;
      if (acc >= stepMs) {
        acc = 0;
        if (canFall()) row++;
        else lock();
        stepMs = Math.max(180, 520 - score / 40);
      }
    }
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("columns", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
    },
  };
}
