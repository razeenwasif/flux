// Missile Command — click to fire an interceptor; its blast destroys any enemy
// missiles it engulfs. Defend your six cities — lose them all and it's over.
// Each wave comes faster. Score = missiles downed + surviving-city bonus.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

interface Enemy {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
}
interface Shot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
}
interface Boom {
  x: number;
  y: number;
  r: number;
  max: number;
  grow: boolean;
}

const CITY_Y = H - 26;

export default function missile(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const cities = Array.from({ length: 6 }, (_, i) => ({ x: 70 + i * ((W - 140) / 5), alive: true }));
  let enemies: Enemy[] = [];
  let shots: Shot[] = [];
  let booms: Boom[] = [];
  let wave = 1;
  let toSpawn = 6;
  let spawnIn = 600;
  let score = 0;
  let over = false;
  let reported = false;

  const alive = () => cities.filter((c) => c.alive);

  const onDown = (e: MouseEvent) => {
    if (over) return;
    const rect = canvas.getBoundingClientRect();
    const tx = (e.clientX - rect.left) * (W / rect.width);
    const ty = (e.clientY - rect.top) * (H / rect.height);
    const sx = W / 2,
      sy = CITY_Y;
    const d = Math.hypot(tx - sx, ty - sy) || 1;
    shots.push({ x: sx, y: sy, vx: ((tx - sx) / d) * 0.6, vy: ((ty - sy) / d) * 0.6, tx, ty });
  };
  canvas.addEventListener("mousedown", onDown);

  function spawnEnemy() {
    const targets = alive();
    const tx = targets.length ? targets[(Math.random() * targets.length) | 0]!.x : W / 2;
    const x = Math.random() * W;
    const speed = 0.03 + wave * 0.006;
    const d = Math.hypot(tx - x, CITY_Y - 0) || 1;
    enemies.push({ x, y: 0, vx: ((tx - x) / d) * speed, vy: (CITY_Y / d) * speed, tx });
  }

  function step(dt: number) {
    // Spawn the wave.
    if (toSpawn > 0) {
      spawnIn -= dt;
      if (spawnIn <= 0) {
        spawnEnemy();
        toSpawn--;
        spawnIn = Math.max(300, 900 - wave * 40) + Math.random() * 300;
      }
    } else if (!enemies.length) {
      score += alive().length * 25;
      ctx.setScore(score);
      wave++;
      toSpawn = 5 + wave;
      spawnIn = 500;
    }

    for (const s of shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if ((s.vy > 0 ? s.y >= s.ty : s.y <= s.ty) || Math.hypot(s.x - s.tx, s.y - s.ty) < 8) {
        booms.push({ x: s.tx, y: s.ty, r: 0, max: 42, grow: true });
        s.vx = 0;
        s.vy = 0;
        s.ty = -1;
      }
    }
    shots = shots.filter((s) => s.ty >= 0);

    for (const b of booms) {
      if (b.grow) {
        b.r += 0.14 * dt;
        if (b.r >= b.max) b.grow = false;
      } else b.r -= 0.1 * dt;
    }
    booms = booms.filter((b) => b.r > 0);

    for (const en of enemies) {
      en.x += en.vx * dt;
      en.y += en.vy * dt;
    }
    // Blasts destroy enemies.
    enemies = enemies.filter((en) => {
      for (const b of booms)
        if (Math.hypot(en.x - b.x, en.y - b.y) < b.r) {
          score += 25;
          ctx.setScore(score);
          booms.push({ x: en.x, y: en.y, r: 0, max: 30, grow: true });
          return false;
        }
      if (en.y >= CITY_Y) {
        const c = cities.find((c) => c.alive && Math.abs(c.x - en.x) < 26);
        if (c) c.alive = false;
        return false;
      }
      return true;
    });
    if (!alive().length) over = true;
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#171326";
    g.fillRect(0, CITY_Y + 6, W, H - CITY_Y);
    for (const c of cities) {
      g.fillStyle = c.alive ? "#2ff3ff" : "#33303f";
      g.shadowBlur = c.alive ? 8 : 0;
      g.shadowColor = "#2ff3ff";
      g.fillRect(c.x - 16, CITY_Y - 6, 32, 16);
      g.shadowBlur = 0;
    }
    g.fillStyle = "#aefcff";
    g.fillRect(W / 2 - 10, CITY_Y - 2, 20, 12); // base
    for (const en of enemies) {
      g.strokeStyle = "rgba(255,77,109,0.4)";
      g.beginPath();
      g.moveTo(en.tx, 0);
      g.lineTo(en.x, en.y);
      g.stroke();
      g.fillStyle = "#ff4d6d";
      g.beginPath();
      g.arc(en.x, en.y, 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const s of shots) {
      g.strokeStyle = "rgba(174,252,255,0.5)";
      g.beginPath();
      g.moveTo(W / 2, CITY_Y);
      g.lineTo(s.x, s.y);
      g.stroke();
      g.fillStyle = "#fff";
      g.fillRect(s.x - 1, s.y - 1, 3, 3);
    }
    for (const b of booms) {
      g.fillStyle = `hsla(${(b.r * 6) % 360}, 90%, 60%, 0.5)`;
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.textAlign = "right";
    g.fillText(`WAVE ${wave}`, W - 10, 22);
    g.textAlign = "left";
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("missile", score);
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
