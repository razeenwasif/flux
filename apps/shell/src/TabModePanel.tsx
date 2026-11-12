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
 *
 * Liquid Silk's Agent and Terminal modes host the app's own agent and terminal
 * column (App's `.rightstack`): the live element moves in here and back, so the
 * conversation and the shells carry on. They sit below the address, which stays
 * in sight, and arrive on the Silk wave (`silkWave`).
 */
import {
  For,
  Show,
  Suspense,
  createEffect,
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
import {
  commitTabMode,
  paneWide,
  setPaneWide,
  setTabModeChanger,
  tabMode,
  SIDE_PANELS,
  TAB_MODES,
  type TabMode,
} from "./tabMode";
import { design } from "./design";
import { visibleInterval } from "./poll";
import { parseQuickEvent } from "./quickEvent";

const MailPane = lazy(() => import("./MailPane"));
const TabNotes = lazy(() => import("./TabNotes"));
const ConnectionsRail = lazy(() => import("./ConnectionsRail"));

// ── Motion ──────────────────────────────────────────────────────────────────
const FAST = 120;
const BASE = 220;
const PAGE = 360;
const EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";
const EXIT = "cubic-bezier(0.3, 0, 1, 1)";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Liquid Silk's morphs: the Silk wave (into the agent or terminal) and the
// cascade (into Calendar, Mail and Notes) ─────────────────────────────────────
/** Their pace: half the speed of the first mockup, as picked. */
const WAVE_K = 2;
/** How long the sidebar takes to widen for the agent or terminal (App's
 *  sideW); `.shell.side-morph` animates the columns for this long. */
const WIDEN = 620 * WAVE_K;
const isDock = (m: TabMode) => SIDE_PANELS.includes(m);
const silk = () => design() === "liquid-silk";

/** What leaves the tabs: the pane's own parts and the rows in view, top to
 *  bottom. The stylesheet hides them already; the morph plays them out first. */
const listParts = (side: HTMLElement): HTMLElement[] => {
  const top = side.getBoundingClientRect();
  return [
    ...side.querySelectorAll<HTMLElement>(
      ":scope > .page-actions, :scope > .ws-chips, :scope > .pin-grid, :scope > .new-tab-control, :scope > .tab-list-head, .tab-list .tab-row, .tab-list .group-head, :scope > .folders",
    ),
  ].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.height > 0 && r.bottom > top.top && r.top < top.bottom;
  });
};

const PEEL_OUT: Keyframe[] = [
  { opacity: 1, visibility: "visible", transform: "none" },
  { opacity: 0, visibility: "visible", transform: "translateX(-46px) rotate(-3deg)" },
];
const SLIDE_IN: Keyframe[] = [
  { opacity: 0, transform: "translateX(48px) rotate(2deg)" },
  { opacity: 1, transform: "none" },
];
const DISSOLVE: Keyframe[] = [
  { opacity: 1, visibility: "visible", filter: "blur(0)", transform: "none" },
  { opacity: 0, visibility: "visible", filter: "blur(8px)", transform: "translateY(-8px) scale(.98)" },
];
const RISE_IN: Keyframe[] = [
  { opacity: 0, filter: "blur(8px)", transform: "translateY(14px)" },
  { opacity: 1, filter: "blur(0)", transform: "none" },
];

/** Play parts out, one after another. `keep` holds them gone at the end (a page
 *  that's about to be swapped out); otherwise the stylesheet has hidden them. */
const leaveAll = (
  outs: HTMLElement[],
  frames: Keyframe[],
  o: { dur: number; first: number; step: number; ease: string; keep: boolean },
) =>
  outs.map((n, i) =>
    n.animate(frames, {
      duration: o.dur * WAVE_K,
      delay: (o.first + Math.min(i, 12) * o.step) * WAVE_K,
      easing: o.ease,
      fill: o.keep ? "forwards" : "backwards",
    }),
  );

/** Bring parts in, one after another. They're hidden from this moment (the
 *  animations exist at once, held at their first frame), so nothing shows and
 *  then starts again. Parts still mounting (the agent's first time) are waited
 *  for a few frames, keeping to the same schedule. */
