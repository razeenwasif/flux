/**
 * Shared tab store. Module-level Solid signals: the tab strip, pinned rail,
 * and web area all read the same source of truth, so a pin/focus mutation is
 * one signal write — no prop drilling, no context provider overhead.
 */
import { createSignal } from "solid-js";
import {
  faviconFetch,
  tabActive,
  tabClose,
  tabCreate,
  tabFocus,
  tabList,
  tabReorder,
  tabSetPinned,
  webviewClose,
  type TabKind,
  type TabMeta,
} from "./ipc";

const [tabs, setTabs] = createSignal<TabMeta[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);
// Tabs currently loading a page (BACKLOG #31) — drives the stop/reload swap and
// the omnibox progress bar. Fed by the page-load events (started/finished).
const [loadingTabs, setLoadingTabs] = createSignal<Set<number>>(new Set());

// Find-in-page (BACKLOG #33). The bar lives in the sidebar (the native webview
// overlays the content card); `findMatches` is the count reported by the page.
const [findOpen, setFindOpen] = createSignal(false);
const [findMatches, setFindMatches] = createSignal<number | null>(null);

// Hibernated tabs (BACKLOG #45) — their native webview was destroyed to free
// RAM; the tab stays in the strip and reloads when re-activated.
const [hibernated, setHibernatedSet] = createSignal<Set<number>>(new Set());

export { tabs, activeId, findOpen, setFindOpen, findMatches, setFindMatches, hibernated };

