/**
 * Shared tab store. Module-level Solid signals: the tab strip, pinned rail,
 * and web area all read the same source of truth, so a pin/focus mutation is
 * one signal write — no prop drilling, no context provider overhead.
 */
import { createSignal } from "solid-js";
import {
  darkmodeSet,
  faviconFetch,
  isStartUrl,
  groupCreate,
  groupDelete,
  groupUpdate,
  groupsFromClusters,
  groupsList,
  tabActive,
  tabClose,
  tabCreate,
  tabFocus,
  tabList,
  tabReorder,
  tabSetGroup,
  tabSetWorkspace,
  tabSetPinned,
  groupSetWorkspace,
  webviewClose,
  workspaceActive,
  workspaceCreate,
  workspaceSwitch,
  workspaceUpdate,
  workspacesList,
  type TabGroup,
  type TabKind,
  type TabMeta,
  type Workspace,
} from "./ipc";

const [tabs, setTabs] = createSignal<TabMeta[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);
// Workspaces (BACKLOG #44). Only the active workspace's tabs are shown + hold
// live webviews; inactive workspaces are pure metadata (kilobytes of RAM).
const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
const [activeWorkspace, setActiveWorkspaceSig] = createSignal<number>(1);
export { workspaces, activeWorkspace };
export const workspaceColor = (w: Workspace): string => `#${(w.color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
async function refreshWorkspaces(): Promise<void> {
  const [ws, act] = await Promise.all([workspacesList().catch(() => []), workspaceActive().catch(() => 1)]);
  setWorkspaces(ws);
  setActiveWorkspaceSig(act);
}
export function setActiveWorkspace(id: number): void {
  setActiveWorkspaceSig(id);
}
export async function createWorkspace(name: string, color: number): Promise<number> {
  const id = await workspaceCreate(name, color).catch(() => 0);
  await refreshWorkspaces();
  return id;
}
export async function renameWorkspace(id: number, name: string): Promise<void> {
  await workspaceUpdate(id, { name }).catch(() => {});
  await refreshWorkspaces();
}
export async function recolorWorkspace(id: number, color: number): Promise<void> {
  await workspaceUpdate(id, { color }).catch(() => {});
  await refreshWorkspaces();
}

// Split view (BACKLOG #43): two browser tabs tiled in the content card.
// `splitPair` is [leftId, rightId]; the split renders only while one of the pair
// is the active tab (switching to a third tab pauses it, switching back resumes).
// `splitRatio` is the left pane's fraction of the card width. `splitDragging`
// hides the native webviews while the seam is dragged — a native webview is a
// separate OS layer that captures the mouse, so the DOM splitter can't track the
// pointer over it; hiding the panes lets the chrome see pointer moves again.
const [splitPair, setSplitPairSig] = createSignal<[number, number] | null>(null);
const [splitRatio, setSplitRatio] = createSignal(0.5);
const [splitDragging, setSplitDragging] = createSignal(false);
export { splitPair, splitRatio, setSplitRatio, splitDragging, setSplitDragging };

/** Tile two browser tabs side by side (left | right) and focus the left one so
 *  the split shows immediately. No-op if asked to split a tab with itself. */
export function startSplit(leftId: number, rightId: number): void {
  if (leftId === rightId) return;
  setSplitPairSig([leftId, rightId]);
  setSplitRatio(0.5);
  void focusTab(leftId);
}
export function clearSplit(): void {
  setSplitPairSig(null);
}
/** The two tabs to tile, or null when the split isn't currently showable: no
 *  pair, the active tab is outside the pair, or a member was closed / left the
 *  workspace / isn't a real page. */
export const splitPanes = (): [TabMeta, TabMeta] | null => {
  const p = splitPair();
  if (!p) return null;
  const a = activeId();
  if (a == null || (p[0] !== a && p[1] !== a)) return null;
  const l = tabs().find((t) => t.id === p[0]);
  const r = tabs().find((t) => t.id === p[1]);
  const ok = (t?: TabMeta) =>
    !!t && t.kind === "browser" && t.workspace === activeWorkspace() && !isStartUrl(t.url);
  return ok(l) && ok(r) ? [l as TabMeta, r as TabMeta] : null;
};

// Manual tab groups (BACKLOG #56).
const [groups, setGroups] = createSignal<TabGroup[]>([]);
export { groups };

async function refreshGroups(): Promise<void> {
  setGroups(await groupsList().catch(() => []));
}
/** Color of a group as a CSS hex string. */
export const groupColor = (g: TabGroup): string => `#${(g.color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