const arriveAll = (
  parts: () => HTMLElement[],
  frames: Keyframe[],
  o: { dur: number; first: number; step: number; ease: string },
) => {
  const t0 = performance.now();
  let tries = 0;
  const go = () => {
    const list = parts();
    if (!list.length && tries++ < 30) {
      requestAnimationFrame(go);
      return;
    }
    const late = performance.now() - t0;
    list.forEach((n, i) =>
      n.animate(frames, {
        duration: o.dur * WAVE_K,
        delay: Math.max(0, o.first * WAVE_K - late) + i * o.step * WAVE_K,
        easing: o.ease,
        fill: "backwards",
      }),
    );
  };
  go();
};

/**
 * The cascade: what's there peels off to the left one after another, and the
 * new parts slide in from the right with a little overshoot. With `swap` (a
 * page giving way to another), the new page is put in once most of the old
 * one has gone.
 */
const cascade = (outs: HTMLElement[], ins: () => HTMLElement[], swap?: () => void) => {
  const gone = leaveAll(outs, PEEL_OUT, {
    dur: 300,
    first: 0,
    step: 22,
    ease: "cubic-bezier(.5,0,.75,0)",
    keep: !!swap,
  });
  const bring = (first: number) =>
    arriveAll(ins, SLIDE_IN, { dur: 520, first, step: 55, ease: "cubic-bezier(.2,1.25,.35,1)" });
  if (!swap) return bring(110);
  // Nothing to see go (the agent or terminal closes with the switch): at once.
  if (!outs.length) {
    swap();
    return bring(0);
  }
  window.setTimeout(() => {
    swap();
    gone.forEach((a) => a.cancel());
    bring(0);
  }, 220 * WAVE_K);
};

/**
 * The Silk wave: a band of light sweeps down the pane; what's there dissolves
 * as it passes, and the panel's parts rise in behind it, top to bottom. With
 * `swap`, as for the cascade.
 */
const silkWave = (side: HTMLElement, outs: HTMLElement[], ins: () => HTMLElement[], swap?: () => void) => {
  // Clipped to the pane's card (drawn on its ::before), so the light stays on it.
  const wave = document.createElement("div");
  wave.className = "silk-wave";
  wave.setAttribute("aria-hidden", "true");
  const card = getComputedStyle(side, "::before");
  for (const p of ["top", "right", "bottom", "left", "border-radius"] as const)
    wave.style.setProperty(p, card.getPropertyValue(p));
  const band = document.createElement("i");
  wave.append(band);
  side.append(wave);
  void band
    .animate(
      [
        { opacity: 0, transform: "translateY(-100%) skewY(-8deg)" },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.8 },
        { opacity: 0, transform: "translateY(240%) skewY(-8deg)" },
      ],
      { duration: 820 * WAVE_K, easing: "cubic-bezier(.45,0,.25,1)" },
    )
    .finished.catch(() => {})
    .then(() => wave.remove());
  const gone = leaveAll(outs, DISSOLVE, { dur: 260, first: 40, step: 30, ease: "ease-in", keep: !!swap });
  const bring = (first: number) =>
    arriveAll(ins, RISE_IN, { dur: 420, first, step: 70, ease: "cubic-bezier(.2,.9,.2,1)" });
  if (!swap) return bring(230);
  if (!outs.length) {
    swap();
    return bring(150);
  }
  window.setTimeout(() => {
    swap();
    gone.forEach((a) => a.cancel());
    bring(0);
  }, 230 * WAVE_K);
};

/** Widen or narrow the pane for the agent or terminal, animating the columns
 *  while it does. */
const widen = (side: HTMLElement, wide: boolean) => {
  if (wide === paneWide()) return;
  const shell = side.closest<HTMLElement>(".shell");
  if (shell && !reducedMotion()) {
    shell.classList.add("side-morph");
    window.setTimeout(() => shell.classList.remove("side-morph"), WIDEN + 80);
  }
  setPaneWide(wide);
};

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

// ── Columns ─────────────────────────────────────────────────────────────────
/** A mode's own column beside the page, on or off from here (the footer's
 *  buttons for them went when they became modes). */
