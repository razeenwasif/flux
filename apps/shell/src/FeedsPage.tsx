/**
 * flux://feeds — native RSS / Atom reader (BACKLOG #72). Subscribe to feeds and
 * read them in Flux: subscriptions persist; items are fetched live (always
 * fresh). Master-detail — feed list + an "All" view on the left, the selected
 * feed's items on the right. Clicking an item opens it in a new browser tab.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  feedAdd,
  feedItems,
  feedRemove,
  feedsList,
  tabCreate,
  tabFocus,
  type Feed,
  type FeedItem,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const FeedsPage: Component = () => {
  const [feeds, setFeeds] = createSignal<Feed[]>([]);
  const [sel, setSel] = createSignal<number | null>(null); // null = All
  const [items, setItems] = createSignal<FeedItem[]>([]);
  const [adding, setAdding] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [draft, setDraft] = createSignal("");

  const loadItems = (id: number | null) => {
    setLoading(true);
    setError("");
    feedItems(id ?? 0)
      .then((r) => setItems(r ?? []))
      .catch((e) => { setItems([]); setError(String(e)); })
      .finally(() => setLoading(false));
  };

  const refreshFeeds = async () => {
    const fs = await feedsList().catch(() => [] as Feed[]);
    setFeeds(fs);
  };

  onMount(async () => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Feeds");
    await refreshFeeds();
    loadItems(null);
  });

  const pick = (id: number | null) => {
    setSel(id);
    loadItems(id);
  };

  const add = async () => {
    const url = draft().trim();
    if (!url || adding()) return;
    setAdding(true);
    setError("");
    try {
      const feed = await feedAdd(url);
      setDraft("");
      await refreshFeeds();
      pick(feed.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: number, e: MouseEvent) => {
    e.stopPropagation();
    await feedRemove(id).catch(() => {});
    await refreshFeeds();
    if (sel() === id) pick(null);
  };

  const open = (link: string) => {
    if (!link) return;
    void tabCreate("browser", link).then((t) => t && tabFocus(t.id)).catch(() => {});
  };

  const selTitle = () => {
    const id = sel();
    if (id == null) return "All feeds";
    return feeds().find((f) => f.id === id)?.title ?? "Feed";
  };

  return (
    <div class="hist-page feeds-page">
      <header class="hist-head">
        <div class="hist-title">📰 Feeds</div>
        <form
          class="feeds-add"
          onSubmit={(e) => { e.preventDefault(); void add(); }}
        >
          <input
            class="arch-search"
            placeholder="Add feed URL (RSS / Atom)…"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <button class="feeds-add-btn" type="submit" disabled={adding() || !draft().trim()}>
            {adding() ? "Adding…" : "Subscribe"}
          </button>
        </form>
        <span class="res-mem">{feeds().length} {feeds().length === 1 ? "feed" : "feeds"}</span>
      </header>

      <div class="arch-body feeds-body">
        <div class="arch-list feeds-list">
          <div
            classList={{ "feed-row": true, active: sel() == null }}
            onClick={() => pick(null)}
          >
            <span class="feed-row-title">★ All feeds</span>
          </div>
          <For each={feeds()}>
            {(f) => (
              <div
                classList={{ "feed-row": true, active: sel() === f.id }}
                onClick={() => pick(f.id)}
              >
                <span class="feed-row-title">{f.title || hostOf(f.url)}</span>
                <span class="feed-row-host">{hostOf(f.url)}</span>
                <button class="arch-del" title="Unsubscribe" onClick={(e) => void remove(f.id, e)}>✕</button>
              </div>
            )}
          </For>
          <Show when={feeds().length === 0}>
            <div class="hist-empty feeds-hint">No feeds yet. Paste a site's RSS/Atom URL above.</div>
          </Show>
        </div>

        <div class="arch-read feeds-items">
          <div class="feeds-items-head">
            <span class="feeds-items-title">{selTitle()}</span>
            <button class="feeds-refresh" title="Refresh" onClick={() => loadItems(sel())} disabled={loading()}>
              {loading() ? "…" : "↻"}
            </button>
          </div>
          <Show when={error()}>
            <div class="feeds-error">{error()}</div>
          </Show>
          <Show
            when={!loading()}
            fallback={<div class="hist-empty">Loading…</div>}
          >
            <Show
              when={items().length > 0}
              fallback={<div class="hist-empty">{error() ? "" : "No items."}</div>}
            >
              <For each={items()}>
                {(it) => (
                  <article class="feed-item" onClick={() => open(it.link)}>
                    <div class="feed-item-top">
                      <span class="feed-item-title">{it.title || it.link}</span>
                      <Show when={it.published}><span class="feed-item-date">{it.published}</span></Show>
                    </div>
                    <Show when={sel() == null}>
                      <div class="feed-item-src">{it.feed_title}</div>
                    </Show>
                    <Show when={it.summary}>
                      <div class="feed-item-snip">{it.summary}</div>
                    </Show>
                  </article>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default FeedsPage;
