// Simon — watch the pattern light up, then repeat it by clicking the pads. Each
// round adds one step. One wrong pad ends it. Score = rounds completed.
import { type GameCtx, type GameHandle, W, H, loop, saveHighScore } from "../engine";

interface Pad { color: string; lit: string; freq: number; x: number; y: number }

export default function simon(ctx: GameCtx): GameHandle {
  const canvas = ctx.canvas;
  const g = canvas.getContext("2d")!;
  const CX = W / 2;
  const CY = H / 2;
  const RO = 168; // outer radius
  const RI = 58; // inner radius
  const pads: Pad[] = [
    { color: "#1f6b3a", lit: "#5dff8f", freq: 329.6, x: -1, y: -1 },
    { color: "#7a1f2b", lit: "#ff6f6f", freq: 261.6, x: 1, y: -1 },
    { color: "#7a5a12", lit: "#ffe14d", freq: 220.0, x: -1, y: 1 },
    { color: "#1f3a7a", lit: "#5b8cff", freq: 164.8, x: 1, y: 1 },
  ];

  let seq: number[] = [];
  let inputAt = 0;
  let phase: "show" | "input" | "over" = "show";
  let showIdx = 0;
  let showTimer = 0;
  let lit = -1;
  let score = 0;
  let reported = false;

  let actx: AudioContext | null = null;
  function tone(freq: number, ms: number) {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      actx = actx || new Ctx();
      const o = actx.createOscillator();
      const gain = actx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(gain); gain.connect(actx.destination);
      const t = actx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.start(t); o.stop(t + ms / 1000 + 0.02);
    } catch { /* audio blocked */ }
  }

  function nextRound() {
    seq.push((Math.random() * 4) | 0);
    phase = "show";
    showIdx = 0;
    showTimer = 500;
    lit = -1;
  }
  nextRound();

  function flash(i: number, ms = 320) { lit = i; tone(pads[i]!.freq, ms); window.setTimeout(() => { if (lit === i) lit = -1; }, ms); }

  const onDown = (e: MouseEvent) => {
    if (phase !== "input") return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width) - CX;
    const my = (e.clientY - rect.top) * (H / rect.height) - CY;
    const dist = Math.hypot(mx, my);
    if (dist < RI || dist > RO) return;
    const i = (my < 0 ? 0 : 2) + (mx < 0 ? 0 : 1);
    flash(i);
    if (seq[inputAt] === i) {
      inputAt++;
      if (inputAt >= seq.length) { score++; ctx.setScore(score); inputAt = 0; window.setTimeout(nextRound, 650); phase = "show"; showTimer = 650; showIdx = 0; }
    } else { phase = "over"; }
  };
  canvas.addEventListener("mousedown", onDown);

  function step(dt: number) {
    if (phase !== "show") return;
    showTimer -= dt;
    if (showTimer <= 0) {
      if (showIdx < seq.length) { flash(seq[showIdx]!, 340); showIdx++; showTimer = 560; }
      else { phase = "input"; inputAt = 0; }
    }
  }

  function padPath(p: Pad) {
    const start = p.x < 0 && p.y < 0 ? Math.PI : p.x > 0 && p.y < 0 ? -Math.PI / 2 : p.x < 0 && p.y > 0 ? Math.PI / 2 : 0;
    g.beginPath();
    g.arc(CX, CY, RO, start, start + Math.PI / 2);
    g.arc(CX, CY, RI, start + Math.PI / 2, start, true);
    g.closePath();
  }

  function draw() {
    g.fillStyle = "#0c0a15";
    g.fillRect(0, 0, W, H);
    pads.forEach((p, i) => {
      padPath(p);
      g.fillStyle = lit === i ? p.lit : p.color;
      if (lit === i) { g.shadowBlur = 24; g.shadowColor = p.lit; }
      g.fill();
      g.shadowBlur = 0;
    });
    g.fillStyle = "#0c0a15";
    g.beginPath(); g.arc(CX, CY, RI - 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#e8e6f4";
    g.font = "600 26px ui-monospace, monospace";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(phase === "over" ? "✕" : String(score), CX, CY);
    g.font = "12px ui-monospace, monospace";
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillText(phase === "show" ? "watch…" : phase === "input" ? "your turn" : "", CX, CY + 26);
    g.textAlign = "left"; g.textBaseline = "alphabetic";
  }

  const l = loop((dt) => {
    step(dt);
    draw();
    if (phase === "over" && !reported) { reported = true; saveHighScore("simon", score); ctx.onGameOver(score); }
  });

  return { stop() { l.stop(); canvas.removeEventListener("mousedown", onDown); } };
}
