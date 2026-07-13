// Snake — grid-stepped classic. Arrows/WASD steer; eat food to grow, don't hit
// the walls or yourself. Speeds up as you eat.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

const CELL = 20;
const COLS = W / CELL; // 32
const ROWS = H / CELL; // 24

export default function snake(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  let body = [{ x: 8, y: 12 }, { x: 7, y: 12 }, { x: 6, y: 12 }];
  let dir = { x: 1, y: 0 };
  let next = { x: 1, y: 0 };
  let food = spawn();
  let score = 0;
  let over = false;
  let reported = false;
  let acc = 0;
  let step = 120;

  function spawn() {
    for (;;) {
      const f = { x: (Math.random() * COLS) | 0, y: (Math.random() * ROWS) | 0 };
      if (!body.some((s) => s.x === f.x && s.y === f.y)) return f;
    }
  }

  const k = keys((key) => {
    if ((key === "ArrowUp" || key === "w") && dir.y === 0) next = { x: 0, y: -1 };
    else if ((key === "ArrowDown" || key === "s") && dir.y === 0) next = { x: 0, y: 1 };
    else if ((key === "ArrowLeft" || key === "a") && dir.x === 0) next = { x: -1, y: 0 };
    else if ((key === "ArrowRight" || key === "d") && dir.x === 0) next = { x: 1, y: 0 };
  });

  function tick() {
    dir = next;
    const h0 = body[0]!;
    const head = { x: h0.x + dir.x, y: h0.y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS || body.some((s) => s.x === head.x && s.y === head.y)) {
      over = true;
      return;
    }
    body.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 10;
      ctx.setScore(score);
      food = spawn();
      if (step > 60) step -= 3;
    } else {
      body.pop();
    }
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,0.04)";
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) g.fillRect(x * CELL + CELL / 2 - 1, y * CELL + CELL / 2 - 1, 2, 2);
    g.shadowBlur = 16;
    g.shadowColor = "#ff4d9d";
    g.fillStyle = "#ff4d9d";
    g.fillRect(food.x * CELL + 3, food.y * CELL + 3, CELL - 6, CELL - 6);
    g.shadowColor = "#2ff3ff";
    body.forEach((s, i) => {
      g.fillStyle = i === 0 ? "#aefcff" : "#2ff3ff";
      g.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
    });
    g.shadowBlur = 0;
  }

  const l = loop((dt) => {
    if (!over) {
      acc += dt;
      while (acc >= step) {
        acc -= step;
        tick();
        if (over) break;
      }
    }
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("snake", score);
      ctx.onGameOver(score);
    }
  });

  return { stop() { l.stop(); k.stop(); } };
}
