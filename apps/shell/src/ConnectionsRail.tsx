/**
 * Connections rail (#123) — the second brain compounding *passively*. As you read
 * a page, Flux embeds its text and surfaces your own related Onyx notes / Scroll
 * papers / Council debates here, updating on each navigation. Click one to open
 * it. Fully local (kb_related → kb_query over the on-device index).
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { fsOpen, kbRelated, onDomUpdated, type KbHit } from "./ipc";
import { activeId, openTab } from "./store";

const SOURCE_ICON: Record<string, string> = { onyx: "📝", scroll: "📜", council: "⚖", web: "🧭" };

const ConnectionsRail: Component = () => {
  const [hits, setHits] = createSignal<KbHit[]>([]);
  const [loading, setLoading] = createSignal(false);
  let gen = 0;

  const refresh = async () => {
    const mine = ++gen;
    setLoading(true);
    try {
      const r = await kbRelated(8);
      if (mine === gen) setHits(r);
    } catch {
      if (mine === gen) setHits([]);
    } finally {
      if (mine === gen) setLoading(false);
    }
  };

  // Refresh when the page's captured DOM changes (navigation / load) and on first
  // mount. Debounced so a burst of dom-updated events coalesces into one query.
  let timer: number | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 400);
  };

  onMount(() => {
    let un: (() => void) | undefined;
    void onDomUpdated(() => schedule()).then((u) => (un = u));
    onCleanup(() => {
      un?.();
      clearTimeout(timer);
    });
  });
  // Re-query whenever the active tab changes (also runs once on mount).
  createEffect(() => {
    activeId();
    schedule();
  });

  const open = (h: KbHit) => {
    if (/^https?:\/\//i.test(h.path)) void openTab("browser", h.path);
    else if (h.path) void fsOpen(h.path).catch(() => {});
  };

  return (
    <aside class="connect-rail">
      <div class="connect-head">
        <span>
          <span class="connect-spark">✦</span> Connections
        </span>
        <button class="connect-refresh" title="Refresh" onClick={() => void refresh()}>
          ↻
        </button>
      </div>
      <Show
        when={hits().length > 0}
        fallback={
          <div class="connect-empty">
            {loading()
              ? "Looking through your knowledge…"
              : "Nothing in your notes connects to this page yet."}
          </div>
        }
      >
        <div class="connect-list">
          <For each={hits()}>
            {(h) => (
              <button class="connect-item" title={`${h.title}\n${h.path}`} onClick={() => open(h)}>
                <span class="connect-item-top">
                  <span class="connect-item-ico">{SOURCE_ICON[h.source] ?? "•"}</span>
                  <span class="connect-item-title">{h.title}</span>
                  <span class="connect-item-score">{h.score}</span>
                </span>
                <span class="connect-item-snip">{h.snippet}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
};

export default ConnectionsRail;
