/**
 * Shared tab store. Module-level Solid signals: the tab strip, pinned rail,
 * and web area all read the same source of truth, so a pin/focus mutation is
 * one signal write — no prop drilling, no context provider overhead.
 */
import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
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
  panelsList,
  panelAdd,
  panelRemove,
  sessionRestore,
  type WebPanel,
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

// Web panels (BACKLOG #48): pinned sites shown in a slim pane beside any tab.
// Only the *open* panel holds a live webview (RAM-conscious). `panelWidth` (px)
// is the pane width; `panelDragging` hides the panel + tab webviews while the
// divider is dragged so the DOM splitter can track the pointer.
const [panels, setPanels] = createSignal<WebPanel[]>([]);
const [activePanelId, setActivePanelId] = createSignal<number | null>(null);
const [panelWidth, setPanelWidthSig] = createSignal(Number(localStorage.getItem("flux.panel.w")) || 380);
const [panelDragging, setPanelDragging] = createSignal(false);
export { panels, activePanelId, panelWidth, panelDragging, setPanelDragging };
export const activePanel = (): WebPanel | null =>
  panels().find((p) => p.id === activePanelId()) ?? null;
export function setPanelWidth(px: number): void {
  const w = Math.round(Math.max(280, Math.min(640, px)));
  setPanelWidthSig(w);
  localStorage.setItem("flux.panel.w", String(w));
}
async function refreshPanels(): Promise<void> {
  setPanels(await panelsList().catch(() => []));
}
/** Pin a site as a panel and open it. */
export async function pinPanel(url: string, title: string): Promise<void> {
  const p = await panelAdd(url, title).catch(() => null);
  await refreshPanels();
  if (p) setActivePanelId(p.id);
}
/** Remove a pinned panel; closes it if it was open. */
export async function unpinPanel(id: number): Promise<void> {
  if (activePanelId() === id) setActivePanelId(null);
  await panelRemove(id).catch(() => {});
  await refreshPanels();
}
/** Toggle a panel open/closed (only one open at a time). */
export function togglePanel(id: number): void {
  setActivePanelId((cur) => (cur === id ? null : id));
}
export function closePanel(): void {
  setActivePanelId(null);
}

// Per-site zoom (BACKLOG #36): factor per host, persisted in localStorage and
// re-applied on each load. 1.0 = 100% (not stored).
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const loadZoom = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem("flux.zoom") || "{}"); } catch { return {}; }
};
const [zoomMap, setZoomMap] = createSignal<Record<string, number>>(loadZoom());
export const zoomFor = (host: string | null): number => (host ? zoomMap()[host] ?? 1 : 1);
function setZoomFor(host: string, factor: number): void {
  setZoomMap((m) => {
    const next = { ...m };
    if (Math.abs(factor - 1) < 0.001) delete next[host];
    else next[host] = factor;
    localStorage.setItem("flux.zoom", JSON.stringify(next));
    return next;
  });
}
/** Step the zoom for `host` (in/out/reset), persist, and return the new factor. */
export function nudgeZoom(host: string, dir: "in" | "out" | "reset"): number {
  if (dir === "reset") { setZoomFor(host, 1); return 1; }
  const cur = zoomFor(host);
  let i = 0, best = Infinity;
  ZOOM_STEPS.forEach((s, idx) => { const d = Math.abs(s - cur); if (d < best) { best = d; i = idx; } });
  const ni = dir === "in" ? Math.min(ZOOM_STEPS.length - 1, i + 1) : Math.max(0, i - 1);
  const next = ZOOM_STEPS[ni]!;
  setZoomFor(host, next);
  return next;
}

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
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
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
    await refreshTabs(); // refreshTabs already refreshes groups + workspaces
  }
}
export async function setTabGroup(tabId: number, group: number | null): Promise<void> {
  await tabSetGroup(tabId, group).catch(() => {});
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
}
/** Send a tab to another workspace (#44). Detaches it from any group. The
 *  caller (App) tears down the moved tab's webview, since it left this space. */
