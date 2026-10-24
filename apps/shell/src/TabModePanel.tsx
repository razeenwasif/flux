/**
 * Calendar and Mail — the tabs pane's other two modes (Velvet Paper; see
 * tabMode.ts). Lazy: the chunk loads on the first switch away from the tabs.
 *
 * The panel lays itself over the pane between the mode switch and the footer.
 * The tab list under it stays mounted and laid out, only hidden, so a switch
 * rebuilds nothing and every row's favicon is still there to measure.
 *
 * The morph is Zephium's change of shape: the marks travel and nothing else
 * does. Each tab's favicon flies between its row and its tile in the rail, as a
 * copy in a fixed layer so neither scroller clips it on the way; what only the
 * old shape had fades where it stands; the new panel's parts arrive after, top
 * to bottom. Calendar ↔ Mail keeps the rail and slides the panel across.
 */
import {
  For,
  Show,
  Suspense,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import { calEventAdd, calEvents, todosList, todoToggle, type CalEvent, type Todo } from "./ipc";
import {
  activeId,
  dockOpen,
  focusTab,
  isHibernated,
  openTab,
  pinnedTabs,
  setCalendarDock,
  setCalendarPopOpen,
  tabLabel,
  toggleDock,
  unpinnedTabs,
} from "./store";
import { Favicon } from "./tabvisual";
import { commitTabMode, setTabMode, setTabModeChanger, tabMode, TAB_MODES, type TabMode } from "./tabMode";
import { visibleInterval } from "./poll";
import { parseQuickEvent } from "./quickEvent";

const MailPane = lazy(() => import("./MailPane"));

// ── Motion ──────────────────────────────────────────────────────────────────
const FAST = 120;
const BASE = 220;
const PAGE = 360;
const EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";
const EXIT = "cubic-bezier(0.3, 0, 1, 1)";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where a mark is drawn, if it's actually on screen: a row scrolled out of its
 *  list (or a tile out of the rail) has nowhere to fly from. */
const shownRect = (el: Element | null): DOMRect | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const clip = el.closest(".tab-list, .mode-rail")?.getBoundingClientRect();
  if (clip && (r.bottom < clip.top || r.top > clip.bottom)) return null;
  return r;
};

// The copy is drawn outside the pane, where the pane's own rules don't reach,
// so it carries the look of the mark it lands as.
const LOOK = [
  "background-color",
  "background-image",
  "border-radius",
  "box-shadow",
  "color",
  "display",
  "align-items",
  "justify-content",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "overflow",
];
const copyLook = (from: HTMLElement, to: HTMLElement) => {
  const cs = getComputedStyle(from);
  for (const p of LOOK) to.style.setProperty(p, cs.getPropertyValue(p));
  const imgs = from.querySelectorAll("img");
  to.querySelectorAll("img").forEach((img, i) => {
    const src = imgs[i];
    if (!src) return;
    const r = src.getBoundingClientRect();
    img.style.width = `${r.width}px`;
    img.style.height = `${r.height}px`;
  });
};

/** Fly a copy of each mark from where it was to its counterpart, which shows
 *  again on landing. */
