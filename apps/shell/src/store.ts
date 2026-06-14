/**
 * Shared tab store. Module-level Solid signals: the tab strip, pinned rail,
 * and web area all read the same source of truth, so a pin/focus mutation is
 * one signal write — no prop drilling, no context provider overhead.
 */
import { createSignal } from "solid-js";
import {
  tabClose,
  tabCreate,
  tabFocus,
  tabList,
  tabSetPinned,
  webviewClose,
  type TabKind,
  type TabMeta,
} from "./ipc";

const [tabs, setTabs] = createSignal<TabMeta[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);

export { tabs, activeId };

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
  // Seed selection on first load so a tab is always active (address bar +
  // highlight reflect it). Backend already tracks its own active tab.
  if (activeId() === null && list.length > 0) {
    setActiveId(list.at(-1)!.id);
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
  await webviewClose(id); // tear down the native webview (no-op for terminal tabs)
  await tabClose(id);
  // If we closed the active tab, fall back to the last remaining tab.
  if (activeId() === id) {
    const remaining = tabs().filter((t) => t.id !== id);
    setActiveId(remaining.at(-1)?.id ?? null);
  }
  await refreshTabs();
}

/** Patch a tab's url/title in place (e.g. from a page-load event). */
export function updateTabUrl(id: number, url: string): void {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, url } : t)));
}

export function updateTabTitle(id: number, title: string): void {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, title } : t)));
}
