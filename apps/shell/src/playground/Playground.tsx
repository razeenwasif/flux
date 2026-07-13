// Playground (BACKLOG #133) — an offline arcade. A neon hub of classic games;
// pick one and it mounts onto a single <canvas> via the shared engine contract.
// High scores are local (localStorage) — online leaderboards are a later layer.
import { type Component, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { type GameEngine, type GameHandle, W, H, highScore, saveHighScore } from "./engine";
import snake from "./games/snake";
import tetris from "./games/tetris";
import breakout from "./games/breakout";
import pong from "./games/pong";
import invaders from "./games/invaders";
import flappy from "./games/flappy";
import asteroids from "./games/asteroids";
import game2048 from "./games/game2048";
import minesweeper from "./games/minesweeper";

interface Meta {
  id: string;
  name: string;
  glyph: string;
  tagline: string;
  controls: string;
  accent: string;
  engine: GameEngine;
}

const GAMES: Meta[] = [
  { id: "snake", name: "Snake", glyph: "🐍", tagline: "Eat, grow, don't bite yourself.", controls: "Arrows / WASD to steer", accent: "#2ff3ff", engine: snake },
  { id: "tetris", name: "Tetris", glyph: "🟪", tagline: "Stack the falling blocks, clear lines.", controls: "← → move · ↑ rotate · ↓ soft · Space drop", accent: "#b07dff", engine: tetris },
  { id: "breakout", name: "Breakout", glyph: "🧱", tagline: "Smash every brick, don't drop the ball.", controls: "Mouse / ← → · Space to launch", accent: "#ff8a3d", engine: breakout },
  { id: "pong", name: "Pong", glyph: "🏓", tagline: "Rally against the machine, endlessly.", controls: "Mouse / ↑ ↓ · W S", accent: "#5dff8f", engine: pong },
  { id: "invaders", name: "Invaders", glyph: "👾", tagline: "Hold the line against the fleet.", controls: "← → move · Space to fire", accent: "#ff4d9d", engine: invaders },
  { id: "flappy", name: "Flappy", glyph: "🐤", tagline: "Flap through the gaps, don't touch.", controls: "Space / ↑ / click to flap", accent: "#ffe14d", engine: flappy },
  { id: "asteroids", name: "Asteroids", glyph: "🚀", tagline: "Blast the rocks, mind the split.", controls: "← → rotate · ↑ thrust · Space fire", accent: "#c8c2ff", engine: asteroids },
  { id: "2048", name: "2048", glyph: "🔢", tagline: "Slide and merge to the big tile.", controls: "Arrows / WASD to slide", accent: "#5dff8f", engine: game2048 },
  { id: "minesweeper", name: "Minesweeper", glyph: "💣", tagline: "Clear the field, flag the mines.", controls: "Left reveal · Right flag", accent: "#ff6f6f", engine: minesweeper },
];

const Playground: Component<{ onClose: () => void }> = (props) => {
  const [game, setGame] = createSignal<Meta | null>(null);
  const [runId, setRunId] = createSignal(0);
  const [score, setScore] = createSignal(0);
  const [result, setResult] = createSignal<{ score: number; record: boolean } | null>(null);
  let canvasRef: HTMLCanvasElement | undefined;
  let handle: GameHandle | null = null;

  const play = (m: Meta) => { setResult(null); setScore(0); setGame(m); setRunId((n) => n + 1); };
  const restart = () => { setResult(null); setScore(0); setRunId((n) => n + 1); };
  const toHub = () => { setResult(null); setGame(null); };

  // (Re)mount the engine whenever the chosen game or run id changes.
  createEffect(() => {
    const m = game();
    const rid = runId(); // dependency: restart re-runs with the same game
    handle?.stop();
    handle = null;
    if (!m) return;
    // Defer until the <Show> has rendered the canvas for this run. Bail if a
    // newer run superseded this one (rapid restart) so we never leak a loop.
    queueMicrotask(() => {
      if (!canvasRef || game() !== m || runId() !== rid) return;
      handle?.stop();
      handle = m.engine({
        canvas: canvasRef,
        setScore,
        onGameOver: (final) => {
          const record = saveHighScore(m.id, final);
          handle?.stop();
          handle = null;
          setResult({ score: final, record });
        },
      });
    });
  });

  onMount(() => {
    // Esc steps back: game → hub → close the pane. Capture so it beats the
    // games' own key handlers and the chrome's global shortcuts.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (game()) toHub();
      else props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  onCleanup(() => { handle?.stop(); handle = null; });

  const best = () => Math.max(score(), highScore(game()!.id));

  return (
    <div class="pg-root">
      <Show
        when={game()}
        fallback={
          <div class="pg-hub">
            <div class="pg-hub-head">
              <h1 class="pg-title">Playground</h1>
              <p class="pg-sub">Offline arcade · {GAMES.length} classics · your scores stay on this device</p>
            </div>
            <div class="pg-grid">
              <For each={GAMES}>
                {(m) => (
                  <button class="pg-card" style={{ "--accent": m.accent }} onClick={() => play(m)}>
                    <span class="pg-card-glyph">{m.glyph}</span>
                    <span class="pg-card-name">{m.name}</span>
                    <span class="pg-card-tag">{m.tagline}</span>
                    <span class="pg-card-hi">{highScore(m.id) > 0 ? `HI ${highScore(m.id)}` : "NEW"}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        }
      >
        <div class="pg-play" style={{ "--accent": game()!.accent }}>
          <div class="pg-hud">
            <button class="pg-hud-btn" onClick={toHub}>← Arcade</button>
            <span class="pg-hud-name">{game()!.glyph} {game()!.name}</span>
            <span class="pg-hud-stat">SCORE <b>{score()}</b></span>
            <span class="pg-hud-stat">BEST <b>{best()}</b></span>
            <button class="pg-hud-btn" onClick={restart}>↻ Restart</button>
          </div>
          <div class="pg-stage">
            <canvas ref={canvasRef} width={W} height={H} class="pg-canvas" />
            <Show when={result()}>
              <div class="pg-over">
                <div class="pg-over-card">
                  <Show when={result()!.record}>
                    <span class="pg-record">★ NEW RECORD</span>
                  </Show>
                  <div class="pg-over-label">GAME OVER</div>
                  <div class="pg-over-score">{result()!.score}</div>
                  <div class="pg-over-sub">best {highScore(game()!.id)}</div>
                  <div class="pg-over-btns">
                    <button class="pg-btn primary" onClick={restart}>Play again</button>
                    <button class="pg-btn" onClick={toHub}>Arcade</button>
                  </div>
                </div>
              </div>
            </Show>
          </div>
          <div class="pg-hint">{game()!.controls} · Esc to go back</div>
        </div>
      </Show>
    </div>
  );
};

export default Playground;
