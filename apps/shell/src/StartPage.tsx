/**
 * Flux start page — the new-tab dashboard (BACKLOG #71).
 *
 * Widget-dashboard layout (central search + glass cards) in Flux's velvet /
 * liquid-glass identity. Functional widgets over real state: the search hero
 * routes through the pluggable backend (#68); a live clock + real weather
 * (Open-Meteo); recent tabs; an editable speed dial (persisted); quick
 * actions; and a subtle flowing wave for the "flux" feel.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  FEEDS_URL,
  HISTORY_URL,
  OMNI_URL,
  calAdd,
  calEvents,
  feedItems,
  historyRecent,
  omniStats,
  type OmniStats,
  noteGet,
  noteSet,
  searchDefault,
  searchEngines,
  searchResolve,
  todoAdd,
  todoRemove,
  todoToggle,
  todosClearDone,
  todosList,
  type CalEvent,
  type FeedItem,
  type Todo,
} from "./ipc";
import { activeId, focusTab, liquidBg, tabs } from "./store";
import LiquidBackground from "./LiquidBackground";

/** Hostname without `www.`, best-effort. */
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.split("/")[2] ?? url; }
}

interface TopSite { url: string; title: string; host: string }

/** Persisted home-page scratchpad note (reuses the notes store, #53). */
const SCRATCH_KEY = "flux://start#scratchpad";

