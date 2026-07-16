// Frogger — hop with the arrows across the traffic and the river to the top
// bank. On the road a car is death; on the river you must ride the logs (or you
// drown). Each crossing scores and speeds things up. 3 lives.
import { type GameCtx, type GameHandle, W, H, loop, keys, saveHighScore } from "../engine";

interface Item {
  x: number;
  w: number;
}
interface Lane {
  row: number;
  type: "road" | "river";
  dir: number;
  speed: number;
  items: Item[];
  color: string;
}

const CELL = 40;
const COLS = W / CELL; // 16
const ROWS = H / CELL; // 12
const START_ROW = 11;
const GOAL_ROW = 1;

export default function frogger(ctx: GameCtx): GameHandle {
  const g = ctx.canvas.getContext("2d")!;
  let fx = (COLS >> 1) * CELL;
  let frow = START_ROW;
  let best = START_ROW;
  let lives = 3;
  let crossings = 0;
  let score = 0;
  let over = false;
  let reported = false;
  let speedMul = 1;

  const lanes: Lane[] = [];
  function buildLanes() {
    lanes.length = 0;
    const carColors = ["#ff6f6f", "#ffe14d", "#5b8cff", "#ff8a3d"];
    // River: rows 2..5 (logs). Road: rows 7..10 (cars).
    for (let r = 2; r <= 5; r++)
      lanes.push({
        row: r,
        type: "river",
        dir: r % 2 ? 1 : -1,
        speed: (0.06 + Math.random() * 0.04) * speedMul,
        items: spread(2.6 + Math.random() * 1.4, 150),
        color: "#8a5a2b",
      });
    for (let r = 7; r <= 10; r++)
      lanes.push({
        row: r,
        type: "road",
        dir: r % 2 ? -1 : 1,
        speed: (0.09 + Math.random() * 0.06) * speedMul,
        items: spread(1.4, 130 + Math.random() * 80),
        color: carColors[(r - 7) % carColors.length]!,
      });
  }
  function spread(wCells: number, gap: number): Item[] {
    const w = wCells * CELL;
    const items: Item[] = [];
    for (let x = -w; x < W + w; x += w + gap) items.push({ x, w });
    return items;
  }
  buildLanes();

  const laneAt = (row: number) => lanes.find((l) => l.row === row);

  const k = keys((key) => {
    if (over) return;
    if (key === "ArrowUp" || key === "w") frow = Math.max(0, frow - 1);
    else if (key === "ArrowDown" || key === "s") frow = Math.min(START_ROW, frow + 1);
    else if (key === "ArrowLeft" || key === "a") fx = Math.max(0, fx - CELL);
    else if (key === "ArrowRight" || key === "d") fx = Math.min(W - CELL, fx + CELL);
    if (frow < best) best = frow;
    if (frow <= GOAL_ROW) cross();
  });

  function cross() {
    crossings++;
    score += 100 + (START_ROW - best) * 5;
    ctx.setScore(score);
    speedMul = Math.min(2.2, speedMul + 0.12);
    buildLanes();
    reset();
  }
  function reset() {
    fx = (COLS >> 1) * CELL;
    frow = START_ROW;
    best = START_ROW;
  }
  function die() {
    lives--;
    if (lives <= 0) over = true;
    else reset();
  }

  function step(dt: number) {
    for (const lane of lanes) {
      for (const it of lane.items) {
        it.x += lane.dir * lane.speed * dt;
        if (lane.dir > 0 && it.x > W) it.x = -it.w;
        if (lane.dir < 0 && it.x < -it.w) it.x = W;
      }
    }
    const lane = laneAt(frow);
    if (!lane) return; // safe row
    const fl = fx + 6,
      fr = fx + CELL - 6;
    if (lane.type === "road") {
      for (const it of lane.items)
        if (fr > it.x && fl < it.x + it.w) {
          die();
          return;
        }
    } else {
      const log = lane.items.find((it) => fx + CELL / 2 > it.x && fx + CELL / 2 < it.x + it.w);
      if (!log) {
        die();
        return;
      }
      fx += lane.dir * lane.speed * dt;
      if (fx < -6 || fx > W - CELL + 6) {
        die();
        return;
      }
    }
  }

  function draw() {
    // Zones.
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#0f2a4a";
    g.fillRect(0, 2 * CELL, W, 4 * CELL); // river
    g.fillStyle = "#141018";
    g.fillRect(0, 7 * CELL, W, 4 * CELL); // road
    g.fillStyle = "#1c3a1c";
    g.fillRect(0, GOAL_ROW * CELL, W, CELL); // goal bank
    g.fillStyle = "#1c3a1c";
    g.fillRect(0, START_ROW * CELL, W, CELL); // start bank
    g.fillStyle = "#26301c";
    g.fillRect(0, 6 * CELL, W, CELL); // median
    for (const lane of lanes) {
      const y = lane.row * CELL;
      for (const it of lane.items) {
        if (lane.type === "river") {
          g.fillStyle = "#8a5a2b";
          g.fillRect(it.x, y + 6, it.w, CELL - 12);
        } else {
          g.shadowBlur = 8;
          g.shadowColor = lane.color;
          g.fillStyle = lane.color;
          g.fillRect(it.x, y + 7, it.w, CELL - 14);
          g.shadowBlur = 0;
        }
      }
    }
    // Frog.
    g.shadowBlur = 12;
    g.shadowColor = "#5dff8f";
    g.fillStyle = "#7dff9d";
    g.beginPath();
    g.arc(fx + CELL / 2, frow * CELL + CELL / 2, CELL / 2 - 6, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = "#0c0a15";
    g.fillRect(fx + 12, frow * CELL + 12, 4, 4);
    g.fillRect(fx + CELL - 16, frow * CELL + 12, 4, 4);
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "14px ui-monospace, monospace";
    g.fillText("🐸".repeat(Math.max(0, lives)), 8, H - 12);
  }

  const l = loop((dt) => {
    if (!over) step(dt);
    draw();
    if (over && !reported) {
      reported = true;
      saveHighScore("frogger", score);
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
