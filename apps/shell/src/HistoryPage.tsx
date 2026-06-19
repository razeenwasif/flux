/**
 * flux://history — full-page browsing history (BACKLOG #39). DOM-rendered in the
 * content card (no webview), like flux://passwords. Search at the top; an empty
 * query shows recent visits grouped by day, a query shows frecency-ranked
 * matches. Each row carries the site favicon (#21); click to open, ✕ to forget.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  historyClear,
  historyDelete,
  historyRecent,
  historySearch,
  type HistoryEntry,
} from "./ipc";
import { activeId, ensureFavicon, faviconFor, updateTabTitle } from "./store";
import { openLinkMenu } from "./linkMenu";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
function dayLabel(ms: number): string {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = startOfDay(new Date(ms));
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const RowIcon: Component<{ url: string }> = (props) => {
  const host = () => hostOf(props.url);
  ensureFavicon(host());
  const data = () => faviconFor(host());
  return (
    <Show when={typeof data() === "string"} fallback={<span class="hist-letter">{(host() ?? "?").charAt(0).toUpperCase()}</span>}>
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

const HistoryPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [entries, setEntries] = createSignal<HistoryEntry[]>([]);

  const load = () => {
    const q = query().trim();
    const p = q ? historySearch(q, 300) : historyRecent(300);
    void p.then(setEntries).catch(() => setEntries([]));
  };
  let debounce: number | undefined;
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "History");
    load();
    onCleanup(() => clearTimeout(debounce));
  });
  const onInput = (v: string) => {
    setQuery(v);
    clearTimeout(debounce);
    debounce = window.setTimeout(load, 120);
  };

  const open = (e: HistoryEntry) => props.onNavigate(e.url);
  const forget = (e: HistoryEntry) => void historyDelete(e.url).then(load);
  const clearAll = () => {
    if (confirm("Clear all browsing history?")) void historyClear().then(load);
  };

  // Empty query → group recents by day; query → a single ranked "Results" group.
  const groups = createMemo<[string, HistoryEntry[]][]>(() => {
    const list = entries();
    if (query().trim()) return list.length ? [[`${list.length} result${list.length === 1 ? "" : "s"}`, list]] : [];
    const out: [string, HistoryEntry[]][] = [];
    for (const e of list) {
      const label = dayLabel(e.last_visit_ms);
      const last = out[out.length - 1];
      if (last && last[0] === label) last[1].push(e);
      else out.push([label, [e]]);
    }
    return out;
  });

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🕘 History</div>
        <input class="hist-search" placeholder="Search history…" value={query()} autofocus onInput={(e) => onInput(e.currentTarget.value)} />
        <button class="hist-clear" onClick={clearAll}>Clear all</button>
      </header>

      <div class="hist-body">
        <Show when={groups().length > 0} fallback={<div class="hist-empty">{query() ? "No matching history." : "No history yet — pages you visit will show up here."}</div>}>
          <For each={groups()}>
            {([label, rows]) => (
              <div class="hist-group">
                <div class="hist-day">{label}</div>
                <For each={rows}>
                  {(e) => (
                    <div class="hist-row" onClick={() => open(e)} onContextMenu={(ev) => openLinkMenu(ev, e.url)}>
                      <span class="hist-time">{timeLabel(e.last_visit_ms)}</span>
                      <RowIcon url={e.url} />
                      <span class="hist-text">
                        <span class="hist-name">{e.title || e.url}</span>
                        <span class="hist-url">{e.url}</span>
                      </span>
                      <button class="hist-forget" title="Remove" onClick={(ev) => { ev.stopPropagation(); forget(e); }}>✕</button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default HistoryPage;
