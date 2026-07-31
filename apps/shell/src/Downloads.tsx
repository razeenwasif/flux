/**
 * Downloads (BACKLOG #34) — the footer ⬇ popover. Lists downloads with live
 * progress and controls (pause/resume/cancel while running; open / show-in-
 * folder when done). Fed by WebView2's DownloadStarting interception in
 * downloads.rs; updates arrive over flux://download-updated.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import { visibleInterval } from "./poll";
import {
  downloadCancel,
  downloadOpen,
  downloadPause,
  downloadResume,
  downloadReveal,
  downloadsClear,
  downloadsList,
  onDownloadUpdated,
  type DownloadItem,
} from "./ipc";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

const Downloads: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [items, setItems] = createSignal<DownloadItem[]>([]);

  const refresh = () =>
    void downloadsList()
      .then(setItems)
      .catch(() => {});
  onMount(async () => {
    refresh(); // initial — for the badge at startup
    const un = await onDownloadUpdated(refresh);
    onCleanup(un);
  });

  const active = createMemo(
    () => items().filter((d) => d.state === "in_progress" || d.state === "paused").length,
  );
  // Poll only while the popover is open OR a download is in flight (the badge
  // needs progress then); idle + closed → no timer. The onDownloadUpdated event
  // bootstraps `active()` when a download starts.
  createEffect(() => {
    if (!open() && active() === 0) return;
    visibleInterval(refresh, 3000);
  });
  const pct = (d: DownloadItem) =>
    d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;

  /** Aggregate progress across everything in flight, for the button's ring.
   *  `null` when no running download reports a size — a ring that jumped to
   *  100% because one item had `total: 0` would be worse than no ring. */
  const overall = createMemo<number | null>(() => {
    const running = items().filter((d) => d.state === "in_progress" || d.state === "paused");
    const sized = running.filter((d) => d.total > 0);
    if (!sized.length) return null;
    const got = sized.reduce((n, d) => n + d.received, 0);
    const all = sized.reduce((n, d) => n + d.total, 0);
    return all > 0 ? Math.min(100, Math.round((got / all) * 100)) : null;
  });

  // A finished download deserves a moment of feedback, because the badge simply
  // disappearing reads as "it stopped" rather than "it's done". Watching the
  // completed count rather than an event keeps this working however the refresh
  // arrived (poll or push).
  const [justDone, setJustDone] = createSignal(false);
  let doneSeen = -1;
  let doneTimer = 0;
  createEffect(() => {
    const done = items().filter((d) => d.state === "completed").length;
    // The first observation is the existing history, not a new arrival.
    if (doneSeen >= 0 && done > doneSeen) {
      setJustDone(true);
      clearTimeout(doneTimer);
      doneTimer = window.setTimeout(() => setJustDone(false), 1400);
    }
    doneSeen = done;
  });
  onCleanup(() => clearTimeout(doneTimer));

  return (
    <div style={{ display: "contents" }}>
      <button
        classList={{
          "icon-btn": true,
          "dl-btn": true,
          active: open(),
          busy: active() > 0,
          done: justDone(),
        }}
        // The ring is drawn from a CSS variable so progress costs one custom
        // property write, not a re-render of the button.
        style={overall() != null ? { "--dl-pct": `${overall()}%` } : undefined}
        title={
          active() > 0
            ? `Downloads — ${active()} in progress${overall() != null ? ` (${overall()}%)` : ""}`
            : "Downloads"
        }
        onClick={() => {
          setOpen((v) => !v);
          if (!open()) refresh();
        }}
      >
        <span class="dl-arrow">⬇</span>
        <Show when={active() > 0}>
          <span class="shield-badge">{active()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover footer-pop">
          <div class="shields-row">
            <span class="shields-label">Downloads</span>
            <Show when={items().length > 0}>
              <button class="dl-clear" onClick={() => void downloadsClear().then(refresh)}>
                Clear
              </button>
            </Show>
          </div>
          <Show
            when={items().length > 0}
            fallback={
              <div class="start-empty" style={{ padding: "4px 8px 8px" }}>
                No downloads yet.
              </div>
            }
          >
            <For each={items()}>
              {(d) => (
                <div class="dl-row">
                  <div class="dl-head">
                    <span class="dl-name" title={d.path || d.url}>
                      {d.filename || d.url}
                    </span>
                    <span class="dl-actions">
                      <Show when={d.state === "in_progress"}>
                        <button class="find-nav" title="Pause" onClick={() => void downloadPause(d.id)}>
                          ⏸
                        </button>
                        <button class="find-nav" title="Cancel" onClick={() => void downloadCancel(d.id)}>
                          ✕
                        </button>
                      </Show>
                      <Show when={d.state === "paused"}>
                        <button class="find-nav" title="Resume" onClick={() => void downloadResume(d.id)}>
                          ▶
                        </button>
                        <button class="find-nav" title="Cancel" onClick={() => void downloadCancel(d.id)}>
                          ✕
                        </button>
                      </Show>
                      <Show when={d.state === "completed"}>
                        <button class="find-nav" title="Open" onClick={() => void downloadOpen(d.id)}>
                          ↗
                        </button>
                        <button
                          class="find-nav"
                          title="Show in folder"
                          onClick={() => void downloadReveal(d.id)}
                        >
                          📂
                        </button>
                      </Show>
                      <Show when={d.state === "interrupted"}>
                        <button
                          class="find-nav"
                          title="Show in folder"
                          onClick={() => void downloadReveal(d.id)}
                        >
                          📂
                        </button>
                      </Show>
                    </span>
                  </div>
                  <Show when={d.state === "in_progress" || d.state === "paused"}>
                    <div class="dl-bar">
                      <div
                        class="dl-fill"
                        classList={{ indet: pct(d) === null }}
                        style={pct(d) !== null ? { width: `${pct(d)}%` } : undefined}
                      />
                    </div>
                  </Show>
                  <div class="dl-sub">
                    {d.state === "completed"
                      ? fmtBytes(d.received)
                      : d.state === "interrupted"
                        ? "Failed"
                        : d.state === "paused"
                          ? `Paused · ${fmtBytes(d.received)}`
                          : d.total > 0
                            ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}`
                            : fmtBytes(d.received)}
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Downloads;
