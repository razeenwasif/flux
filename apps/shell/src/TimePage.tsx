/**
 * flux://time — Time & Focus (Flux Next; sitetime.rs, focus.rs).
 *
 * Time: where today (or this week) went on the web, by hour (or day), and
 * each site against the day (or week) before; under five minutes of change
 * reads "About the same". Counted only while Flux is in front, kept on this Mac.
 * Focus: start a session that closes chosen sites, or watch the one running.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";

import { TIME_URL, type TimeReport } from "./ipc";
import { focusEnd, focusPause, focusSet, focusStart, timeForget, timeReport } from "./focusIpc";
import { clockOf, focus, focusLeft, refreshFocus } from "./focusStore";
import { visibleInterval } from "./poll";
import { titleInternalTab } from "./store";
import "./TimePage.css";

/** "4h 12m", "58m", "under a minute". */
export const duration = (secs: number): string => {
  const m = Math.round(secs / 60);
  if (m < 1) return secs > 0 ? "<1m" : "0m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};

const SAME = 5 * 60;
const LENGTHS = [25, 50, 90];

const TimePage: Component = () => {
  const [week, setWeek] = createSignal(false);
  const [report, setReport] = createSignal<TimeReport | null>(null);
  const load = () =>
    void timeReport(week())
      .then(setReport)
      .catch(() => {});
  onMount(() => {
    titleInternalTab(TIME_URL, "Time & Focus");
    load();
    void refreshFocus();
  });
  visibleInterval(load, 30_000);
  const pick = (w: boolean) => {
    setWeek(w);
    load();
  };

  const now = new Date();
  const max = createMemo(() => Math.max(1, ...(report()?.bars.map((b) => b.secs) ?? [0])));
  const busiest = createMemo(() => {
    const r = report();
    if (!r || !r.total_secs) return "";
    const i = r.bars.reduce((best, b, j) => (b.secs > r.bars[best]!.secs ? j : best), 0);
    if (week()) return `most on ${r.bars[i]!.label}`;
    const h = new Date(2000, 0, 1, i).toLocaleTimeString(undefined, { hour: "numeric" });
    return `most in the ${h} hour`;
  });
  const current = (i: number) => (week() ? i === 6 : i === now.getHours());
  const topSite = createMemo(() => Math.max(1, ...(report()?.sites.map((s) => s.secs) ?? [0])));
  const change = (secs: number, prev: number) => {
    const d = secs - prev;
    if (Math.abs(d) < SAME) return { text: "About the same", dir: "same" };
    return { text: `${d > 0 ? "+" : "−"}${duration(Math.abs(d))}`, dir: d > 0 ? "up" : "down" };
  };
  const forget = async () => {
    if (!confirm("Forget all the time Flux has counted?")) return;
    await timeForget().catch(() => {});
    load();
  };

  // Focus: the form while none runs.
  const [name, setName] = createSignal("");
  const [minutes, setMinutes] = createSignal(25);
  const [adding, setAdding] = createSignal("");
  const sites = () => focus()?.sites ?? [];
  const setSites = (next: string[]) =>
    void focusSet(next)
      .then(refreshFocus)
      .catch(() => {});
  const addSite = () => {
    const s = adding().trim();
    if (!s) return;
    setSites([...sites(), s]);
    setAdding("");
  };
  const start = () =>
    void focusStart(name(), minutes(), sites())
      .then(refreshFocus)
      .catch(() => {});

  const R = 78;
  const CIRC = 2 * Math.PI * R;
  const done = () => {
    const f = focus();
    return f?.running ? 1 - focusLeft() / (f.minutes * 60_000) : 0;
  };
  const endsAt = () =>
    new Date(Date.now() + focusLeft()).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const goal = () => (focus()?.goal_minutes ?? 120) * 60;

  return (
    <div class="tp-page">
      <section class="tp-card tp-time" aria-labelledby="tp-time-h">
        <span class="tp-legend" id="tp-time-h">
          Time
        </span>
        <div class="tp-time-head">
          <div>
            <p class="tp-date">
              {week()
                ? "The last seven days"
                : now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            </p>
            <p class="tp-total">
              <span>{duration(report()?.total_secs ?? 0)}</span> on the web
            </p>
          </div>
          <div class="tp-seg" role="radiogroup" aria-label="Period">
            <button
              role="radio"
              aria-checked={!week()}
              classList={{ on: !week() }}
              onClick={() => pick(false)}
            >
              Today
            </button>
            <button role="radio" aria-checked={week()} classList={{ on: week() }} onClick={() => pick(true)}>
              This week
            </button>
          </div>
        </div>
        <figure class="tp-chart">
          <div class="tp-bars" classList={{ week: week() }} aria-hidden="true">
            <For each={report()?.bars ?? []}>
              {(b, i) => (
                <span
                  class="tp-bar"
                  classList={{ now: current(i()) }}
                  style={{ height: `${Math.max(b.secs ? 3 : 1, (b.secs / max()) * 100)}%` }}
                  title={`${b.label}: ${duration(b.secs)}`}
                />
              )}
            </For>
          </div>
          <div class="tp-axis" aria-hidden="true">
            <Show
              when={week()}
              fallback={<For each={["00", "06", "12", "18", "24"]}>{(l) => <span>{l}</span>}</For>}
            >
              <For each={report()?.bars ?? []}>{(b) => <span>{b.label}</span>}</For>
            </Show>
          </div>
          <figcaption class="tp-sr">
            {week() ? "Time on the web each day this week" : "Minutes on the web in each hour today"}
            {busiest() ? `; ${busiest()}` : ""}
          </figcaption>
        </figure>
        <table class="tp-sites">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col" class="tp-bar-col">
                <span class="tp-sr">Share</span>
              </th>
              <th scope="col" class="num">
                {week() ? "This week" : "Today"}
              </th>
              <th scope="col" class="num">
                {week() ? "Vs last week" : "Vs yesterday"}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={report()?.sites ?? []}>
              {(s) => (
                <tr>
                  <td class="tp-site">
                    <span class="tp-fav" aria-hidden="true">
                      {s.host[0]!.toUpperCase()}
                    </span>
                    <span class="tp-host" title={s.host}>
                      {s.host}
                    </span>
                  </td>
                  <td class="tp-bar-col">
                    <span class="tp-share">
                      <span style={{ width: `${(s.secs / topSite()) * 100}%` }} />
                    </span>
                  </td>
                  <td class="num mono">{duration(s.secs)}</td>
                  <td class={`num tp-change ${change(s.secs, s.prev_secs).dir}`}>
                    <span aria-hidden="true">
                      {{ up: "↑ ", down: "↓ ", same: "— " }[change(s.secs, s.prev_secs).dir]}
                    </span>
                    {change(s.secs, s.prev_secs).text}
                  </td>
                </tr>
              )}
            </For>
            <Show when={report()?.other_count}>
              <tr class="tp-other">
                <td>
                  {report()!.other_count} other site{report()!.other_count === 1 ? "" : "s"}
                </td>
                <td class="tp-bar-col" />
                <td class="num mono">{duration(report()!.other_secs)}</td>
                <td />
              </tr>
            </Show>
          </tbody>
        </table>
        <Show when={!report()?.total_secs}>
          <p class="tp-empty">Nothing counted yet {week() ? "this week" : "today"}.</p>
        </Show>
        <p class="tp-foot">
          Counted on this Mac only, while Flux is in front.{" "}
          <button class="tp-link" onClick={() => void forget()}>
            Forget it
          </button>
        </p>
      </section>

      <section class="tp-card tp-focus" aria-labelledby="tp-focus-h">
        <span class="tp-legend" id="tp-focus-h">
          Focus
        </span>
        <Show when={focus()?.running}>
          <span class="tp-state">{focus()!.paused ? "Paused" : "Running"}</span>
        </Show>
        <Show
          when={focus()?.running}
          fallback={
            <div class="tp-start">
              <label class="tp-field">
                <span>What are you working on?</span>
                <input
                  value={name()}
                  placeholder="COMP3320 assignment 2"
                  onInput={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && start()}
                />
              </label>
              <div class="tp-lengths" role="radiogroup" aria-label="Length">
                <For each={LENGTHS}>
                  {(m) => (
                    <button
                      role="radio"
                      aria-checked={minutes() === m}
                      classList={{ on: minutes() === m }}
                      onClick={() => setMinutes(m)}
                    >
                      {m} min
                    </button>
                  )}
                </For>
              </div>
              <p class="tp-sub">
                Closes {sites().length} site{sites().length === 1 ? "" : "s"} while it runs
              </p>
              <div class="tp-chips">
                <For each={sites()}>
                  {(s) => (
                    <span class="tp-chip">
                      <span aria-hidden="true">⦸</span> {s}
                      <button
                        aria-label={`Stop blocking ${s}`}
                        onClick={() => setSites(sites().filter((x) => x !== s))}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </For>
                <input
                  class="tp-add"
                  aria-label="Add a site to block"
                  placeholder="Add a site"
                  value={adding()}
                  onInput={(e) => setAdding(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSite()}
                />
              </div>
              <div class="tp-actions">
                <button class="tp-btn primary" onClick={start}>
                  Start focus
                </button>
              </div>
            </div>
          }
        >
          <div class="tp-running">
            <svg class="tp-ring" viewBox="0 0 180 180" role="img" aria-label={`${clockOf(focusLeft())} left`}>
              <defs>
                <linearGradient id="tp-ring-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#f3b6d3" />
                  <stop offset="0.5" stop-color="#c9b5ff" />
                  <stop offset="1" stop-color="#a9e6ec" />
                </linearGradient>
              </defs>
              <circle class="tp-ring-track" cx="90" cy="90" r={R} />
              <circle
                class="tp-ring-arc"
                cx="90"
                cy="90"
                r={R}
                stroke="url(#tp-ring-grad)"
                stroke-dasharray={`${(done() * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`}
                transform="rotate(-90 90 90)"
              />
              <text class="tp-ring-time" x="90" y="92" text-anchor="middle">
                {clockOf(focusLeft())}
              </text>
              <text class="tp-ring-note" x="90" y="116" text-anchor="middle">
                left
              </text>
            </svg>
            <div class="tp-session">
              <p class="tp-kicker">{focus()!.minutes}-minute session</p>
              <h2>{focus()!.name || "Focus"}</h2>
              <p class="tp-sub">
                {Math.floor(focus()!.elapsed_ms / 60_000)} of {focus()!.minutes} minutes
                {focus()!.paused ? " · paused" : ` · ends ${endsAt()}`}
              </p>
            </div>
          </div>
          <p class="tp-sub">
            {focus()!.paused ? "Open during the break: " : "Blocks "}
            {focus()!.blocks.length} site{focus()!.blocks.length === 1 ? "" : "s"}
          </p>
          <div class="tp-chips">
            <For each={focus()!.blocks}>
              {(s) => (
                <span class="tp-chip">
                  <span aria-hidden="true">⦸</span> {s}
                </span>
              )}
            </For>
          </div>
          <div class="tp-actions">
            <button
              class="tp-btn primary"
              onClick={() =>
                void focusPause(!focus()!.paused)
                  .then(refreshFocus)
                  .catch(() => {})
              }
            >
              {focus()!.paused ? "Resume" : "Pause"}
            </button>
            <button
              class="tp-btn"
              onClick={() =>
                void focusEnd()
                  .then(refreshFocus)
                  .catch(() => {})
              }
            >
              End focus
            </button>
          </div>
        </Show>
        <div class="tp-goal">
          <span>
            Focused today <strong>{duration(focus()?.focused_secs ?? 0)}</strong> of {duration(goal())}
          </span>
          <span class="tp-goal-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, ((focus()?.focused_secs ?? 0) / goal()) * 100)}%` }} />
          </span>
          <select
            aria-label="Daily focus goal"
            value={String(focus()?.goal_minutes ?? 120)}
            onChange={(e) => void focusSet(undefined, Number(e.currentTarget.value)).then(refreshFocus)}
          >
            <For each={[30, 60, 90, 120, 180, 240]}>
              {(m) => <option value={String(m)}>Goal {duration(m * 60)}</option>}
            </For>
          </select>
        </div>
      </section>
    </div>
  );
};

export default TimePage;
