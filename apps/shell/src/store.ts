/**
 * Shared tab store. Module-level Solid signals: the tab strip, pinned rail,
 * and web area all read the same source of truth, so a pin/focus mutation is
 * one signal write — no prop drilling, no context provider overhead.
 */
import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setPendingCommand } from "./terminals";
import {
  darkmodeSet,
  navSet,
  spotifySetDir,
  agentSetModel,
  agentModel,
  faviconFetch,
  isStartUrl,
  START_URL,
  tabSetUrl,
  groupCreate,
  groupDelete,
  groupUpdate,
  groupsFromClusters,
  groupsList,
  tabsRecluster,
  foldersList,
  folderCreate,
  folderUpdate,
  folderDelete,
  tabSetFolder,
  tabRename,
  type TabFolder,
  tabClose,
  tabCreate,
  tabFocus,
  shellSnapshot,
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
  panelReorder,
  containersList,
  containerCreate,
  containerUpdate,
  containerDelete,
  type Container,
  sessionRestore,
  snapshotRestore,
  type WebPanel,
  type ReaderBlock,
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
  // Any "page" tab in this workspace is splittable — real web pages (tiled native
  // webview) AND Flux's internal DOM pages (home, tasks, …, rendered into the
  // half by ContentArea). Terminals/files stay excluded.
  const ok = (t?: TabMeta) => !!t && t.kind === "browser" && t.workspace === activeWorkspace();
  return ok(l) && ok(r) ? [l as TabMeta, r as TabMeta] : null;
};

// Web panels (BACKLOG #48): pinned sites shown in a slim pane beside any tab.
// Only the *open* panel holds a live webview (RAM-conscious). `panelWidth` (px)
// is the pane width; `panelDragging` hides the panel + tab webviews while the
// divider is dragged so the DOM splitter can track the pointer.
const [panels, setPanels] = createSignal<WebPanel[]>([]);
// Two stacked slots: `activePanelId` is the top, `activePanelIdB` the bottom split
// (e.g. calendar over email). Each holds at most one panel; the same panel can't
// be in both. When only the top is set the pane shows one panel full-height.
const [activePanelId, setActivePanelIdRaw] = createSignal<number | null>(null);
const [activePanelIdB, setActivePanelIdBRaw] = createSignal<number | null>(null);
// Persist which panels are open so they reopen on next launch (panel "on by default").
function setActivePanelId(id: number | null): void {
  setActivePanelIdRaw(id);
  localStorage.setItem("flux.panel.active", id == null ? "" : String(id));
}
function setActivePanelIdB(id: number | null): void {
  setActivePanelIdBRaw(id);
  localStorage.setItem("flux.panel.activeB", id == null ? "" : String(id));
}
const [panelWidth, setPanelWidthSig] = createSignal(Number(localStorage.getItem("flux.panel.w")) || 380);
// Top panel's share of the pane height when both slots are filled (0.2–0.8).
const [panelSplitRatio, setPanelSplitRatioSig] = createSignal(
  Math.min(0.8, Math.max(0.2, Number(localStorage.getItem("flux.panel.split")) || 0.5)),
);
const [panelDragging, setPanelDragging] = createSignal(false);
export { panels, activePanelId, activePanelIdB, panelWidth, panelSplitRatio, panelDragging, setPanelDragging };
export const activePanel = (): WebPanel | null =>
  panels().find((p) => p.id === activePanelId()) ?? null;
export const activePanelB = (): WebPanel | null =>
  panels().find((p) => p.id === activePanelIdB()) ?? null;