const fly = (pairs: { from: DOMRect; to: HTMLElement }[]) => {
  if (!pairs.length) return;
  const layer = document.createElement("div");
  layer.className = "mode-flight";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  let left = pairs.length;
  for (const { from, to } of pairs) {
    const end = to.getBoundingClientRect();
    const ghost = to.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-tab-id");
    copyLook(to, ghost);
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${end.left}px`,
      top: `${end.top}px`,
      width: `${end.width}px`,
      height: `${end.height}px`,
      margin: "0",
      boxSizing: "border-box",
      transformOrigin: "0 0",
      visibility: "visible",
    });
    layer.append(ghost);
    to.style.visibility = "hidden";
    const s = from.width / end.width;
    const flight = ghost.animate(
      [
        { transform: `translate(${from.left - end.left}px, ${from.top - end.top}px) scale(${s})` },
        { transform: "none" },
      ],
      { duration: PAGE, easing: EMPHASIZED, fill: "both" },
    );
    void flight.finished
      .catch(() => {})
      .then(() => {
        to.style.visibility = "";
        if (--left === 0) layer.remove();
      });
  }
};

// ── Dates ───────────────────────────────────────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const minsOf = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** "14:00" → "2 pm", "09:30" → "9:30 am". */
const clock = (t: string) => {
  const m = minsOf(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}${m % 60 ? `:${pad2(m % 60)}` : ""} ${h < 12 ? "am" : "pm"}`;
};
const DAY_MS = 86_400_000;
const mondayOf = (d: Date) => {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
};
/** The teaching week, counted from the Monday the calendar pane calls Week 1. */
const weekNo = (d: Date) => {
  const w1 = localStorage.getItem("flux.cal.week1") || "2026-07-27";
  return Math.round((mondayOf(d).getTime() - mondayOf(new Date(`${w1}T00:00`)).getTime()) / (7 * DAY_MS)) + 1;
};

// ── Calendar ────────────────────────────────────────────────────────────────
const CalendarBody: Component = () => {
  const [events, setEvents] = createSignal<CalEvent[]>([]);
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const today = () => ymd(new Date());
  const [month, setMonth] = createSignal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [day, setDay] = createSignal(today());
  const [draft, setDraft] = createSignal("");
  const [note, setNote] = createSignal("");
  const [now, setNow] = createSignal(Date.now());

  const load = () => {
    void calEvents()
      .then(setEvents)
      .catch(() => {});
    void todosList()
      .then(setTodos)
      .catch(() => {});
  };
  // cal_events fetches the ICS feeds, so not often; the clock ticks for "in 25 min".
  onMount(() => {
    visibleInterval(load, 600_000);
    visibleInterval(() => setNow(Date.now()), 60_000);
  });

  const byDate = createMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events()) {
      const list = m.get(e.date);
      if (list) list.push(e);
      else m.set(e.date, [e]);
    }
    for (const list of m.values()) list.sort((a, b) => a.sort_key - b.sort_key);
    return m;
  });
  /** Six weeks of the shown month, Monday first. */
  const weeks = createMemo(() => {
    const first = mondayOf(month());
    return Array.from({ length: 6 }, (_, w) =>
      Array.from(
        { length: 7 },
        (_, d) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d),
      ),
    );
  });
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const dayEvents = () => byDate().get(day()) ?? [];
  /** The next timed event today: the one on now, or the first still to come. */
  const nextUp = createMemo(() => {
    const t = new Date(now());
    const mins = t.getHours() * 60 + t.getMinutes();
    return (byDate().get(ymd(t)) ?? []).find((e) => e.time && minsOf(e.end || e.time) > mins) ?? null;
  });
  const nextWhen = (e: CalEvent) => {
    const t = new Date(now());
    const d = minsOf(e.time) - (t.getHours() * 60 + t.getMinutes());
    if (d <= 0) return "Now";
    return d < 60 ? `In ${d} min` : `In ${Math.floor(d / 60)} h ${d % 60 ? `${d % 60} min` : ""}`.trim();
  };
  /** Where the now-line goes in today's agenda: before the first event still to come. */
  const nowAt = () => {
    if (day() !== today()) return -1;
    const t = new Date(now());
    const mins = t.getHours() * 60 + t.getMinutes();
    const list = dayEvents();
    const i = list.findIndex((e) => e.time && minsOf(e.time) > mins);
    return i < 0 ? list.length : i;
  };
  const dueTasks = () => todos().filter((t) => !t.done && t.due && t.due <= day());

  const add = (e: Event) => {
    e.preventDefault();
    const p = parseQuickEvent(draft(), day());
    if (!p) return;
    const end = p.start
      ? `${pad2(Math.min(23, Math.floor(minsOf(p.start) / 60) + 1))}:${pad2(minsOf(p.start) % 60)}`
      : "";
    void calEventAdd({ title: p.title, date: p.date, start: p.start, end })
      .then(() => {
        setDraft("");
        const when = new Date(`${p.date}T00:00`).toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
        });
        setNote(`Added ${p.title} · ${when}${p.start ? ` · ${clock(p.start)}` : ""}`);
        load();
      })
      .catch((err) => setNote(`Couldn't add it: ${String(err).replace(/^Error:\s*/, "")}`));
  };
  // Elsewhere: the full-size overlay, or the calendar + mail column.
  const popOut = () => {
    setCalendarDock("overlay");
    setCalendarPopOpen(true);
  };
  const dock = () => {
    setCalendarDock("dock");
    setCalendarPopOpen(true);
    if (!dockOpen()) toggleDock();
    setTabMode("tabs");
  };

  let row = 0; // stagger index for the entrance cascade
  const i = () => ({ "--i": String(row++) });
  return (
    <div class="mode-cal">
      <div class="mode-head" style={i()}>
        <span class="mode-title">
          {month().toLocaleDateString(undefined, { month: "short", year: "numeric" })}
        </span>
        <button class="mode-btn" title="Previous month" onClick={() => shift(-1)}>
          ‹
        </button>
        <button class="mode-btn" title="Next month" onClick={() => shift(1)}>
          ›
        </button>
      </div>
      <div class="mode-month" role="grid" aria-label="Month">
        <div class="mode-dows" style={i()}>
          <For each={["M", "T", "W", "T", "F", "S", "S"]}>{(d) => <span>{d}</span>}</For>
        </div>
        <For each={weeks()}>
          {(week) => (
            <div class="mode-weekrow" role="row" style={i()}>
              <For each={week}>
                {(d) => {
                  const key = ymd(d);
                  return (
                    <button
                      role="gridcell"
                      classList={{
                        "mode-day": true,
                        out: d.getMonth() !== month().getMonth(),
                        today: key === today(),
                        sel: key === day(),
                        busy: byDate().has(key),
                      }}
                      aria-label={d.toLocaleDateString(undefined, {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                      aria-selected={key === day()}
                      onClick={() => setDay(key)}
                    >
                      {d.getDate()}
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
      <Show when={day() === today() && nextUp()}>
        {(e) => (
          <div class="mode-next" style={i()}>
            <span class="mode-next-when">{nextWhen(e())}</span>
            <span class="mode-next-title">{e().summary}</span>
            <span class="mode-next-meta">
              {clock(e().time)}
              {e().end ? `–${clock(e().end)}` : ""}
              {e().location ? ` · ${e().location}` : ""}
            </span>
          </div>
        )}
      </Show>
      <div class="mode-agenda" style={i()}>
        <div class="mode-sub">
          {day() === today()
            ? "Today"
            : new Date(`${day()}T00:00`).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}
          <span class="mode-week" title="Teaching week">
            Wk {weekNo(new Date(`${day()}T00:00`))}
          </span>
        </div>
        <Show when={dayEvents().length > 0} fallback={<div class="mode-empty">Nothing on.</div>}>
          <For each={dayEvents()}>
            {(e, k) => (
              <>
                <Show when={k() === nowAt()}>
                  <div class="mode-now" aria-label="Now" />
                </Show>
                <div class="mode-ev" title={e.notes || e.summary}>
                  <span class="mode-ev-title">{e.summary}</span>
                  <span class="mode-ev-time">
                    {e.time ? `${clock(e.time)}${e.end ? `–${clock(e.end)}` : ""}` : "All day"}
                    {e.location ? ` · ${e.location}` : ""}
                    <Show when={!e.editable}>
                      <span class="mode-ev-lock" title={`From ${e.calendar} (read-only)`}>
                        {" "}
                        · {e.calendar}
                      </span>
                    </Show>
                  </span>
                </div>
              </>
            )}
          </For>
          <Show when={nowAt() === dayEvents().length}>
            <div class="mode-now" aria-label="Now" />
          </Show>
        </Show>
      </div>
      <Show when={dueTasks().length > 0}>
        <div class="mode-tasks" style={i()}>
          <div class="mode-sub">Due</div>
          <For each={dueTasks()}>
            {(t) => (
              <label class="mode-task">
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() =>
                    void todoToggle(t.id)
                      .then(load)
                      .catch(() => {})
                  }
                />
                <span>{t.title}</span>
                <Show when={t.due! < today()}>
                  <span class="mode-task-late">overdue</span>
                </Show>
              </label>
            )}
          </For>
        </div>
      </Show>
      <div class="mode-elsewhere" style={i()}>
        <button class="mode-link" title="Open the calendar over the page" onClick={popOut}>
          ⇱ Pop out
        </button>
        <button class="mode-link" title="Calendar + mail in their own column" onClick={dock}>
          ⇥ Dock
        </button>
      </div>
      <form class="mode-add" onSubmit={add} style={i()}>
        <span aria-hidden="true">＋</span>
        <input
          aria-label="Add an event"
          placeholder={'Add: "lab tue 3pm"'}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          spellcheck={false}
        />
      </form>
      <Show when={note()}>
        <div class="mode-note" role="status">
          {note()}
        </div>
      </Show>
    </div>
  );
};

// ── The panel ───────────────────────────────────────────────────────────────
const TabModePanel: Component<{ onNavigate: (url: string) => void }> = () => {
  let el!: HTMLDivElement;
  let body!: HTMLDivElement;
  let rail!: HTMLDivElement;
  const away = (m: TabMode) => (m === "mail" ? "mail" : "calendar");
  const [shown, setShown] = createSignal<"calendar" | "mail">(away(tabMode()));
  const [open, setOpen] = createSignal(false);
  const [entering, setEntering] = createSignal(false);
  const [mailSeen, setMailSeen] = createSignal(shown() === "mail");

  /** The pane between the switch and the footer, inside its padding. Written
   *  straight to the element: the morph measures the rail right after, and a
   *  signal set from onMount wouldn't reach the DOM until its batch ends. */
  const measure = () => {
    const side = el.parentElement;
    const modes = side?.querySelector<HTMLElement>(":scope > .tab-modes");
    const foot = side?.querySelector<HTMLElement>(":scope > .sidebar-footer");
    if (!side || !modes || !foot) return;
    const cs = getComputedStyle(side);
    Object.assign(el.style, {
      top: `${modes.offsetTop + modes.offsetHeight + 10}px`,
      bottom: `${side.clientHeight - foot.offsetTop + 8}px`,
      left: `${parseFloat(cs.paddingLeft) || 0}px`,
      right: `${parseFloat(cs.paddingRight) || 0}px`,
    });
  };

  const railTiles = () => [...rail.querySelectorAll<HTMLElement>(".mode-rail-tile[data-tab-id]")];
  const rowMark = (id: string) =>
    el.parentElement?.querySelector<HTMLElement>(
      `.tab-row .tab-favicon[data-tab-id="${id}"], .pin-tile[data-tab-id="${id}"]`,
    ) ?? null;

  /** Into a mode from the tabs: the favicons fly into the rail, then the panel's
   *  parts arrive top to bottom. */
  const enter = () => {
    measure();
    setOpen(true);
    if (reducedMotion()) return;
    rail.querySelector(".mode-rail-tile.on")?.scrollIntoView({ block: "nearest" });
    fly(
      railTiles().flatMap((to) => {
        const from = shownRect(rowMark(to.dataset.tabId!));
        return from ? [{ from, to }] : [];
      }),
    );
    setEntering(true);
    window.setTimeout(() => setEntering(false), FAST + PAGE + 300);
  };

  /** Back to the tabs: the rail's favicons fly home to their rows, and each
   *  row's name arrives behind its mark. */
  const leave = () => {
    const from = new Map(
      railTiles().flatMap((t) => {
        const r = shownRect(t);
        return r ? [[t.dataset.tabId!, r] as const] : [];
      }),
    );
    setOpen(false);
    commitTabMode("tabs");
    if (reducedMotion()) return;
    const side = el.parentElement;
    if (!side) return;
    fly(
      [...from].flatMap(([id, r]) => {
        const to = rowMark(id);
        return to && shownRect(to) ? [{ from: r, to }] : [];
      }),
    );
    for (const name of side.querySelectorAll<HTMLElement>(".tab-row .title, .tab-row .tab-where")) {
      name.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: BASE,
        delay: FAST,
        easing: "ease-out",
        fill: "backwards",
      });
    }
  };

  /** Calendar ↔ Mail: the rail stays; the panel slides out toward the old
   *  side and in from the new one. */
  const cross = (to: "calendar" | "mail", dir: number) => {
    commitTabMode(to);
    if (reducedMotion()) {
      setShown(to);
      if (to === "mail") setMailSeen(true);
      return;
    }
    const out = body.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: `translateX(${-12 * dir}px)` },
      ],
      { duration: FAST, easing: EXIT, fill: "forwards" },
    );
    void out.finished
      .catch(() => {})
      .then(() => {
        setShown(to);
        if (to === "mail") setMailSeen(true);
        out.cancel();
        body.animate(
          [
            { opacity: 0, transform: `translateX(${12 * dir}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: BASE, easing: EMPHASIZED, fill: "backwards" },
        );
      });
  };

  const change = (to: TabMode) => {
    const from = tabMode();
    if (to === "tabs") return leave();
    if (from === "tabs") {
      setShown(to);
      if (to === "mail") setMailSeen(true);
      commitTabMode(to);
      return enter();
    }
    cross(to, TAB_MODES.indexOf(to) > TAB_MODES.indexOf(from) ? 1 : -1);
  };

  onMount(() => {
    setTabModeChanger(change);
    const ro = new ResizeObserver(measure);
    const side = el.parentElement!;
    ro.observe(side);
    for (const part of side.querySelectorAll(":scope > .tab-modes, :scope > .sidebar-footer"))
      ro.observe(part);
    // Mounted by the first switch, which the plain setter already committed.
    if (tabMode() !== "tabs") enter();
    onCleanup(() => {
      ro.disconnect();
      setTabModeChanger(null);
    });
  });

  return (
    <div
      ref={el}
      classList={{ "tab-mode-panel": true, open: open(), entering: entering() }}
      role="tabpanel"
      aria-label={shown() === "mail" ? "Mail" : "Calendar"}
      inert={!open()}
    >
      {/* The tabs, folded: one tile each, a click switches tab and stays here. */}
      <div class="mode-rail" ref={rail} role="list" aria-label="Tabs">
        <For each={pinnedTabs()}>
          {(t) => (
            <button
              classList={{ "mode-rail-tile": true, on: activeId() === t.id, asleep: isHibernated(t.id) }}
              data-tab-id={t.id}
              role="listitem"
              title={tabLabel(t)}
              onClick={() => void focusTab(t.id)}
            >
              <Favicon tab={t} />
            </button>
          )}
        </For>
        <Show when={pinnedTabs().length > 0}>
          <span class="mode-rail-rule" aria-hidden="true" />
        </Show>
        <For each={unpinnedTabs()}>
          {(t) => (
            <button
              classList={{ "mode-rail-tile": true, on: activeId() === t.id, asleep: isHibernated(t.id) }}
              data-tab-id={t.id}
              role="listitem"
              title={isHibernated(t.id) ? `${tabLabel(t)} — sleeping` : tabLabel(t)}
              onClick={() => void focusTab(t.id)}
            >
              <Favicon tab={t} />
            </button>
          )}
        </For>
        <button
          class="mode-rail-add"
          title="New tab"
          aria-label="New tab"
          onClick={() => void openTab("browser")}
        >
          +
        </button>
      </div>
      <div class="mode-body" ref={body}>
        <div class="mode-page" hidden={shown() !== "calendar"}>
          <CalendarBody />
        </div>
        <Show when={mailSeen()}>
          <div class="mode-page mode-mail" hidden={shown() !== "mail"}>
            <Suspense>
              <MailPane inPane />
            </Suspense>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default TabModePanel;