const ColumnToggle: Component<{ on: boolean; what: string; onToggle: () => void }> = (p) => (
  <button
    classList={{ "mode-link": true, on: p.on }}
    aria-pressed={p.on}
    title={p.on ? `Close the ${p.what} column` : `Show ${p.what} in a column beside the page`}
    onClick={p.onToggle}
  >
    {p.on ? "✕ Column" : "⇥ Column"}
  </button>
);
/** The calendar + mail column. Opening it from here brings the calendar too. */
const DockToggle: Component = () => (
  <ColumnToggle
    on={dockOpen()}
    what="calendar + mail"
    onToggle={() => {
      if (!dockOpen()) {
        setCalendarDock("dock");
        setCalendarPopOpen(true);
      }
      toggleDock();
    }}
  />
);

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
        <DockToggle />
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
type Away = Exclude<TabMode, "tabs">;

const TabModePanel: Component<{
  onNavigate: (url: string) => void;
  /** The connections column (your notes, System, Trail): Context mode holds
   *  it while it's closed, and can open it again. */
  connectOpen: boolean;
  onToggleConnect: () => void;
}> = (props) => {
  let el!: HTMLDivElement;
  let body!: HTMLDivElement;
  let rail!: HTMLDivElement;
  let dock: HTMLDivElement | undefined;
  const away = (m: TabMode): Away => (m === "tabs" ? "calendar" : m);
  const [shown, setShownSig] = createSignal<Away>(away(tabMode()));
  const [open, setOpen] = createSignal(false);
  const [entering, setEntering] = createSignal(false);
  // A mode's page mounts the first time it's shown and stays, so going back to
  // it keeps its place (the open note, the month, the filter).
  const [seen, setSeen] = createSignal(new Set<Away>([shown()]));
  const setShown = (m: Away) => {
    setShownSig(m);
    if (!seen().has(m)) setSeen(new Set([...seen(), m]));
  };

  /** The pane between the switch and the footer, inside its padding. Written
   *  straight to the element: the morph measures the rail right after, and a
   *  signal set from onMount wouldn't reach the DOM until its batch ends. */
  const measure = () => {
    const side = el.parentElement;
    // The agent and terminal start below the address, which stays in sight.
    const modes = side?.querySelector<HTMLElement>(
      isDock(tabMode()) ? ":scope > .addr-stack" : ":scope > .tab-modes",
    );
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
    const side = el.parentElement;
    if (side && silk()) {
      if (isDock(tabMode())) silkWave(side, listParts(side), dockParts);
      else cascade(listParts(side), pageParts);
    }
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

  /** Between two modes: the rail stays; the panel slides out toward the old
   *  side and in from the new one. */
  const cross = (to: Away, dir: number) => {
    const from = shown();
    commitTabMode(to);
    const side = el.parentElement;
    if (silk() && side && !reducedMotion()) {
      // The panel's top moves (the agent and terminal sit below the address)
      // with the swap, not before the old page has gone.
      const swap = () => {
        setShown(to);
        measure();
      };
      if (!isDock(to)) return cascade(pageParts(), pageParts, swap);
      // Into the agent or terminal on the wave: from another mode's page, or
      // straight across from the other one (they share the page).
      if (isDock(from)) {
        swap();
        return silkWave(side, [], dockParts);
      }
      return silkWave(side, pageParts(), dockParts, swap);
    }
    measure();
    if (reducedMotion()) {
      setShown(to);
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
    if (el.parentElement) widen(el.parentElement, isDock(to));
    if (to === "tabs") return leave();
    if (from === "tabs") {
      setShown(to);
      commitTabMode(to);
      return enter();
    }
    cross(to, TAB_MODES.indexOf(to) > TAB_MODES.indexOf(from) ? 1 : -1);
  };

  // ── The agent and terminal, hosted ──
  /** App's agent + terminal column, wherever it is now. */
  const stack = () => document.querySelector<HTMLElement>(".rightstack:not(.dock-col)");
  let home: HTMLElement | null = null;
  /** Bring the column in; it may not exist for a frame or two after the toggle
   *  that mounts it. */
  const claim = (tries = 30) => {
    const s = stack();
    if (!dock) return;
    if (!s) {
      if (tries > 0) requestAnimationFrame(() => claim(tries - 1));
      return;
    }
    if (s.parentElement === dock) return;
    home ??= s.parentElement;
    dock.append(s);
  };
  /** Put it back in its column (another design, or this pane going away). */
  const release = () => {
    const s = dock?.querySelector<HTMLElement>(":scope > .rightstack");
    if (s && home) home.append(s);
  };
  createEffect(() => {
    if (!silk()) release();
    else if (isDock(shown())) claim();
  });
  onCleanup(() => {
    release();
    setPaneWide(false);
  });
  /** The page showing, in parts for the cascade: its own children, or theirs
   *  when it's just a wrapper or two. */
  const pageParts = (): HTMLElement[] => {
    const page = body.querySelector<HTMLElement>(":scope > .mode-page:not([hidden])");
    if (!page) return [];
    let kids = [...page.children] as HTMLElement[];
    if (kids.length <= 2)
      kids = kids.flatMap((k) => (k.children.length ? ([...k.children] as HTMLElement[]) : [k]));
    return kids.filter((k) => k.getBoundingClientRect().height > 0).slice(0, 14);
  };
  /** The hosted panel's parts, for the wave to bring in one by one. */
  const dockParts = (): HTMLElement[] => {
    const slot = [...(dock?.querySelectorAll<HTMLElement>(".rightstack-slot") ?? [])].find(
      (s) => s.style.display !== "none",
    );
    const inner = slot?.querySelector<HTMLElement>(".agent-inner") ?? slot?.firstElementChild;
    const kids = inner ? ([...inner.children] as HTMLElement[]) : [];
    return kids.filter((k) => k.getBoundingClientRect().height > 0);
  };

  onMount(() => {
    setTabModeChanger(change);
    const ro = new ResizeObserver(measure);
    const side = el.parentElement!;
    ro.observe(side);
    for (const part of side.querySelectorAll(":scope > .tab-modes, :scope > .sidebar-footer"))
      ro.observe(part);
    // Mounted by the first switch, which the plain setter already committed.
    if (tabMode() !== "tabs") {
      widen(side, isDock(tabMode()));
      enter();
    }
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
      aria-label={
        {
          calendar: "Calendar",
          mail: "Mail",
          notes: "Notes",
          context: "Context",
          agent: "Flux Agent",
          terminal: "Terminal",
        }[shown()]
      }
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
        <Show when={seen().has("mail")}>
          <div class="mode-page mode-mail" hidden={shown() !== "mail"}>
            <Suspense>
              <MailPane inPane />
            </Suspense>
            <div class="mode-elsewhere">
              <DockToggle />
            </div>
          </div>
        </Show>
        <Show when={seen().has("notes")}>
          <div class="mode-page" hidden={shown() !== "notes"}>
            <Suspense>
              <TabNotes />
            </Suspense>
          </div>
        </Show>
        {/* Liquid Silk's Agent and Terminal: App's own column, moved in here
            (claim, above) so nothing restarts. */}
        <Show when={seen().has("agent") || seen().has("terminal")}>
          <div class="mode-page mode-dock" ref={dock} hidden={!isDock(shown())} />
        </Show>
        {/* Context: what the right-hand column holds, here instead. It lives in
            one place at a time; while the column is open, this says so. */}
        <Show when={seen().has("context")}>
          <div class="mode-page mode-context" hidden={shown() !== "context"}>
            <Show
              when={!props.connectOpen}
              fallback={
                <div class="mode-moved">
                  <p>Your notes, System and the Trail are in the column beside the page.</p>
                  <button class="mode-link" onClick={props.onToggleConnect}>
                    Bring them here
                  </button>
                </div>
              }
            >
              <Suspense>
                <ConnectionsRail />
              </Suspense>
              <div class="mode-elsewhere">
                <ColumnToggle
                  on={false}
                  what="your notes, System and Trail"
                  onToggle={props.onToggleConnect}
                />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default TabModePanel;
