// Breakout — bounce the ball to clear the bricks. Move the paddle with the
// mouse or ←/→; press Space (or click) to launch. Clearing every brick respawns
// a faster wall (endless). 3 lives.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Brick {
  x: number;
  y: number;
  alive: boolean;
  color: string;
}

export default function breakout(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const PW = 92;
  const PH = 12;
  const PY = H - 26;
  const R = 7;
  let px = (W - PW) / 2;
  let left = false;
  let right = false;
  let bx = W / 2;
  let by = PY - R - 1;
  let speed = 0.34;
  let bvx = 0;
  let bvy = 0;
  let launched = false;
  let score = 0;
  let lives = 3;
  let over = false;
  let reported = false;

  const COLS = 10;
  const ROWS = 6;
  const BW = 56;
  const BH = 20;
  const GAP = 4;
  const TOP = 54;
  const LEFTX = (W - (COLS * (BW + GAP) - GAP)) / 2;
  const palette = ["#ff4d9d", "#ff8a3d", "#ffe14d", "#5dff8f", "#2ff3ff", "#8a7dff"];
  let bricks: Brick[] = [];
  function buildWall() {
    bricks = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        bricks.push({
          x: LEFTX + c * (BW + GAP),
          y: TOP + r * (BH + GAP),
          alive: true,
          color: palette[r % palette.length]!,
        });
  }
  buildWall();

  function launch() {
    if (!launched && !over) {
      launched = true;
      bvx = speed * 0.55;
      bvy = -speed;
    }
  }
  const k = keys(
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = true;
      else if (key === "ArrowRight" || key === "d") right = true;
      else if (key === " " || key === "Spacebar") launch();
    },
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = false;
      else if (key === "ArrowRight" || key === "d") right = false;
    },
  );
  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    px = Math.max(0, Math.min(W - PW, (e.clientX - rect.left) * (W / rect.width) - PW / 2));
  };
  const onClick = () => launch();
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mousedown", onClick);

  function loseLife() {
    lives--;
    launched = false;
    if (lives <= 0) {
      over = true;
      return;
    }
    bx = px + PW / 2;
    by = PY - R - 1;
  }

  function step(dt: number) {
    if (left) px = Math.max(0, px - 0.6 * dt);
    if (right) px = Math.min(W - PW, px + 0.6 * dt);
    if (!launched) {
      bx = px + PW / 2;
      by = PY - R - 1;
      return;
    }

    bx += bvx * dt;
    by += bvy * dt;
    if (bx < R) {
      bx = R;
      bvx = Math.abs(bvx);
    }
    if (bx > W - R) {
      bx = W - R;
      bvx = -Math.abs(bvx);
    }
    if (by < R) {
      by = R;
      bvy = Math.abs(bvy);
    }
    if (by > H + R) {
      loseLife();
      return;
    }

    // Paddle
    if (by + R >= PY && by - R <= PY + PH && bx >= px && bx <= px + PW && bvy > 0) {
      const hit = (bx - (px + PW / 2)) / (PW / 2); // -1..1
      const sp = Math.hypot(bvx, bvy);
      const ang = hit * 1.05; // steer up to ~60°
      bvx = sp * Math.sin(ang);
      bvy = -Math.abs(sp * Math.cos(ang));
      by = PY - R - 1;
    }
    // Bricks
    for (const b of bricks) {
      if (!b.alive) continue;
      if (bx + R > b.x && bx - R < b.x + BW && by + R > b.y && by - R < b.y + BH) {
        b.alive = false;
        score += 10;
        ctx.setScore(score);
        // Reflect off the nearer axis.
        const overlapX = Math.min(bx + R - b.x, b.x + BW - (bx - R));
        const overlapY = Math.min(by + R - b.y, b.y + BH - (by - R));
        if (overlapX < overlapY) bvx = -bvx;
        else bvy = -bvy;
        break;
      }
    }
    if (bricks.every((b) => !b.alive)) {
      speed = Math.min(speed + 0.05, 0.6);
      launched = false;
      buildWall();
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    for (const b of bricks) {
      if (!b.alive) continue;
      g.shadowBlur = 10;
      g.shadowColor = b.color;
      g.fillStyle = b.color;
      g.fillRect(b.x, b.y, BW, BH);
    }
    g.shadowBlur = 14;
    g.shadowColor = "#2ff3ff";
    g.fillStyle = "#aefcff";
    g.fillRect(px, PY, PW, PH);
    g.beginPath();
    g.arc(bx, by, R, 0, Math.PI * 2);
    g.fillStyle = "#ffffff";
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.fillText("♥".repeat(Math.max(0, lives)), 10, H - 8);
    if (!launched && !over) {
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.font = "16px ui-monospace, monospace";
      g.textAlign = "center";
      g.fillText("Space / click to launch", W / 2, H / 2 + 60);
      g.textAlign = "left";
    }
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("breakout", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onClick);
    },
  };
}
