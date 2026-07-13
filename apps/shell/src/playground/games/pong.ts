// Pong — endless survival. You're the left paddle (mouse or ↑/↓ · W/S). Return
// the ball past the AI to score; the rally speeds up each point. Miss once and
// it's over.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

export default function pong(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const PH = 76;
  const PW = 12;
  const M = 22;
  const R = 8;
  let py = (H - PH) / 2;
  let ay = (H - PH) / 2;
  let up = false;
  let down = false;
  let base = 0.3;
  let bx = W / 2;
  let by = H / 2;
  let bvx = -base;
  let bvy = base * 0.35;
  let score = 0;
  let over = false;
  let reported = false;

  function serve() {
    bx = W / 2;
    by = H / 2;
    const sp = base + score * 0.02;
    bvx = -sp;
    bvy = (Math.random() * 2 - 1) * sp * 0.5;
  }

  const k = keys(
    (key) => {
      if (key === "ArrowUp" || key === "w") up = true;
      else if (key === "ArrowDown" || key === "s") down = true;
    },
    (key) => {
      if (key === "ArrowUp" || key === "w") up = false;
      else if (key === "ArrowDown" || key === "s") down = false;
    },
  );
  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    py = Math.max(0, Math.min(H - PH, ((e.clientY - rect.top) * (H / rect.height)) - PH / 2));
  };
  canvas.addEventListener("mousemove", onMove);

  function step(dt: number) {
    if (up) py = Math.max(0, py - 0.7 * dt);
    if (down) py = Math.min(H - PH, py + 0.7 * dt);

    // AI: track the ball, but with a capped, imperfect speed so it's beatable.
    const target = by - PH / 2;
    const aiSpeed = 0.34 + score * 0.006;
    if (ay + 4 < target) ay = Math.min(H - PH, ay + aiSpeed * dt);
    else if (ay - 4 > target) ay = Math.max(0, ay - aiSpeed * dt);

    bx += bvx * dt;
    by += bvy * dt;
    if (by < R) { by = R; bvy = Math.abs(bvy); }
    if (by > H - R) { by = H - R; bvy = -Math.abs(bvy); }

    // Player paddle.
    if (bvx < 0 && bx - R <= M + PW && bx - R > M - 6 && by >= py && by <= py + PH) {
      const hit = (by - (py + PH / 2)) / (PH / 2);
      const sp = Math.hypot(bvx, bvy) * 1.03;
      bvx = Math.abs(sp * Math.cos(hit * 0.9));
      bvy = sp * Math.sin(hit * 0.9);
    }
    // AI paddle.
    if (bvx > 0 && bx + R >= W - M - PW && bx + R < W - M + 6 && by >= ay && by <= ay + PH) {
      const hit = (by - (ay + PH / 2)) / (PH / 2);
      const sp = Math.hypot(bvx, bvy);
      bvx = -Math.abs(sp * Math.cos(hit * 0.9));
      bvy = sp * Math.sin(hit * 0.9);
    }

    if (bx > W) { score++; ctx.setScore(score); serve(); }
    if (bx < -R) { over = true; }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.setLineDash([8, 12]);
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.stroke();
    g.setLineDash([]);
    g.shadowBlur = 12;
    g.shadowColor = "#2ff3ff";
    g.fillStyle = "#aefcff";
    g.fillRect(M, py, PW, PH);
    g.shadowColor = "#ff4d9d";
    g.fillStyle = "#ff9ac6";
    g.fillRect(W - M - PW, ay, PW, PH);
    g.shadowColor = "#ffffff";
    g.beginPath();
    g.arc(bx, by, R, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    g.shadowBlur = 0;
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("pong", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
      canvas.removeEventListener("mousemove", onMove);
    },
  };
}
