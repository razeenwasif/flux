/**
 * Watched pages (BACKLOG #128) — the list of pages Flux is monitoring for
 * *semantic* changes, with what changed at the last check (sections added /
 * removed). Opened from the command palette or the 👁 page-action.
 */
import { For, Show, createEffect, createSignal, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import { watchPanelOpen, setWatchPanelOpen, openTab } from "./store";
import { watchList, watchRemove, watchCheckNow, watchMarkSeen, type WatchItem } from "./ipc";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const relTime = (ms: number): string => {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  const m = Math.floor(s / 60),
    h = Math.floor(m / 60),
    d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
};
const intervalLabel = (s: number) =>
  s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`;

const WatchPanel: Component = () => {
  const [items, setItems] = createSignal<WatchItem[]>([]);
  const [expanded, setExpanded] = createSignal<number | null>(null);
  const [checking, setChecking] = createSignal<number | null>(null);

  const load = () =>
    void watchList()
      .then(setItems)
      .catch(() => setItems([]));

  createEffect(() => {
    if (!watchPanelOpen()) return;
    load();
  });

  const close = () => setWatchPanelOpen(false);
  const toggle = (it: WatchItem) => {
    if (expanded() === it.id) {
      setExpanded(null);
      return;
    }
    setExpanded(it.id);
    if (!it.seen) void watchMarkSeen(it.id).then(load);
  };
  const checkNow = async (id: number) => {
    setChecking(id);
    try {
      await watchCheckNow(id);
      load();
    } catch {
      /* ignore */
    } finally {
      setChecking(null);
    }
  };
  const remove = (id: number) => void watchRemove(id).then(load);
  const open = (url: string) => {
    close();
    void openTab("browser", url);
  };

  return (
    <Show when={watchPanelOpen()}>
      <Portal>
        <div class="watch-backdrop" onClick={close}>
          <div
            class="watch-panel glass"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
          >
            <div class="watch-head">
              <span class="watch-title">👁 Watched pages</span>
              <button class="watch-x" title="Close (Esc)" onClick={close}>
                ✕
              </button>
            </div>
            <div class="watch-list">
              <For
                each={items()}
                fallback={
                  <div class="watch-empty">
                    No watched pages yet. Open a page and hit 👁 in the toolbar to watch it for changes — Flux
                    checks on a schedule and tells you what semantically changed.
                  </div>
                }
              >
                {(it) => (
                  <div classList={{ "watch-item": true, unseen: !it.seen }}>
                    <div class="watch-row">
                      <button class="watch-main" onClick={() => toggle(it)}>
                        <span class="watch-name" title={it.url}>
                          <Show when={!it.seen}>
                            <span class="watch-dot" />
                          </Show>
                          {it.title || host(it.url)}
                        </span>
                        <span class="watch-meta">
                          {host(it.url)} · every {intervalLabel(it.interval_secs)} · checked{" "}
                          {relTime(it.last_checked_ms)}
                          <Show when={it.error}>
                            <span class="watch-err"> · {it.error}</span>
                          </Show>
                          <Show when={!it.error && it.last_change_ms > 0}>
                            <span class="watch-changed">
                              {" "}
                              · changed {relTime(it.last_change_ms)} (+{it.added.length}/−{it.removed.length})
                            </span>
                          </Show>
                        </span>
                      </button>
                      <button
                        class="watch-act"
                        title="Check now"
                        disabled={checking() === it.id}
                        onClick={() => void checkNow(it.id)}
                      >
                        {checking() === it.id ? "…" : "↻"}
                      </button>
                      <button class="watch-act" title="Open page" onClick={() => open(it.url)}>
                        ↗
                      </button>
                      <button class="watch-act watch-del" title="Stop watching" onClick={() => remove(it.id)}>
                        ✕
                      </button>
                    </div>
                    <Show when={expanded() === it.id}>
                      <div class="watch-diff">
                        <Show when={!it.added.length && !it.removed.length}>
                          <div class="watch-nochange">
                            No changes detected yet{it.last_checked_ms ? "" : " (not checked)"}.
                          </div>
                        </Show>
                        <For each={it.added}>{(p) => <div class="watch-add">＋ {p}</div>}</For>
                        <For each={it.removed}>{(p) => <div class="watch-rem">− {p}</div>}</For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default WatchPanel;
