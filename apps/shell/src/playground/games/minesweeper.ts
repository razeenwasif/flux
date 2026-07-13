// Minesweeper — left-click to reveal, right-click to flag. Clear every safe
// cell without hitting a mine. The first click is always safe. Score = safe
// cells revealed, plus a bonus for a full clear.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

interface Cell { mine: boolean; rev: boolean; flag: boolean; count: number }

const COLS = 16;
const ROWS = 12;
const CELL = 40; // 16×40 = 640, 12×40 = 480 → fills the canvas
const MINES = 32;
const NUMCOL = ["", "#5b8cff", "#5dff8f", "#ff6f6f", "#b07dff", "#ff8a3d", "#2ff3ff", "#e8e6f4", "#ff4d9d"];

export default function minesweeper(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  let grid: Cell[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ mine: false, rev: false, flag: false, count: 0 })));
  let started = false;
  let over = false;
  let won = false;
  let reported = false;
  let revealed = 0;
  let flags = 0;

  const inb = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const forNbrs = (r: number, c: number, fn: (r: number, c: number) => void) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && inb(r + dr, c + dc)) fn(r + dr, c + dc);
  };

  function place(safeR: number, safeC: number) {
    let placed = 0;
    while (placed < MINES) {
      const r = (Math.random() * ROWS) | 0;
      const c = (Math.random() * COLS) | 0;
      const near = Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1;
      if (grid[r]![c]!.mine || near) continue;
      grid[r]![c]!.mine = true;
      placed++;
    }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      let n = 0;
      forNbrs(r, c, (rr, cc) => { if (grid[rr]![cc]!.mine) n++; });
      grid[r]![c]!.count = n;
    }
  }

  function reveal(r: number, c: number) {
    const stack: [number, number][] = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      const cell = grid[cr]![cc]!;
      if (cell.rev || cell.flag) continue;
      cell.rev = true;
      if (cell.mine) { over = true; revealAllMines(); return; }
      revealed++;
      if (cell.count === 0) forNbrs(cr, cc, (rr, ccc) => { if (!grid[rr]![ccc]!.rev) stack.push([rr, ccc]); });
    }
    ctx.setScore(revealed);
    if (revealed === COLS * ROWS - MINES) { won = true; over = true; }
  }

  function revealAllMines() {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r]![c]!.mine) grid[r]![c]!.rev = true;
  }

  function cellAt(e: MouseEvent): [number, number] | null {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (H / rect.height);
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
    return inb(r, c) ? [r, c] : null;
  }

  const onDown = (e: MouseEvent) => {
    if (over) return;
    const at = cellAt(e);
    if (!at) return;
    const [r, c] = at;
    if (e.button === 2) {
      const cell = grid[r]![c]!;
      if (!cell.rev) { cell.flag = !cell.flag; flags += cell.flag ? 1 : -1; }
    } else if (!grid[r]![c]!.flag) {
      if (!started) { started = true; place(r, c); }
      reveal(r, c);
    }
  };
  const onCtx = (e: Event) => e.preventDefault();
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("contextmenu", onCtx);

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.font = "600 18px ui-monospace, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = grid[r]![c]!;
        const x = c * CELL, y = r * CELL;
        if (cell.rev) {
          g.fillStyle = cell.mine ? "#ff4d6d" : "#151226";
          g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          if (cell.mine) { g.fillStyle = "#0c0a15"; g.beginPath(); g.arc(x + CELL / 2, y + CELL / 2, 8, 0, Math.PI * 2); g.fill(); }
          else if (cell.count > 0) { g.fillStyle = NUMCOL[cell.count]!; g.fillText(String(cell.count), x + CELL / 2, y + CELL / 2 + 1); }
        } else {
          g.fillStyle = "rgba(255,255,255,0.07)";
          g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          if (cell.flag) { g.fillStyle = "#ffe14d"; g.fillText("⚑", x + CELL / 2, y + CELL / 2 + 1); }
        }
      }
    }
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.fillText(`💣 ${MINES - flags}`, 10, H - 12);
    if (won) {
      g.fillStyle = "#5dff8f";
      g.textAlign = "center";
      g.font = "700 15px ui-monospace, monospace";
      g.fillText("SWEPT!", W / 2, H - 12);
      g.textAlign = "left";
    }
  }

  const l = loop(() => {
    draw();
    if (over && !reported) {
      reported = true;
      const final = won ? revealed + MINES * 10 : revealed;
      saveHighScore("minesweeper", final);
      ctx.onGameOver(final);
    }
  });

  return {
    stop() {
      l.stop();
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("contextmenu", onCtx);
    },
  };
}
