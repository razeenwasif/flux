// Whack-a-Mole — click the moles as they pop up; the game speeds up as you
// score. Click a 💣 bomb and it's over. Missing a mole is free — it's all about
// the bonks.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

interface Hole {
  x: number;
  y: number;
  up: number;
  kind: "mole" | "bomb" | null;
  timer: number;
}

const COLS = 3;
const ROWS = 3;
const R = 52;

export default function whack(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const holes: Hole[] = [];
  const gapX = W / (COLS + 1);
  const gapY = (H - 40) / (ROWS + 1);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      holes.push({ x: gapX * (c + 1), y: 30 + gapY * (r + 1), up: 0, kind: null, timer: 0 });

  let score = 0;
  let over = false;
  let reported = false;
  let spawnIn = 700;
  let upTime = 900;

  function popRandom() {
    const empty = holes.filter((h) => !h.kind);
    if (!empty.length) return;
    const h = empty[(Math.random() * empty.length) | 0]!;
    h.kind = Math.random() < 0.16 ? "bomb" : "mole";
    h.timer = upTime;
    h.up = 0;
  }

  const onDown = (e: MouseEvent) => {
    if (over) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    for (const h of holes) {
      if (h.kind && h.up > 0.4 && Math.hypot(mx - h.x, my - (h.y - h.up * 18)) < R * 0.7) {
        if (h.kind === "bomb") {
          over = true;
          return;
        }
        score++;
        ctx.setScore(score);
        h.kind = null;
        upTime = Math.max(480, 900 - score * 8);
        return;
      }
    }
  };
  canvas.addEventListener("mousedown", onDown);

  function step(dt: number) {
    spawnIn -= dt;
    if (spawnIn <= 0) {
      popRandom();
      spawnIn = Math.max(320, 720 - score * 6) + Math.random() * 300;
    }
    for (const h of holes) {
      if (!h.kind) {
        h.up = Math.max(0, h.up - dt / 120);
        continue;
      }
      h.timer -= dt;
      h.up = Math.min(1, h.up + dt / 120);
      if (h.timer <= 0) {
        h.kind = null;
      } // retracted un-hit — no penalty
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    for (const h of holes) {
      // Hole.
      g.fillStyle = "#171326";
      g.beginPath();
      g.ellipse(h.x, h.y + 14, R, R * 0.4, 0, 0, Math.PI * 2);
      g.fill();
      if (h.kind && h.up > 0.02) {
        const cy = h.y - h.up * 18;
        g.save();
        g.beginPath();
        g.ellipse(h.x, h.y + 14, R, R * 0.4, 0, 0, Math.PI * 2);
        g.clip();
        if (h.kind === "mole") {
          g.shadowBlur = 12;
          g.shadowColor = "#ff8a3d";
          g.fillStyle = "#c98a5a";
          g.beginPath();
          g.arc(h.x, cy, R * 0.62, 0, Math.PI * 2);
          g.fill();
          g.shadowBlur = 0;
          g.fillStyle = "#0c0a15";
          g.beginPath();
          g.arc(h.x - 14, cy - 6, 4, 0, Math.PI * 2);
          g.arc(h.x + 14, cy - 6, 4, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#ff6f6f";
          g.beginPath();
          g.arc(h.x, cy + 8, 5, 0, Math.PI * 2);
          g.fill();
        } else {
          g.shadowBlur = 14;
          g.shadowColor = "#ff4d6d";
          g.fillStyle = "#20202a";
          g.beginPath();
          g.arc(h.x, cy, R * 0.55, 0, Math.PI * 2);
          g.fill();
          g.shadowBlur = 0;
          g.fillStyle = "#ffe14d";
          g.font = "24px serif";
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText("💣", h.x, cy);
          g.textAlign = "left";
          g.textBaseline = "alphabetic";
        }
        g.restore();
      }
    }
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("whack", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      canvas.removeEventListener("mousedown", onDown);
    },
  };
}
