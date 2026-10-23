/**
 * Velvet Paper's Focus card (design.ts): the start page's existing timer
 * (clocks.ts — the same one the Time card runs) drawn as a ring with Pause and
 * Reset. It owns no timer state; starting it here starts it everywhere.
 */
import { createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";

import {
  clockRevision,
  fmtClock,
  timerRemaining,
  timerReset,
  timerRunning,
  timerStartPause,
  timerTotal,
} from "../clocks";

const R = 58;
const CIRC = 2 * Math.PI * R;

const VpFocusCard: Component = () => {
  // Tick only while it runs; a paused timer changes only on a press, which
  // `clockRevision` covers.
  const [tick, setTick] = createSignal(0);
  createEffect(() => {
    if (!timerRunning()) return;
    const iv = window.setInterval(() => setTick((t) => t + 1), 500);
    onCleanup(() => clearInterval(iv));
  });
  const remaining = createMemo(() => (tick(), clockRevision(), timerRemaining()));
  const done = () => (timerTotal() > 0 ? Math.min(1, Math.max(0, 1 - remaining() / timerTotal())) : 0);
  const totalMin = () => Math.max(1, Math.round(timerTotal() / 60_000));
  const doneMin = () => Math.min(totalMin(), Math.floor((timerTotal() - remaining()) / 60_000));
  const started = () => remaining() > 0 && remaining() < timerTotal();

  return (
    <section class="glass start-card vp-focus-card" data-legend="Focus" aria-label="Focus timer">
      <svg
        class="vp-focus-ring"
        viewBox="0 0 140 140"
        role="img"
        aria-label={`Focus timer, ${fmtClock(remaining())} left`}
      >
        <defs>
          <linearGradient id="vp-focus-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f3b6d3" />
            <stop offset="0.5" stop-color="#c9b5ff" />
            <stop offset="1" stop-color="#a9e6ec" />
          </linearGradient>
        </defs>
        <circle class="vp-focus-track" cx="70" cy="70" r={R} />
        <circle
          class="vp-focus-arc"
          cx="70"
          cy="70"
          r={R}
          stroke="url(#vp-focus-grad)"
          stroke-dasharray={`${(done() * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`}
          transform="rotate(-90 70 70)"
        />
        <text class="vp-focus-time" x="70" y="79" text-anchor="middle">
          {fmtClock(remaining())}
        </text>
      </svg>
      <span class="vp-focus-note">
        {doneMin()} of {totalMin()} minutes done
      </span>
      <div class="vp-focus-actions">
        <button class="vp-pill vp-pill-satin" onClick={timerStartPause}>
          {timerRunning() ? "Pause" : started() ? "Resume" : "Start"}
        </button>
        <button class="vp-pill" onClick={timerReset}>
          Reset
        </button>
      </div>
    </section>
  );
};

export default VpFocusCard;
