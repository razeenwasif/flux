// Stack — time the drop (Space / click) so each sliding block lands on the one
// below. The overhang is sliced off, so the tower narrows; miss entirely and
// it's over. Score = blocks stacked.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Block {
  x: number;
  w: number;
  hue: number;
}

const BH = 30; // block height
const CX = W / 2;

export default function stack(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  const placed: Block[] = [{ x: CX - 110, w: 220, hue: 190 }];
  let cur: Block = { x: 40, w: 220, hue: 210 };
  let dir = 1;
  let speed = 0.26;
  let score = 0;
  let over = false;
  let reported = false;

  const drop = () => {
    if (over) return;
    const top = placed[placed.length - 1]!;
    const left = Math.max(cur.x, top.x);
    const right = Math.min(cur.x + cur.w, top.x + top.w);
    const overlap = right - left;
    if (overlap <= 0) {
      over = true;
      return;
    }
    placed.push({ x: left, w: overlap, hue: cur.hue });
    score++;
    ctx.setScore(score);
    speed = Math.min(0.5, speed + 0.012);
    cur = { x: dir > 0 ? -overlap : W, w: overlap, hue: (cur.hue + 24) % 360 };
    dir = -dir;
  };
  const k = keys((key) => {
    if (key === " " || key === "Spacebar" || key === "ArrowUp") drop();
  });
  const onDown = () => drop();
  ctx.canvas.addEventListener("mousedown", onDown);

  // The tower is drawn from the top block downward; as it grows we keep the
  // active block near the vertical middle by offsetting everything.
  function baseY() {
    return H - 90 + Math.max(0, placed.length - 6) * BH;
  }

  function step(dt: number) {
    cur.x += dir * speed * dt;
    if (cur.x < -cur.w + 8) {
      cur.x = -cur.w + 8;
      dir = 1;
    }
    if (cur.x > W - 8) {
      cur.x = W - 8;
      dir = -1;
    }
  }

  function block(b: Block, y: number, glow: boolean) {
    g.shadowBlur = glow ? 16 : 6;
    g.shadowColor = `hsl(${b.hue} 90% 62%)`;
    g.fillStyle = `hsl(${b.hue} 80% 58%)`;
    g.fillRect(b.x, y, b.w, BH - 2);
    g.shadowBlur = 0;
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    const base = baseY();
    for (let i = 0; i < placed.length; i++) block(placed[i]!, base - i * BH, false);
    block(cur, base - placed.length * BH, true);
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.font = "13px ui-monospace, monospace";
    g.fillText("Space / click to drop", 12, 22);
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("stack", score);
      ctx.onGameOver(score);
    }
  });

  return {
    stop() {
      l.stop();
      k.stop();
      ctx.canvas.removeEventListener("mousedown", onDown);
    },
  };
}
