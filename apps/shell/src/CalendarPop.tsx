/**
 * Calendar pane (#114 follow-up) — the from-anywhere calendar, opened by the
 * footer 📅 or ⌘K. A centered two-column editor: month grid on the left, the
 * selected day's agenda on the right with inline add / edit / delete for
 * Flux-local events (ICS-feed events are read-only, marked 🔒). Same data as
 * the home calendar (`cal_events`), repeat presets → RRULE like StartPage.
 *
 * Rendered in a Portal over the content card; `calendarPopOpen` is OR'd into
 * `pageOverlayActive`, which hides the native webviews while open (they're an
 * OS layer above all chrome HTML — the only way an overlay can cover a page).
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import {
  calEventAdd,
  calEventDelete,
  calEventUpdate,
  calEvents,
  START_URL,
  type CalEvent,
  type CalEventFields,
} from "./ipc";
import { openTab, setCalendarPopOpen } from "./store";

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStrOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const REPEATS: { v: string; label: string }[] = [
  { v: "", label: "One-off" },
  { v: "FREQ=DAILY", label: "Daily" },
  { v: "FREQ=WEEKLY", label: "Weekly" },
  { v: "FREQ=WEEKLY;INTERVAL=2", label: "Every 2 weeks" },
  { v: "FREQ=MONTHLY", label: "Monthly" },
  { v: "FREQ=YEARLY", label: "Yearly" },
];

const CalendarPop: Component = () => {
  const [events, setEvents] = createSignal<CalEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const todayStr = dateStrOf(new Date());
  const [ym, setYm] = createSignal<[number, number]>([new Date().getFullYear(), new Date().getMonth()]);
  const [selected, setSelected] = createSignal<string>(todayStr);
  // Inline editor: null = closed, 0 = new event, >0 = editing that local event id.
  const [editing, setEditing] = createSignal<number | null>(null);
  const [fTitle, setFTitle] = createSignal("");
  const [fStart, setFStart] = createSignal("");
  const [fEnd, setFEnd] = createSignal("");
  const [fLocation, setFLocation] = createSignal("");
  const [fRepeat, setFRepeat] = createSignal("");
  const [err, setErr] = createSignal("");

  const refresh = () =>
    calEvents()
      .then(setEvents)
      .catch(() => {})
      .finally(() => setLoading(false));
  onMount(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editing() !== null) setEditing(null);
        else setCalendarPopOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const monthPrefix = () => `${ym()[0]}-${pad2(ym()[1] + 1)}-`;
  const monthLabel = () =>
    new Date(ym()[0], ym()[1], 1).toLocaleDateString([], { month: "long", year: "numeric" });
  const shiftMonth = (d: number) => {
    const [y, m] = ym();
    const nd = new Date(y, m + d, 1);
    setYm([nd.getFullYear(), nd.getMonth()]);
  };
  const goToday = () => {
    const now = new Date();
    setYm([now.getFullYear(), now.getMonth()]);
    setSelected(todayStr);
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

  const dayEvents = createMemo(() =>
    events()
      .filter((e) => e.date === selected())
      .sort((a, b) => a.sort_key - b.sort_key),
  );
  const dayTitle = () =>
    selected() === todayStr
      ? "Today"
      : new Date(`${selected()}T00:00`).toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  // ── inline editor ──
  const startAdd = () => {
    setFTitle("");
    setFStart("");
    setFEnd("");
    setFLocation("");
    setFRepeat("");
    setErr("");
    setEditing(0);
  };
  const startEdit = (e: CalEvent) => {
    setFTitle(e.summary);
    setFStart(e.time);
    setFEnd(e.end);
    setFLocation(e.location);
    setFRepeat(e.rrule ?? "");
    setErr("");
    setEditing(e.id);
  };
  const save = async () => {
    const fields: CalEventFields = {
      title: fTitle().trim(),
      date: selected(),
      start: fStart().trim(),
      end: fEnd().trim(),
      location: fLocation().trim(),
      rrule: fRepeat(),
    };
    if (!fields.title) {
      setErr("Give it a title");
      return;
    }
    try {
      const id = editing();
      if (id && id > 0) await calEventUpdate(id, fields);
      else await calEventAdd(fields);
      setEditing(null);
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };
  const remove = async (e: CalEvent) => {
    if (!window.confirm(`Delete “${e.summary}”${e.rrule ? " (the whole repeating series)" : ""}?`)) return;
    await calEventDelete(e.id).catch(() => {});
    await refresh();
  };

  const openFull = () => {
    setCalendarPopOpen(false);
    void openTab("browser", START_URL);
  };

  return (
    <Portal>
      <div class="cal-pane-backdrop" onClick={() => setCalendarPopOpen(false)} />
      <div class="glass cal-pane">
        <div class="cal-pop-head">
          <button class="cal-pop-nav" onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <span class="cal-pop-month">{monthLabel()}</span>
          <button class="cal-pop-nav" onClick={() => shiftMonth(1)}>
            ›
          </button>
          <button class="cal-pop-nav" title="Jump to today" onClick={goToday}>
            Today
          </button>
          <span style={{ flex: 1 }} />
          <button class="cal-pop-full" title="Open the full calendar (home)" onClick={openFull}>
            ↗ Full calendar
          </button>
          <button class="cal-pop-nav" title="Close (Esc)" onClick={() => setCalendarPopOpen(false)}>
            ✕
          </button>
        </div>
        <div class="cal-pane-body">
          <div class="cal-pop-grid cal-pane-grid">
            <For each={["M", "T", "W", "T", "F", "S", "S"]}>
              {(d) => <span class="cal-pop-dow">{d}</span>}
            </For>
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
                    onClick={() => {
                      setSelected(dateOf(day!));
                      setEditing(null);
                    }}
                  >
                    {day}
                  </button>
                </Show>
              )}
            </For>
          </div>
          <div class="cal-pane-day">
            <div class="cal-pane-day-head">
              <span class="cal-pane-day-title">{dayTitle()}</span>
              <button class="cal-pop-nav" title="Add an event on this day" onClick={startAdd}>
                ＋ Add
              </button>
            </div>
            <div class="cal-pop-list cal-pane-list">
              <Show
                when={dayEvents().length > 0 || editing() === 0}
                fallback={
                  <div class="cal-pop-empty">
                    {loading() ? "Loading events…" : "Nothing on this day — ＋ Add one, or ask Gemma."}
                  </div>
                }
              >
                <For each={dayEvents()}>
                  {(e) => (
                    <Show when={editing() !== e.id} fallback={<EventForm />}>
                      <div class="cal-pop-ev cal-pane-ev" title={e.notes || undefined}>
                        <span class="cal-pop-ev-when">
                          {e.time ? `${e.time}${e.end ? ` – ${e.end}` : ""}` : "all day"}
                          {e.rrule ? " · 🔁" : ""}
                          {!e.editable ? ` · 🔒 ${e.calendar}` : ""}
                        </span>
                        <span class="cal-pop-ev-sum">{e.summary}</span>
                        <Show when={e.location}>
                          <span class="cal-pane-ev-loc">📍 {e.location}</span>
                        </Show>
                        <Show when={e.editable}>
                          <div class="cal-pane-ev-actions">
                            <button class="cal-pane-ev-btn" onClick={() => startEdit(e)}>
                              ✎ Edit
                            </button>
                            <button class="cal-pane-ev-btn danger" onClick={() => void remove(e)}>
                              ✕ Delete
                            </button>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  )}
                </For>
                <Show when={editing() === 0}>
                  <EventForm />
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );

  /** The inline add/edit form (shared; reads/writes the f* signals). */
  function EventForm() {
    return (
      <div class="cal-pane-form">
        <input
          class="cal-pane-in"
          placeholder="Event title"
          value={fTitle()}
          onInput={(e) => setFTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          autofocus
        />
        <div class="cal-pane-form-row">
          <input
            class="cal-pane-in cal-pane-in-time"
            type="time"
            title="Start"
            value={fStart()}
            onInput={(e) => setFStart(e.currentTarget.value)}
          />
          <span class="cal-pane-form-dash">–</span>
          <input
            class="cal-pane-in cal-pane-in-time"
            type="time"
            title="End"
            value={fEnd()}
            onInput={(e) => setFEnd(e.currentTarget.value)}
          />
          <select
            class="cal-pane-in cal-pane-in-rep"
            title="Repeat"
            value={fRepeat()}
            onChange={(e) => setFRepeat(e.currentTarget.value)}
          >
            <For each={REPEATS}>{(r) => <option value={r.v}>{r.label}</option>}</For>
          </select>
        </div>
        <input
          class="cal-pane-in"
          placeholder="Location (optional)"
          value={fLocation()}
          onInput={(e) => setFLocation(e.currentTarget.value)}
        />
        <Show when={err()}>
          <span class="cal-pane-err">{err()}</span>
        </Show>
        <div class="cal-pane-form-row">
          <button class="cal-pane-save" onClick={() => void save()}>
            {editing() && editing()! > 0 ? "Save" : "Add"}
          </button>
          <button class="cal-pane-ev-btn" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
};

export default CalendarPop;