export function setPanelWidth(px: number): void {
  const w = Math.round(Math.max(280, Math.min(640, px)));
  setPanelWidthSig(w);
  localStorage.setItem("flux.panel.w", String(w));
}
export function setPanelSplitRatio(r: number): void {
  const v = Math.min(0.8, Math.max(0.2, r));
  setPanelSplitRatioSig(v);
  localStorage.setItem("flux.panel.split", String(v));
}
function applyPanels(list: WebPanel[]): void {
  setPanels(list);
  // On boot, reopen the last-open panels (panel "on by default"); drop stale ones.
  const saved = Number(localStorage.getItem("flux.panel.active") || "0");
  if (activePanelId() == null && saved && list.some((p) => p.id === saved)) setActivePanelIdRaw(saved);
  else if (activePanelId() != null && !list.some((p) => p.id === activePanelId())) setActivePanelIdRaw(null);
  const savedB = Number(localStorage.getItem("flux.panel.activeB") || "0");
  if (activePanelIdB() == null && savedB && savedB !== activePanelId() && list.some((p) => p.id === savedB)) setActivePanelIdBRaw(savedB);
  else if (activePanelIdB() != null && !list.some((p) => p.id === activePanelIdB())) setActivePanelIdBRaw(null);
}
async function refreshPanels(): Promise<void> {
  const list = await panelsList().catch(() => []);
  applyPanels(list);
}
/** Pin a site as a panel and open it. */
export async function pinPanel(url: string, title: string): Promise<void> {
  const p = await panelAdd(url, title).catch(() => null);
  await refreshPanels();
  if (p) setActivePanelId(p.id);
}
/** Remove a pinned panel; closes it if it was open in either slot. */
export async function unpinPanel(id: number): Promise<void> {
  if (activePanelId() === id) setActivePanelId(null);
  if (activePanelIdB() === id) setActivePanelIdB(null);
  await panelRemove(id).catch(() => {});
  await refreshPanels();
}
/** Reorder pinned panels (drag in the app rail): apply optimistically, persist. */
export function reorderPanels(ids: number[]): void {
  const byId = new Map(panels().map((p) => [p.id, p]));
  const next = ids.map((i) => byId.get(i)).filter((p): p is WebPanel => !!p);
  if (next.length === panels().length) setPanels(next);
  void panelReorder(ids).catch(() => void refreshPanels());
}
/** Toggle a panel in the top slot. If it was in the bottom split, move it up. */
export function togglePanel(id: number): void {
  if (activePanelIdB() === id) setActivePanelIdB(null);
  setActivePanelId(activePanelId() === id ? null : id);
}
/** Toggle a panel in the bottom split slot. If it was on top, move it down. */
export function togglePanelBottom(id: number): void {
  if (activePanelId() === id) setActivePanelId(null);
  setActivePanelIdB(activePanelIdB() === id ? null : id);
}
export function closePanel(): void {
  // Closing the top promotes the bottom split up, so the pane never goes blank
  // with a panel still parked below.
  const b = activePanelIdB();
  setActivePanelId(null);
  if (b != null) { setActivePanelIdB(null); setActivePanelId(b); }
}
export function closePanelB(): void {
  setActivePanelIdB(null);
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

// Reader mode (BACKLOG #41): the extracted article for the active tab, rendered
// over the (hidden) webview. `readerTab` is the tab it belongs to so it closes
// when you switch away.
const [readerOpen, setReaderOpen] = createSignal(false);
const [readerTitle, setReaderTitle] = createSignal("");
const [readerBlocks, setReaderBlocks] = createSignal<ReaderBlock[]>([]);
const [readerTab, setReaderTab] = createSignal<number | null>(null);
export { readerOpen, readerTitle, readerBlocks, readerTab };
export function openReader(tab: number, title: string, blocks: ReaderBlock[]): void {
  setReaderTab(tab);
  setReaderTitle(title);
  setReaderBlocks(blocks);
  setReaderOpen(true);
}
export function closeReader(): void {
  setReaderOpen(false);
  setReaderBlocks([]);
}

// Multi-account containers (BACKLOG #59): isolated cookie/storage jars.
const [containers, setContainers] = createSignal<Container[]>([]);
export { containers };
export const containerColor = (c: Container): string => `#${(c.color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
export const containerById = (id: number): Container | null => containers().find((c) => c.id === id) ?? null;
async function refreshContainers(): Promise<void> {
  setContainers(await containersList().catch(() => []));
}
const C_PALETTE = [0xff8a8a, 0x7cf5b0, 0xffcc66, 0x5bc0eb, 0xec4be0, 0x9d8df1];
export async function createContainer(name?: string): Promise<number> {
  const color = C_PALETTE[containers().length % C_PALETTE.length]!;
  const id = await containerCreate(name || `Container ${containers().length + 1}`, color).catch(() => 0);
  await refreshContainers();
  return id;
}
export async function renameContainer(id: number, name: string): Promise<void> {
  await containerUpdate(id, { name }).catch(() => {});
  await refreshContainers();
}
export async function recolorContainer(id: number): Promise<void> {
  const c = containerById(id);
  if (!c) return;
  const i = C_PALETTE.indexOf(c.color);
  await containerUpdate(id, { color: C_PALETTE[(i + 1) % C_PALETTE.length]! }).catch(() => {});
  await refreshContainers();
}
export async function deleteContainer(id: number): Promise<void> {
  await containerDelete(id).catch(() => {});
  await refreshTabs();
}
/** Open a new tab in a container (#59) — isolated cookie/storage jar. */
export async function openTabInContainer(containerId: number, url?: string): Promise<TabMeta> {
  const tab = await tabCreate("browser", url, false, containerId);
  setActiveId(tab.id);
  await refreshTabs();
  return tab;
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
  // Re-embed all tabs from their current captured page content first, so we group
  // by *fresh* clusters — otherwise clicking did nothing when the clusters were
  // stale or single-tab. tabsRecluster resolves once assignments are set.
  await tabsRecluster().catch(() => {});
  const n = await groupsFromClusters().catch(() => 0);
  await refreshTabs(); // refreshTabs already refreshes groups + workspaces
  return n;
}

// Tab folders — hibernated parking buckets (distinct from groups). Refreshed by
// refreshTabs. Member tabs are excluded from the strip (see unpinnedTabs) and
// the App keeps them hibernated.
const [folders, setFolders] = createSignal<TabFolder[]>([]);
export { folders };
async function refreshFolders(): Promise<void> {
  setFolders(await foldersList().catch(() => []));
}
/** Move a tab into a folder (or out, with null). App hibernates folder members. */
export async function setTabFolder(tabId: number, folder: number | null): Promise<void> {
  await tabSetFolder(tabId, folder).catch(() => {});
  await refreshTabs(); // refreshes folders too
}
export async function newFolderWithTab(tabId: number): Promise<void> {
  const id = await folderCreate("New folder").catch(() => null);
  if (id != null) await tabSetFolder(tabId, id).catch(() => {});
  await refreshTabs();
}
export async function renameFolder(id: number, name: string): Promise<void> {
  await folderUpdate(id, { name }).catch(() => {});
  await refreshFolders();
}
export async function toggleFolderCollapsed(f: TabFolder): Promise<void> {
  await folderUpdate(f.id, { collapsed: !f.collapsed }).catch(() => {});
  await refreshFolders();
}
export async function deleteFolder(id: number): Promise<void> {
  await folderDelete(id).catch(() => {});
  await refreshTabs();
}

/** Display name for a tab: the user's custom name, else the page title, else url. */
export const tabLabel = (t: TabMeta): string => t.custom_title || t.title || t.url;
/** Rename a tab (empty → revert to the page title). */
export async function renameTab(id: number, name: string): Promise<void> {
  await tabRename(id, name).catch(() => {});
  await refreshTabs();
}
/** Restore a named session (#47): open each of its tabs. Returns the count. */
export async function restoreSession(id: number): Promise<number> {
  const tabs = await sessionRestore(id).catch(() => []);
  for (const t of tabs) await openTab("browser", t.url).catch(() => {});
  return tabs.length;
}
/** Reopen a daily auto-snapshot (#47): open each tab captured that day. */
export async function restoreSnapshot(day: number): Promise<number> {
  const tabs = await snapshotRestore(day).catch(() => []);
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
// Visual Lens trigger (#115): ⌘K / button sets this; the agent panel picks it up,
// captures the active page, and identifies it with the local vision model.
const [pendingLens, setPendingLens] = createSignal(false);
export { pendingLens, setPendingLens };
// True while a start-page widget is expanded into its full-screen modal (#90).
// Native web-panel webviews are an OS layer ABOVE all HTML, so z-index can't put
// the modal over them — App hides the panel webviews while this is set instead.
const [homeModalOpen, setHomeModalOpen] = createSignal(false);
export { homeModalOpen, setHomeModalOpen };

// Bookmark bar (#22): a chip row docked under the content card. Persisted,
// default on. Toggling resizes the card → the webview relayout follows.
const [bookmarkBarOpen, setBookmarkBarRaw] = createSignal(localStorage.getItem("flux.bookmarkbar") !== "0");
export { bookmarkBarOpen };
export function setBookmarkBarOpen(on: boolean): void {
  setBookmarkBarRaw(on);
  localStorage.setItem("flux.bookmarkbar", on ? "1" : "0");
}

// Web panel unread badges (#48): panel id → last-reported unread count from its
// title. A fine-grained store so updating one panel's badge only re-renders that
// rail icon. Set by a `flux://panel-badge` listener.
const [panelBadges, setPanelBadgeRaw] = createStore<Record<number, number>>({});
export { panelBadges };
export function setPanelBadge(id: number, count: number): void {
  setPanelBadgeRaw(id, count);
}

// Liquid start-page background (#77): the WebGL particle-liquid backdrop vs the
// cheap SVG wave. Persisted, default ON (auto-falls back to the wave if WebGL2
// is unavailable or the shader fails).
const [liquidBg, setLiquidRaw] = createSignal(localStorage.getItem("flux.liquidbg") !== "0");
export { liquidBg };
export function setLiquidBg(on: boolean): void {
  setLiquidRaw(on);
  localStorage.setItem("flux.liquidbg", on ? "1" : "0");
}

// Pages bar: a quick-access strip of Flux native pages above the content card.
// Persisted, default OFF (opt-in). Like the bookmark bar, toggling resizes the
// card so the native webview relayout follows.
const [pagesBarOpen, setPagesBarRaw] = createSignal(localStorage.getItem("flux.pagesbar") === "1");
export { pagesBarOpen };
export function setPagesBarOpen(on: boolean): void {
  setPagesBarRaw(on);
  localStorage.setItem("flux.pagesbar", on ? "1" : "0");
}

// Files popout panel (#6 file explorer): a DOM file-explorer overlay toggled
// from the toolbar, separate from Files *tabs*. Its cwd persists (localStorage)
// so it reopens where you left off.
const [filesPanelOpen, setFilesPanelOpen] = createSignal(false);
const [filesPanelPath, setFilesPanelPathRaw] = createSignal(localStorage.getItem("flux.filespanel.path") ?? "");
export { filesPanelOpen, setFilesPanelOpen, filesPanelPath };
export function setFilesPanelPath(p: string): void {
  setFilesPanelPathRaw(p);
  localStorage.setItem("flux.filespanel.path", p);
}

// AudioPulse config-dir override (#115): on a Windows Flux build, AudioPulse's
// token lives in WSL — let the user paste the path (e.g. a \\wsl.localhost\… one)
// instead of an env var. Persisted; pushed to the backend on change + on boot.
const [audiopulseDir, setAudiopulseDirRaw] = createSignal(localStorage.getItem("flux.audiopulse.dir") ?? "");
export { audiopulseDir };
export function setAudiopulseDir(p: string): void {
  setAudiopulseDirRaw(p);
  localStorage.setItem("flux.audiopulse.dir", p);
  void spotifySetDir(p).catch(() => {});
}
/** Push the persisted AudioPulse dir to the backend (call once on boot). */
export function applyAudiopulseDir(): void {
  const d = audiopulseDir();
  if (d) void spotifySetDir(d).catch(() => {});
}

// Google Maps popout pane: a floating DOM panel (like the files popout, bigger)
// holding a Google Maps embed iframe. `mapQuery` persists the last search so it
// reopens where you left off.
const [mapPanelOpen, setMapPanelOpen] = createSignal(false);
const [mapQuery, setMapQueryRaw] = createSignal(localStorage.getItem("flux.map.query") ?? "");
export { mapPanelOpen, setMapPanelOpen, mapQuery };
// Notebook / KB floating pane (#116) — the second-brain (Onyx + Scroll) in a glass
// popout, like the file explorer. Opened from the toolbar 📓 button.
const [kbPanelOpen, setKbPanelOpen] = createSignal(false);
export { kbPanelOpen, setKbPanelOpen };
// Semantic shell-history search overlay (#122) — Ctrl+Shift+R / command palette.
const [shellHistOpen, setShellHistOpen] = createSignal(false);
export { shellHistOpen, setShellHistOpen };
// Split-view picker overlay (#43) — center-screen, so it must gate the webview.
const [splitPickerOpen, setSplitPickerOpen] = createSignal(false);
export { splitPickerOpen, setSplitPickerOpen };
// Semantic find overlay (#126) — find-by-meaning in-page / across tabs.
const [semFindOpen, setSemFindOpen] = createSignal(false);
export { semFindOpen, setSemFindOpen };
// Watched-pages panel (#128) — semantic change monitor list.
const [watchPanelOpen, setWatchPanelOpen] = createSignal(false);
export { watchPanelOpen, setWatchPanelOpen };
// Tracker graph overlay (#129) — privacy viz of third-party requests.
const [trackerGraphOpen, setTrackerGraphOpen] = createSignal(false);
export { trackerGraphOpen, setTrackerGraphOpen };
// Pinned-app launcher (#131) — which app panes are open + which has focus (for
// Gemma's context). App panes are iframe overlays, so they gate the webview.
const [openAppIds, setOpenAppIds] = createSignal<string[]>([]);
const [focusedAppId, setFocusedAppId] = createSignal<string | null>(null);
export { openAppIds, setOpenAppIds, focusedAppId, setFocusedAppId };

// An agent-panel dropdown (model picker / past chats) is open. Native page
// webviews are an OS layer above the chrome, so a dropdown rendered over the page
// would be behind it (translucent + unclickable). App hides the active webview
// while this is set, like the other chrome overlays.
const [agentMenuOpen, setAgentMenuOpen] = createSignal(false);
export { agentMenuOpen, setAgentMenuOpen };

// Deferred permission Asks (#38) — the engine is paused on each until the
// chrome's permission bar answers. A queue: pages can fire several at once
// (mic + camera). NOT an overlay — the bar docks above the content card, so
// the webview shrinks instead of being hidden.
const [permAsks, setPermAsks] = createSignal<import("./ipc").PermAsk[]>([]);
export { permAsks };
export function pushPermAsk(a: import("./ipc").PermAsk): void {
  setPermAsks((q) => (q.some((x) => x.id === a.id) ? q : [...q, a]));
}
export function removePermAsk(id: number): void {
  setPermAsks((q) => q.filter((x) => x.id !== id));
}

// "Save password?" prompt (BACKLOG #61 follow-up) — the sentinel captured a
// manually-typed login on submit. One at a time (latest wins); docks above the
// content card like the permission bar. The captured password stays in Rust.
const [savePrompt, setSavePrompt] = createSignal<import("./ipc").VaultSavePrompt | null>(null);
export { savePrompt, setSavePrompt };

// ─── Overlay registry ────────────────────────────────────────────────────────
// THE single source of truth for "an HTML overlay must cover the page area".
// Native tab webviews are an OS layer above ALL chrome HTML — z-index can't put
// an overlay over them, so the tiling/panel effects hide the webviews whenever
// any of these is open. Every full-card overlay flag MUST be OR'd in here (plus
// paletteOpen, which is App-local and composed in App.tsx); the effects read
// only this. Forgetting a flag here is the bug class that hid split view and
// buried expanded home widgets — don't re-grow per-effect boolean chains.
export const pageOverlayActive = (): boolean =>
  readerOpen() ||
  filesPanelOpen() ||
  mapPanelOpen() ||
  kbPanelOpen() ||
  agentMenuOpen() ||
  homeModalOpen() ||
  shellHistOpen() ||
  splitPickerOpen() ||
  semFindOpen() ||
  watchPanelOpen() ||
  trackerGraphOpen() ||
  openAppIds().length > 0;
export function setMapQuery(q: string): void {
  setMapQueryRaw(q);
  localStorage.setItem("flux.map.query", q);
}

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

// Navigation toggles (#51/#52): vim link-hints + mouse gestures. Off by default
// (they hijack `f` and the right-drag), persisted; applied on boot + on toggle.
const [vimHints, setVimHintsRaw] = createSignal(localStorage.getItem("flux.nav.hints") === "1");
const [mouseGestures, setMouseGesturesRaw] = createSignal(localStorage.getItem("flux.nav.gestures") === "1");
export { vimHints, mouseGestures };
export function setVimHints(on: boolean): void {
  setVimHintsRaw(on);
  localStorage.setItem("flux.nav.hints", on ? "1" : "0");
  void navSet(on, mouseGestures()).catch(() => {});
}
export function setMouseGestures(on: boolean): void {
  setMouseGesturesRaw(on);
  localStorage.setItem("flux.nav.gestures", on ? "1" : "0");
  void navSet(vimHints(), on).catch(() => {});
}
/** Apply the persisted nav toggles (call once on boot). */
export function applyNav(): void {
  void navSet(vimHints(), mouseGestures()).catch(() => {});
}

// Agent model (#81): the chosen Ollama model, persisted; "" = env/default.
const [agentModelName, setAgentModelRaw] = createSignal(localStorage.getItem("flux.model") || "");
export { agentModelName };
export function setAgentModel(name: string): void {
  setAgentModelRaw(name);
  localStorage.setItem("flux.model", name);
  void agentSetModel(name).catch(() => {});
}
/** Apply the persisted model choice + sync the label with the live default. */
export function applyAgentModel(): void {
  const saved = agentModelName();
  if (saved) void agentSetModel(saved).catch(() => {});
  else void agentModel().then((m) => setAgentModelRaw(m)).catch(() => {});
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
export const pinnedTabs = createMemo(() => tabs().filter((t) => t.pinned && t.folder == null && t.workspace === activeWorkspace()));
// Folder tabs are parked out of the strip (rendered in the folder section); they
// stay hibernated for ≈0 RAM.
export const unpinnedTabs = createMemo(() => tabs().filter((t) => !t.pinned && t.folder == null && t.workspace === activeWorkspace()));
/** Active-workspace tabs in a given folder (for the folder section). */
export const folderTabs = (folderId: number) =>
  tabs().filter((t) => t.folder === folderId && t.workspace === activeWorkspace());

export async function refreshTabs(): Promise<void> {
  const snapshot = await shellSnapshot();
  const list = snapshot.tabs;
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
    const restored = snapshot.active_tab;
    setActiveId(restored && list.some((t) => t.id === restored) ? restored : list.at(-1)!.id);
  }
  setGroups(snapshot.groups);
  setFolders(snapshot.folders);
  setWorkspaces(snapshot.workspaces);
  setActiveWorkspaceSig(snapshot.active_workspace);
  applyPanels(snapshot.panels);
  setContainers(snapshot.containers);
}

export async function openTab(kind: TabKind, url?: string, isPrivate?: boolean, background?: boolean): Promise<TabMeta> {
  const tab = await tabCreate(kind, url, isPrivate);
  if (!background) setActiveId(tab.id); // background tabs (middle/Ctrl-click) don't steal focus
  await refreshTabs();
  return tab;
}

/** Open a Terminal tab that auto-runs `cmd` once its shell is up (TUI app launcher,
 *  #117). cwd seeds the terminal's working dir. The command is registered before
 *  the tab mounts, so TerminalView runs it right after the PTY spawns (no race). */
export async function openTerminalApp(cmd: string, cwd?: string): Promise<void> {
  const tab = await tabCreate("terminal", cwd && cwd.trim() ? cwd.trim() : undefined);
  if (cmd.trim()) setPendingCommand(tab.id, cmd.trim());
  setActiveId(tab.id);
  await refreshTabs();
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
  // QoL: always keep a start tab around. Closing a browser tab when no *other*
  // flux://start tab is open converts this one into a fresh start tab instead of
  // removing it — so there's always a new tab to start from.
  const all = tabs();
  const closing = all.find((t) => t.id === id);
  const otherStart = all.some((t) => t.id !== id && t.url === START_URL);
  if (closing && closing.kind === "browser" && closing.url !== START_URL && !otherStart) {
    if (splitPair()?.includes(id)) clearSplit();
    setTabLoading(id, false);
    setHibernated(id, false);
    await webviewClose(id); // drop the page webview; start tabs have none
    updateTabUrl(id, START_URL);
    await tabSetUrl(id, START_URL, "New Tab").catch(() => {});
    await refreshTabs();
    return;
  }
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

// ─── Auto-archive stale tabs (#46) ──────────────────────────────────────────
// Close browser tabs left untouched for N days into a restorable list, so a long-
// lived window sheds clutter (hibernation already handles their RAM). Access times
// are keyed by URL — tab ids reset across restarts — and persisted; the archived
// list and the "days" setting also live in localStorage. Off by default (days = 0).
export type ArchivedTab = { url: string; title: string; ts: number };
const ACCESS_KEY = "flux.tabAccess";
const ARCHIVED_KEY = "flux.archivedTabs";
const ARCH_DAYS_KEY = "flux.autoArchive.days";

const readJson = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
};
let accessMap: Record<string, number> = readJson(ACCESS_KEY, {});
const saveAccess = () => localStorage.setItem(ACCESS_KEY, JSON.stringify(accessMap));
/** Record that a tab's URL was just visited (so it's not considered stale). */
export function touchTabUrl(url: string): void {
  if (!url || url === START_URL) return;
  accessMap[url] = Date.now();
  saveAccess();
}
/** Seed access times for URLs we haven't seen, so freshly-restored tabs aren't
 *  instantly stale on the first sweep after a long-ago last visit. */
export function seedTabAccess(urls: string[]): void {
  const now = Date.now();
  let changed = false;
  for (const u of urls) if (u && u !== START_URL && accessMap[u] == null) { accessMap[u] = now; changed = true; }
  if (changed) saveAccess();
}

const [archivedTabs, setArchivedTabs] = createSignal<ArchivedTab[]>(readJson(ARCHIVED_KEY, []));
export { archivedTabs };
export const autoArchiveDays = (): number => Number(localStorage.getItem(ARCH_DAYS_KEY) || "0");
export function setAutoArchiveDays(d: number): void {
  localStorage.setItem(ARCH_DAYS_KEY, String(Math.max(0, Math.round(d))));
}
function persistArchived(list: ArchivedTab[]): void {
  setArchivedTabs(list);
  localStorage.setItem(ARCHIVED_KEY, JSON.stringify(list.slice(0, 200)));
}
/** Record a tab in the archived list (newest first; dedup by URL). */
export function archiveTabRecord(url: string, title: string): void {
  if (!url || url === START_URL) return;
  persistArchived([{ url, title: title || url, ts: Date.now() }, ...archivedTabs().filter((a) => a.url !== url)].slice(0, 200));
}
export function removeArchived(url: string): void { persistArchived(archivedTabs().filter((a) => a.url !== url)); }
export function clearArchived(): void { persistArchived([]); }
/** Reopen an archived tab and drop it from the list. */
export async function restoreArchived(a: ArchivedTab): Promise<void> {
  removeArchived(a.url);
  touchTabUrl(a.url);
  await openTab("browser", a.url);
}
/** Open browser tabs stale enough to auto-archive now (excludes the active, pinned,
 *  foldered and start tabs). Empty when the feature is off (days = 0). */
export function staleTabIds(now: number): number[] {
  const days = autoArchiveDays();
  if (days <= 0) return [];
  const cutoff = days * 86_400_000;
  return tabs()
    .filter((t) => t.kind === "browser" && !t.pinned && t.folder == null && t.id !== activeId() && t.url !== START_URL && now - (accessMap[t.url] ?? now) > cutoff)
    .map((t) => t.id);
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

/** Curated snapshot of Flux's live UI state for the agent (#4 introspection) —
 *  reads the meaningful store signals into a readable summary. */
export function fluxStateSnapshot(): string {
  const ts = tabs();
  const at = activeTab();
  const n = (k: string) => ts.filter((t) => t.kind === k).length;
  const lines = [
    `Workspace: ${activeWorkspace()} (of ${workspaces().length})`,
    `Tabs: ${ts.length} open — ${n("browser")} browser, ${n("terminal")} terminal, ${n("files")} files`,
    at ? `Active tab: #${at.id} ${at.kind} — ${(at.title || at.url || "").slice(0, 80)}` : "Active tab: none",
    `Web panels: ${panels().length} pinned, active=${activePanelId() ?? "none"}`,
    `Overlays: reader=${readerOpen()}, files-popout=${filesPanelOpen()}, map=${mapPanelOpen()}, agent-menu=${agentMenuOpen()}`,
    `Split view: ${splitPair() ? "on" : "off"}`,
    `Appearance: dark=${darkMode()}, liquidBg=${liquidBg()}, bookmarkBar=${bookmarkBarOpen()}, pagesBar=${pagesBarOpen()}`,
    `Agent model: ${agentModelName() || "(default)"}`,
  ];
  return `Flux UI state:\n${lines.join("\n")}`;
}
