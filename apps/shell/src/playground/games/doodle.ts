// Doodle Jump — auto-bounce ever upward; steer with ←/→ (you wrap around the
// edges). Land on platforms, don't fall off the bottom. Score = height climbed.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Plat { x: number; y: number; vx: number }

const PW = 66;
const PH = 12;
const PLR = 18; // player radius-ish
const GRAV = 0.0016;
const JUMP = -0.78;

export default function doodle(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  let px = W / 2;
  let py = H - 120;
  let vy = 0;
  let left = false;
  let right = false;
  let climbed = 0; // total world scroll = score basis
  let score = 0;
  let over = false;
  let reported = false;
  let plats: Plat[] = [];

  // Seed platforms up the screen, guaranteed reachable spacing.
  for (let y = H - 40; y > -20; y -= 62) plats.push({ x: Math.random() * (W - PW), y, vx: 0 });
  // Ensure one right under the player to start.
  plats.push({ x: px - PW / 2, y: H - 90, vx: 0 });

  const k = keys(
    (key) => { if (key === "ArrowLeft" || key === "a") left = true; else if (key === "ArrowRight" || key === "d") right = true; },
    (key) => { if (key === "ArrowLeft" || key === "a") left = false; else if (key === "ArrowRight" || key === "d") right = false; },
  );

  function addPlatform() {
    const highest = plats.reduce((m, p) => Math.min(m, p.y), H);
    const moving = climbed > 1200 && Math.random() < 0.28;
    plats.push({ x: Math.random() * (W - PW), y: highest - (48 + Math.random() * 26), vx: moving ? (Math.random() < 0.5 ? -0.12 : 0.12) : 0 });
  }

  function step(dt: number) {
    if (left) px -= 0.55 * dt;
    if (right) px += 0.55 * dt;
    if (px < -PLR) px = W + PLR;
    if (px > W + PLR) px = -PLR;

    vy += GRAV * dt;
    py += vy * dt;

    for (const p of plats) {
      if (p.vx) { p.x += p.vx * dt; if (p.x < 0 || p.x > W - PW) p.vx = -p.vx; }
      // Land only when falling and crossing the platform top within its span.
      if (vy > 0 && px > p.x - PLR && px < p.x + PW + PLR && py + PLR > p.y && py + PLR < p.y + PH + 12) {
        vy = JUMP;
      }
    }

    // Scroll the world down when the player climbs into the upper third.
    if (py < H * 0.42) {
      const d = H * 0.42 - py;
      py = H * 0.42;
      climbed += d;
      for (const p of plats) p.y += d;
      score = Math.floor(climbed / 6);
      ctx.setScore(score);
      while (plats.some((p) => p.y > -10) && plats.reduce((m, p) => Math.min(m, p.y), H) > -20) addPlatform();
    }
    plats = plats.filter((p) => p.y < H + 20);
    if (py - PLR > H) over = true;
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    for (const p of plats) {
      g.shadowBlur = 8;
      g.shadowColor = p.vx ? "#ff8a3d" : "#5dff8f";
      g.fillStyle = p.vx ? "#ff8a3d" : "#3ddc78";
      g.fillRect(p.x, p.y, PW, PH);
    }
    g.shadowBlur = 14; g.shadowColor = "#2ff3ff"; g.fillStyle = "#aefcff";
    g.beginPath(); g.arc(px, py, PLR, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0; g.fillStyle = "#0c0a15";
    g.fillRect(px - 7, py - 6, 4, 5); g.fillRect(px + 3, py - 6, 4, 5);
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) { reported = true; saveHighScore("doodle", score); ctx.onGameOver(score); }
  });

  return { stop() { l.stop(); k.stop(); } };
}
