/**
 * Velvet Paper's Today card (design.ts): today's calendar as a 24-hour strip —
 * busy hours lit, the current hour marked — over the day's events. The events
 * are the start page's own (ICS feeds + Flux-local events, `cal_events`), passed
 * in so the page fetches them once.
 */
import { For, Show, type Component } from "solid-js";

import type { CalEvent } from "../ipc";

/** "HH:MM" → minutes past midnight; null for an all-day event's empty time. */
const toMin = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const SCALE = ["00", "06", "12", "18", "24"];

const VpTodayCard: Component<{
  /** Its place in the start page's card grid (CSS `order`). */
  order: number;
  events: () => CalEvent[];
  now: () => Date;
  todayStr: () => string;
  /** Open the full calendar (the start page's expanded calendar widget). */
  onOpenCalendar: () => void;
}> = (props) => {
  const today = () =>
    props
      .events()
      .filter((e) => e.date === props.todayStr())
      .sort((a, b) => a.sort_key - b.sort_key);

  const hours = () => {
    const busy = new Set<number>();
    for (const e of today()) {
      const start = toMin(e.time);
      if (start == null) continue;
      const end = Math.max(start + 1, toMin(e.end) ?? start + 60);
      for (let h = Math.floor(start / 60); h <= Math.min(23, Math.floor((end - 1) / 60)); h++) busy.add(h);
    }
    const nowH = props.now().getHours();
    return Array.from({ length: 24 }, (_, h) => (h === nowH ? "now" : busy.has(h) ? "busy" : "free"));
  };
  const busyCount = () => hours().filter((h) => h === "busy").length;

  return (
    <section
      class="glass start-card vp-today-card"
      data-legend="Today"
      data-row="lead"
      style={{ order: props.order }}
    >
      <div class="start-card-title">
        Today
        <button class="start-card-link" title="Open the calendar" onClick={props.onOpenCalendar}>
          ⤢ Calendar
        </button>
      </div>
      <div
        class="vp-day-strip"
        role="img"
        aria-label={`Today: ${today().length} event${today().length === 1 ? "" : "s"}, ${busyCount()} busy hour${busyCount() === 1 ? "" : "s"}`}
      >
        <For each={hours()}>{(h) => <span class={`vp-hour vp-hour-${h}`} />}</For>
      </div>
      <div class="vp-day-scale" aria-hidden="true">
        <For each={SCALE}>{(s) => <span>{s}</span>}</For>
      </div>
      <Show
        when={today().length > 0}
        fallback={<div class="start-empty vp-day-empty">Nothing on today.</div>}
      >
        <div class="vp-day-events">
          <For each={today().slice(0, 4)}>
            {(e) => (
              <div class="vp-day-event" title={[e.summary, e.location].filter(Boolean).join(" · ")}>
                <span class="vp-day-time">{e.time || "All day"}</span>
                <span class="vp-day-title">{e.summary}</span>
                <Show when={e.location}>
                  <span class="vp-day-where">{e.location}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};

export default VpTodayCard;
