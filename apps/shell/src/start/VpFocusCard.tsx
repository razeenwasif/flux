/**
 * Velvet Paper's Focus card (design.ts): the focus session (focus.rs) as a
 * ring. Start runs 25 minutes and closes the sites chosen last time
 * (flux://time chooses them); Pause is a break, End stops it. Starting here
 * starts it everywhere.
 */
import { Show, type Component } from "solid-js";

import { focusEnd, focusPause, focusStart } from "../focusIpc";
import { clockOf, focus, focusLeft, refreshFocus } from "../focusStore";

const R = 58;
const CIRC = 2 * Math.PI * R;
const LENGTH = 25;

const VpFocusCard: Component = () => {
  const running = () => !!focus()?.running;
  const left = () => (running() ? focusLeft() : LENGTH * 60_000);
  const total = () => (focus()?.minutes || LENGTH) * 60_000;
  const done = () => (running() ? Math.min(1, Math.max(0, 1 - left() / total())) : 0);
  const act = (p: Promise<unknown>) => void p.then(refreshFocus).catch(() => {});

  return (
    <section class="glass start-card vp-focus-card" data-legend="Focus" aria-label="Focus session">
      <svg
        class="vp-focus-ring"
        viewBox="0 0 140 140"
        role="img"
        aria-label={`Focus, ${clockOf(left())} left`}
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
          {clockOf(left())}
        </text>
      </svg>
      <span class="vp-focus-note">
        <Show when={running()} fallback={`${LENGTH} minutes · closes ${focus()?.sites.length ?? 0} sites`}>
          {focus()!.paused
            ? "On a break"
            : `${Math.floor((focus()!.elapsed_ms ?? 0) / 60_000)} of ${focus()!.minutes} minutes · ${focus()!.blocks.length} sites closed`}
        </Show>
      </span>
      <div class="vp-focus-actions">
        <Show
          when={running()}
          fallback={
            <button class="vp-pill vp-pill-satin" onClick={() => act(focusStart("", LENGTH, []))}>
              Start
            </button>
          }
        >
          <button class="vp-pill vp-pill-satin" onClick={() => act(focusPause(!focus()!.paused))}>
            {focus()!.paused ? "Resume" : "Pause"}
          </button>
          <button class="vp-pill" onClick={() => act(focusEnd())}>
            End
          </button>
        </Show>
      </div>
    </section>
  );
};

export default VpFocusCard;
