// Space Invaders — ←/→ move, Space fire. Wipe the fleet before it lands or
// bombs you; each cleared wave comes back faster. 3 lives.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Alien {
  x: number;
  y: number;
  alive: boolean;
  row: number;
}

export default function invaders(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const SW = 38;
  const SH = 14;
  const SY = H - 34;
  const AW = 26;
  const AH = 18;
  const GX = 18;
  const GY = 16;
  const COLS = 10;
  const ROWS = 5;
  const OX = 48;
  const OY = 50;
  const rowColor = ["#ff4d9d", "#ff8a3d", "#ffe14d", "#5dff8f", "#2ff3ff"];

  let sx = (W - SW) / 2;
  let left = false;
  let right = false;
  let shoot = false;
  let cool = 0;
  let dir = 1;
  let moveAcc = 0;
  let bombAcc = 0;
  let waveNum = 1;
  let baseMs = 560;
  let score = 0;
  let lives = 3;
  let over = false;
  let reported = false;
  let aliens: Alien[] = [];
  let bullets: { x: number; y: number }[] = [];
  let bombs: { x: number; y: number }[] = [];

  function buildWave() {
    aliens = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        aliens.push({ x: OX + c * (AW + GX), y: OY + r * (AH + GY), alive: true, row: r });
  }
  buildWave();

  const k = keys(
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = true;
      else if (key === "ArrowRight" || key === "d") right = true;
      else if (key === " " || key === "Spacebar") shoot = true;
    },
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = false;
      else if (key === "ArrowRight" || key === "d") right = false;
      else if (key === " " || key === "Spacebar") shoot = false;
    },
  );

  function alive() {
    return aliens.filter((a) => a.alive);
  }

  function stepAliens() {
    const live = alive();
    if (!live.length) {
      waveNum++;
      baseMs = Math.max(160, baseMs - 70);
      score += 100;
      ctx.setScore(score);
      buildWave();
      return;
    }
    let edge = false;
    for (const a of live) {
      const nx = a.x + dir * 10;
      if (nx < 6 || nx + AW > W - 6) edge = true;
    }
    if (edge) {
      dir *= -1;
      for (const a of live) a.y += 16;
    } else {
      for (const a of live) a.x += dir * 10;
    }
    for (const a of live) if (a.y + AH >= SY) over = true;
  }

  function step(dt: number) {
    if (left) sx = Math.max(6, sx - 0.5 * dt);
    if (right) sx = Math.min(W - SW - 6, sx + 0.5 * dt);
    cool -= dt;
    if (shoot && cool <= 0) {
      bullets.push({ x: sx + SW / 2, y: SY });
      cool = 300;
    }

    for (const b of bullets) b.y -= 0.6 * dt;
    bullets = bullets.filter((b) => b.y > -10);
    for (const b of bombs) b.y += 0.32 * dt;
    bombs = bombs.filter((b) => b.y < H + 10);

    // Formation movement — faster as the fleet thins.
    const live = alive();
    const ratio = live.length / (COLS * ROWS);
    moveAcc += dt;
    if (moveAcc >= 120 + baseMs * ratio) {
      moveAcc = 0;
      stepAliens();
    }

    // Aliens drop bombs.
    bombAcc += dt;
    if (bombAcc >= 750 && live.length) {
      bombAcc = 0;
      const a = live[(Math.random() * live.length) | 0]!;
      bombs.push({ x: a.x + AW / 2, y: a.y + AH });
    }

    // Bullet vs alien.
    for (const b of bullets) {
      for (const a of aliens) {
        if (a.alive && b.x > a.x && b.x < a.x + AW && b.y > a.y && b.y < a.y + AH) {
          a.alive = false;
          b.y = -20;
          score += 10 + (ROWS - a.row) * 2;
          ctx.setScore(score);
          break;
        }
      }
    }
    // Bomb vs ship.
    for (const b of bombs) {
      if (b.x > sx && b.x < sx + SW && b.y > SY && b.y < SY + SH + 6) {
        b.y = H + 20;
        lives--;
        bombs = [];
        if (lives <= 0) over = true;
        break;
      }
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    for (const a of aliens) {
      if (!a.alive) continue;
      g.shadowBlur = 8;
      g.shadowColor = rowColor[a.row]!;
      g.fillStyle = rowColor[a.row]!;
      g.fillRect(a.x, a.y, AW, AH);
      g.fillStyle = "#0c0a15";
      g.fillRect(a.x + 5, a.y + 6, 4, 4);
      g.fillRect(a.x + AW - 9, a.y + 6, 4, 4);
    }
    g.shadowBlur = 12;
    g.shadowColor = "#aefcff";
    g.fillStyle = "#aefcff";
    g.fillRect(sx, SY, SW, SH);
    g.fillRect(sx + SW / 2 - 2, SY - 6, 4, 6);
    g.shadowColor = "#ffe14d";
    g.fillStyle = "#ffe14d";
    for (const b of bullets) g.fillRect(b.x - 1.5, b.y - 8, 3, 10);
    g.shadowColor = "#ff4d9d";
    g.fillStyle = "#ff9ac6";
    for (const b of bombs) g.fillRect(b.x - 1.5, b.y, 3, 9);
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.fillText("♥".repeat(Math.max(0, lives)), 10, H - 8);
    g.textAlign = "right";
    g.fillText(`WAVE ${waveNum}`, W - 10, H - 8);
    g.textAlign = "left";
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("invaders", score);
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
