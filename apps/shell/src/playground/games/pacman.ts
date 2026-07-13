// Pac-Man — eat every dot, dodge the ghosts. Grab a power pellet (o) and the
// ghosts turn blue and edible for a few seconds. Arrows to steer. 3 lives; clear
// the board to win. Tile-based movement with a connectivity-safe maze (every
// odd row is fully open, so no dot can be walled off).
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

const MAZE = [
  "###################",
  "#o...............o#",
  "#.###.###.###.###.#",
  "#.................#",
  "#.#.....###.....#.#",
  "#.................#",
  "#.###.###.###.###.#",
  "#.................#",
  "#.#.....###.....#.#",
  "#.................#",
  "#.................#",
  "#.................#",
  "#.#.....###.....#.#",
  "#.................#",
  "#.###.###.###.###.#",
  "#.................#",
  "#.#.....###.....#.#",
  "#.................#",
  "#.###.###.###.###.#",
  "#o...............o#",
  "###################",
];
const COLS = 19;
const ROWS = 21;
const CELL = 20;
const OX = (W - COLS * CELL) / 2;
const OY = (H - ROWS * CELL) / 2;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const GCOLORS = ["#ff4d6d", "#ff9ac6", "#2ff3ff"];

interface Ent { c: number; r: number; dir: [number, number] | null; prog: number }