export const isHibernated = (id: number): boolean => hibernated().has(id);
export function setHibernated(id: number, on: boolean): void {
  setHibernatedSet((s) => {
    if (on === s.has(id)) return s;
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
}

// Hibernation settings (persisted). Default on, 30 min — the RAM win.
const [hibernateEnabled, setHibEnabledRaw] = createSignal(localStorage.getItem("flux.hibernate") !== "0");
const [hibernateMins, setHibMinsRaw] = createSignal(Number(localStorage.getItem("flux.hibernate.mins")) || 30);
export { hibernateEnabled, hibernateMins };
export function setHibernateEnabled(on: boolean): void {
  setHibEnabledRaw(on);
  localStorage.setItem("flux.hibernate", on ? "1" : "0");
}
export function setHibernateMins(m: number): void {
  setHibMinsRaw(m);
  localStorage.setItem("flux.hibernate.mins", String(m));
}

// Sleep background tabs early when free system memory is low (#45). On by
// default — it only acts under genuine pressure, so it's quiet with headroom.
const [memEvict, setMemEvictRaw] = createSignal(localStorage.getItem("flux.mem.evict") !== "0");
export { memEvict };
export function setMemEvict(on: boolean): void {
  setMemEvictRaw(on);
  localStorage.setItem("flux.mem.evict", on ? "1" : "0");
}

// Favicons (#21) — host → data URL (string) | null (no icon) | undefined (not
// fetched). Backed by the Rust per-host cache; fetched once per host per session.
const [favicons, setFavicons] = createSignal<Record<string, string | null>>({});
export { favicons };
const faviconInflight = new Set<string>();
export const faviconFor = (host: string | null): string | null | undefined =>
  host ? favicons()[host] : undefined;
// AI search answers (#32-ish / agent): when you search, the local Gemma also
// drafts a quick answer in the agent panel. On by default (it's local — no
// privacy cost, just local compute); toggle in Settings.
const [aiAnswersOn, setAiAnswersRaw] = createSignal(localStorage.getItem("flux.ai-answers") !== "0");
export { aiAnswersOn };
export function setAiAnswersOn(on: boolean): void {
  setAiAnswersRaw(on);
  localStorage.setItem("flux.ai-answers", on ? "1" : "0");
}
// A search query handed to the agent panel to answer (consumed once).
const [pendingAsk, setPendingAsk] = createSignal<string | null>(null);
export { pendingAsk, setPendingAsk };

// Omnibox search suggestions (#32). On by default; gating it off keeps your
// keystrokes off the search engine (history suggestions stay local either way).
const [searchSuggestOn, setSearchSuggestRaw] = createSignal(localStorage.getItem("flux.suggest") !== "0");
export { searchSuggestOn };
export function setSearchSuggestOn(on: boolean): void {
  setSearchSuggestRaw(on);
  localStorage.setItem("flux.suggest", on ? "1" : "0");
}

export function ensureFavicon(host: string | null): void {
  if (!host || host in favicons() || faviconInflight.has(host)) return;
  faviconInflight.add(host);
  void faviconFetch(host)
    .then((d) => setFavicons((m) => ({ ...m, [host]: d ?? null })))
    .catch(() => setFavicons((m) => ({ ...m, [host]: null })))
    .finally(() => faviconInflight.delete(host));
}

/** Whether a tab (default: the active one) is mid-load. */
export const isLoading = (id: number | null = activeId()): boolean =>
  id != null && loadingTabs().has(id);

export function setTabLoading(id: number, loading: boolean): void {
  setLoadingTabs((s) => {
    if (loading === s.has(id)) return s;
    const next = new Set(s);
    if (loading) next.add(id);
    else next.delete(id);
    return next;
  });
}

export const activeTab = (): TabMeta | null =>
  tabs().find((t) => t.id === activeId()) ?? null;

export const pinnedTabs = () => tabs().filter((t) => t.pinned);
export const unpinnedTabs = () => tabs().filter((t) => !t.pinned);

export async function refreshTabs(): Promise<void> {
  const list = await tabList();
  // The backend only knows each tab's *creation* url/title — it does NOT track
  // in-webview navigation (that's frontend state, via updateTabUrl/onTabLoaded).
  // So preserve the live url/title for tabs we already hold, and take only
  // structural fields (kind/pinned/cluster) + additions/removals from the
  // backend. Without this merge, opening or closing a tab would reset every
  // other browser tab back to its start page.
  setTabs((prev) => {
    const live = new Map(prev.map((t) => [t.id, t]));
    return list.map((bt) => {
      const ft = live.get(bt.id);
      return ft ? { ...bt, url: ft.url, title: ft.title } : bt;
    });
  });
  // Seed selection on first load so a tab is always active. Prefer the backend's
  // restored active tab (session restore, #19); fall back to the last tab.
  if (activeId() === null && list.length > 0) {
    const restored = await tabActive().catch(() => null);
    setActiveId(restored && list.some((t) => t.id === restored) ? restored : list.at(-1)!.id);
  }
}

export async function openTab(kind: TabKind, url?: string): Promise<TabMeta> {
  const tab = await tabCreate(kind, url);
  setActiveId(tab.id);
  await refreshTabs();
  return tab;
}

export async function focusTab(id: number): Promise<void> {
  setActiveId(id);
  await tabFocus(id);
}

export async function togglePin(tab: TabMeta): Promise<void> {
  await tabSetPinned(tab.id, !tab.pinned);
  await refreshTabs();
}

export async function closeTab(id: number): Promise<void> {
  setTabLoading(id, false);
  setHibernated(id, false);
  await webviewClose(id); // tear down the native webview (no-op for terminal tabs)
  await tabClose(id);
  // If we closed the active tab, fall back to the last remaining tab.
  if (activeId() === id) {
    const remaining = tabs().filter((t) => t.id !== id);
    setActiveId(remaining.at(-1)?.id ?? null);
  }
  await refreshTabs();
}

/** Drag-reorder (#30): move `draggedId` before/after `targetId`, optimistically
 *  update the strip, and persist the new full order to the backend. */
export async function reorderTabs(draggedId: number, targetId: number, after: boolean): Promise<void> {
  if (draggedId === targetId) return;
  const cur = tabs();
  const moved = cur.find((t) => t.id === draggedId);
  if (!moved) return;
  const rest = cur.filter((t) => t.id !== draggedId);
  const ti = rest.findIndex((t) => t.id === targetId);
  const idx = ti < 0 ? rest.length : after ? ti + 1 : ti;
  const next = [...rest.slice(0, idx), moved, ...rest.slice(idx)];
  setTabs(next); // optimistic
  await tabReorder(next.map((t) => t.id)).catch(() => void refreshTabs());
}

/** Patch a tab's url/title in place (e.g. from a page-load event). */
export function updateTabUrl(id: number, url: string): void {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, url } : t)));
}

export function updateTabTitle(id: number, title: string): void {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, title } : t)));
}
