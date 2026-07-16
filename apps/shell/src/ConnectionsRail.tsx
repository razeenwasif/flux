/**
 * Connections rail (#123) — the second brain compounding *passively*. As you read
 * a page, Flux embeds its text and surfaces your own related Onyx notes / Scroll
 * papers / Council debates here, updating on each navigation. Click one to open
 * it. Fully local (kb_related → kb_query over the on-device index).
 *
 * Also home to the **ambient watcher** (ADR 0011, local-only): when the current
 * page shows an error you've hit before, a "⚡ Seen before" section surfaces the
 * past sighting — with a 💬 when a chat thread is attached (you may have solved
 * it there). Precision-gated backend-side; it's empty on almost every page.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { fsOpen, kbRelated, onDomUpdated, traceAmbient, type AmbientHint, type KbHit } from "./ipc";
import { activeId, openTab } from "./store";

const SOURCE_ICON: Record<string, string> = { onyx: "📝", scroll: "📜", council: "⚖", web: "🧭" };

const ConnectionsRail: Component = () => {
  const [hits, setHits] = createSignal<KbHit[]>([]);
  const [seen, setSeen] = createSignal<AmbientHint[]>([]);
  const [loading, setLoading] = createSignal(false);
  let gen = 0;

  const refresh = async () => {
    const mine = ++gen;
    setLoading(true);
    const id = activeId();
    try {
      // The ambient check is cheap (empty unless the page shows a shaped error),
      // so it rides along with every relatedness refresh.
      const [r, s] = await Promise.all([
        kbRelated(8),
        id != null ? traceAmbient(id).catch(() => [] as AmbientHint[]) : Promise.resolve([] as AmbientHint[]),
      ]);
      if (mine === gen) {
        setHits(r);
        setSeen(s);
      }
    } catch {
      if (mine === gen) {
        setHits([]);
        setSeen([]);
      }
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

  const ago = (ms: number): string => {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
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

      {/* Ambient watcher: this page's error, seen on a past page. */}
      <Show when={seen().length > 0}>
        <div class="connect-seen">
          <div class="connect-seen-head">⚡ Seen before</div>
          <For each={seen()}>
            {(h) => (
              <button
                class="connect-item connect-seen-item"
                title={`${h.signature}\n${h.url}`}
                onClick={() => void openTab("browser", h.url)}
              >
                <span class="connect-item-top">
                  <span class="connect-item-ico">{h.has_chat ? "💬" : "🧭"}</span>
                  <span class="connect-item-title">{h.title || h.url}</span>
                  <span class="connect-seen-when">{ago(h.saved_ms)}</span>
                </span>
                <span class="connect-item-snip">
                  {h.has_chat ? "You chatted about this error here · " : "This error appears here · "}
                  {h.signature}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

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