export async function sendTabToWorkspace(tabId: number, ws: number): Promise<void> {
  await tabSetWorkspace(tabId, ws).catch(() => {});
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
}
/** Send a whole group to another workspace (#44). Returns the moved tab ids. */
export async function sendGroupToWorkspace(groupId: number, ws: number): Promise<number[]> {
  const moved = await groupSetWorkspace(groupId, ws).catch(() => [] as number[]);
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
  return moved;
}
export async function deleteGroup(id: number): Promise<void> {
  await groupDelete(id).catch(() => {});
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
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
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
  return n;
}
/** Restore a named session (#47): open each of its tabs. Returns the count. */
export async function restoreSession(id: number): Promise<number> {
  const tabs = await sessionRestore(id).catch(() => []);
  for (const t of tabs) await openTab("browser", t.url).catch(() => {});
  return tabs.length;
}
/** Open a set of URLs as browser tabs and bundle them into a new tab group
 *  (#56). Capped so a big folder can't open hundreds of tabs at once. The
 *  practical "import tab groups" bridge: open a bookmark folder as a group. */
export async function openUrlsAsGroup(name: string, urls: string[]): Promise<number> {
  const palette = [0x5bc0eb, 0x9d8df1, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const color = palette[groups().length % palette.length]!;
  const ids: number[] = [];
  for (const url of urls.slice(0, 20)) {
    const t = await openTab("browser", url).catch(() => null);
    if (t) ids.push(t.id);
  }
  if (ids.length) await groupCreate(name || "Group", color, ids).catch(() => {});
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
  return ids.length;
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
// A fine-grained store (not one big object signal) so loading one host's icon
// only re-renders rows showing THAT host — not every favicon consumer (which was
// O(rows²) when many tabs fetched icons at once on session restore).
const [favicons, setFavicons] = createStore<Record<string, string | null>>({});
const faviconInflight = new Set<string>();
export const faviconFor = (host: string | null): string | null | undefined =>
  host ? favicons[host] : undefined;
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

// Auto-trigger the streaming Omni answer on every search submit. Off by default:
// each submit spins up the local LLM (seconds + VRAM), so it's opt-in — the
// "Ask Omni" row / Alt+Enter are always available regardless.
const [omniAutoAnswer, setOmniAutoAnswerRaw] = createSignal(localStorage.getItem("flux.omni-auto") === "1");
export { omniAutoAnswer };
export function setOmniAutoAnswer(on: boolean): void {
  setOmniAutoAnswerRaw(on);
  localStorage.setItem("flux.omni-auto", on ? "1" : "0");
}

export function ensureFavicon(host: string | null): void {
  if (!host || host in favicons || faviconInflight.has(host)) return;
  faviconInflight.add(host);
  void faviconFetch(host)
    .then((d) => setFavicons(host, d ?? null))
    .catch(() => setFavicons(host, null))
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

// Memoized — read in many reactive scopes per render (effects, components, the
// sidebar); recompute once per tabs()/activeId() change, not per call.
export const activeTab = createMemo((): TabMeta | null =>
  tabs().find((t) => t.id === activeId()) ?? null);

// Only the active workspace's tabs appear in the strip (#44). Memoized — these
// are read many times per render (every tab row, group section, split fold), so
// recomputing the filter each call was O(tabs) per call → O(tabs²) per render.
export const pinnedTabs = createMemo(() => tabs().filter((t) => t.pinned && t.workspace === activeWorkspace()));
export const unpinnedTabs = createMemo(() => tabs().filter((t) => !t.pinned && t.workspace === activeWorkspace()));

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
  void refreshPanels();
}

export async function openTab(kind: TabKind, url?: string, isPrivate?: boolean): Promise<TabMeta> {
  const tab = await tabCreate(kind, url, isPrivate);
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