export async function newGroupWithTab(tabId: number): Promise<void> {
  const palette = [0x5bc0eb, 0x9d8df1, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const color = palette[groups().length % palette.length]!;
  await groupCreate("New group", color, [tabId]).catch(() => {});
  await Promise.all([refreshTabs(), refreshGroups()]);
}
/** Drag-to-group (#56): drop `dragged` onto `target` → join target's group, or
 *  start a new group containing both if the target is ungrouped. */
export async function groupWithTab(draggedId: number, targetId: number): Promise<void> {
  if (draggedId === targetId) return;
  const target = tabs().find((t) => t.id === targetId);
  if (!target) return;
  if (target.group != null) {
    await setTabGroup(draggedId, target.group);
  } else {
    const palette = [0x5bc0eb, 0x9d8df1, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
    const color = palette[groups().length % palette.length]!;
    await groupCreate("New group", color, [targetId, draggedId]).catch(() => {});
    await Promise.all([refreshTabs(), refreshGroups()]);
  }
}
export async function setTabGroup(tabId: number, group: number | null): Promise<void> {
  await tabSetGroup(tabId, group).catch(() => {});
  await Promise.all([refreshTabs(), refreshGroups()]);
}
/** Send a tab to another workspace (#44). Detaches it from any group. The
 *  caller (App) tears down the moved tab's webview, since it left this space. */
export async function sendTabToWorkspace(tabId: number, ws: number): Promise<void> {
  await tabSetWorkspace(tabId, ws).catch(() => {});
  await Promise.all([refreshTabs(), refreshGroups()]);
}
/** Send a whole group to another workspace (#44). Returns the moved tab ids. */
export async function sendGroupToWorkspace(groupId: number, ws: number): Promise<number[]> {
  const moved = await groupSetWorkspace(groupId, ws).catch(() => [] as number[]);
  await Promise.all([refreshTabs(), refreshGroups()]);
  return moved;
}
export async function deleteGroup(id: number): Promise<void> {
  await groupDelete(id).catch(() => {});
  await Promise.all([refreshTabs(), refreshGroups()]);
}
export async function renameGroup(id: number, name: string): Promise<void> {
  await groupUpdate(id, { name }).catch(() => {});
  await refreshGroups();
}
export async function recolorGroup(id: number, color: number): Promise<void> {
  await groupUpdate(id, { color }).catch(() => {});
  await refreshGroups();
}
export async function toggleGroupCollapsed(g: TabGroup): Promise<void> {
  await groupUpdate(g.id, { collapsed: !g.collapsed }).catch(() => {});
  await refreshGroups();
}
export async function groupByTopic(): Promise<number> {
  const n = await groupsFromClusters().catch(() => 0);
  await Promise.all([refreshTabs(), refreshGroups()]);
  return n;
}
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

// Native dark mode (#40) — WebView2 preferred-color-scheme. Persisted; applied
// on boot + on toggle.
const [darkMode, setDarkRaw] = createSignal(localStorage.getItem("flux.dark") === "1");
export { darkMode };
export function setDarkMode(on: boolean): void {
  setDarkRaw(on);
  localStorage.setItem("flux.dark", on ? "1" : "0");
  void darkmodeSet(on).catch(() => {});
}
/** Apply the persisted dark-mode setting (call once on boot). */
export function applyDarkMode(): void {
  void darkmodeSet(darkMode()).catch(() => {});
}

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

// Only the active workspace's tabs appear in the strip (#44).
export const pinnedTabs = () => tabs().filter((t) => t.pinned && t.workspace === activeWorkspace());
export const unpinnedTabs = () => tabs().filter((t) => !t.pinned && t.workspace === activeWorkspace());

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
  void refreshGroups();
  void refreshWorkspaces();
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
  if (splitPair()?.includes(id)) clearSplit(); // a tiled tab is gone → drop the split
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
