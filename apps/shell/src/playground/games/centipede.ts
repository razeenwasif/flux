// Centipede — move with the arrows (in the bottom band), Space to fire. Shoot
// the centipede: each hit drops a mushroom and splits it in two. Mushrooms
// deflect it downward. Clear every segment for the next, faster wave. Touch it
// and you lose a life — 3 to start.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

const COLS = 20;
const ROWS = 15;
const CELL = 32;
const BAND = ROWS - 4; // player is confined to rows BAND..ROWS-1

interface Seg { c: number; r: number }
interface Bug { cells: Seg[]; dir: number }

export default function centipede(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const mush: number[][] = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
  let bugs: Bug[] = [];
  let bullets: { x: number; y: number }[] = [];
  let px = W / 2, py = (ROWS - 1) * CELL + CELL / 2;
  let left = false, right = false, up = false, down = false, fire = false, cool = 0;
  let acc = 0, stepMs = 130;
  let wave = 1, lives = 3, score = 0, invuln = 0;
  let over = false, reported = false;

  for (let i = 0; i < 32; i++) { const r = 1 + ((Math.random() * (BAND - 1)) | 0); const c = (Math.random() * COLS) | 0; mush[r]![c] = 3; }

  function spawnWave() {
    const len = 9 + wave;
    const cells: Seg[] = [];
    for (let i = 0; i < len; i++) cells.push({ c: -i, r: 0 });
    bugs = [{ cells, dir: 1 }];
    stepMs = Math.max(60, 130 - wave * 8);
  }
  spawnWave();

  const k = keys(
    (key) => { if (key === "ArrowLeft" || key === "a") left = true; else if (key === "ArrowRight" || key === "d") right = true; else if (key === "ArrowUp" || key === "w") up = true; else if (key === "ArrowDown" || key === "s") down = true; else if (key === " " || key === "Spacebar") fire = true; },
    (key) => { if (key === "ArrowLeft" || key === "a") left = false; else if (key === "ArrowRight" || key === "d") right = false; else if (key === "ArrowUp" || key === "w") up = false; else if (key === "ArrowDown" || key === "s") down = false; else if (key === " " || key === "Spacebar") fire = false; },
  );

  const cellFree = (c: number, r: number) => c >= 0 && c < COLS && r >= 0 && r < ROWS && mush[r]![c] === 0;

  function tickBugs() {
    for (const bug of bugs) {
      const head = bug.cells[0]!;
      let nc = head.c + bug.dir, nr = head.r;
      if (nc < 0 || nc >= COLS || (mush[nr]?.[nc] ?? 0) > 0) { nr = Math.min(ROWS - 1, head.r + 1); bug.dir = -bug.dir; nc = head.c; if (head.r >= ROWS - 1) nr = head.r - 1; }
      bug.cells.unshift({ c: nc, r: nr });
      bug.cells.pop();
      // Reaching the player band as a whole is fine; collision is checked per-frame.
    }
  }

  function shoot(bx: number, by: number) {
    const bc = Math.floor(bx / CELL), br = Math.floor(by / CELL);
    // Mushroom hit?
    if (br >= 0 && br < ROWS && bc >= 0 && bc < COLS && mush[br]![bc]! > 0) { mush[br]![bc]!--; if (mush[br]![bc] === 0) { score += 1; ctx.setScore(score); } return true; }
    // Segment hit?
    for (let bi = 0; bi < bugs.length; bi++) {
      const bug = bugs[bi]!;
      const idx = bug.cells.findIndex((s) => s.c === bc && s.r === br);
      if (idx < 0) continue;
      const seg = bug.cells[idx]!;
      mush[seg.r]![seg.c] = 3; // dead segment leaves a mushroom
      score += 10; ctx.setScore(score);
      const front = bug.cells.slice(0, idx);
      const back = bug.cells.slice(idx + 1);
      const repl: Bug[] = [];
      if (front.length) repl.push({ cells: front, dir: bug.dir });
      if (back.length) repl.push({ cells: back, dir: bug.dir });
      bugs.splice(bi, 1, ...repl);
      return true;
    }
    return false;
  }

  function hitPlayer() { lives--; invuln = 1800; if (lives <= 0) over = true; }

  function step(dt: number) {
    const sp = 0.34;
    if (left) px = Math.max(CELL / 2, px - sp * dt);
    if (right) px = Math.min(W - CELL / 2, px + sp * dt);
    if (up) py = Math.max(BAND * CELL + CELL / 2, py - sp * dt);
    if (down) py = Math.min((ROWS - 1) * CELL + CELL / 2, py + sp * dt);
    cool -= dt;
    if (fire && cool <= 0) { bullets.push({ x: px, y: py - 14 }); cool = 260; }

    for (const b of bullets) b.y -= 0.7 * dt;
    bullets = bullets.filter((b) => { if (b.y < 0) return false; return !shoot(b.x, b.y); });

    acc += dt;
    if (acc >= stepMs) { acc = 0; tickBugs(); }
    if (invuln > 0) invuln -= dt;

    if (!bugs.length) { wave++; spawnWave(); }

    // Player collision.
    if (invuln <= 0) {
      const pc = Math.floor(px / CELL), pr = Math.floor(py / CELL);
      for (const bug of bugs) if (bug.cells.some((s) => s.c === pc && s.r === pr)) { hitPlayer(); break; }
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.05)"; g.beginPath(); g.moveTo(0, BAND * CELL); g.lineTo(W, BAND * CELL); g.stroke();
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (mush[r]![c]! > 0) { const hp = mush[r]![c]!; g.fillStyle = hp === 3 ? "#5dff8f" : hp === 2 ? "#8a7dff" : "#ff8a3d"; g.fillRect(c * CELL + 6, r * CELL + 6, CELL - 12, CELL - 12); }
    for (const bug of bugs) bug.cells.forEach((s, i) => { g.shadowBlur = 8; g.shadowColor = "#ff4d9d"; g.fillStyle = i === 0 ? "#ff9ac6" : "#ff4d9d"; g.beginPath(); g.arc(s.c * CELL + CELL / 2, s.r * CELL + CELL / 2, CELL / 2 - 4, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0; });
    g.fillStyle = "#ffe14d"; for (const b of bullets) g.fillRect(b.x - 1.5, b.y - 8, 3, 10);
    if (!(invuln > 0 && Math.floor(invuln / 120) % 2 === 0)) { g.shadowBlur = 10; g.shadowColor = "#2ff3ff"; g.fillStyle = "#aefcff"; g.fillRect(px - 12, py - 8, 24, 16); g.shadowBlur = 0; }
    g.fillStyle = "rgba(255,255,255,0.7)"; g.font = "14px ui-monospace, monospace";
    g.fillText("▲".repeat(Math.max(0, lives)), 10, 22);
    g.textAlign = "right"; g.fillText(`WAVE ${wave}`, W - 10, 22); g.textAlign = "left";
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) { reported = true; saveHighScore("centipede", score); ctx.onGameOver(score); }
  });

  return { stop() { l.stop(); k.stop(); } };
}
