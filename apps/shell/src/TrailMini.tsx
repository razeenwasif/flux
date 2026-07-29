/**
 * Trail mini (ADR 0011 follow-up) — this workspace's browsing, in the sidebar.
 *
 * Three states, because one widget can't do all three jobs well at 230px:
 *   • **Preview** — a frozen dot-map of the workspace's visits. No labels (they'd
 *     be unreadable at this size), no live simulation (it settles once and stops).
 *     It's an affordance and a density cue, not a thing you read.
 *   • **Expanded** — the list you actually *find* things in: recent visits,
 *     filterable by title/URL. Finding is a search problem, not a graph problem.
 *   • **⤢** — opens `flux://trail`, where the real graph lives.
 *
 * Scoped by workspace id (with a name fallback for visits recorded before ids
 * were stamped), so it only ever shows the research you're currently in.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";

import { TRAIL_URL, traceGraph, type Visit } from "./ipc";
import { activeWorkspace, activeWorkspaceName, openTab } from "./store";

/** Layout the visits as a frozen dot-map: newest at the bottom-right, oldest at
 *  the top-left, jittered by a hash of the URL so it reads as a scatter rather
 *  than a line. Deterministic, so it doesn't reshuffle on every render. */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

const TrailMini: Component = () => {
  const [visits, setVisits] = createSignal<Visit[]>([]);
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);

  const load = () => {
    void traceGraph(undefined, undefined, activeWorkspace(), activeWorkspaceName())
      .then((g) => {
        setVisits([...g.visits].sort((a, b) => b.last_ms - a.last_ms));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  };

  // Refresh on workspace switch and on a slow tick — browsing adds visits while
  // this sits open, but a sidebar widget shouldn't poll hard. An *effect*, not a
  // memo: memos are lazy, so a memo used for a side effect never runs unless
  // something reads it.
  createEffect(() => {
    activeWorkspace();
    load();
  });
  const timer = window.setInterval(load, 30_000);
  onCleanup(() => window.clearInterval(timer));

  const filtered = createMemo(() => {
    const needle = q().trim().toLowerCase();
    const all = visits();
    if (!needle) return all.slice(0, 40);
    return all
      .filter((v) => v.title.toLowerCase().includes(needle) || v.url.toLowerCase().includes(needle))
      .slice(0, 40);
  });

  /** Dots for the frozen preview — capped, because past ~60 it's just noise. */
  const dots = createMemo(() =>
    visits()
      .slice(0, 60)
      .map((v, i, arr) => {
        const t = arr.length > 1 ? i / (arr.length - 1) : 0; // 0 = newest
        return {
          // Newest bottom-right → oldest top-left, plus deterministic jitter.
          x: 12 + (1 - t) * 70 + (hash(v.url) - 0.5) * 22,
          y: 12 + (1 - t) * 58 + (hash(v.title || v.url) - 0.5) * 20,
          hot: v.snapshot_id != null,
        };
      }),
  );

  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };

  return (
    <div class="trailmini" classList={{ open: open() }}>
      <div class="trailmini-head">
        <button
          class="trailmini-toggle"
          title={
            open()
              ? "Collapse"
              : `Browsing in ${activeWorkspaceName() ?? "this workspace"} — click to search it`
          }
          onClick={() => setOpen((v) => !v)}
        >
          <span class="trailmini-spark">🧭</span>
          <span class="trailmini-label">Trail</span>
          <span class="trailmini-count">{visits().length}</span>
        </button>
        <button
          class="trailmini-expand"
          title="Open the full Trail graph"
          onClick={() => void openTab("browser", TRAIL_URL)}
        >
          ⤢
        </button>
      </div>

      {/* Frozen preview: density at a glance, and the thing you click. */}
      <Show when={!open()}>
        <button
          class="trailmini-map"
          title="Click to search this workspace's browsing"
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 104 82" preserveAspectRatio="none">
            <For each={dots()}>
              {(d) => <circle cx={d.x} cy={d.y} r={d.hot ? 2.6 : 1.8} classList={{ hot: d.hot }} />}
            </For>
          </svg>
          <Show when={loaded() && visits().length === 0}>
            <span class="trailmini-empty">No browsing here yet</span>
          </Show>
        </button>
      </Show>

      {/* Expanded: the part that actually finds a page. */}
      <Show when={open()}>
        <input
          class="trailmini-q"
          placeholder="Find a page you visited…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          autofocus
        />
        <div class="trailmini-list">
          <For
            each={filtered()}
            fallback={
              <div class="trailmini-empty-row">
                {visits().length ? "No match in this workspace." : "No browsing here yet."}
              </div>
            }
          >
            {(v) => (
              <button
                class="trailmini-item"
                title={`${v.title || v.url}\n${v.url}`}
                onClick={() => void openTab("browser", v.url)}
              >
                <span class="trailmini-item-title">{v.title || host(v.url)}</span>
                <span class="trailmini-item-host">{host(v.url)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default TrailMini;
