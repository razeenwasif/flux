// Playground (BACKLOG #133) — the shared contract every game implements, plus
// local high-score storage. Games are plain <canvas> + requestAnimationFrame
// engines (no framework), so they stay self-contained and offline. The harness
// (Playground.tsx) owns the canvas, mounts one engine at a time, and tears it
// down via the returned handle. Online leaderboards are a later layer that will
// wrap `saveHighScore`.

export interface GameCtx {
  /** The 640×480 canvas the game draws into (fixed internal resolution). */
  canvas: HTMLCanvasElement;
  /** Report the live score (drives the HUD). */
  setScore: (n: number) => void;
  /** Called once when the run ends, with the final score. */
  onGameOver: (finalScore: number) => void;
}

export interface GameHandle {
  /** Cancel the loop and remove every listener. Must be idempotent. */
  stop(): void;
}

export type GameEngine = (ctx: GameCtx) => GameHandle;

/** The fixed internal resolution every game draws to; CSS scales it to the pane. */
export const W = 640;
export const H = 480;

const hiKey = (id: string) => `flux.playground.hi.${id}`;

export function highScore(id: string): number {
  const v = Number(localStorage.getItem(hiKey(id)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Persist `score` if it beats the stored best. Returns true if it's a new record. */
export function saveHighScore(id: string, score: number): boolean {
  if (score > highScore(id)) {
    try { localStorage.setItem(hiKey(id), String(Math.floor(score))); } catch { /* private mode */ }
    return true;
  }
  return false;
}

/** A small rAF loop helper: calls `frame(dtMs)` until `stop()`. */
export function loop(frame: (dt: number) => void): { stop(): void } {
  let raf = 0;
  let last = performance.now();
  let alive = true;
  const tick = (now: number) => {
    if (!alive) return;
    const dt = Math.min(now - last, 50); // clamp huge gaps (tab was hidden)
    last = now;
    frame(dt);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop() { alive = false; cancelAnimationFrame(raf); } };
}

/** Standard key handler wiring that swallows arrows/space (so the pane never scrolls). */
export function keys(onDown: (k: string) => void, onUp?: (k: string) => void): { stop(): void } {
  const swallow = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Spacebar"]);
  const down = (e: KeyboardEvent) => {
    if (swallow.has(e.key)) e.preventDefault();
    onDown(e.key);
  };
  const up = (e: KeyboardEvent) => onUp?.(e.key);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  return { stop() { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); } };
}
