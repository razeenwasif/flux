// Tetris — ←/→ move, ↑ rotate, ↓ soft drop, Space hard drop. Clear lines to
// score; every 10 lines speeds up. Standard 10×20 well with a NEXT preview and
// a landing ghost.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

const COLS = 10;
const ROWS = 20;
const CELL = 24;
const BX = 168; // board pixel origin x (board is 240 wide, panel to the right)
const BY = 0;

type Piece = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type Cell = string | null;

const SHAPES: Record<Piece, number[][]> = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};
const COLORS: Record<Piece, string> = {
  I: "#2ff3ff", O: "#ffe14d", T: "#b07dff", S: "#5dff8f", Z: "#ff4d9d", J: "#4d8bff", L: "#ff8a3d",
};
const TYPES: Piece[] = ["I", "O", "T", "S", "Z", "J", "L"];

function clone(m: number[][]): number[][] {
  return m.map((r) => r.slice());
}

function rotate(m: number[][]): number[][] {
  const n = m.length;
  const out = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let y = 0; y < n; y++) {
    const row = m[y]!;
    for (let x = 0; x < n; x++) out[x]![n - 1 - y] = row[x]!;
  }
  return out;
}

export default function tetris(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const board: Cell[][] = Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));
  let type: Piece = rng();
  let nextType: Piece = rng();
  let m = clone(SHAPES[type]);
  let px = 3;
  let py = 0;
  let score = 0;
  let lines = 0;
  let level = 1;
  let over = false;
  let reported = false;
  let acc = 0;

  function rng(): Piece { return TYPES[(Math.random() * TYPES.length) | 0]!; }
  function stepMs() { return Math.max(80, 520 - (level - 1) * 42); }

  function collide(mat: number[][], x: number, y: number): boolean {
    for (let r = 0; r < mat.length; r++) {
      const row = mat[r]!;
      for (let c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        const br = y + r;
        const bc = x + c;
        if (bc < 0 || bc >= COLS || br >= ROWS) return true;
        if (br >= 0 && board[br]![bc]) return true;
      }
    }
    return false;
  }

  function spawn() {
    type = nextType;
    nextType = rng();
    m = clone(SHAPES[type]);
    px = ((COLS - m[0]!.length) / 2) | 0;
    py = 0;
    if (collide(m, px, py)) over = true;
  }

  function lock() {
    for (let r = 0; r < m.length; r++) {
      const row = m[r]!;
      for (let c = 0; c < row.length; c++) if (row[c] && py + r >= 0) board[py + r]![px + c] = COLORS[type];
    }
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r]!.every((v) => v)) {
        board.splice(r, 1);
        board.unshift(Array<Cell>(COLS).fill(null));
        cleared++;
        r++;
      }
    }
    if (cleared) {
      score += ([0, 100, 300, 500, 800][cleared] ?? 800) * level;
      lines += cleared;
      level = 1 + Math.floor(lines / 10);
      ctx.setScore(score);
    }
    spawn();
  }

  function drop() {
    if (!collide(m, px, py + 1)) py++;
    else lock();
  }

  const k = keys((key) => {
    if (over) return;
    if (key === "ArrowLeft" || key === "a") { if (!collide(m, px - 1, py)) px--; }
    else if (key === "ArrowRight" || key === "d") { if (!collide(m, px + 1, py)) px++; }
    else if (key === "ArrowDown" || key === "s") { drop(); acc = 0; }
    else if (key === "ArrowUp" || key === "w") {
      const rm = rotate(m);
      for (const off of [0, -1, 1, -2, 2]) if (!collide(rm, px + off, py)) { m = rm; px += off; break; }
    } else if (key === " " || key === "Spacebar") {
      while (!collide(m, px, py + 1)) py++;
      lock();
      acc = 0;
    }
  });

  function cell(x: number, y: number, color: string, alpha = 1) {
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(BX + x * CELL + 1, BY + y * CELL + 1, CELL - 2, CELL - 2);
    g.globalAlpha = 1;
  }

  function drawPiece(mat: number[][], ox: number, oy: number, color: string, alpha = 1) {
    for (let r = 0; r < mat.length; r++) {
      const row = mat[r]!;
      for (let c = 0; c < row.length; c++) if (row[c] && oy + r >= 0) cell(ox + c, oy + r, color, alpha);
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#07060d";
    g.fillRect(BX, BY, COLS * CELL, ROWS * CELL);
    g.strokeStyle = "rgba(255,255,255,0.06)";
    for (let x = 0; x <= COLS; x++) { g.beginPath(); g.moveTo(BX + x * CELL, BY); g.lineTo(BX + x * CELL, BY + ROWS * CELL); g.stroke(); }
    for (let y = 0; y <= ROWS; y++) { g.beginPath(); g.moveTo(BX, BY + y * CELL); g.lineTo(BX + COLS * CELL, BY + y * CELL); g.stroke(); }
    for (let y = 0; y < ROWS; y++) {
      const row = board[y]!;
      for (let x = 0; x < COLS; x++) if (row[x]) cell(x, y, row[x]!);
    }
    // Ghost landing position.
    let gy = py;
    while (!collide(m, px, gy + 1)) gy++;
    drawPiece(m, px, gy, COLORS[type], 0.18);
    // Active piece (glow).
    g.shadowBlur = 10;
    g.shadowColor = COLORS[type];
    drawPiece(m, px, py, COLORS[type]);
    g.shadowBlur = 0;
    // Panel.
    const panelX = BX + COLS * CELL + 28;
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.font = "13px ui-monospace, monospace";
    g.fillText("SCORE", panelX, 40);
    g.fillText("LEVEL", panelX, 100);
    g.fillText("LINES", panelX, 160);
    g.fillText("NEXT", panelX, 230);
    g.font = "22px ui-monospace, monospace";
    g.fillStyle = "#aefcff";
    g.fillText(String(score), panelX, 66);
    g.fillText(String(level), panelX, 126);
    g.fillText(String(lines), panelX, 186);
    const nm = SHAPES[nextType];
    g.shadowBlur = 8;
    g.shadowColor = COLORS[nextType];
    g.fillStyle = COLORS[nextType];
    for (let r = 0; r < nm.length; r++) {
      const row = nm[r]!;
      for (let c = 0; c < row.length; c++) if (row[c]) g.fillRect(panelX + c * 18 + 1, 250 + r * 18 + 1, 16, 16);
    }
    g.shadowBlur = 0;
  }

  const l = loop((dt) => {
    if (!over) {
      acc += dt;
      if (acc >= stepMs()) { acc = 0; drop(); }
    }
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("tetris", score);
      ctx.onGameOver(score);
    }
  });

  return { stop() { l.stop(); k.stop(); } };
}
