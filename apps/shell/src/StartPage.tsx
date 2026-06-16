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
import { HISTORY_URL, OMNI_URL, searchDefault, searchEngines, searchResolve } from "./ipc";
import { activeId, focusTab, tabs } from "./store";

interface Shortcut {
  label: string;
  url: string;
  tint: string;
}

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
  const [engineName, setEngineName] = createSignal("");
  const [now, setNow] = createSignal(new Date());
  const [weather, setWeather] = createSignal<{ temp: number; code: number; city: string } | null>(null);

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
  const [adding, setAdding] = createSignal(false);
  const [newUrl, setNewUrl] = createSignal("");

  const persist = (list: Shortcut[]) => {
    setShortcuts(list);
    localStorage.setItem("flux.shortcuts", JSON.stringify(list));
  };

  onMount(async () => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    onCleanup(() => clearInterval(timer));

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
  });

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
    setAdding(false);
  };
  const removeShortcut = (i: number) => persist(shortcuts().filter((_, j) => j !== i));

  const recent = () =>
    tabs().filter(
      (t) => t.kind === "browser" && !t.pinned && t.id !== activeId() && !t.url.startsWith("flux://"),
    );

  return (
    <div class="start">
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
        <div class="glass start-card">
          <div class="start-card-title">Recent</div>
          <Show
            when={recent().length > 0}
            fallback={<div class="start-empty">Open a few tabs and they'll show up here.</div>}
          >
            <div class="start-list">
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
        <div class="glass start-card">
          <div class="start-card-title">Shortcuts</div>
          <div class="start-dial">
            <For each={shortcuts()}>
              {(s, i) => (
                <div class="start-tile-wrap">
                  <button class="start-tile" style={{ "--tint": s.tint }} onClick={() => props.onNavigate(s.url)} title={s.url}>
                    {s.label}
                  </button>
                  <button class="start-tile-x" title="Remove" onClick={() => removeShortcut(i())}>×</button>
                </div>
              )}
            </For>
            <button class="start-tile start-tile-add" title="Add shortcut" onClick={() => setAdding((v) => !v)}>+</button>
          </div>
          <Show when={adding()}>
            <form class="start-add" onSubmit={addShortcut}>
              <input
                value={newUrl()}
                onInput={(e) => setNewUrl(e.currentTarget.value)}
                placeholder="example.com"
                spellcheck={false}
                autofocus
              />
              <button type="submit">Add</button>
            </form>
          </Show>
        </div>

        {/* Quick actions */}
        <div class="glass start-card">
          <div class="start-card-title">Quick actions</div>
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

      {/* Subtle flowing wave — the "flux" feel. Paths span wider than the
          viewBox so the SMIL translate loops seamlessly. (Richer motion is
          BACKLOG #77.) */}
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
    </div>
  );
};

/** Letter favicon stand-in (BACKLOG #21). */
function favicon(url: string): string {
  const host = url.split("/")[2] ?? url;
  return (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
}

export default StartPage;
