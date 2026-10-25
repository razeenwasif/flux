/**
 * The strip under the new tab's clock (Flux Next "time and focus"): requests
 * Shields blocked today, focus today against the goal, tasks due today.
 * `today_strip` (sitetime.rs) gathers them; this asks every minute it's shown.
 */
import { Show, createSignal, onMount, type Component } from "solid-js";

import { todayStrip } from "../focusIpc";
import type { TodayStrip as Strip } from "../ipc";
import { visibleInterval } from "../poll";
import "./TodayStrip.css";

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dur = (secs: number) => {
  const m = Math.round(secs / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
};

const TodayStrip: Component = () => {
  const [strip, setStrip] = createSignal<Strip | null>(null);
  const load = () =>
    void todayStrip(ymd(new Date()))
      .then(setStrip)
      .catch(() => {});
  onMount(load);
  visibleInterval(load, 60_000);
  const share = () => {
    const s = strip()!;
    return Math.min(100, (s.focused_secs / Math.max(60, s.goal_minutes * 60)) * 100);
  };
  return (
    <Show when={strip()}>
      {(s) => (
        <div class="today-strip" role="status" aria-label="Today">
          <span>
            <span aria-hidden="true">⛉</span> Blocked today <strong>{s().blocked}</strong>
          </span>
          <span class="today-dot" aria-hidden="true">
            ·
          </span>
          <span>
            <span aria-hidden="true">◷</span> Focused <strong>{dur(s().focused_secs)}</strong> of{" "}
            {dur(s().goal_minutes * 60)}
            <span class="today-bar" aria-hidden="true">
              <span style={{ width: `${share()}%` }} />
            </span>
          </span>
          <span class="today-dot" aria-hidden="true">
            ·
          </span>
          <span>
            <span aria-hidden="true">✓</span> Due today <strong>{s().due}</strong>
          </span>
        </div>
      )}
    </Show>
  );
};

export default TodayStrip;
