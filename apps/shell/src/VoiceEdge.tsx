/**
 * Liquid Silk: while the agent speaks (Fairy, or Flux's own voice), the
 * sidebar's right edge comes alive. A line of light takes the pane's edge
 * over: in along the top, round the corner, down the side rippling outward
 * with the rhythm of speech (the space it opens tinted like the pane, so the
 * pane itself seems to move), round the bottom corner and away along the
 * bottom. The pane's own right edge steps aside meanwhile (`data-agent-voice`
 * on <html>, liquid-silk.css), and it all settles back when she stops.
 *
 * Fairy speaks through her own app, which says when she starts and stops but
 * not how loud she is, so the movement follows a speech-like rhythm (syllables,
 * gaps, pauses between phrases) rather than her audio.
 *
 * One canvas, fixed over the pane's right side (so nothing in the pane clips
 * it), drawn only while speaking or settling, held to 60 fps, and not at all
 * under Reduce Motion or while Flux is hidden. Mounted by TabModePanel.
 */
import { createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { speaking } from "./speak";

/** How far the edge may ripple out. */
const REACH = 12;
/** Room around the drawing for the glow. */
const PAD = 16;
/** How far the line runs along the top and bottom before it fades. */
const TAIL = 56;
const MIN_FRAME_MS = 1000 / 60 - 2;

const VoiceEdge: Component = () => {
  const [fairy, setFairy] = createSignal(false);
  const on = () => fairy() || speaking();

  onMount(() => {
    const root = document.documentElement;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    Object.assign(cv.style, { position: "fixed", zIndex: "40", pointerEvents: "none" });
    document.body.append(cv);
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const offs = [
      listen("flux://fairy-speaking", () => setFairy(true)),
      listen("flux://fairy-spoken", () => setFairy(false)),
    ];

    // ── The pane's card (drawn on ::before in this design), in canvas terms:
    // its right edge at `ex`, its top and bottom at `y0` and `y1`.
    let ex = 0,
      y0 = 0,
      y1 = 0,
      R = 22,
      w = 0,
      hgt = 0,
      dpr = 1;
    const place = () => {
      const side = document.querySelector<HTMLElement>(".sidebar");
      if (!side) return;
      const r = side.getBoundingClientRect();
      const card = getComputedStyle(side, "::before");
      const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
      const drawn = card.content !== "none";
      const right = r.right - (drawn ? px(card.right) : 0);
      const top = r.top + (drawn ? px(card.top) : 0);
      const h = Math.max(0, r.height - (drawn ? px(card.top) + px(card.bottom) : 0));
      R = px(card.borderTopRightRadius) || 22;
      // The edge's own line sits in the middle of its 1.5px border.
      ex = PAD + TAIL + R - 0.75;
      y0 = PAD + 0.75;
      y1 = PAD + h - 0.75;
      w = TAIL + R + REACH + PAD * 2;
      hgt = h + PAD * 2;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      Object.assign(cv.style, {
        left: `${right - (TAIL + R + PAD)}px`,
        top: `${top - PAD}px`,
        width: `${w}px`,
        height: `${hgt}px`,
      });
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hgt * dpr);
    };
    const ro = new ResizeObserver(place);
    const watch = () => {
      const side = document.querySelector(".sidebar");
      if (side) ro.observe(side);
    };
    watch();
    addEventListener("resize", place);
    place();

    // ── Speech: syllables of 90–240 ms, short gaps, longer pauses.
    let env = 0,
      target = 0,
      nextAt = 0,
      level = 0;
    const voice = (t: number) => {
      if (t >= nextAt) {
        const r = Math.random();
        if (r < 0.12) {
          target = 0;
          nextAt = t + 260 + Math.random() * 380;
        } else if (r < 0.35) {
          target = 0.15;
          nextAt = t + 50 + Math.random() * 70;
        } else {
          target = 0.55 + Math.random() * 0.45;
          nextAt = t + 90 + Math.random() * 150;
        }
      }
      env += (target - env) * (target > env ? 0.35 : 0.12);
    };
    const seeds = Array.from({ length: 64 }, () => Math.random());
    const noise = (x: number) => {
      const i = Math.floor(x),
        f = x - i;
      const a = seeds[((i % 64) + 64) % 64]!,
        b = seeds[(((i + 1) % 64) + 64) % 64]!;
      return a + (b - a) * f * f * (3 - 2 * f);
    };
    const rgb = (name: string, fallback: string) =>
      getComputedStyle(root).getPropertyValue(name).trim() || fallback;

    /** The line's path, and the rippling run's points (for the tint). */
    const shape = (time: number) => {
      const run: [number, number][] = [];
      const top = y0 + R,
        bottom = y1 - R,
        span = Math.max(1, bottom - top);
      for (let y = top; y <= bottom; y += 3) {
        // Still where the run meets the corners, full in between.
        const k = Math.min(y - top, bottom - y) / Math.min(span / 2, R * 2.5);
        const taper = Math.max(0, Math.min(1, k));
        const ripple =
          Math.sin(y / 22 - time * 5.2) * 0.55 +
          Math.sin(y / 9 + time * 7.3) * 0.3 +
          (noise(y / 30 + time * 1.8) - 0.5) * 0.6;
        // Outward only: the edge never dips into the pane.
        const out = ((ripple + 1.45) / 2.9) * env * REACH * taper * level;
        run.push([ex + out, y]);
      }
      const path = new Path2D();
      path.moveTo(ex - R - TAIL, y0);
      path.lineTo(ex - R, y0);
      path.arc(ex - R, y0 + R, R, -Math.PI / 2, 0);
      for (const [x, y] of run) path.lineTo(x, y);
      path.lineTo(ex, y1 - R);
      path.arc(ex - R, y1 - R, R, 0, Math.PI / 2);
      path.lineTo(ex - R - TAIL, y1);
      return { path, run };
    };

    let raf = 0,
      drawn = 0,
      t0 = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (drawn && now - drawn < MIN_FRAME_MS) return;
      drawn = now;
      const t = now - t0;
      if (on()) voice(t);
      else env += (0 - env) * 0.08;
      level += ((on() ? 1 : 0) - level) * 0.06;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      if (!on() && level < 0.01) {
        cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      const { path, run } = shape(t / 1000);
      // The pane, reaching out to the wave.
      ctx.beginPath();
      ctx.moveTo(ex - 1, y0 + R);
      for (const [x, y] of run) ctx.lineTo(x, y);
      ctx.lineTo(ex - 1, y1 - R);
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb("--silk-tint", "14, 14, 28")}, ${0.55 * level})`;
      ctx.fill();
      // The line, in the accents, top to bottom.
      const grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, `rgba(${rgb("--accent-rgb", "147, 232, 216")}, 0.95)`);
      grad.addColorStop(1, `rgba(${rgb("--accent-ai-rgb", "210, 156, 246")}, 0.95)`);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const [lw, a, glow] of [
        [5, 0.22, 14],
        [1.6, 1, 8],
      ] as const) {
        ctx.strokeStyle = grad;
        ctx.globalAlpha = a * level;
        ctx.lineWidth = lw;
        ctx.shadowColor = `rgba(${rgb("--accent-ai-rgb", "210, 156, 246")}, 0.8)`;
        ctx.shadowBlur = glow;
        ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      // Its ends fade away along the top and bottom.
      ctx.globalCompositeOperation = "destination-out";
      const fade = ctx.createLinearGradient(ex - R - TAIL, 0, ex - R, 0);
      fade.addColorStop(0, "rgba(0,0,0,1)");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, ex - R, hgt);
      ctx.globalCompositeOperation = "source-over";
    };
    const start = () => {
      if (raf || reduce.matches || document.hidden) return;
      watch();
      place();
      t0 = performance.now();
      drawn = 0;
      raf = requestAnimationFrame(frame);
    };
    createEffect(() => {
      const speaking = on();
      // The pane's own right edge steps aside while the line has it.
      root.toggleAttribute("data-agent-voice", speaking && !reduce.matches);
      if (speaking) start();
    });
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, cv.width, cv.height);
      } else if (on()) start();
    };
    document.addEventListener("visibilitychange", onVis);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("resize", place);
      document.removeEventListener("visibilitychange", onVis);
      root.removeAttribute("data-agent-voice");
      for (const off of offs) void off.then((f) => f()).catch(() => {});
      cv.remove();
    });
  });
  return null;
};

export default VoiceEdge;
