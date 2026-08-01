/**
 * Connections rail (#123) — the second brain compounding *passively*. As you read
 * a page, Flux embeds its text and surfaces your own related Onyx notes / Scroll
 * papers / Council debates / Scribe pages here, updating on each navigation. Click
 * one to open it. Fully local (kb_related → kb_query over the on-device index).
 *
 * **Your own writing only.** Visited pages (the `web` corpus) are excluded — the
 * Trail has its own graph in the sidebar, so listing them here as well showed the
 * same browsing history twice. The source list lives in `kb.rs`'s `OWN_SOURCES`.
 *
 * Also home to the **ambient watcher** (ADR 0011, local-only): when the current
 * page shows an error you've hit before, a "⚡ Seen before" section surfaces the
 * past sighting — with a 💬 when a chat thread is attached (you may have solved
 * it there). Precision-gated backend-side; it's empty on almost every page.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";

import {
  fsOpen,
  kbRelated,
  kbStatus,
  onDomUpdated,
  OWN_SOURCES,
  traceAmbient,
  type AmbientHint,
  type KbHit,
} from "./ipc";
import { activeId, openTab } from "./store";

const SOURCE_ICON: Record<string, string> = {
  onyx: "📝",
  scroll: "📜",
  council: "⚖",
  scribe: "✍",
  pdf: "📄",
  // Machine-read: a vision model transcribed handwriting into this text, so it
  // may not say quite what the page said. Marked wherever it's cited.
  "scribe-ocr": "🔍",
  "pdf-ocr": "🔍",
};
/** Sources whose text a model produced rather than the user. */
const MACHINE_READ = new Set(["scribe-ocr", "pdf-ocr"]);

/** Default cards. */
const RAIL_LIMIT = 8;
/** The most `kb_related` will ever return (it clamps at 20), so "show more"
 *  stops offering once we're asking for everything there is. */
const MAX_RELATED = 20;

const ConnectionsRail: Component = () => {
  const [hits, setHits] = createSignal<KbHit[]>([]);
  const [seen, setSeen] = createSignal<AmbientHint[]>([]);
  const [loading, setLoading] = createSignal(false);
  // Why the rail is empty. "Nothing connects" reads as *no matches* even when the
  // real cause is an unindexed corpus — an invisible failure that makes the whole
  // feature look broken, so the empty state names the actual reason.
  const [why, setWhy] = createSignal("");
  /** How many cards to ask for. Hits come back ranked, so the tail is
   *  monotonically weaker — 8 keeps the rail scannable, and the rest is there
   *  when you actually want to dig. `MAX_RELATED` is the backend's own clamp;
   *  asking for more returns the same thing. */
  const [limit, setLimit] = createSignal(RAIL_LIMIT);
  let gen = 0;

  const refresh = async () => {
    const mine = ++gen;
    setLoading(true);
    const id = activeId();
    try {
      // The ambient check is cheap (empty unless the page shows a shaped error),
      // so it rides along with every relatedness refresh.
      const [r, s] = await Promise.all([
        kbRelated(limit()),
        id != null ? traceAmbient(id).catch(() => [] as AmbientHint[]) : Promise.resolve([] as AmbientHint[]),
      ]);
      if (mine === gen) {
        setHits(r);
        setSeen(s);
        // Only pay for the diagnosis when there's nothing to show.
        setWhy(r.length ? "" : await diagnose());
      }
    } catch (e) {
      if (mine === gen) {
        setHits([]);
        setSeen([]);
        setWhy(String(e).replace(/^Error:\s*/, ""));
      }
    } finally {
      if (mine === gen) setLoading(false);
    }
  };

  /** Ask for the long tail. A refetch rather than a client-side reveal: the
   *  backend only ever sent the top `limit`, so the extra cards don't exist here
   *  yet. */
  const showMore = () => {
    setLimit(MAX_RELATED);
    void refresh();
  };
  const showLess = () => {
    setLimit(RAIL_LIMIT);
    setHits((h) => h.slice(0, RAIL_LIMIT)); // already have these; no round trip
  };

  /** Distinguish "your corpus is empty" from "this page matched nothing". */
  const diagnose = async (): Promise<string> => {
    try {
      const st = await kbStatus();
      const docs = st.sources.filter((s) => OWN_SOURCES.includes(s.source)).reduce((n, s) => n + s.docs, 0);
      if (st.indexing) return "Indexing your notes… connections appear once that finishes.";
      if (docs === 0)
        return "You have no indexed notes yet — open the Notebook and hit ↻ Reindex to pull in your Onyx vault.";
      return `Nothing in your ${docs} indexed notes connects to this page yet.`;
    } catch {
      return "Nothing in your notes connects to this page yet.";
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
    // Collapse on navigation: expanding is a choice about the page you were
    // looking at, not a standing preference.
    setLimit(RAIL_LIMIT);
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
              : why() || "Nothing in your notes connects to this page yet."}
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
                  <Show when={MACHINE_READ.has(h.source)}>
                    <span
                      class="kb-machine"
                      title="Transcribed by a local vision model — it may not match the page exactly"
                    >
                      machine-read
                    </span>
                  </Show>
                  <span class="connect-item-score">{h.score}</span>
                </span>
                <span class="connect-item-snip">{h.snippet}</span>
              </button>
            )}
          </For>
          {/* Only offered when there might be more: a short result list means
              the corpus had nothing else, not that it's being withheld. */}
          <Show when={limit() === RAIL_LIMIT && hits().length >= RAIL_LIMIT}>
            <button class="connect-more" disabled={loading()} onClick={showMore}>
              {loading() ? "Looking…" : "Show more"}
            </button>
          </Show>
          <Show when={limit() > RAIL_LIMIT && hits().length > RAIL_LIMIT}>
            <button class="connect-more" onClick={showLess}>
              Show fewer
            </button>
          </Show>
        </div>
      </Show>
    </aside>
  );
};

export default ConnectionsRail;
