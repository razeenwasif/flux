/**
 * Calendar popover (#114 follow-up) — the glanceable agenda, one click from any
 * page: a mini month grid (event dots, ‹ › month nav) + the upcoming agenda
 * (or a tapped day's events). Same data as the StartPage calendar (`cal_events`:
 * ICS feeds + Flux-local events, recurrence expanded backend-side). Lazy — only
 * the footer 📅 icon is eager. Anchors to the sidebar footer like Shields, so it
 * never extends over the native webview layer.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";

import { calEvents, START_URL, type CalEvent } from "./ipc";
import { openTab, setCalendarPopOpen } from "./store";

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStrOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const CalendarPop: Component = () => {
  const [events, setEvents] = createSignal<CalEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  // Viewed month as (year, month0); starts on the current month.
  const [ym, setYm] = createSignal<[number, number]>([new Date().getFullYear(), new Date().getMonth()]);
  const [selected, setSelected] = createSignal<string | null>(null);

  onMount(() => {
    void calEvents()
      .then(setEvents)
      .catch(() => {})
      .finally(() => setLoading(false));
  });

  const todayStr = dateStrOf(new Date());
  const monthPrefix = () => `${ym()[0]}-${pad2(ym()[1] + 1)}-`;
  const monthLabel = () =>
    new Date(ym()[0], ym()[1], 1).toLocaleDateString([], { month: "long", year: "numeric" });
  const shiftMonth = (d: number) => {
    const [y, m] = ym();
    const nd = new Date(y, m + d, 1);
    setYm([nd.getFullYear(), nd.getMonth()]);
    setSelected(null);
  };

  /** The grid: leading blanks + day numbers (weeks start Monday). */
  const cells = createMemo(() => {
    const [y, m] = ym();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const out: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d++) out.push(d);
    return out;
  });
  const eventDays = createMemo(() => {
    const p = monthPrefix();
    const s = new Set<number>();
    for (const e of events()) if (e.date.startsWith(p)) s.add(Number(e.date.slice(8, 10)));
    return s;
  });
  const dateOf = (day: number) => `${monthPrefix()}${pad2(day)}`;

  /** The list: the tapped day's events, else the next 8 from today onward. */
  const list = createMemo(() => {
    const sel = selected();
    if (sel) return events().filter((e) => e.date === sel);
    return events()
      .filter((e) => e.date >= todayStr)
      .slice(0, 8);
  });
  const dayLabel = (date: string) =>
    date === todayStr
      ? "Today"
      : new Date(`${date}T00:00`).toLocaleDateString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
        });

  const openFull = () => {
    setCalendarPopOpen(false);
    void openTab("browser", START_URL);
  };

  return (
    <>
      <div class="shield-backdrop" onClick={() => setCalendarPopOpen(false)} />
      <div class="glass popover footer-pop cal-pop">
        <div class="cal-pop-head">
          <button class="cal-pop-nav" onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <span class="cal-pop-month">{monthLabel()}</span>
          <button class="cal-pop-nav" onClick={() => shiftMonth(1)}>
            ›
          </button>
          <button class="cal-pop-full" title="Open the full calendar (home)" onClick={openFull}>
            ↗
          </button>
        </div>
        <div class="cal-pop-grid">
          <For each={["M", "T", "W", "T", "F", "S", "S"]}>{(d) => <span class="cal-pop-dow">{d}</span>}</For>
          <For each={cells()}>
            {(day) => (
              <Show when={day !== null} fallback={<span />}>
                <button
                  classList={{
                    "cal-pop-day": true,
                    today: dateOf(day!) === todayStr,
                    sel: selected() === dateOf(day!),
                    has: eventDays().has(day!),
                  }}
                  onClick={() => setSelected(selected() === dateOf(day!) ? null : dateOf(day!))}
                >
                  {day}
                </button>
              </Show>
            )}
          </For>
        </div>
        <div class="cal-pop-list">
          <Show
            when={list().length > 0}
            fallback={
              <div class="cal-pop-empty">
                {loading()
                  ? "Loading events…"
                  : selected()
                    ? "Nothing on this day."
                    : "Nothing coming up. Ask Gemma: “schedule lunch tomorrow at noon”."}
              </div>
            }
          >
            <For each={list()}>
              {(e) => (
                <div class="cal-pop-ev" title={`${e.summary}${e.location ? `\n${e.location}` : ""}`}>
                  <span class="cal-pop-ev-when">
                    {dayLabel(e.date)}
                    {e.time ? ` · ${e.time}` : ""}
                  </span>
                  <span class="cal-pop-ev-sum">{e.summary}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </>
  );
};

export default CalendarPop;
