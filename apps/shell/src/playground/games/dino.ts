// Dino Run — the offline-page runner. Space/↑ to jump, ↓ to duck. Clear the
// cacti and the birds; it just gets faster. Score = distance.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Obstacle {
  x: number;
  kind: "cactus" | "bird";
  w: number;
  h: number;
  y: number;
}

export default function dino(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const GROUND = H - 64;
  const DINO_X = 76;
  const GRAV = 0.0032;
  const JUMP = -1.02;
  let y = GROUND;
  let vy = 0;
  let ducking = false;
  let obstacles: Obstacle[] = [];
  let speed = 0.36;
  let spawnIn = 700;
  let score = 0;
  let over = false;
  let reported = false;
  let legT = 0;

  const onGround = () => y >= GROUND - 0.5;
  const jump = () => {
    if (!over && onGround()) vy = JUMP;
  };
  const k = keys(
    (key) => {
      if (key === " " || key === "Spacebar" || key === "ArrowUp" || key === "w") jump();
      else if (key === "ArrowDown" || key === "s") ducking = true;
    },
    (key) => {
      if (key === "ArrowDown" || key === "s") ducking = false;
    },
  );

  function dinoBox() {
    const h = ducking && onGround() ? 26 : 46;
    const w = ducking && onGround() ? 58 : 42;
    return { x: DINO_X, y: y - h, w, h };
  }

  function spawn() {
    if (Math.random() < 0.7)
      obstacles.push({ x: W, kind: "cactus", w: 16 + ((Math.random() * 3) | 0) * 10, h: 34, y: GROUND - 34 });
    else obstacles.push({ x: W, kind: "bird", w: 34, h: 24, y: GROUND - (Math.random() < 0.5 ? 30 : 66) });
  }

  function step(dt: number) {
    legT += dt;
    vy += GRAV * dt;
    y = Math.min(GROUND, y + vy * dt);
    if (ducking && !onGround()) vy += GRAV * dt; // dive faster when ducking mid-air

    speed = Math.min(0.9, speed + dt * 0.00002);
    score += dt * speed * 0.05;
    ctx.setScore(Math.floor(score));

    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = (620 + Math.random() * 520) / (speed / 0.36);
    }
    for (const o of obstacles) o.x -= speed * dt;
    obstacles = obstacles.filter((o) => o.x + o.w > -4);

    const d = dinoBox();
    for (const o of obstacles) {
      if (d.x < o.x + o.w - 6 && d.x + d.w - 6 > o.x && d.y < o.y + o.h - 4 && d.y + d.h > o.y + 4) {
        over = true;
        break;
      }
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.18)";
    g.beginPath();
    g.moveTo(0, GROUND);
    g.lineTo(W, GROUND);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,0.06)";
    for (let x = (-score * 4) % 40; x < W; x += 40) g.fillRect(x, GROUND + 8, 14, 3);

    const d = dinoBox();
    g.shadowBlur = 12;
    g.shadowColor = "#2ff3ff";
    g.fillStyle = "#aefcff";
    g.fillRect(d.x, d.y, d.w, d.h);
    g.shadowBlur = 0;
    g.fillStyle = "#0c0a15";
    g.fillRect(d.x + d.w - 12, d.y + 5, 4, 4); // eye
    if (onGround()) {
      const up = Math.floor(legT / 90) % 2 === 0;
      g.fillStyle = "#2ff3ff";
      g.fillRect(d.x + 4, d.y + d.h, 6, up ? 6 : 3);
      g.fillRect(d.x + d.w - 14, d.y + d.h, 6, up ? 3 : 6);
    }

    for (const o of obstacles) {
      g.shadowBlur = 8;
      if (o.kind === "cactus") {
        g.shadowColor = "#5dff8f";
        g.fillStyle = "#3ddc78";
        g.fillRect(o.x, o.y, o.w, o.h);
      } else {
        g.shadowColor = "#ff8a3d";
        g.fillStyle = "#ff8a3d";
        const flap = Math.floor(legT / 130) % 2 === 0;
        g.fillRect(o.x, o.y + 8, o.w, 8);
        g.fillRect(o.x + 6, flap ? o.y : o.y + 14, o.w - 14, 6);
      }
    }
    g.shadowBlur = 0;
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("dino", Math.floor(score));
      ctx.onGameOver(Math.floor(score));
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
    },
  };
}