/** Extra clocks shown beside the local time. */
const WORLD_ZONES: { label: string; tz: string }[] = [
  { label: "New York", tz: "America/New_York" },
  { label: "London", tz: "Europe/London" },
  { label: "Tokyo", tz: "Asia/Tokyo" },
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

interface Shortcut {
  label: string;
  url: string;
  tint: string;
}

type ExpandedWidget = "recent" | "shortcuts" | "topSites" | "headlines" | "scratch" | "calendar" | "tasks" | "actions" | null;

const TINTS = ["#7b61ff", "#ec4be0", "#2ff3ff", "#ff9f45", "#ff6b4a", "#9d8df1", "#5bc0eb", "#7cf5b0"];

const DEFAULT_SHORTCUTS: Shortcut[] = [
  { label: "GH", url: "https://github.com", tint: "#7b61ff" },
  { label: "YT", url: "https://youtube.com", tint: "#ec4be0" },
  { label: "W", url: "https://wikipedia.org", tint: "#2ff3ff" },
  { label: "HN", url: "https://news.ycombinator.com", tint: "#ff9f45" },
  { label: "R", url: "https://reddit.com", tint: "#ff6b4a" },
];

/** WMO weather code → (emoji, short label). */
function weatherInfo(code: number): [string, string] {
  if (code === 0) return ["☀️", "Clear"];
  if (code <= 3) return ["⛅", "Partly cloudy"];
  if (code <= 48) return ["🌫️", "Fog"];
  if (code <= 67) return ["🌧️", "Rain"];
  if (code <= 77) return ["🌨️", "Snow"];
  if (code <= 82) return ["🌦️", "Showers"];
  if (code <= 86) return ["🌨️", "Snow showers"];
  return ["⛈️", "Thunderstorm"];
}

const StartPage: Component<{
  onNavigate: (url: string) => void;
  onNewTerminal: () => void;
  onToggleAgent: () => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  // Liquid backdrop (#77): falls back to the SVG wave if WebGL2/shader fails.
  const [liquidOk, setLiquidOk] = createSignal(true);
  const [engineName, setEngineName] = createSignal("");
  const [now, setNow] = createSignal(new Date());
  const [weather, setWeather] = createSignal<{ temp: number; code: number; city: string } | null>(null);
  const [headlines, setHeadlines] = createSignal<FeedItem[]>([]);
  const [topSites, setTopSites] = createSignal<TopSite[]>([]);
  const [scratch, setScratch] = createSignal("");
  let scratchTimer: number | undefined;
  const [events, setEvents] = createSignal<CalEvent[]>([]);
  const [addingCal, setAddingCal] = createSignal(false);
  const [newCalUrl, setNewCalUrl] = createSignal("");
  const [expandedWidget, setExpandedWidget] = createSignal<ExpandedWidget>(null);
  // Show/hide widgets (#71) — persisted list of hidden widget keys (the clock + hero
  // are always shown). `Customize` toggles a checklist popover.
  const WIDGETS: { key: string; label: string }[] = [
    { key: "recent", label: "Recent" },
    { key: "shortcuts", label: "Shortcuts" },
    { key: "topsites", label: "Top sites" },
    { key: "headlines", label: "Headlines" },
    { key: "scratchpad", label: "Scratchpad" },
    { key: "calendar", label: "Calendar & clocks" },
    { key: "tasks", label: "Tasks" },
    { key: "omni", label: "Omni index" },
    { key: "actions", label: "Quick actions" },
  ];
  const readHidden = (): string[] => { try { return JSON.parse(localStorage.getItem("flux.start.hidden") || "[]"); } catch { return []; } };
  const [hiddenWidgets, setHiddenWidgets] = createSignal<string[]>(readHidden());
  const widgetOn = (k: string) => !hiddenWidgets().includes(k);
  const toggleWidget = (k: string) => {
    const next = widgetOn(k) ? [...hiddenWidgets(), k] : hiddenWidgets().filter((x) => x !== k);
    setHiddenWidgets(next);
    localStorage.setItem("flux.start.hidden", JSON.stringify(next));
  };
  const [customizing, setCustomizing] = createSignal(false);
  // Widget order (#71) — persisted key order; merged with WIDGETS so new widgets are
  // appended and removed ones dropped. Applied via CSS `order` (the grid honours it);
  // the clock/hero stays first (order 0, since widget orders are 1-based).
  const readOrder = (): string[] => {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem("flux.start.order") || "[]"); } catch { saved = []; }
    const keys = WIDGETS.map((w) => w.key);
    const ordered = saved.filter((k) => keys.includes(k));
    for (const k of keys) if (!ordered.includes(k)) ordered.push(k);
    return ordered;
  };
  const [widgetOrder, setWidgetOrder] = createSignal<string[]>(readOrder());
  const orderOf = (k: string) => widgetOrder().indexOf(k) + 1;
  const orderedWidgets = () => widgetOrder().map((k) => WIDGETS.find((w) => w.key === k)).filter((w): w is { key: string; label: string } => !!w);
  const moveWidget = (k: string, dir: -1 | 1) => {
    const arr = [...widgetOrder()];
    const i = arr.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    setWidgetOrder(arr);
    localStorage.setItem("flux.start.order", JSON.stringify(arr));
  };
  // Omni index glance (#97).
  const [omni, setOmni] = createSignal<OmniStats | null>(null);
  // Custom start-page background (#71): an image URL or any CSS color/gradient.
  // Empty = the liquid/wave backdrop. Persisted.
  const [bg, setBgRaw] = createSignal(localStorage.getItem("flux.start.bg") || "");
  const setBg = (v: string) => { setBgRaw(v.trim()); localStorage.setItem("flux.start.bg", v.trim()); };
  const bgStyle = () => {
    const v = bg();
    if (!v) return undefined;
    return /^(https?:|data:|\/|\.)/.test(v)
      ? { "background-image": `url("${v}")`, "background-size": "cover", "background-position": "center" }
      : { background: v }; // a CSS color or gradient
  };
  const [selectedCalDate, setSelectedCalDate] = createSignal<string | null>(null);
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [newTodo, setNewTodo] = createSignal("");

  const loadShortcuts = (): Shortcut[] => {
    try {
      const s = localStorage.getItem("flux.shortcuts");
      if (s) return JSON.parse(s) as Shortcut[];
    } catch {
      /* fall through */
    }
    return DEFAULT_SHORTCUTS;
  };
  const [shortcuts, setShortcuts] = createSignal<Shortcut[]>(loadShortcuts());
  const [newUrl, setNewUrl] = createSignal("");

  const persist = (list: Shortcut[]) => {
    setShortcuts(list);
    localStorage.setItem("flux.shortcuts", JSON.stringify(list));
  };

  onMount(async () => {
    visibleInterval(() => setNow(new Date()), 1000);
    void omniStats().then(setOmni).catch(() => {}); // #97 glance widget (best-effort)

    try {
      const [def, engines] = await Promise.all([searchDefault(), searchEngines()]);
      setEngineName(engines.find((e) => e.id === def)?.name ?? "Search");
    } catch {
      setEngineName("Search");
    }

    // Real weather: IP geolocation → Open-Meteo (both free, no key, CORS-ok).
    try {
      const geo = await fetch("https://ipapi.co/json/").then((r) => r.json());
      const w = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,weather_code`,
      ).then((r) => r.json());
      setWeather({ temp: Math.round(w.current.temperature_2m), code: w.current.weather_code, city: geo.city });
    } catch {
      /* offline — the widget just omits weather */
    }

    // Feed headlines (#72) — aggregate of all subscribed feeds, newest-ish first.
    feedItems(0).then((items) => setHeadlines(items ?? [])).catch(() => {});

    // Top sites — most-visited hosts from history, deduped by host.
    historyRecent(250)
      .then((rows) => {
        const byHost = new Map<string, TopSite>();
        for (const h of rows ?? []) {
          if (h.url.startsWith("flux://")) continue;
          const host = hostOf(h.url);
          if (!byHost.has(host)) byHost.set(host, { url: h.url, title: h.title || host, host });
        }
        setTopSites([...byHost.values()].slice(0, 24));
      })
      .catch(() => {});

    // Scratchpad — persisted via the notes store.
    noteGet(SCRATCH_KEY).then((t) => setScratch(t ?? "")).catch(() => {});

    // Calendar events (#114) from subscribed ICS feeds + local tasks.
    loadEvents();
    refreshTodos();
  });

  const loadEvents = () => void calEvents().then((e) => setEvents(e ?? [])).catch(() => {});
  const refreshTodos = () => void todosList().then((t) => setTodos(t ?? [])).catch(() => {});

  const onScratch = (text: string) => {
    setScratch(text);
    clearTimeout(scratchTimer);
    scratchTimer = window.setTimeout(() => void noteSet(SCRATCH_KEY, text).catch(() => {}), 400);
  };
  onCleanup(() => clearTimeout(scratchTimer));

  const monthLabel = () => now().toLocaleDateString([], { month: "long", year: "numeric" });
  const monthCells = (): (number | null)[] => {
    const d = now();
    const first = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const cells: (number | null)[] = Array.from({ length: first }, () => null);
    for (let day = 1; day <= days; day++) cells.push(day);
    return cells;
  };
  const zoneTime = (tz: string) => {
    try { return now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz }); } catch { return ""; }
  };

  // ── Calendar (#114) ──────────────────────────────────────────────────────
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStrOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayStr = () => dateStrOf(now());
  const monthPrefix = () => `${now().getFullYear()}-${pad2(now().getMonth() + 1)}-`;
  const dateForDay = (day: number) => `${monthPrefix()}${pad2(day)}`;
  const isTodayDay = (day: number | null) => day !== null && dateForDay(day) === todayStr();
  const selectedDayNum = () => {
    const date = selectedCalDate();
    return date?.startsWith(monthPrefix()) ? Number(date.slice(8, 10)) : null;
  };
  /** Set of day-of-month numbers in the visible month that have ≥1 event. */
  const eventDays = (): Set<number> => {
    const p = monthPrefix();
    const s = new Set<number>();
    for (const e of events()) if (e.date.startsWith(p)) s.add(Number(e.date.slice(8, 10)));
    return s;
  };
  const eventsForDate = (date: string | null): CalEvent[] =>
    date ? events().filter((e) => e.date === date) : [];
  /** Next few events from today onward, for the list under the grid. */
  const upcoming = () => events().filter((e) => e.date >= todayStr()).slice(0, 4);
  const visibleCardEvents = () => selectedCalDate() ? eventsForDate(selectedCalDate()) : upcoming();
  const whenLabel = (e: CalEvent) => {
    const d = e.date === todayStr() ? "Today" : new Date(`${e.date}T00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return e.time ? `${d} · ${e.time}` : d;
  };
  const dayLabel = (date: string) =>
    date === todayStr() ? "Today" : new Date(`${date}T00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const eventListTitle = () => selectedCalDate() ? dayLabel(selectedCalDate()!) : "Upcoming";
  /** All events from today onward, grouped by date, for the expanded view. */
  const groupedEvents = (): { date: string; items: CalEvent[] }[] => {
    const groups: { date: string; items: CalEvent[] }[] = [];
    for (const e of events().filter((ev) => ev.date >= todayStr())) {
      const g = groups.at(-1);
      if (g && g.date === e.date) g.items.push(e);
      else groups.push({ date: e.date, items: [e] });
    }
    return groups;
  };
  const visibleEventGroups = (): { date: string; items: CalEvent[] }[] => {
    const selected = selectedCalDate();
    if (!selected) return groupedEvents();
    return [{ date: selected, items: eventsForDate(selected) }];
  };
  const selectCalDay = (day: number) => {
    const date = dateForDay(day);
    setSelectedCalDate((cur) => cur === date ? null : date);
  };
  const CalendarGrid: Component<{ modal?: boolean }> = (gridProps) => (
    <div classList={{ "start-cal": true, "cal-modal-cal": !!gridProps.modal }}>
      <For each={WEEKDAYS}>{(w) => <span class="start-cal-wd">{w}</span>}</For>
      <For each={monthCells()}>
        {(c) => (
          <Show
            when={c !== null}
            fallback={<span class="start-cal-day blank" />}
          >
            <button
              type="button"
              classList={{
                "start-cal-day": true,
                today: isTodayDay(c),
                selected: selectedDayNum() === c,
                "has-event": eventDays().has(c!),
              }}
              aria-pressed={selectedDayNum() === c ? "true" : "false"}
              title={`Show events for ${dayLabel(dateForDay(c!))}`}
              onClick={() => selectCalDay(c!)}
            >
              {c}
            </button>
          </Show>
        )}
      </For>
    </div>
  );
  const addCalendar = (ev: SubmitEvent) => {
    ev.preventDefault();
    const url = newCalUrl().trim();
    if (!url) return;
    void calAdd(url).then(() => { setNewCalUrl(""); setAddingCal(false); loadEvents(); }).catch(() => {});
  };

  // ── Tasks (#114) ───────────────────────────────────────────────────────────
  const addTodo = (ev: SubmitEvent) => {
    ev.preventDefault();
    const title = newTodo().trim();
    if (!title) return;
    void todoAdd(title).then(() => { setNewTodo(""); refreshTodos(); }).catch(() => {});
  };
  const toggleTodo = (id: number) => void todoToggle(id).then(refreshTodos).catch(() => {});
  const removeTodo = (id: number) => void todoRemove(id).then(refreshTodos).catch(() => {});
  const clearDoneTodos = () => void todosClearDone().then(refreshTodos).catch(() => {});
  const openTodos = () => todos().filter((t) => !t.done).length;
  const sortedTodos = () => [...todos()].sort((a, b) => Number(a.done) - Number(b.done));

  const greeting = () => {
    const h = now().getHours();
    return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  };
  const clock = () => now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = () => now().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const v = query().trim();
    if (!v) return;
    setQuery("");
    const { url } = await searchResolve(v);
    props.onNavigate(url);
  };

  const addShortcut = (e: SubmitEvent) => {
    e.preventDefault();
    const v = newUrl().trim();
    if (!v) return;
    const url = /^https?:\/\//.test(v) ? v : `https://${v}`;
    const host = (url.split("/")[2] ?? url).replace(/^www\./, "");
    const label = host.slice(0, 2).toUpperCase();
    const tint = TINTS[shortcuts().length % TINTS.length] ?? "#7b61ff";
    persist([...shortcuts(), { label, url, tint }]);
    setNewUrl("");
  };
  const removeShortcut = (i: number) => persist(shortcuts().filter((_, j) => j !== i));

  const recent = () =>
    tabs().filter(
      (t) => t.kind === "browser" && !t.pinned && t.id !== activeId() && !t.url.startsWith("flux://"),
    );

  return (
    <div class="start" style={bgStyle()}>
      <button class="start-customize" title="Show/hide widgets" onClick={() => setCustomizing((v) => !v)}>⚙</button>
      <Show when={customizing()}>
        <div class="shield-backdrop" onClick={() => setCustomizing(false)} />
        <div class="glass popover start-customize-pop">
          <div class="ctx-label">Widgets — toggle to show/hide, ↑↓ to reorder</div>
          <For each={orderedWidgets()}>
            {(w, i) => (
              <div class="start-customize-row">
                <input type="checkbox" checked={widgetOn(w.key)} onChange={() => toggleWidget(w.key)} />
                <span class="start-customize-name">{w.label}</span>
                <button class="start-customize-move" disabled={i() === 0} title="Move up" onClick={() => moveWidget(w.key, -1)}>↑</button>
                <button class="start-customize-move" disabled={i() === orderedWidgets().length - 1} title="Move down" onClick={() => moveWidget(w.key, 1)}>↓</button>
              </div>
            )}
          </For>
          <div class="ctx-sep" />
          <div class="ctx-label">Background — image URL or CSS color (empty = liquid)</div>
          <input
            class="start-customize-bg"
            value={bg()}
            placeholder="https://…/wallpaper.jpg  ·  #0b0a1d  ·  empty"
            spellcheck={false}
            onChange={(e) => setBg(e.currentTarget.value)}
          />
        </div>
      </Show>
      <header class="start-hero">
        <div class="start-brand">
          <span class="start-spark">✦</span> Flux
        </div>
        <div class="start-greeting">{greeting()}</div>

        <form class="start-search glass" onSubmit={submit}>
          <span class="start-search-icon">⌕</span>
          <input
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search the web or enter a URL"
            spellcheck={false}
            autofocus
          />
          <Show when={engineName()}>
            <span class="start-engine">{engineName()}</span>
          </Show>
        </form>
        <div class="start-hint">
          <kbd>!g</kbd> Google · type a site to go there · everything else searches {engineName()}
        </div>
      </header>

      <div class="start-scroll">
      <section class="start-cards">
        {/* Clock + weather */}
        <div class="glass start-card start-clock">
          <div class="start-clock-time">{clock()}</div>
          <div class="start-clock-date">{dateStr()}</div>
          <Show when={weather()}>
            {(w) => (
              <div class="start-weather">
                {weatherInfo(w().code)[0]} {w().temp}° · {weatherInfo(w().code)[1]}
                <span class="start-weather-city">{w().city}</span>
              </div>
            )}
          </Show>
        </div>

        {/* Recent tabs */}
        <div class="glass start-card" style={{ display: widgetOn("recent") ? undefined : "none", order: orderOf("recent") }}>
          <div class="start-card-title">
            Recent
            <button class="start-card-link" title="Expand recent tabs" onClick={() => setExpandedWidget("recent")}>⤢ Expand</button>
          </div>
          <Show
            when={recent().length > 0}
            fallback={<div class="start-empty">Open a few tabs and they'll show up here.</div>}
          >
            <div class="start-list start-card-body">
              <For each={recent().slice(0, 6)}>
                {(t) => (
                  <button class="start-row" onClick={() => focusTab(t.id)} title={t.url}>
                    <span class="start-fav">{favicon(t.url)}</span>
                    <span class="start-row-label">{t.title || t.url}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Editable speed dial */}
        <div class="glass start-card" style={{ display: widgetOn("shortcuts") ? undefined : "none", order: orderOf("shortcuts") }}>
          <div class="start-card-title">
            Shortcuts
            <button class="start-card-link" title="Expand shortcuts" onClick={() => setExpandedWidget("shortcuts")}>⤢ Expand</button>
          </div>
          <div class="start-card-body">
            <div class="start-dial">
              <For each={shortcuts().slice(0, 5)}>
                {(s, i) => (
                  <div class="start-tile-wrap">
                    <button class="start-tile" style={{ "--tint": s.tint }} onClick={() => props.onNavigate(s.url)} title={s.url}>
                      {s.label}
                    </button>
                    <button class="start-tile-x" title="Remove" onClick={() => removeShortcut(i())}>×</button>
                  </div>
                )}
              </For>
              <button class="start-tile start-tile-add" title="Add shortcut" onClick={() => setExpandedWidget("shortcuts")}>+</button>
            </div>
          </div>
        </div>

        {/* Top sites */}
        <Show when={widgetOn("topsites") && topSites().length > 0}>
          <div class="glass start-card" style={{ order: orderOf("topsites") }}>
            <div class="start-card-title">
              Top sites
              <button class="start-card-link" title="Expand top sites" onClick={() => setExpandedWidget("topSites")}>⤢ Expand</button>
            </div>
            <div class="start-dial start-card-body">
              <For each={topSites().slice(0, 6)}>
                {(s, i) => (
                  <div class="start-tile-wrap">
                    <button
                      class="start-tile"
                      style={{ "--tint": TINTS[i() % TINTS.length] }}
                      onClick={() => props.onNavigate(s.url)}
                      title={s.title}
                    >
                      {(s.host[0] ?? "?").toUpperCase()}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Feed headlines (#72) */}
        <div class="glass start-card" style={{ display: widgetOn("headlines") ? undefined : "none", order: orderOf("headlines") }}>
          <div class="start-card-title">
            Headlines
            <span class="start-card-actions">
              <button class="start-card-link" title="Expand headlines" onClick={() => setExpandedWidget("headlines")}>⤢ Expand</button>
              <button class="start-card-link" onClick={() => props.onNavigate(FEEDS_URL)}>Feeds →</button>
            </span>
          </div>
          <Show
            when={headlines().length > 0}
            fallback={<div class="start-empty">Subscribe to feeds in <b>Feeds</b> and the latest items show here.</div>}
          >
            <div class="start-list start-card-body">
              <For each={headlines().slice(0, 6)}>
                {(it) => (
                  <button class="start-row" onClick={() => props.onNavigate(it.link)} title={`${it.feed_title} — ${it.title}`}>
                    <span class="start-fav">📰</span>
                    <span class="start-row-label">{it.title}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Scratchpad */}
        <div class="glass start-card" style={{ display: widgetOn("scratchpad") ? undefined : "none", order: orderOf("scratchpad") }}>
          <div class="start-card-title">
            Scratchpad
            <button class="start-card-link" title="Expand scratchpad" onClick={() => setExpandedWidget("scratch")}>⤢ Expand</button>
          </div>
          <textarea
            class="start-scratch"
            value={scratch()}
            onInput={(e) => onScratch(e.currentTarget.value)}
            placeholder="Jot a quick note, todo, or link… saved automatically."
            spellcheck={false}
          />
        </div>

        {/* Calendar (Google via ICS, #114) + world clocks */}
        <div class="glass start-card" style={{ display: widgetOn("calendar") ? undefined : "none", order: orderOf("calendar") }}>
          <div class="start-card-title">
            {monthLabel()}
            <span class="start-card-actions">
              <Show when={events().length > 0}>
                <button class="start-card-link" title="Expand — see all events" onClick={() => setExpandedWidget("calendar")}>⤢ Expand</button>
              </Show>
              <button class="start-card-link" title="Subscribe to a calendar's secret ICS URL" onClick={() => setAddingCal((v) => !v)}>＋ Calendar</button>
            </span>
          </div>
          <Show when={addingCal()}>
            <form class="start-add" onSubmit={addCalendar}>
              <input
                value={newCalUrl()}
                onInput={(e) => setNewCalUrl(e.currentTarget.value)}
                placeholder="Paste your calendar's secret .ics URL"
                spellcheck={false}
                autofocus
              />
              <button type="submit">Add</button>
            </form>
          </Show>
          <CalendarGrid />
          <Show when={visibleCardEvents().length > 0}>
            <div class="start-events">
              <div class="start-event-list-title">{eventListTitle()}</div>
              <For each={visibleCardEvents().slice(0, 2)}>
                {(e) => (
                  <div class="start-event" title={e.location ? `${e.summary} · ${e.location}` : e.summary}>
                    <span class="start-event-when">{whenLabel(e)}</span>
                    <span class="start-event-title">{e.summary}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={selectedCalDate() && visibleCardEvents().length === 0}>
            <div class="start-events">
              <div class="start-event-list-title">{eventListTitle()}</div>
              <div class="start-empty">No events for this day.</div>
            </div>
          </Show>
          <div class="start-zones">
            <For each={WORLD_ZONES}>
              {(z) => (
                <div class="start-zone">
                  <span class="start-zone-label">{z.label}</span>
                  <span class="start-zone-time">{zoneTime(z.tz)}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        {/* Tasks (#114) — local, on-device */}
        <div class="glass start-card" style={{ display: widgetOn("tasks") ? undefined : "none", order: orderOf("tasks") }}>
          <div class="start-card-title">
            Tasks
            <span class="start-card-actions">
              <button class="start-card-link" title="Expand tasks" onClick={() => setExpandedWidget("tasks")}>⤢ Expand</button>
              <Show when={todos().some((t) => t.done)}>
                <button class="start-card-link" onClick={clearDoneTodos}>Clear done</button>
              </Show>
            </span>
          </div>
          <form class="start-todo-add" onSubmit={addTodo}>
            <input
              value={newTodo()}
              onInput={(e) => setNewTodo(e.currentTarget.value)}
              placeholder="Add a task…"
              spellcheck={false}
            />
          </form>
          <Show
            when={todos().length > 0}
            fallback={<div class="start-empty">Nothing yet — add a task above. Stored on your device.</div>}
          >
            <div class="start-todos start-card-body">
              <For each={sortedTodos().slice(0, 5)}>
                {(t) => (
                  <div classList={{ "start-todo": true, done: t.done }}>
                    <button class="start-todo-check" title={t.done ? "Mark not done" : "Mark done"} onClick={() => toggleTodo(t.id)}>{t.done ? "☑" : "☐"}</button>
                    <span class="start-todo-title">{t.title}</span>
                    <Show when={t.due}><span class="start-todo-due">{t.due}</span></Show>
                    <button class="start-todo-x" title="Remove" onClick={() => removeTodo(t.id)}>×</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={openTodos() > 0}><div class="start-todo-count">{openTodos()} open</div></Show>
        </div>

        {/* Omni index glance (#97) */}
        <div class="glass start-card" style={{ display: widgetOn("omni") ? undefined : "none", order: orderOf("omni") }}>
          <div class="start-card-title">
            Omni index
            <button class="start-card-link" title="Open the Omni dashboard" onClick={() => props.onNavigate(OMNI_URL)}>⤢ Dashboard</button>
          </div>
          <Show when={omni()} fallback={<div class="start-empty">Your local search index — save pages with ⌘⇧O and they're searchable here.</div>}>
            {(s) => (
              <div class="start-card-body start-omni">
                <div class="start-omni-row">
                  <div class="start-omni-stat"><span class="start-omni-num">{s().live_docs.toLocaleString()}</span><span class="start-omni-lbl">pages</span></div>
                  <div class="start-omni-stat"><span class="start-omni-num">{s().ann_vectors.toLocaleString()}</span><span class="start-omni-lbl">vectors</span></div>
                </div>
                <div class="start-omni-meta">{s().embedder_kind}{s().embedded ? ` · ${s().embedder_dim}-dim` : " · hashing (offline)"}</div>
              </div>
            )}
          </Show>
        </div>

        {/* Quick actions */}
        <div class="glass start-card" style={{ display: widgetOn("actions") ? undefined : "none", order: orderOf("actions") }}>
          <div class="start-card-title">
            Quick actions
            <button class="start-card-link" title="Expand quick actions" onClick={() => setExpandedWidget("actions")}>⤢ Expand</button>
          </div>
          <div class="start-actions">
            <button class="start-action" onClick={props.onNewTerminal}>
              <span class="start-action-icon">⌨</span> New terminal
            </button>
            <button class="start-action" onClick={props.onToggleAgent}>
              <span class="start-action-icon" style={{ color: "var(--flux-violet)" }}>✦</span> Ask Flux Agent
            </button>
            <button class="start-action" onClick={() => props.onNavigate(OMNI_URL)}>
              <span class="start-action-icon" style={{ color: "var(--flux-teal)" }}>✦</span> Omni index
            </button>
            <button class="start-action" onClick={() => props.onNavigate(HISTORY_URL)}>
              <span class="start-action-icon">🕘</span> History
            </button>
          </div>
        </div>
      </section>
      </div>

      {/* Expanded widgets — dashboard cards keep a fixed footprint; dense content
          opens here instead of resizing the grid. */}
      <Show when={expandedWidget()}>
        <div class="cal-modal-backdrop" onClick={() => setExpandedWidget(null)} onKeyDown={(e) => { if (e.key === "Escape") setExpandedWidget(null); }}>
          <div class="cal-modal glass" onClick={(e) => e.stopPropagation()}>
            <div class="cal-modal-head">
              <span class="cal-modal-title">
                {expandedWidget() === "recent" ? "Recent tabs"
                  : expandedWidget() === "shortcuts" ? "Shortcuts"
                  : expandedWidget() === "topSites" ? "Top sites"
                  : expandedWidget() === "headlines" ? "Headlines"
                  : expandedWidget() === "scratch" ? "Scratchpad"
                  : expandedWidget() === "tasks" ? "Tasks"
                  : expandedWidget() === "actions" ? "Quick actions"
                  : monthLabel()}
              </span>
              <button class="files-panel-x" title="Close (Esc)" onClick={() => setExpandedWidget(null)}>✕</button>
            </div>
            <Show when={expandedWidget() === "calendar"}>
              <div class="cal-modal-body">
                <div class="cal-modal-grid">
                  <CalendarGrid modal />
                </div>
                <div class="cal-modal-events">
                  <Show when={visibleEventGroups().some((g) => g.items.length > 0)} fallback={<div class="start-empty">{selectedCalDate() ? "No events for this day." : "No upcoming events."}</div>}>
                    <For each={visibleEventGroups().filter((g) => g.items.length > 0)}>
                      {(g) => (
                        <div class="cal-day-group">
                          <div class="cal-day-header">{dayLabel(g.date)}</div>
                          <For each={g.items}>
                            {(e) => (
                              <div class="cal-day-event">
                                <span class="cal-event-time">{e.time || "all-day"}</span>
                                <div class="cal-event-main">
                                  <span class="cal-event-title">{e.summary}</span>
                                  <Show when={e.location || e.calendar}>
                                    <span class="cal-event-sub">{[e.calendar, e.location].filter(Boolean).join(" · ")}</span>
                                  </Show>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={expandedWidget() !== "calendar"}>
              <div class="widget-modal-body">
                <Show when={expandedWidget() === "recent"}>
                  <div class="start-list">
                    <For each={recent()}>{(t) => <button class="start-row" onClick={() => { setExpandedWidget(null); focusTab(t.id); }} title={t.url}><span class="start-fav">{favicon(t.url)}</span><span class="start-row-label">{t.title || t.url}</span></button>}</For>
                  </div>
                </Show>
                <Show when={expandedWidget() === "shortcuts"}>
                  <div class="start-dial widget-modal-dial">
                    <For each={shortcuts()}>
                      {(s, i) => (
                        <div class="start-tile-wrap">
                          <button class="start-tile" style={{ "--tint": s.tint }} onClick={() => { setExpandedWidget(null); props.onNavigate(s.url); }} title={s.url}>{s.label}</button>
                          <button class="start-tile-x" title="Remove" onClick={() => removeShortcut(i())}>×</button>
                        </div>
                      )}
                    </For>
                  </div>
                  <form class="start-add" onSubmit={addShortcut}>
                    <input value={newUrl()} onInput={(e) => setNewUrl(e.currentTarget.value)} placeholder="example.com" spellcheck={false} />
                    <button type="submit">Add</button>
                  </form>
                </Show>
                <Show when={expandedWidget() === "topSites"}>
                  <div class="start-dial widget-modal-dial">
                    <For each={topSites()}>
                      {(s, i) => <button class="start-tile" style={{ "--tint": TINTS[i() % TINTS.length] }} onClick={() => { setExpandedWidget(null); props.onNavigate(s.url); }} title={s.title}>{(s.host[0] ?? "?").toUpperCase()}</button>}
                    </For>
                  </div>
                </Show>
                <Show when={expandedWidget() === "headlines"}>
                  <div class="start-list">
                    <For each={headlines()}>{(it) => <button class="start-row" onClick={() => { setExpandedWidget(null); props.onNavigate(it.link); }} title={`${it.feed_title} — ${it.title}`}><span class="start-fav">📰</span><span class="start-row-label">{it.title}</span></button>}</For>
                  </div>
                </Show>
                <Show when={expandedWidget() === "scratch"}>
                  <textarea class="start-scratch widget-modal-scratch" value={scratch()} onInput={(e) => onScratch(e.currentTarget.value)} spellcheck={false} />
                </Show>
                <Show when={expandedWidget() === "tasks"}>
                  <form class="start-todo-add" onSubmit={addTodo}>
                    <input value={newTodo()} onInput={(e) => setNewTodo(e.currentTarget.value)} placeholder="Add a task…" spellcheck={false} />
                  </form>
                  <div class="start-todos">
                    <For each={sortedTodos()}>
                      {(t) => (
                        <div classList={{ "start-todo": true, done: t.done }}>
                          <button class="start-todo-check" title={t.done ? "Mark not done" : "Mark done"} onClick={() => toggleTodo(t.id)}>{t.done ? "☑" : "☐"}</button>
                          <span class="start-todo-title">{t.title}</span>
                          <Show when={t.due}><span class="start-todo-due">{t.due}</span></Show>
                          <button class="start-todo-x" title="Remove" onClick={() => removeTodo(t.id)}>×</button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={expandedWidget() === "actions"}>
                  <div class="start-actions widget-modal-actions">
                    <button class="start-action" onClick={() => { setExpandedWidget(null); props.onNewTerminal(); }}><span class="start-action-icon">⌨</span> New terminal</button>
                    <button class="start-action" onClick={() => { setExpandedWidget(null); props.onToggleAgent(); }}><span class="start-action-icon" style={{ color: "var(--flux-violet)" }}>✦</span> Ask Flux Agent</button>
                    <button class="start-action" onClick={() => { setExpandedWidget(null); props.onNavigate(OMNI_URL); }}><span class="start-action-icon" style={{ color: "var(--flux-teal)" }}>✦</span> Omni index</button>
                    <button class="start-action" onClick={() => { setExpandedWidget(null); props.onNavigate(HISTORY_URL); }}><span class="start-action-icon">🕘</span> History</button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      {/* Backdrop (#77): the WebGL particle-liquid, or — when it's toggled off,
          unsupported, or the shader fails — the cheap SMIL flowing wave. The
          liquid only animates while this (the active) tab is visible + focused. */}
      <Show
        when={liquidBg() && liquidOk()}
        fallback={
          <svg class="start-wave" viewBox="0 0 1440 220" preserveAspectRatio="none" aria-hidden="true">
            <g>
              <path class="start-wave-1" d="M0 120 Q 240 60 480 120 T 960 120 T 1440 120 T 1920 120 V220 H0 Z" />
              <animateTransform attributeName="transform" type="translate" from="0 0" to="-480 0" dur="14s" repeatCount="indefinite" />
            </g>
            <g>
              <path class="start-wave-2" d="M0 150 Q 240 110 480 150 T 960 150 T 1440 150 T 1920 150 V220 H0 Z" />
              <animateTransform attributeName="transform" type="translate" from="0 0" to="-480 0" dur="9s" repeatCount="indefinite" />
            </g>
          </svg>
        }
      >
        <LiquidBackground active={() => true} onFallback={() => setLiquidOk(false)} />
      </Show>
    </div>
  );
};

/** Letter favicon stand-in (BACKLOG #21). */
function favicon(url: string): string {
  const host = url.split("/")[2] ?? url;
  return (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
}

export default StartPage;
