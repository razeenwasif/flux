// Asteroids — rotate with ←/→, thrust with ↑, fire with Space. Blast the rocks;
// big ones split into smaller, faster ones. Everything wraps around the edges.
// Clear a wave and a bigger one arrives. 3 lives.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  size: number;
  spin: number;
  a: number;
  verts: number[];
}
interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const RSIZE = [0, 14, 26, 44]; // radius by size (1=small … 3=large)
const RSCORE = [0, 100, 50, 20];

export default function asteroids(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const ship = { x: W / 2, y: H / 2, a: -Math.PI / 2, vx: 0, vy: 0 };
  let left = false,
    right = false,
    thrust = false;
  let fire = false,
    fireCool = 0;
  let rocks: Rock[] = [];
  let bullets: Bullet[] = [];
  let score = 0,
    lives = 3,
    wave = 1,
    invuln = 0;
  let over = false,
    reported = false;

  const wrap = (v: number, max: number) => (v < 0 ? v + max : v >= max ? v - max : v);

  function makeRock(x: number, y: number, size: number): Rock {
    const speed = 0.05 + Math.random() * 0.06 + wave * 0.008;
    const dir = Math.random() * Math.PI * 2;
    const verts = Array.from({ length: 10 }, () => 0.7 + Math.random() * 0.5);
    return {
      x,
      y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      r: RSIZE[size]!,
      size,
      spin: (Math.random() - 0.5) * 0.003,
      a: 0,
      verts,
    };
  }
  function spawnWave() {
    rocks = [];
    const n = 3 + wave;
    for (let i = 0; i < n; i++) {
      // Spawn at edges, away from the ship's centre.
      const edge = Math.random() < 0.5;
      const x = edge ? (Math.random() < 0.5 ? 0 : W) : Math.random() * W;
      const y = edge ? Math.random() * H : Math.random() < 0.5 ? 0 : H;
      rocks.push(makeRock(x, y, 3));
    }
  }
  spawnWave();

  const k = keys(
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = true;
      else if (key === "ArrowRight" || key === "d") right = true;
      else if (key === "ArrowUp" || key === "w") thrust = true;
      else if (key === " " || key === "Spacebar") fire = true;
    },
    (key) => {
      if (key === "ArrowLeft" || key === "a") left = false;
      else if (key === "ArrowRight" || key === "d") right = false;
      else if (key === "ArrowUp" || key === "w") thrust = false;
      else if (key === " " || key === "Spacebar") fire = false;
    },
  );

  function hitShip() {
    lives--;
    invuln = 2000;
    ship.x = W / 2;
    ship.y = H / 2;
    ship.vx = 0;
    ship.vy = 0;
    ship.a = -Math.PI / 2;
    if (lives <= 0) over = true;
  }

  function step(dt: number) {
    if (left) ship.a -= 0.005 * dt;
    if (right) ship.a += 0.005 * dt;
    if (thrust) {
      ship.vx += Math.cos(ship.a) * 0.0004 * dt;
      ship.vy += Math.sin(ship.a) * 0.0004 * dt;
    }
    const drag = Math.pow(0.9992, dt);
    ship.vx *= drag;
    ship.vy *= drag;
    ship.x = wrap(ship.x + ship.vx * dt, W);
    ship.y = wrap(ship.y + ship.vy * dt, H);
    if (invuln > 0) invuln -= dt;

    fireCool -= dt;
    if (fire && fireCool <= 0) {
      fireCool = 260;
      bullets.push({
        x: ship.x + Math.cos(ship.a) * 14,
        y: ship.y + Math.sin(ship.a) * 14,
        vx: ship.vx + Math.cos(ship.a) * 0.5,
        vy: ship.vy + Math.sin(ship.a) * 0.5,
        life: 800,
      });
    }
    for (const b of bullets) {
      b.x = wrap(b.x + b.vx * dt, W);
      b.y = wrap(b.y + b.vy * dt, H);
      b.life -= dt;
    }
    bullets = bullets.filter((b) => b.life > 0);

    for (const r of rocks) {
      r.x = wrap(r.x + r.vx * dt, W);
      r.y = wrap(r.y + r.vy * dt, H);
      r.a += r.spin * dt;
    }

    // Bullet vs rock.
    const fresh: Rock[] = [];
    for (const r of rocks) {
      let hit = false;
      for (const b of bullets) {
        if (b.life > 0 && Math.hypot(b.x - r.x, b.y - r.y) < r.r) {
          b.life = 0;
          hit = true;
          score += RSCORE[r.size]!;
          ctx.setScore(score);
          break;
        }
      }
      if (!hit) fresh.push(r);
      else if (r.size > 1) {
        fresh.push(makeRock(r.x, r.y, r.size - 1), makeRock(r.x, r.y, r.size - 1));
      }
    }
    rocks = fresh;
    bullets = bullets.filter((b) => b.life > 0);

    // Ship vs rock.
    if (invuln <= 0) {
      for (const r of rocks)
        if (Math.hypot(ship.x - r.x, ship.y - r.y) < r.r + 10) {
          hitShip();
          break;
        }
    }
    if (rocks.length === 0) {
      wave++;
      spawnWave();
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    // Rocks.
    g.strokeStyle = "#c8c2ff";
    g.lineWidth = 1.5;
    g.shadowBlur = 6;
    g.shadowColor = "#8a7dff";
    for (const r of rocks) {
      g.beginPath();
      for (let i = 0; i < r.verts.length; i++) {
        const ang = r.a + (i / r.verts.length) * Math.PI * 2;
        const rad = r.r * r.verts[i]!;
        const px = r.x + Math.cos(ang) * rad,
          py = r.y + Math.sin(ang) * rad;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
    // Bullets.
    g.shadowColor = "#ffe14d";
    g.fillStyle = "#ffe14d";
    for (const b of bullets) {
      g.beginPath();
      g.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    // Ship (blink while invulnerable).
    if (!(invuln > 0 && Math.floor(invuln / 120) % 2 === 0)) {
      g.strokeStyle = "#aefcff";
      g.shadowColor = "#2ff3ff";
      g.save();
      g.translate(ship.x, ship.y);
      g.rotate(ship.a);
      g.beginPath();
      g.moveTo(15, 0);
      g.lineTo(-10, -9);
      g.lineTo(-5, 0);
      g.lineTo(-10, 9);
      g.closePath();
      g.stroke();
      if (thrust) {
        g.beginPath();
        g.moveTo(-6, -4);
        g.lineTo(-16, 0);
        g.lineTo(-6, 4);
        g.stroke();
      }
      g.restore();
    }
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.fillText("▲".repeat(Math.max(0, lives)), 10, H - 10);
    g.textAlign = "right";
    g.fillText(`WAVE ${wave}`, W - 10, H - 10);
    g.textAlign = "left";
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("asteroids", score);
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
