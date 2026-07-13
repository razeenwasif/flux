// 2048 — slide with the arrow keys / WASD; equal tiles merge. Keep going past
// 2048. It's over when the board is full with no moves left. Score = merges.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

type Grid = number[][];

const N = 4;
const BOARD = 412;
const GAP = 12;
const CELL = (BOARD - GAP * (N + 1)) / N;
const OX = (W - BOARD) / 2;
const OY = (H - BOARD) / 2;

const TILE: Record<number, string> = {
  2: "#3a3550", 4: "#4a4066", 8: "#ff8a3d", 16: "#ff6f3d", 32: "#ff4d6d", 64: "#ff4d9d",
  128: "#b07dff", 256: "#8a7dff", 512: "#4d8bff", 1024: "#2ff3ff", 2048: "#5dff8f",
};

const empty = (): Grid => Array.from({ length: N }, () => Array<number>(N).fill(0));
const transpose = (g: Grid): Grid => g[0]!.map((_, c) => g.map((row) => row[c]!));
const reverseRows = (g: Grid): Grid => g.map((row) => [...row].reverse());

function slideRow(row: number[]): { row: number[]; gained: number } {
  const nums = row.filter((x) => x);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] === nums[i + 1]) { const v = nums[i]! * 2; out.push(v); gained += v; i++; }
    else out.push(nums[i]!);
  }
  while (out.length < N) out.push(0);
  return { row: out, gained };
}

function slideLeft(g: Grid): { grid: Grid; gained: number; changed: boolean } {
  let gained = 0;
  let changed = false;
  const out = g.map((row) => {
    const r = slideRow(row);
    if (!r.row.every((v, i) => v === row[i])) changed = true;
    gained += r.gained;
    return r.row;
  });
  return { grid: out, gained, changed };
}

export default function game2048(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  let grid = empty();
  let score = 0;
  let over = false;
  let reported = false;

  function addRandom() {
    const cells: [number, number][] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (grid[r]![c] === 0) cells.push([r, c]);
    if (!cells.length) return;
    const [r, c] = cells[(Math.random() * cells.length) | 0]!;
    grid[r]![c] = Math.random() < 0.9 ? 2 : 4;
  }
  addRandom();
  addRandom();

  function canMove(): boolean {
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (grid[r]![c] === 0) return true;
      if (c < N - 1 && grid[r]![c] === grid[r]![c + 1]) return true;
      if (r < N - 1 && grid[r]![c] === grid[r + 1]![c]) return true;
    }
    return false;
  }

  function move(dir: "left" | "right" | "up" | "down") {
    if (over) return;
    let work = grid;
    if (dir === "right") work = reverseRows(grid);
    else if (dir === "up") work = transpose(grid);
    else if (dir === "down") work = reverseRows(transpose(grid));
    const { grid: slid, gained, changed } = slideLeft(work);
    if (!changed) return;
    if (dir === "right") grid = reverseRows(slid);
    else if (dir === "up") grid = transpose(slid);
    else if (dir === "down") grid = transpose(reverseRows(slid));
    else grid = slid;
    score += gained;
    ctx.setScore(score);
    addRandom();
    if (!canMove()) over = true;
  }

  const k = keys((key) => {
    if (key === "ArrowLeft" || key === "a") move("left");
    else if (key === "ArrowRight" || key === "d") move("right");
    else if (key === "ArrowUp" || key === "w") move("up");
    else if (key === "ArrowDown" || key === "s") move("down");
  });

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#141024";
    roundRect(OX, OY, BOARD, BOARD, 12);
    g.fill();
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = OX + GAP + c * (CELL + GAP);
        const y = OY + GAP + r * (CELL + GAP);
        const v = grid[r]![c]!;
        g.fillStyle = v === 0 ? "rgba(255,255,255,0.04)" : (TILE[v] ?? "#5dff8f");
        roundRect(x, y, CELL, CELL, 8);
        g.fill();
        if (v) {
          g.fillStyle = v <= 4 ? "#e8e6f4" : "#0c0a15";
          const s = String(v);
          g.font = `700 ${s.length > 3 ? 26 : s.length > 2 ? 32 : 40}px ui-monospace, monospace`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText(s, x + CELL / 2, y + CELL / 2 + 2);
        }
      }
    }
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  const l = loop(() => {
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("2048", score);
      ctx.onGameOver(score);
    }
  });

  return { stop() { l.stop(); k.stop(); } };
}
