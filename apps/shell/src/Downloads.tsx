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

  return (
    <div style={{ display: "contents" }}>
      <button
        classList={{ "icon-btn": true, active: open() }}
        title="Downloads"
        onClick={() => {
          setOpen((v) => !v);
          if (!open()) refresh();
        }}
      >
        ⬇
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
