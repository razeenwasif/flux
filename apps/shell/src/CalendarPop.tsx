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
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import {
  calEventAdd,
  calEventDelete,
  calEventUpdate,
  calEvents,
  START_URL,
  todoAdd,
  todoRemove,
  todoSetProfile,
  todoToggle,
  todosList,
  type Todo,
  type CalEvent,
  type CalEventFields,
} from "./ipc";
import { calendarPopView, openTab, setCalendarDock, setCalendarPopOpen, setCalendarPopView } from "./store";

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStrOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** `HH:MM` → minutes since midnight. */
const minsOf = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** Monday of the week containing `d` (weeks start Monday, like the month grid). */
const mondayOf = (d: Date) => {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
};
/** Smallest hour row we'll shrink to before the week grid starts scrolling. */
const MIN_HOUR_H = 34;

const REPEATS: { v: string; label: string }[] = [
  { v: "", label: "One-off" },
  { v: "FREQ=DAILY", label: "Daily" },
  { v: "FREQ=WEEKLY", label: "Weekly" },
  { v: "FREQ=WEEKLY;INTERVAL=2", label: "Every 2 weeks" },
  { v: "FREQ=MONTHLY", label: "Monthly" },
  { v: "FREQ=YEARLY", label: "Yearly" },
];

const CalendarPop: Component<{ docked?: boolean }> = (props) => {
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

  // ── Week / timetable view ───────────────────────────────────────────────
  // A uni timetable is a week of hour-blocks, so this is the same data in the
  // shape you actually read it in. `calFilter` narrows to one calendar, which
  // is what makes the pane act purely as the timetable rather than everything.
  const [view, setView] = createSignal<"month" | "week">(calendarPopView());
  const setViewPersist = (v: "month" | "week") => {
    setView(v);
    setCalendarPopView(v);
  };
  const [calFilter, setCalFilter] = createSignal(localStorage.getItem("flux.cal.filter") ?? "");
  const pickFilter = (v: string) => {
    setCalFilter(v);
    localStorage.setItem("flux.cal.filter", v);
  };
  /** Monday of the displayed week. */
  const [weekStart, setWeekStart] = createSignal(mondayOf(new Date()));
  const shiftWeek = (n: number) => {
    const d = new Date(weekStart());
    d.setDate(d.getDate() + n * 7);
    setWeekStart(d);
  };
  const weekDays = createMemo(() =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart());
      d.setDate(d.getDate() + i);
      return d;
    }),
  );
  const weekLabel = () => {
    const a = weekDays()[0]!;
    const b = weekDays()[6]!;
    const f = (d: Date) => d.toLocaleDateString([], { day: "numeric", month: "short" });
    return `${f(a)} – ${f(b)}`;
  };
  /** Calendars present in the data, for the filter control. */
  const calendars = createMemo(() => [...new Set(events().map((e) => e.calendar))].sort());
  const shown = createMemo(() => {
    const f = calFilter();
    return f ? events().filter((e) => e.calendar === f) : events();
  });
  /** Timed events of the displayed week, keyed by date. */
  const weekEvents = createMemo(() => {
    const days = new Set(weekDays().map(dateStrOf));
    return shown().filter((e) => days.has(e.date) && e.time);
  });
  const allDayEvents = createMemo(() => {
    const days = new Set(weekDays().map(dateStrOf));
    return shown().filter((e) => days.has(e.date) && !e.time);
  });
  /** Hour range worth drawing — a timetable never runs at 3am, so the grid is
   *  clamped to the events actually present (with a sane default). */
  const hourRange = createMemo<[number, number]>(() => {
    const evs = weekEvents();
    if (!evs.length) return [8, 18];
    let lo = 23;
    let hi = 1;
    for (const e of evs) {
      const s = Math.floor(minsOf(e.time) / 60);
      const en = Math.ceil((e.end ? minsOf(e.end) : minsOf(e.time) + 60) / 60);
      lo = Math.min(lo, s);
      hi = Math.max(hi, en);
    }
    return [Math.max(0, Math.min(lo, 22)), Math.min(24, Math.max(hi, lo + 2))];
  });
  const hours = createMemo(() => {
    const [lo, hi] = hourRange();
    return Array.from({ length: hi - lo }, (_, i) => lo + i);
  });
  // Hour rows stretch to fill the pane instead of stopping partway down it. This
  // has to be a measured number rather than CSS `1fr`, because event blocks are
  // absolutely positioned from the same value — letting CSS stretch the rows on
  // its own would slide every block off its gridline. Below MIN_HOUR_H the grid
  // scrolls instead of squashing.
  const [availH, setAvailH] = createSignal(0);
  const hourH = createMemo(() => {
    const n = hours().length;
    if (!n || !availH()) return MIN_HOUR_H + 8;
    return Math.max(MIN_HOUR_H, availH() / n);
  });
  // A callback ref, not `onMount` + a variable: the week grid lives inside a
  // <Show>, so when the pane opens in Month view the element doesn't exist yet
  // and a mount-time observer would never attach.
  let ro: ResizeObserver | undefined;
  const measureScroll = (el: HTMLDivElement) => {
    ro?.disconnect();
    ro = new ResizeObserver(() => setAvailH(el.clientHeight));
    ro.observe(el);
    setAvailH(el.clientHeight);
  };
  onCleanup(() => ro?.disconnect());

  const [nowMins, setNowMins] = createSignal(new Date().getHours() * 60 + new Date().getMinutes());
  onMount(() => {
    const t = window.setInterval(
      () => setNowMins(new Date().getHours() * 60 + new Date().getMinutes()),
      60_000,
    );
    onCleanup(() => window.clearInterval(t));
  });

  // ── Tasks column ──
  // One task store, viewed through named profiles ("Uni", "Personal", …) so the
  // pane can be a course to-do list without a second, separate list to keep in
  // sync. The profile names live in localStorage (the store only tags each task
  // with a string), so an empty profile still gets a tab.
  const DEFAULT_PROFILES = ["Uni", "Personal"];
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [profiles, setProfiles] = createSignal<string[]>(
    (() => {
      try {
        const v = JSON.parse(localStorage.getItem("flux.task.profiles") || "null");
        return Array.isArray(v) && v.length ? (v as string[]) : DEFAULT_PROFILES;
      } catch {
        return DEFAULT_PROFILES;
      }
    })(),
  );
  const [profile, setProfileSig] = createSignal(
    localStorage.getItem("flux.task.profile") || DEFAULT_PROFILES[0]!,
  );
  const setProfile = (p: string) => {
    setProfileSig(p);
    localStorage.setItem("flux.task.profile", p);
  };
  const saveProfiles = (list: string[]) => {
    setProfiles(list);
    localStorage.setItem("flux.task.profiles", JSON.stringify(list));
  };
  const [newTask, setNewTask] = createSignal("");
  /** Task id whose "move to…" row is expanded, or null. */
  const [movingTask, setMovingTask] = createSignal<number | null>(null);
  const moveTask = (id: number, to: string) => {
    setMovingTask(null);
    void todoSetProfile(id, to)
      .then(refreshTodos)
      .catch(() => {});
  };
  const refreshTodos = () =>
    void todosList()
      .then(setTodos)
      .catch(() => {});
  /** Tasks in the selected profile. Tasks saved before profiles existed carry
   *  "" and show in the first profile, so nothing becomes invisible. */
  const profileTodos = createMemo(() => {
    const p = profile();
    const first = profiles()[0];
    return todos()
      .filter((t) => t.profile === p || (!t.profile && p === first))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.created_ms - b.created_ms);
  });
  const addTask = () => {
    const title = newTask().trim();
    if (!title) return;
    setNewTask("");
    void todoAdd(title, undefined, profile())
      .then(refreshTodos)
      .catch(() => {});
  };
  const addProfile = () => {
    const name = window.prompt("New task list name (e.g. a course code)")?.trim();
    if (!name || profiles().includes(name)) return;
    saveProfiles([...profiles(), name]);
    setProfile(name);
  };
  const removeProfile = () => {
    const p = profile();
    if (profiles().length <= 1) return;
    if (!window.confirm(`Remove the “${p}” list? Its tasks move to “${profiles()[0]}”.`)) return;
    const rest = profiles().filter((x) => x !== p);
    // Never orphan tasks into a list with no tab — move them to the first one.
    void Promise.all(
      todos()
        .filter((t) => t.profile === p)
        .map((t) => todoSetProfile(t.id, rest[0]!)),
    )
      .then(refreshTodos)
      .catch(() => {});
    saveProfiles(rest);
    setProfile(rest[0]!);
  };

  const refresh = () =>
    calEvents()
      .then(setEvents)
      .catch(() => {})
      .finally(() => setLoading(false));
  onMount(() => {
    void refresh();
    refreshTodos();
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

  /** Overlay vs docked differ only in the wrapper: docked renders as ordinary
   *  DOM inside the web-panel column (a layout column, so the page underneath
   *  stays visible), while the overlay portals over the card with a backdrop. */
  const Frame: Component<{ children?: JSX.Element }> = (f) =>
    props.docked ? (
      <div class="cal-pane docked">{f.children}</div>
    ) : (
      <Portal>
        <div class="cal-pane-backdrop" onClick={() => setCalendarPopOpen(false)} />
        <div class="glass cal-pane">{f.children}</div>
      </Portal>
    );

  return (
    <Frame>
      <div class="cal-pop-head">
        <button class="cal-pop-nav" onClick={() => (view() === "week" ? shiftWeek(-1) : shiftMonth(-1))}>
          ‹
        </button>
        <span class="cal-pop-month">{view() === "week" ? weekLabel() : monthLabel()}</span>
        <button class="cal-pop-nav" onClick={() => (view() === "week" ? shiftWeek(1) : shiftMonth(1))}>
          ›
        </button>
        <button
          class="cal-pop-nav"
          title="Jump to today"
          onClick={() => {
            setWeekStart(mondayOf(new Date()));
            goToday();
          }}
        >
          Today
        </button>
        {/* Month = plan/edit; Week = read your timetable. */}
        <div class="cal-viewtoggle">
          <button
            classList={{ on: view() === "month" }}
            title="Month + day agenda (add & edit events)"
            onClick={() => setViewPersist("month")}
          >
            Month
          </button>
          <button
            classList={{ on: view() === "week" }}
            title="Week grid — your timetable"
            onClick={() => setViewPersist("week")}
          >
            Timetable
          </button>
        </div>
        <Show when={view() === "week" && calendars().length > 1}>
          <select
            class="cal-filter"
            title="Show only one calendar — pick your uni timetable"
            value={calFilter()}
            onChange={(e) => pickFilter(e.currentTarget.value)}
          >
            <option value="">All calendars</option>
            <For each={calendars()}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        </Show>
        <span style={{ flex: 1 }} />
        <button
          class="cal-pop-nav"
          title={
            props.docked
              ? "Float over the page (hides the page while open)"
              : "Dock in the side panel — stays open beside the page"
          }
          onClick={() => setCalendarDock(props.docked ? "overlay" : "panel")}
        >
          {props.docked ? "⤢" : "⇥"}
        </button>
        <button class="cal-pop-full" title="Open the full calendar (home)" onClick={openFull}>
          ↗ Full calendar
        </button>
        <button class="cal-pop-nav" title="Close (Esc)" onClick={() => setCalendarPopOpen(false)}>
          ✕
        </button>
      </div>
      <div class="cal-pane-cols">
        <Show when={view() === "week"}>
          <div class="tt-week">
            <div class="tt-head">
              <span class="tt-gutter" />
              <For each={weekDays()}>
                {(d) => (
                  <span classList={{ "tt-dow": true, today: dateStrOf(d) === todayStr }}>
                    {d.toLocaleDateString([], { weekday: "short" })} {d.getDate()}
                  </span>
                )}
              </For>
            </div>
            {/* All-day / untimed rows sit above the grid, as in any calendar. */}
            <Show when={allDayEvents().length > 0}>
              <div class="tt-allday">
                <span class="tt-gutter">all day</span>
                <For each={weekDays()}>
                  {(d) => (
                    <span class="tt-allday-col">
                      <For each={allDayEvents().filter((e) => e.date === dateStrOf(d))}>
                        {(e) => <span class="tt-chip">{e.summary}</span>}
                      </For>
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="tt-scroll" ref={measureScroll}>
              <div class="tt-body" style={{ "--hour-h": `${hourH()}px` }}>
                <div class="tt-hours">
                  <For each={hours()}>{(h) => <span class="tt-hour">{pad2(h)}:00</span>}</For>
                </div>
                <For each={weekDays()}>
                  {(d) => (
                    <div classList={{ "tt-col": true, today: dateStrOf(d) === todayStr }}>
                      <For each={hours()}>{() => <div class="tt-slot" />}</For>
                      {/* Now-line, only on today's column. */}
                      <Show
                        when={
                          dateStrOf(d) === todayStr &&
                          nowMins() >= hourRange()[0] * 60 &&
                          nowMins() <= hourRange()[1] * 60
                        }
                      >
                        <div
                          class="tt-now"
                          style={{ top: `${((nowMins() - hourRange()[0] * 60) / 60) * hourH()}px` }}
                        />
                      </Show>
                      <For each={weekEvents().filter((e) => e.date === dateStrOf(d))}>
                        {(e) => {
                          const top = () => ((minsOf(e.time) - hourRange()[0] * 60) / 60) * hourH();
                          const height = () => {
                            const mins = e.end ? minsOf(e.end) - minsOf(e.time) : 60;
                            return Math.max((mins / 60) * hourH() - 2, 18);
                          };
                          return (
                            <button
                              class="tt-ev"
                              classList={{ ro: !e.editable }}
                              style={{ top: `${top()}px`, height: `${height()}px` }}
                              title={`${e.summary}\n${e.time}${e.end ? `–${e.end}` : ""}${
                                e.location ? `\n📍 ${e.location}` : ""
                              }\n${e.calendar}`}
                              onClick={() => {
                                // Jump to the month view's agenda for this day,
                                // which is where editing lives.
                                setSelected(e.date);
                                setViewPersist("month");
                              }}
                            >
                              <span class="tt-ev-t">{e.summary}</span>
                              <Show when={height() > 34}>
                                <span class="tt-ev-m">
                                  {e.time}
                                  {e.location ? ` · ${e.location}` : ""}
                                </span>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <Show when={!loading() && weekEvents().length === 0 && allDayEvents().length === 0}>
              <div class="cal-pop-empty">
                Nothing this week{calFilter() ? ` in “${calFilter()}”` : ""}. Subscribe to your uni's .ics
                timetable from the home calendar's ＋ Calendar.
              </div>
            </Show>
          </div>
        </Show>
        <div class="cal-pane-body" classList={{ hidden: view() === "week" }}>
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
        {/* Tasks: one store, viewed per profile. Sits beside both the month and
            timetable views, so a course to-do list is always a glance away. */}
        <aside class="cal-tasks">
          <div class="cal-tasks-head">
            <For each={profiles()}>
              {(p) => (
                <button
                  classList={{ "cal-tasks-tab": true, on: profile() === p }}
                  title={`Show the “${p}” list`}
                  onClick={() => setProfile(p)}
                >
                  {p}
                </button>
              )}
            </For>
            <button class="cal-tasks-tab add" title="New task list" onClick={addProfile}>
              ＋
            </button>
            <Show when={profiles().length > 1}>
              <button
                class="cal-tasks-tab add"
                title={`Remove the “${profile()}” list`}
                onClick={removeProfile}
              >
                ✕
              </button>
            </Show>
          </div>
          <form
            class="cal-tasks-add"
            onSubmit={(e) => {
              e.preventDefault();
              addTask();
            }}
          >
            <input
              value={newTask()}
              onInput={(e) => setNewTask(e.currentTarget.value)}
              placeholder={`Add to ${profile()}…`}
            />
          </form>
          <div class="cal-tasks-list">
            <For
              each={profileTodos()}
              fallback={<div class="cal-pop-empty">Nothing in {profile()} yet.</div>}
            >
              {(t) => (
                <div classList={{ "cal-task": true, done: t.done }}>
                  <div class="cal-task-row">
                    <button
                      class="cal-task-box"
                      title={t.done ? "Mark as not done" : "Mark as done"}
                      onClick={() => void todoToggle(t.id).then(refreshTodos)}
                    >
                      {t.done ? "☑" : "☐"}
                    </button>
                    <span class="cal-task-title">{t.title}</span>
                    <Show when={t.due}>
                      <span class="cal-task-due">{t.due}</span>
                    </Show>
                    <Show when={profiles().length > 1}>
                      <button
                        class="cal-task-del"
                        title="Move to another list"
                        onClick={() => setMovingTask(movingTask() === t.id ? null : t.id)}
                      >
                        ⇄
                      </button>
                    </Show>
                    <button
                      class="cal-task-del"
                      title="Delete task"
                      onClick={() => void todoRemove(t.id).then(refreshTodos)}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Expanded inline rather than a floating menu: the list
                        scrolls (clipping an absolutely-positioned popover) and a
                        fixed one would be clipped by the glass card's
                        backdrop-filter. */}
                  <Show when={movingTask() === t.id}>
                    <div class="cal-task-move">
                      <span class="cal-task-move-lbl">Move to</span>
                      <For each={profiles().filter((p) => p !== (t.profile || profiles()[0]))}>
                        {(p) => (
                          <button class="cal-tasks-tab" onClick={() => moveTask(t.id, p)}>
                            {p}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </aside>
      </div>
    </Frame>
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