export default function pacman(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const grid = MAZE.map((row) => row.split(""));
  let dots = grid.reduce((n, row) => n + row.filter((ch) => ch === "." || ch === "o").length, 0);

  const pac: Ent & { want: [number, number] | null; mouth: number } = { c: 9, r: 15, dir: null, prog: 0, want: null, mouth: 0 };
  const ghosts: Ent[] = [{ c: 7, r: 9, dir: [1, 0], prog: 0 }, { c: 9, r: 9, dir: [-1, 0], prog: 0 }, { c: 11, r: 9, dir: [1, 0], prog: 0 }];
  let fright = 0;
  let combo = 0;
  let score = 0;
  let lives = 3;
  let over = false;
  let won = false;
  let reported = false;

  const isWall = (c: number, r: number) => r < 0 || r >= ROWS || c < 0 || c >= COLS || grid[r]![c] === "#";

  const k = keys((key) => {
    if (key === "ArrowUp" || key === "w") pac.want = [0, -1];
    else if (key === "ArrowDown" || key === "s") pac.want = [0, 1];
    else if (key === "ArrowLeft" || key === "a") pac.want = [-1, 0];
    else if (key === "ArrowRight" || key === "d") pac.want = [1, 0];
  });

  function resetPositions() {
    pac.c = 9; pac.r = 15; pac.dir = null; pac.prog = 0; pac.want = null;
    ghosts[0]!.c = 7; ghosts[1]!.c = 9; ghosts[2]!.c = 11;
    for (const gh of ghosts) { gh.r = 9; gh.prog = 0; gh.dir = [1, 0]; }
    fright = 0;
  }

  function eat(c: number, r: number) {
    const ch = grid[r]![c];
    if (ch === ".") { grid[r]![c] = " "; dots--; score += 10; ctx.setScore(score); }
    else if (ch === "o") { grid[r]![c] = " "; dots--; score += 50; ctx.setScore(score); fright = 6000; combo = 0; }
    if (dots <= 0) { won = true; over = true; }
  }

  function movePac(dt: number) {
    const speed = 0.0052;
    if (!pac.dir) { if (pac.want && !isWall(pac.c + pac.want[0], pac.r + pac.want[1])) pac.dir = pac.want; else return; }
    pac.prog += speed * dt;
    pac.mouth += dt;
    if (pac.prog >= 1) {
      pac.c += pac.dir![0]; pac.r += pac.dir![1]; pac.prog = 0;
      eat(pac.c, pac.r);
      if (pac.want && !isWall(pac.c + pac.want[0], pac.r + pac.want[1])) pac.dir = pac.want;
      else if (isWall(pac.c + pac.dir![0], pac.r + pac.dir![1])) pac.dir = null;
    }
  }

  function pickGhostDir(gh: Ent): [number, number] {
    const notRev = (d: [number, number]) => !gh.dir || !(d[0] === -gh.dir[0] && d[1] === -gh.dir[1]);
    let opts = DIRS.filter((d) => !isWall(gh.c + d[0], gh.r + d[1]) && notRev(d));
    if (!opts.length) opts = DIRS.filter((d) => !isWall(gh.c + d[0], gh.r + d[1]));
    if (!opts.length) return gh.dir ?? [1, 0];
    if (fright > 0) return opts[(Math.random() * opts.length) | 0]!;
    let best = opts[0]!, bd = Infinity;
    for (const d of opts) {
      const dc = gh.c + d[0] - pac.c, dr = gh.r + d[1] - pac.r;
      const dist = dc * dc + dr * dr;
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  function moveGhost(gh: Ent, dt: number) {
    const speed = fright > 0 ? 0.0031 : 0.0044;
    if (!gh.dir) gh.dir = pickGhostDir(gh);
    gh.prog += speed * dt;
    if (gh.prog >= 1) {
      gh.c += gh.dir![0]; gh.r += gh.dir![1]; gh.prog = 0;
      gh.dir = pickGhostDir(gh);
    }
  }

  function collide() {
    for (const gh of ghosts) {
      if (gh.c === pac.c && gh.r === pac.r) {
        if (fright > 0) { combo++; score += 200 * combo; ctx.setScore(score); gh.c = 9; gh.r = 9; gh.prog = 0; gh.dir = [-1, 0]; }
        else { lives--; if (lives <= 0) over = true; else resetPositions(); return; }
      }
    }
  }

  function step(dt: number) {
    if (fright > 0) fright = Math.max(0, fright - dt);
    movePac(dt);
    collide();
    if (over) return;
    for (const gh of ghosts) moveGhost(gh, dt);
    collide();
  }

  function px(e: Ent) { return OX + ((e.dir ? e.c + e.dir[0] * e.prog : e.c) + 0.5) * CELL; }
  function py(e: Ent) { return OY + ((e.dir ? e.r + e.dir[1] * e.prog : e.r) + 0.5) * CELL; }

  function draw() {
    g.fillStyle = "#0c0a15"; g.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const ch = grid[r]![c];
      const x = OX + c * CELL, y = OY + r * CELL;
      if (ch === "#") { g.fillStyle = "#241f4a"; g.fillRect(x + 2, y + 2, CELL - 4, CELL - 4); }
      else if (ch === ".") { g.fillStyle = "#ffe14d"; g.fillRect(x + CELL / 2 - 2, y + CELL / 2 - 2, 4, 4); }
      else if (ch === "o") { g.shadowBlur = 8; g.shadowColor = "#ffe14d"; g.fillStyle = "#ffe14d"; g.beginPath(); g.arc(x + CELL / 2, y + CELL / 2, 6, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0; }
    }
    // Ghosts.
    ghosts.forEach((gh, i) => {
      g.fillStyle = fright > 0 ? (fright < 1600 && Math.floor(fright / 200) % 2 === 0 ? "#e8e6f4" : "#3a5bff") : GCOLORS[i]!;
      const x = px(gh), y = py(gh);
      g.beginPath(); g.arc(x, y, CELL / 2 - 2, Math.PI, 0); g.lineTo(x + CELL / 2 - 2, y + CELL / 2 - 2); g.lineTo(x - CELL / 2 + 2, y + CELL / 2 - 2); g.closePath(); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(x - 4, y - 2, 2.5, 0, Math.PI * 2); g.arc(x + 4, y - 2, 2.5, 0, Math.PI * 2); g.fill();
    });
    // Pac.
    const a = (Math.sin(pac.mouth / 90) * 0.5 + 0.5) * 0.6;
    const dir = pac.dir ?? [1, 0];
    const face = Math.atan2(dir[1], dir[0]);
    g.save(); g.translate(px(pac), py(pac)); g.rotate(face);
    g.shadowBlur = 12; g.shadowColor = "#ffe14d"; g.fillStyle = "#ffe14d";
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, CELL / 2 - 1, a, Math.PI * 2 - a); g.closePath(); g.fill();
    g.restore(); g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.7)"; g.font = "13px ui-monospace, monospace";
    g.fillText("●".repeat(Math.max(0, lives)), 10, OY - 8);
    if (won) { g.fillStyle = "#5dff8f"; g.textAlign = "center"; g.font = "700 15px ui-monospace, monospace"; g.fillText("CLEARED!", W / 2, OY - 8); g.textAlign = "left"; }
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) { reported = true; saveHighScore("pacman", score); ctx.onGameOver(score); }
  });

  return { stop() { l.stop(); k.stop(); } };
}
