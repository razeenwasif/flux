// Flappy — tap Space / ↑ / click to flap; thread the gaps between the pipes.
// One touch and it's over. Endless, nudges faster as you go.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Pipe { x: number; gap: number; passed: boolean }

export default function flappy(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const BIRD_X = 168;
  const R = 12;
  const GROUND = H - 28;
  const PIPE_W = 62;
  const GAP_H = 158;
  const SPACING = 250;
  const GRAVITY = 0.0021;
  const FLAP_V = -0.62;

  let y = H / 2;
  let vy = 0;
  let wingT = 0;
  let speed = 0.2;
  let pipes: Pipe[] = [];
  let score = 0;
  let started = false;
  let over = false;
  let reported = false;

  function newGap(): number {
    const margin = 46;
    return margin + Math.random() * (GROUND - GAP_H - margin * 2);
  }
  pipes.push({ x: W + 120, gap: newGap(), passed: false });

  const flap = () => {
    if (over) return;
    started = true;
    vy = FLAP_V;
    wingT = 120;
  };
  const k = keys((key) => { if (key === " " || key === "Spacebar" || key === "ArrowUp" || key === "w") flap(); });
  const onDown = () => flap();
  canvas.addEventListener("mousedown", onDown);

  function step(dt: number) {
    wingT = Math.max(0, wingT - dt);
    if (!started) return;
    vy += GRAVITY * dt;
    y += vy * dt;

    for (const p of pipes) p.x -= speed * dt;
    const last = pipes[pipes.length - 1];
    if (!last || last.x < W - SPACING) pipes.push({ x: W, gap: newGap(), passed: false });
    pipes = pipes.filter((p) => p.x > -PIPE_W);

    for (const p of pipes) {
      if (!p.passed && p.x + PIPE_W < BIRD_X) {
        p.passed = true;
        score++;
        ctx.setScore(score);
        speed = Math.min(speed + 0.006, 0.42);
      }
      if (BIRD_X + R > p.x && BIRD_X - R < p.x + PIPE_W && (y - R < p.gap || y + R > p.gap + GAP_H)) over = true;
    }
    if (y + R > GROUND || y - R < 0) { y = Math.min(y, GROUND - R); over = true; }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    // Pipes.
    for (const p of pipes) {
      g.shadowBlur = 10;
      g.shadowColor = "#5dff8f";
      g.fillStyle = "#3ddc78";
      g.fillRect(p.x, 0, PIPE_W, p.gap);
      g.fillRect(p.x, p.gap + GAP_H, PIPE_W, GROUND - (p.gap + GAP_H));
      g.shadowBlur = 0;
      g.fillStyle = "#5dff8f";
      g.fillRect(p.x - 3, p.gap - 14, PIPE_W + 6, 14);
      g.fillRect(p.x - 3, p.gap + GAP_H, PIPE_W + 6, 14);
    }
    // Ground.
    g.fillStyle = "#171326";
    g.fillRect(0, GROUND, W, H - GROUND);
    g.fillStyle = "rgba(255,255,255,0.06)";
    for (let x = 0; x < W; x += 24) g.fillRect(x, GROUND, 12, 4);
    // Bird.
    const tilt = Math.max(-0.5, Math.min(1, vy * 1.2));
    g.save();
    g.translate(BIRD_X, y);
    g.rotate(tilt);
    g.shadowBlur = 14;
    g.shadowColor = "#ffe14d";
    g.fillStyle = "#ffe14d";
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = "#ff8a3d"; // wing
    g.fillRect(-6, wingT > 0 ? 2 : -8, 12, 6);
    g.fillStyle = "#0c0a15"; // eye
    g.beginPath();
    g.arc(5, -4, 2.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ff8a3d"; // beak
    g.fillRect(R - 2, -2, 7, 4);
    g.restore();

    if (!started && !over) {
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.font = "16px ui-monospace, monospace";
      g.textAlign = "center";
      g.fillText("Space / click to flap", W / 2, H / 2 + 70);
      g.textAlign = "left";
    }
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("flappy", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
      canvas.removeEventListener("mousedown", onDown);
    },
  };
}
