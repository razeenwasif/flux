/**
 * Flux shell — Arc-style vertical layout (ADR 0002).
 *
 * One CSS grid; columns are set inline so toggling/collapsing a region is a
 * single template swap (one style recalc, no JS layout — the geometry contract
 * from ADR 0001 survives the redesign):
 *
 *   ┌─────────┬────────────────┬──────────┬─────────┐
 *   │ SIDEBAR │ ┌────────────┐ │ TERMINAL │  AGENT  │
 *   │ pins    │ │  content   │ │ (vertical│ (panel) │
 *   │ address │ │  card      │ │  column) │         │
 *   │ tabs    │ │  (floats)  │ │          │         │
 *   │ footer  │ └────────────┘ │          │         │
 *   └─────────┴────────────────┴──────────┴─────────┘
 *     248px        1fr             420px     360px
 *
 * Sidebar collapses to a 60px icon rail; terminal and agent columns each
 * collapse to 0. Defaults: sidebar open, agent open, terminal closed.
 */
import { For, Match, Show, Suspense, Switch, createEffect, createMemo, createSignal, lazy, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import {
  NOTEBOOK_URL,
  OMNI_URL,
  VAULT_URL,
  HISTORY_URL,
  BOOKMARKS_URL,
  SESSIONS_URL,
  RESOURCES_URL,
  TASKS_URL,
  SPEEDTEST_URL,
  PERMISSIONS_URL,
  PDF_URL,
  isPdfUrl,
  pdfViewerUrl,
  ARCHIVE_URL,
  archiveSave,
  FEEDS_URL,
  SYNC_URL,
  APPS_URL,
  SETTINGS_URL,
  pwaInstall,
  PANE_SESSION,
  agentTranslate,
  noteGet,
  noteSet,
  bookmarkAdd,
  bookmarkRemove,
  bookmarksList,
  webviewDevtools,
  chromeFocus,
  isStartUrl,
  launchIntent,
  onClustersUpdated,
  onExtOpenTab,
  onFindResult,
  onFullscreenChanged,
  onShortcut,
  onOpenUrl,
  onTabLoaded,
  onPanelBadge,
  historySearch,
  searchDefault,
  searchEngines,
  searchResolve,
  searchSetDefault,
  searchSuggest,
  tabSetUrl,
  webviewBack,
  type SearchEngine,
  webviewForward,
  memStatus,
  hibernateRank,
  prefetchRecord,
  prefetchHints,
  prefetchSetPressure,
  webviewPreconnect,
  webviewCaptureState,
  webviewHibernate,
  webviewHide,
  webviewNavigate,
  webviewOpen,
  webviewReload,
  webviewZoom,
  webviewExtractReader,
  onReader,
  webviewCapture,
  onScreenshot,
  type ReaderBlock,
  omniIngestActive,
  omniAnswer,
  type OmniAnswerSource,
  webviewSetBounds,
  webviewShow,
  webviewStop,
  webviewFind,
  panelOpen,
  panelSetBounds,
  panelShow,
  panelHide,
  panelClose,
  panelNavigate,
  workspaceActive,
  workspaceDelete,
  workspaceSwitch,
  win,
  type MemInfo,
  type Rect,
  type ResizeDir,
  type TabGroup,
  type TabMeta,
  type WebPanel,
  type Workspace,
} from "./ipc";
import TerminalView from "./TerminalView";
import { setTerminalOpener } from "./terminals";
import { keyToAction } from "./shortcuts";
import FindBar from "./FindBar";
import Downloads from "./Downloads";
import Shields from "./Shields";
import type { PaletteAction } from "./CommandPalette";
import { LinkMenu } from "./linkMenu";
// Lazy-loaded: not shown on a fresh window, so they stay out of the boot bundle
// and load on first use (instant — assets are local/embedded). #startup
const CommandPalette = lazy(() => import("./CommandPalette"));
const StartPage = lazy(() => import("./StartPage"));
const Extensions = lazy(() => import("./Extensions"));
const FilesView = lazy(() => import("./FilesView"));
const OmniDashboard = lazy(() => import("./OmniDashboard"));
const NotebookPage = lazy(() => import("./NotebookPage"));
const VaultPage = lazy(() => import("./VaultPage"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const BookmarksPage = lazy(() => import("./BookmarksPage"));
const SessionsPage = lazy(() => import("./SessionsPage"));
const ResourcesPage = lazy(() => import("./ResourcesPage"));
const TasksPage = lazy(() => import("./TasksPage"));
const SpeedtestPage = lazy(() => import("./SpeedtestPage"));
const PermissionsPage = lazy(() => import("./PermissionsPage"));
const PdfViewer = lazy(() => import("./PdfViewer"));
const ArchivePage = lazy(() => import("./ArchivePage"));
const FeedsPage = lazy(() => import("./FeedsPage"));
const BookmarkBar = lazy(() => import("./BookmarkBar"));
const PagesBar = lazy(() => import("./PagesBar"));
const TuiAppsBar = lazy(() => import("./TuiAppsBar"));
const AgentPanel = lazy(() => import("./AgentPanel"));
const SyncPage = lazy(() => import("./SyncPage"));
const AppsPage = lazy(() => import("./AppsPage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const Boosts = lazy(() => import("./Boosts"));
const Macros = lazy(() => import("./Macros"));
const Passwords = lazy(() => import("./Passwords"));
import {
  activeId,
  activeTab,
  activeWorkspace,
  aiAnswersOn,
  applyDarkMode,
  applyNav,
  applyAgentModel,
  applyAudiopulseDir,
  bookmarkBarOpen,
  setBookmarkBarOpen,
  pagesBarOpen,
  setPagesBarOpen,
  filesPanelOpen,
  setFilesPanelOpen,
  filesPanelPath,
  setFilesPanelPath,
  mapPanelOpen,
  agentMenuOpen,
  setMapPanelOpen,
  mapQuery,
  setMapQuery,
  vimHints,
  mouseGestures,
  setVimHints,
  setMouseGestures,
  closeTab,
  createWorkspace,
  containers,
  containerColor,
  containerById,
  createContainer,
  renameContainer,
  recolorContainer,
  deleteContainer,
  openTabInContainer,
  panels,
  activePanel,
  activePanelId,
  activePanelB,
  activePanelIdB,
  panelWidth,
  setPanelWidth,
  panelSplitRatio,
  setPanelSplitRatio,
  panelDragging,
  setPanelDragging,
  pinPanel,
  unpinPanel,
  togglePanel,
  togglePanelBottom,
  closePanel,
  closePanelB,
  panelBadges,
  setPanelBadge,
  darkMode,
  deleteGroup,
  ensureFavicon,
  faviconFor,
  findOpen,
  focusTab,
  groupByTopic,
  groupColor,
  groupWithTab,
  groups,
  hibernateEnabled,
  hibernateMins,
  isHibernated,
  isLoading,
  memEvict,
  newGroupWithTab,
  openTab,
  pinnedTabs,
  recolorGroup,
  recolorWorkspace,
  refreshTabs,
  renameGroup,
  renameWorkspace,
  reorderTabs,
  searchSuggestOn,
  setActiveWorkspace,
  setDarkMode,
  setTabGroup,
  zoomFor,
  nudgeZoom,
  readerOpen,
  readerTitle,
  readerBlocks,
  readerTab,
  openReader,
  closeReader,
  startSplit,
  clearSplit,
  splitPair,
  splitPanes,
  splitRatio,
  setSplitRatio,
  splitDragging,
  setSplitDragging,
  toggleGroupCollapsed,
  folders,
  folderTabs,
  setTabFolder,
  newFolderWithTab,
  renameFolder,
  toggleFolderCollapsed,
  deleteFolder,
  workspaceColor,
  workspaces,
  setFindMatches,
  setFindOpen,
  setHibernated,
  setHibernateEnabled,
  setAiAnswersOn,
  setHibernateMins,
  setMemEvict,
  setPendingAsk,
  setPendingLens,
  setSearchSuggestOn,
  omniAutoAnswer,
  setOmniAutoAnswer,
  setTabLoading,
  sendTabToWorkspace,
  sendGroupToWorkspace,
  tabs,
  touchTabUrl,
  seedTabAccess,
  staleTabIds,
  archiveTabRecord,
  archivedTabs,
  restoreArchived,
  removeArchived,
  clearArchived,
  tabLabel,
  renameTab,
  togglePin,
  unpinnedTabs,
  updateTabTitle,
  updateTabUrl,
} from "./store";

const App: Component = () => {
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  // Terminal column open by default (persisted — toggling off sticks).
  const [terminalOpen, setTerminalOpen] = createSignal(localStorage.getItem("flux.term.open") !== "0");
  createEffect(() => localStorage.setItem("flux.term.open", terminalOpen() ? "1" : "0"));
  // Let the agent bring up a terminal before running a command in it (#65).
  setTerminalOpener(() => setTerminalOpen(true));
  const [agentOpen, setAgentOpen] = createSignal(true);
  // Focus/compact mode (#55): hide all chrome, content only. Esc or Ctrl+Shift+F exits.
  const [focusMode, setFocusMode] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  // Resizable pane widths (px), persisted across sessions (BACKLOG #27).
  const loadW = (k: string, d: number) => Number(localStorage.getItem(k)) || d;
  const [sidebarW, setSidebarW] = createSignal(loadW("flux.w.sidebar", 252));
  const [terminalW, setTerminalW] = createSignal(loadW("flux.w.terminal", 440));
  const [agentW, setAgentW] = createSignal(loadW("flux.w.agent", 372));

  // Live rect of the content card, in CSS (logical) px relative to the window.
  // Native tab webviews are positioned to match it (BACKLOG #2).
  const [contentRect, setContentRect] = createSignal<Rect | null>(null);
  // Window width drives the responsive pane-shedding (#28). Tracked from the window
  // resize event only (not layout changes) so it can't feed back into the columns
  // it sizes. Initialised to the current width.
  const [winW, setWinW] = createSignal(window.innerWidth);
  // #46: track per-URL last-access (keyed by URL so it survives restarts) and seed
  // restored tabs so they aren't treated as stale on the first auto-archive sweep.
  createEffect(() => { const t = activeTab(); if (t?.kind === "browser") touchTabUrl(t.url); });
  createEffect(() => { seedTabAccess(tabs().filter((t) => t.kind === "browser").map((t) => t.url)); });
  // Bumped to force the webview tiling effects to re-apply bounds even when the
  // card rect hasn't changed. Needed because exiting an HTML5 video fullscreen
  // leaves the native webview oversized (covering the bookmark bar / footer) and
  // fires no window resize, so nothing would otherwise re-tile it back down.
  const [relayoutTick, setRelayoutTick] = createSignal(0);
  const forceRelayout = () => setRelayoutTick((n) => n + 1);
  const openedWebviews = new Set<number>();
  const openingWebviews = new Set<number>();
  // Webview ids currently shown (visible panes). Lets the layout effect issue
  // show/hide IPC only on transitions, not once per tab on every resize frame.
  const shown = new Set<number>();
  // Last time each tab was the active one (ms) — drives tab hibernation (#45).
  const lastActive = new Map<number, number>();
  // Last finished URL per tab — the "from" of the next navigation, for training
  // the predictive-prefetch Markov model (#103).
  const prevUrlByTab = new Map<number, string>();

  // Fire-and-forget a webview command, surfacing failures (the search/position
  // bug is hard to see otherwise — check the devtools console).
  const wv = (p: Promise<unknown>) => void p.catch((e) => console.error("[flux webview]", e));
  const forgetWebview = (id: number) => {
    openedWebviews.delete(id);
    openingWebviews.delete(id);
    shown.delete(id);
  };

  // Read the content-card rect fresh from the DOM (never a stale signal).
  const readRect = (): Rect | null => {
    const el = document.getElementById("flux-web-area");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // The pane layout (#43): normally the active browser tab fills the card; when
  // a split is active and one of the pair is focused, the two pair tabs tile
  // left | right at `splitRatio` with a small gap the DOM splitter sits in.
  const SPLIT_GAP = 8;
  // Web panel (#48) geometry: the panel is its own grid pane beside the content
  // card; its native webview sits below a DOM toolbar.
  const PANEL_TOOLBAR = 34; // DOM toolbar height atop the panel
  const mainRect = (): Rect | null => {
    return readRect();
  };
  // Each split slot is a DOM element (toolbar + native-webview region); the webview
  // is tiled below the toolbar of its slot's box, so a vertical split is just two
  // boxes the native layer follows.
  const slotViewRect = (elId: string, active: boolean): Rect | null => {
    const el = document.getElementById(elId);
    if (!el || !active) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < PANEL_TOOLBAR + 1) return null;
    return { x: r.x, y: r.y + PANEL_TOOLBAR, width: r.width, height: Math.max(0, r.height - PANEL_TOOLBAR) };
  };
  const panelViewRect = (): Rect | null => slotViewRect("flux-panel-area", activePanelId() != null);
  const panelViewRectB = (): Rect | null => slotViewRect("flux-panel-area-b", activePanelIdB() != null);
  const paneLayout = (): { tab: TabMeta; rect: Rect }[] => {
    if (readerOpen()) return []; // reader view covers the card; hide the page
    const rect = mainRect();
    if (!rect) return [];
    const pair = splitPanes();
    if (pair) {
      const ratio = Math.min(0.8, Math.max(0.2, splitRatio()));
      const lw = Math.round(rect.width * ratio - SPLIT_GAP / 2);
      const rw = Math.round(rect.width - lw - SPLIT_GAP);
      return [
        { tab: pair[0], rect: { x: rect.x, y: rect.y, width: lw, height: rect.height } },
        { tab: pair[1], rect: { x: rect.x + lw + SPLIT_GAP, y: rect.y, width: rw, height: rect.height } },
      ];
    }
    const act = activeTab();
    if (act?.kind === "browser" && !isStartUrl(act.url)) return [{ tab: act, rect }];
    return [];
  };

  // Coalesce webview bounds updates to one IPC call per animation frame — a
  // resize fires dozens of layout changes/sec, and one IPC each was the lag.
  // Pane-aware: repositions every tiled pane, not just the active tab.
  let boundsRaf = 0;
  const scheduleRelayout = () => {
    if (boundsRaf) return;
    boundsRaf = requestAnimationFrame(() => {
      boundsRaf = 0;
      if (splitDragging() || panelDragging() || readerOpen() || filesPanelOpen() || mapPanelOpen() || paletteOpen() || agentMenuOpen()) return;
      for (const p of paneLayout()) wv(webviewSetBounds(p.tab.id, p.rect));
    });
  };

  // Materialize CLI launch intent exactly once (`flux <url> -t`).
  onMount(async () => {
    await refreshTabs();
    const intent = await launchIntent().catch(() => null);
    if (intent) {
      for (const url of intent.urls) await openTab("browser", url);
      if (intent.terminal) {
        await openTab("terminal");
        setTerminalOpen(true);
      }
    }
    // Always land on something: a fresh session opens the start page.
    if (tabs().length === 0) await openTab("browser");
    applyDarkMode(); // re-apply the persisted dark-mode preference (#40)
    applyNav(); // re-apply vim-hints / mouse-gestures toggles (#51/#52)
    applyAgentModel(); // re-apply the chosen agent model (#81)
    applyAudiopulseDir(); // push the persisted AudioPulse config-dir override (#115)
    const unClusters = await onClustersUpdated(refreshTabs);
    // An extension called flux.tabs.open (#94) — the shell owns webview
    // geometry, so the broker emits an intent and we open the tab here.
    const unExtOpen = await onExtOpenTab((url) => void openTab("browser", url));
    // App keyboard shortcuts (#18). Capture phase so we win over child widgets
    // (e.g. xterm's own key handler) when the chrome/terminal is focused; the
    // injected shortcuts.js handles the case where a page webview has focus and
    // forwards the action over `flux://shortcut`.
    // While the terminal (xterm) is focused, plain Ctrl+letter chords are
    // readline/tmux bindings (Ctrl+R search, Ctrl+W delete-word, Ctrl+L clear,
    // Ctrl+B tmux prefix, …) and must reach the shell. Only claim chords that
    // don't collide — shifted/alt variants, the terminal toggle, and tab nav.
    const terminalSafe = new Set([
      "toggle-terminal", "toggle-agent", "new-terminal", "next-tab", "prev-tab", "back", "forward",
    ]);
    const inTerminal = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
    const onKey = (e: KeyboardEvent) => {
      // The command palette (#6) is modal: only Ctrl+K (to toggle it closed) is
      // a chrome shortcut while it's open; everything else goes to its input.
      if (paletteOpen()) {
        if (keyToAction(e) === "palette") { e.preventDefault(); e.stopPropagation(); dispatch("palette"); }
        return;
      }
      // Esc closes the find bar (#33), else stops the active page load (#31).
      // Handled outside the chord table so it isn't forwarded from focused pages
      // (they use Esc themselves).
      if (e.key === "Escape" && !inTerminal()) {
        if (filesPanelOpen() || mapPanelOpen()) {
          closeFilesPanel();
          return;
        }
        if (focusMode()) {
          setFocusMode(false);
          return;
        }
        if (readerOpen()) {
          closeReader();
          return;
        }
        if (findOpen()) {
          closeFind();
          return;
        }
        const t = activeTab();
        if (t?.kind === "browser" && isLoading(t.id)) {
          void webviewStop(t.id).catch(() => {});
          setTabLoading(t.id, false);
        }
        return;
      }
      const a = keyToAction(e);
      if (!a) return;
      if (inTerminal() && !(terminalSafe.has(a) || a.startsWith("tab-"))) return;
      if (dispatch(a)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // #79: drop glass blur during window resize too — repaints are GPU-heavy.
    // Add `busy` on each resize event, remove shortly after the last one.
    let busyTimer: number | undefined;
    const onWinResize = () => {
      setWinW(window.innerWidth);
      document.body.classList.add("busy");
      clearTimeout(busyTimer);
      busyTimer = window.setTimeout(() => document.body.classList.remove("busy"), 160);
    };
    window.addEventListener("resize", onWinResize);
    onCleanup(() => { window.removeEventListener("resize", onWinResize); clearTimeout(busyTimer); });
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
    const unShortcut = await onShortcut((a) => dispatch(a));
    // A page left HTML5 fullscreen (video): wry restored the webview to fill the
    // window, covering the chrome. Re-tile to put it back in the content card —
    // twice, since wry's restore can land just after the event fires.
    const unFullscreen = await onFullscreenChanged(() => {
      forceRelayout();
      setTimeout(forceRelayout, 120);
      setTimeout(forceRelayout, 400);
    });
    // Page-initiated new windows (window.open / target="_blank" / modified
    // click) → open as a Flux tab; background tabs don't steal focus.
    const unOpenUrl = await onOpenUrl((url, background) => {
      void openTab("browser", isPdfUrl(url) ? pdfViewerUrl(url) : url, false, background).catch(() => {});
    });
    // Reader mode (#41): the injected extractor posts blocks back here.
    const unReader = await onReader((tabId, title, blocks) => openReader(tabId, title, blocks));
    onCleanup(unReader);
    // Web capture (#54): a screenshot finished writing.
    const unShot = await onScreenshot(() => {
      setOmniToast("📸 Screenshot saved");
      window.setTimeout(() => setOmniToast(null), 2600);
    });
    onCleanup(unShot);
    // Tab hibernation (#45): every 30s, keep the active tab fresh and destroy
    // the webviews of browser tabs that are idle past the timeout — or, under
    // genuine memory pressure, the least-recently-used ones. Freed tabs stay in
    // the strip and reload when re-activated (the effect above re-opens any tab
    // not in `openedWebviews`).
    const hibernateTab = (id: number) => {
      forgetWebview(id);
      setHibernated(id, true);
      wv(webviewHibernate(id));
    };
    // Tab folders: members are kept hibernated (≈0 RAM) — the active tab is the
    // only exception (you're viewing it); switching away re-sleeps it. Reacts to
    // folder membership (tabs()) and the active tab.
    createEffect(() => {
      const act = activeId();
      for (const t of tabs()) {
        if (t.folder != null && t.id !== act && (openedWebviews.has(t.id) || openingWebviews.has(t.id))) {
          hibernateTab(t.id);
        }
      }
    });
    // Background = live browser tabs that aren't currently tiled in the card.
    // (In split view both panes are visible, so neither is hibernatable.)
    const liveBackground = (_act: number | null) => {
      const visible = new Set(paneLayout().map((p) => p.tab.id));
      return tabs().filter((t) =>
        t.kind === "browser" &&
        !visible.has(t.id) &&
        !isStartUrl(t.url) &&
        (openedWebviews.has(t.id) || openingWebviews.has(t.id))
      );
    };
    const hibTimer = window.setInterval(async () => {
      const now = Date.now();
      const act = activeId();
      if (act != null) lastActive.set(act, now);
      // Auto-archive (#46): close long-stale tabs into the restorable list. Gentle —
      // a few per sweep — and run BEFORE the live-bg bail, since stale tabs are
      // usually already hibernated (so not "live").
      for (const id of staleTabIds(now).slice(0, 5)) {
        const t = tabs().find((x) => x.id === id);
        if (t) { archiveTabRecord(t.url, t.title); void closeTab(id); }
      }
      // Nothing live in the background → no idle-sleep candidates and no reason
      // to scan system memory. Bail before the sysinfo IPC (the periodic cost).
      const bg = liveBackground(act);
      if (bg.length === 0) return;
      // Idle-timeout sleep.
      if (hibernateEnabled()) {
        const cutoff = hibernateMins() * 60_000;
        for (const t of bg) {
          if (now - (lastActive.get(t.id) ?? now) > cutoff) hibernateTab(t.id);
        }
      }
      // Memory-pressure eviction — only when free system memory is genuinely
      // low; sleep the LRU few (more when it's critical). memStatus (a sysinfo
      // scan) runs only here, i.e. only when there are background tabs to evict.
      if (memEvict()) {
        const m = await memStatus().catch(() => null);
        // Gate predictive prefetch (#103) on real memory pressure.
        if (m) void prefetchSetPressure(m.available_pct < 12).catch(() => {});
        if (m && m.available_pct < 12) {
          const bgNow = liveBackground(act);
          const limit = m.available_pct < 6 ? 4 : 2;
          // #106: ask the backend to order candidates worst-first (least likely
          // to be needed next, per the #103 Markov model), skipping any it wants
          // to keep. Fall back to plain LRU if the call fails / returns nothing.
          const candidates = bgNow.map((t) => ({
            tab_id: t.id,
            url: t.url,
            idle_secs: Math.round((now - (lastActive.get(t.id) ?? now)) / 1000),
          }));
          const ranked = await hibernateRank(activeTab()?.url ?? "", candidates).catch(() => null);
          const order =
            ranked && ranked.length
              ? ranked.filter((r) => !r.protected).map((r) => r.tab_id)
              : bgNow.sort((a, b) => (lastActive.get(a.id) ?? 0) - (lastActive.get(b.id) ?? 0)).map((t) => t.id);
          for (const id of order.slice(0, limit)) hibernateTab(id);
        }
      }
    }, 60_000);
    onCleanup(() => clearInterval(hibTimer));
    // Find-in-page match count from the active page (#33).
    const unFind = await onFindResult((tabId, count) => {
      if (tabId === activeId()) setFindMatches(count);
    });
    // Keep the address bar fresh as pages navigate, and re-apply the active
    // tab's bounds once it finishes loading (defensive: ensures the page sits
    // in the content card even if the initial position didn't stick).
    const unLoaded = await onTabLoaded((tabId, url, phase) => {
      updateTabUrl(tabId, url);
      setTabLoading(tabId, phase === "started"); // stop/reload swap + progress (#31)
      if (phase === "finished") {
        // Sync the live url to the backend so the persisted session (#19)
        // reflects where the tab actually is, not its creation url.
        void tabSetUrl(tabId, url).catch(() => {});
        // Re-apply the pane layout once loaded (defensive: ensures the page sits
        // in its pane even if the initial position didn't stick). Pane-aware so a
        // split pane lands in its half, not the full card.
        if (paneLayout().some((p) => p.tab.id === tabId)) scheduleRelayout();
        // Re-apply this host's saved zoom (#36).
        const z = zoomFor(hostOfUrl(url));
        if (z !== 1) void webviewZoom(tabId, z).catch(() => {});
        // Predictive prefetch (#103): learn this navigation transition, then
        // preconnect to the hosts the model expects you to visit next from here.
        if (url.startsWith("http")) {
          const prev = prevUrlByTab.get(tabId);
          if (prev && prev !== url && prev.startsWith("http")) {
            void prefetchRecord(prev, url).catch(() => {});
          }
          prevUrlByTab.set(tabId, url);
          void prefetchHints(url, 4)
            .then((hints) => {
              const hosts = (hints ?? []).map((h) => h.host);
              if (hosts.length) void webviewPreconnect(tabId, hosts).catch(() => {});
            })
            .catch(() => {});
        }
      }
    });
    // Web panel unread badges (#48): a panel reports its title's (N) count.
    const unBadge = await onPanelBadge((id, count) => setPanelBadge(id, count));
    onCleanup(() => {
      unClusters();
      unExtOpen();
      unShortcut();
      unFullscreen();
      unOpenUrl();
      unFind();
      unLoaded();
      unBadge();
    });

    // Track the content-card rect: ResizeObserver catches every layout change
    // (window resize, sidebar collapse, panel toggles, pane resize) in one place.
    const el = document.getElementById("flux-web-area");
    if (el) {
      const measure = () => setContentRect(readRect());
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener("resize", measure);
      // Recover the layout after a video leaves fullscreen: the host window regains
      // focus / fires a fullscreenchange, but no resize, so we re-measure AND force a
      // bounds re-apply to shrink the page webview off the bottom chrome again.
      const recover = () => { measure(); forceRelayout(); };
      window.addEventListener("focus", recover);
      document.addEventListener("visibilitychange", recover);
      document.addEventListener("fullscreenchange", recover);
      document.addEventListener("webkitfullscreenchange", recover);
      measure();
      onCleanup(() => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
        window.removeEventListener("focus", recover);
        document.removeEventListener("visibilitychange", recover);
        document.removeEventListener("fullscreenchange", recover);
        document.removeEventListener("webkitfullscreenchange", recover);
      });
    }
  });

  // Sync native webviews to the pane layout (#2/#43): show the tiled pane(s) at
  // their rects, hide every other browser tab's webview. `flux://start` tabs get
  // no webview — the dashboard renders in the card. While the split seam is being
  // dragged, hide all panes so the DOM splitter can track the pointer (a native
  // webview is a separate OS layer that would otherwise eat the mouse).
  createEffect(() => {
    contentRect(); // subscribe: re-run on any layout change
    relayoutTick(); // subscribe: forced re-tile (e.g. after fullscreen-video exit)
    splitRatio(); // subscribe: re-tile when the seam moves
    panelWidth(); // subscribe: re-tile when the panel divider moves
    const dragging = splitDragging() || panelDragging();
    const overlay = readerOpen() || filesPanelOpen() || mapPanelOpen() || paletteOpen() || agentMenuOpen();
    const panes = overlay ? [] : paneLayout();
    const liveIds = new Set(panes.map((p) => p.tab.id));
    // Hide only what's currently shown but shouldn't be (or everything mid-drag).
    // Crucially this issues NO hide IPC on a pure resize — `shown` already matches
    // `liveIds`, so the loop is a no-op and only the throttled bounds update runs.
    for (const id of [...shown]) {
      if (dragging || !liveIds.has(id)) {
        wv(webviewHide(id));
        shown.delete(id);
      }
    }
    if (dragging || overlay) return; // panes re-show when the drag/overlay ends
    let needRelayout = false;
    for (const p of panes) {
      const id = p.tab.id;
      if (openedWebviews.has(id)) {
        if (!shown.has(id)) {
          wv(webviewShow(id)); // only on transition into view
          shown.add(id);
        }
        needRelayout = true; // throttled bounds for resize/seam follow
      } else if (!openingWebviews.has(id)) {
        openingWebviews.add(id);
        setHibernated(id, false); // (re)opening = waking from sleep (#45)
        lastActive.set(id, Date.now());
        const r = p.rect;
        webviewOpen(id, p.tab.url, r)
          .then(async () => {
            if (!openingWebviews.has(id)) {
              shown.delete(id);
              await webviewHibernate(id);
              return;
            }
            await webviewSetBounds(id, r);
            openingWebviews.delete(id);
            openedWebviews.add(id);
            if (readerOpen() || filesPanelOpen() || mapPanelOpen() || paletteOpen() || agentMenuOpen() || splitDragging() || panelDragging()) {
              shown.delete(id);
              await webviewHide(id);
              return;
            }
            shown.add(id);
            await webviewShow(id);
          })
          .catch((e) => {
            openingWebviews.delete(id);
            openedWebviews.delete(id);
            shown.delete(id);
            console.error("[flux webview] open failed:", e);
          });
      }
    }
    if (needRelayout) scheduleRelayout();
  });

  // Web panel (#48): manage the single open panel's webview — positioned in its
  // own grid pane beside the content card. Switching panels closes the old one;
  // hidden mid-divider-drag.
  const opened: { top: number | null; bottom: number | null } = { top: null, bottom: null };
  // Reconcile one split slot's native webview against the panel it should show and
  // the rect it should occupy (null rect = keep alive but hidden behind an overlay).
  const syncSlot = (slot: "top" | "bottom", p: WebPanel | null, rect: Rect | null) => {
    const prev = opened[slot];
    if (prev != null && prev !== (p?.id ?? null)) {
      wv(panelClose(prev));
      opened[slot] = null;
    }
    if (!p) return;
    if (!rect) {
      wv(panelHide(p.id));
      return;
    }
    if (opened[slot] === p.id) {
      wv(panelSetBounds(p.id, rect));
      wv(panelShow(p.id));
    } else {
      opened[slot] = p.id;
      wv(panelOpen(p.id, p.url, rect).then(() => panelSetBounds(p.id, rect)));
    }
  };
  createEffect(() => {
    contentRect();
    relayoutTick(); // subscribe: forced re-tile (e.g. after fullscreen-video exit)
    panelWidth(); // subscribe: re-position on resize / divider drag
    panelSplitRatio(); // subscribe: re-tile both slots when the split moves
    const top = activePanel();
    const bottom = activePanelB();
    // Reader / Files popout / command palette are full overlays that must sit above
    // everything — including the web panel's own native webview layer.
    const hidden =
      panelDragging() || focusMode() || readerOpen() || filesPanelOpen() || mapPanelOpen() || paletteOpen() || agentMenuOpen();
    syncSlot("top", top, hidden ? null : panelViewRect());
    syncSlot("bottom", bottom, hidden ? null : panelViewRectB());
  });

  // Capture a tab's scroll/form state the moment you switch away from it (#45),
  // while its webview still exists — so it's preserved if the tab later sleeps.
  // No rush: a backgrounded page is frozen, so this never races hibernation.
  let prevActive: number | null = null;
  createEffect(() => {
    const cur = activeId();
    if (prevActive != null && prevActive !== cur) {
      const pid = prevActive;
      const pt = tabs().find((t) => t.id === pid);
      if (pt?.kind === "browser" && !isStartUrl(pt.url) && openedWebviews.has(pid)) {
        void webviewCaptureState(pid).catch(() => {});
      }
    }
    prevActive = cur;
  });

  // Reader mode (#41) closes when you switch away from its tab.
  createEffect(() => {
    if (readerOpen() && activeId() !== readerTab()) closeReader();
  });

  // New tab / start page → focus the omnibox so you can just start typing.
  let lastStartFocus: number | null = null;
  createEffect(() => {
    const t = activeTab();
    if (t && t.kind === "browser" && isStartUrl(t.url)) {
      if (t.id !== lastStartFocus) {
        lastStartFocus = t.id;
        setSidebarOpen(true);
        // A focused page webview holds OS keyboard focus, so pull it back to the
        // chrome window first — otherwise el.focus() is a no-op for typing (#18).
        void chromeFocus().catch(() => {});
        requestAnimationFrame(() => {
          const el = document.getElementById("flux-address") as HTMLInputElement | null;
          el?.focus();
          el?.select();
        });
      }
    } else {
      lastStartFocus = null; // re-arm so returning to a start tab refocuses
    }
  });

  // Navigate the active tab to `url` (from the omnibox or the start page).
  // Start-page tabs have no webview yet, so the effect opens it once the url
  // becomes real; already-open tabs navigate in place.
  const go = (url: string) => {
    // PDFs open in Flux's built-in viewer (#35) rather than the engine's.
    if (isPdfUrl(url)) url = pdfViewerUrl(url);
    const tab = activeTab();
    if (tab?.kind !== "browser") {
      void openTab("browser", url);
      return;
    }
    updateTabUrl(tab.id, url);
    void tabSetUrl(tab.id, url).catch(() => {}); // keep the persisted session current (#19)
    if (!isStartUrl(url) && openedWebviews.has(tab.id)) {
      // `wv` swallows the benign "no such tab webview" race (navigating just as
      // the webview is (re)created) instead of an uncaught promise rejection.
      wv(webviewNavigate(tab.id, url));
    }
  };

  // Run a webview command against the active browser tab (back/forward/reload).
  const navActive = (fn: (id: number) => Promise<unknown>) => {
    const t = activeTab();
    if (t?.kind === "browser") void fn(t.id).catch(() => {});
  };

  // #79: drop the GPU-heavy glass blur while dragging a split seam or panel
  // divider (continuous repaints). `body.busy` overrides --glass-blur to none.
  createEffect(() => {
    document.body.classList.toggle("busy", splitDragging() || panelDragging());
  });

  // Bookmark state for the active page — drives the address-bar star + Ctrl+D.
  const [bookmarkedId, setBookmarkedId] = createSignal<number | null>(null);
  const bookmarkableUrl = () => {
    const t = activeTab();
    return t?.kind === "browser" && !isStartUrl(t.url) ? t.url : null;
  };
  createEffect(() => {
    const url = bookmarkableUrl();
    if (!url) { setBookmarkedId(null); return; }
    void bookmarksList()
      .then((bms) => setBookmarkedId(bms.find((b) => b.url === url)?.id ?? null))
      .catch(() => setBookmarkedId(null));
  });
  const toggleBookmark = () => {
    const t = activeTab();
    const url = bookmarkableUrl();
    if (!t || !url) return;
    const flash = (m: string) => { setOmniToast(m); window.setTimeout(() => setOmniToast(null), 1800); };
    const existing = bookmarkedId();
    const notify = () => window.dispatchEvent(new Event("flux:bookmarks-changed"));
    if (existing != null) {
      void bookmarkRemove(existing).then(() => { setBookmarkedId(null); flash("Bookmark removed"); notify(); }).catch(() => {});
    } else {
      void bookmarkAdd(t.title || url, url).then((b) => { setBookmarkedId(b?.id ?? null); flash("★ Bookmarked"); notify(); }).catch(() => {});
    }
  };

  // Per-site zoom (#36). Ctrl +/-/0 step the active page's zoom, persisted per host.
  const hostOfUrl = (url: string): string | null => {
    try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; }
  };
  const zoom = (dir: "in" | "out" | "reset") => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    const host = hostOfUrl(t.url);
    if (!host) return;
    const f = nudgeZoom(host, dir);
    void webviewZoom(t.id, f).catch(() => {});
  };

  // Resource governor (#70): hibernate every live background tab now, freeing
  // their webviews (RAM). Mirrors the idle-sweep but on demand.
  const sleepBackgroundTabs = () => {
    const visible = new Set(paneLayout().map((p) => p.tab.id));
    let n = 0;
    for (const t of tabs()) {
      if (t.kind === "browser" && !visible.has(t.id) && !isStartUrl(t.url) && (openedWebviews.has(t.id) || openingWebviews.has(t.id))) {
        forgetWebview(t.id);
        setHibernated(t.id, true);
        wv(webviewHibernate(t.id));
        n++;
      }
    }
    setOmniToast(n ? `💤 Slept ${n} background tab${n === 1 ? "" : "s"}` : "No background tabs to sleep");
    window.setTimeout(() => setOmniToast(null), 2600);
  };

  // Translate page (#40): translate the active page's text with the local model
  // and show it in the reader overlay (which already hides the webview + handles
  // Esc/close), rendered as paragraph blocks.
  const translatePage = async (lang: string) => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    setOmniToast(`🌐 Translating to ${lang}…`);
    try {
      const text = await agentTranslate(lang);
      const blocks = text
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => ({ kind: "p", text: p, level: 0, src: "" }));
      openReader(t.id, `Translated · ${lang}`, blocks.length ? blocks : [{ kind: "p", text, level: 0, src: "" }]);
      setOmniToast(null);
    } catch (e) {
      setOmniToast(`Translate: ${String(e)}`);
      window.setTimeout(() => setOmniToast(null), 3000);
    }
  };
  // The user's own language name, for the one-click "Translate to <lang>" action.
  const myLang = (() => {
    try {
      const base = (navigator.language || "en").split("-")[0]!;
      return new Intl.DisplayNames([navigator.language], { type: "language" }).of(base) || "English";
    } catch { return "English"; }
  })();

  // Web capture (#54): screenshot the visible page (async; toast on completion).
  const capturePage = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void webviewCapture(t.id).catch((e) => { setOmniToast(`Capture: ${String(e)}`); window.setTimeout(() => setOmniToast(null), 3000); });
  };

  // Install-site-as-app (#42): open the active site in its own window + save it.
  const installApp = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void pwaInstall(t.url, t.title || t.url)
      .then(() => { setOmniToast("🧩 Installed as app"); window.setTimeout(() => setOmniToast(null), 2400); })
      .catch((e) => { setOmniToast(`Install: ${String(e)}`); window.setTimeout(() => setOmniToast(null), 3000); });
  };

  // Offline archive / read-later (#69): save the active page's text for offline
  // reading + semantic search.
  const saveToArchive = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    const flash = (m: string) => { setOmniToast(m); window.setTimeout(() => setOmniToast(null), 2400); };
    void archiveSave()
      .then((m) => flash(m ? `📚 Saved “${m.title || "page"}” for offline` : "Nothing to save"))
      .catch((e) => flash(`Archive: ${String(e)}`));
  };

  // Reader mode (#41): inject the extractor (result arrives via onReader → opens
  // the reader view), or close it if already open.
  const toggleReader = () => {
    if (readerOpen()) { closeReader(); return; }
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void webviewExtractReader(t.id).catch(() => {});
  };

  // Cycle through the non-pinned tabs of the active workspace (Ctrl+Tab /
  // Ctrl+Shift+Tab). Pinned tabs aren't part of the cycle; if a pinned tab is
  // active, we enter the loop at the first (forward) or last (backward) tab.
  const cycleTab = (dir: 1 | -1) => {
    const list = unpinnedTabs();
    if (list.length === 0) return;
    const i = list.findIndex((t) => t.id === activeId());
    const next = i < 0 ? (dir === 1 ? list[0] : list[list.length - 1]) : list[(i + dir + list.length) % list.length];
    if (next) void focusTab(next.id);
  };

  // Focus + select the omnibox (Ctrl+L); open the sidebar first if collapsed.
  const focusAddress = () => {
    setSidebarOpen(true);
    void chromeFocus().catch(() => {}); // grab OS focus from any page webview (#18)
    requestAnimationFrame(() => {
      const el = document.getElementById("flux-address") as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  };

  // Open the find bar (Ctrl+F). It lives in the sidebar, so open that first.
  const openFind = () => {
    setSidebarOpen(true);
    setFindOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById("flux-find") as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  };

  // Close the find bar + clear the page highlight.
  const closeFind = () => {
    const t = activeTab();
    if (t?.kind === "browser") void webviewFind(t.id, "").catch(() => {});
    setFindMatches(null);
    setFindOpen(false);
  };

  // Save the active page into the Omni index (Ctrl/Cmd+Shift+O, or forwarded from
  // a focused page). Shows a brief toast with the result.
  const [omniToast, setOmniToast] = createSignal<string | null>(null);
  let omniToastTimer: number | undefined;
  const saveToOmni = async () => {
    setOmniToast("Saving to Omni…");
    try {
      const r = await omniIngestActive();
      setOmniToast(r.added ? "✦ Saved to Omni" : r.skipped ? "Already in Omni" : "Saved");
    } catch (e) {
      setOmniToast(`Omni: ${String(e)}`);
    }
    clearTimeout(omniToastTimer);
    omniToastTimer = window.setTimeout(() => setOmniToast(null), 2600);
  };

  // Workspaces (#44). Switching destroys the leaving workspace's webviews so
  // inactive workspaces cost only their (KB) metadata; it activates the target
  // workspace's last-used tab.
  const wsLastTab = new Map<number, number>();
  const switchWorkspace = async (id: number) => {
    if (id === activeWorkspace()) return;
    const cur = activeId();
    if (cur != null) wsLastTab.set(activeWorkspace(), cur);
    for (const t of tabs()) {
      if (t.workspace !== id && (openedWebviews.has(t.id) || openingWebviews.has(t.id))) {
        forgetWebview(t.id);
        setHibernated(t.id, true);
        wv(webviewHibernate(t.id));
      }
    }
    await workspaceSwitch(id).catch(() => {});
    setActiveWorkspace(id);
    const members = tabs().filter((t) => t.workspace === id);
    const target = members.find((t) => t.id === wsLastTab.get(id)) ?? members[0];
    if (target) void focusTab(target.id);
    else void openTab("browser"); // empty workspace → a fresh tab (created in it)
  };
  const newWorkspace = async () => {
    const palette = [0x9d8df1, 0x5bc0eb, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
    const id = await createWorkspace("New space", palette[workspaces().length % palette.length]!);
    if (id) await switchWorkspace(id);
  };
  const removeWorkspace = async (id: number) => {
    if (workspaces().length <= 1) return;
    if (!confirm("Delete this workspace and all its tabs?")) return;
    const closed = await workspaceDelete(id).catch(() => [] as number[]);
    for (const tid of closed) {
      forgetWebview(tid);
      wv(webviewHibernate(tid));
    }
    await refreshTabs();
    const act = await workspaceActive().catch(() => activeWorkspace());
    setActiveWorkspace(act);
    const members = tabs().filter((t) => t.workspace === act);
    if (members[0]) void focusTab(members[0].id);
  };

  // Send tab(s) to another workspace (#44). The moved tabs leave the active
  // space, so tear down their webviews (freeing the RAM) and — if we sent the
  // active tab away — fall back to another tab in the current workspace.
  const teardownMoved = (ids: number[]) => {
    const act = activeId();
    for (const id of ids) {
      if (openedWebviews.has(id) || openingWebviews.has(id)) {
        forgetWebview(id);
        setHibernated(id, true);
        wv(webviewHibernate(id));
      }
    }
    if (act != null && ids.includes(act)) {
      const here = tabs().filter((t) => t.workspace === activeWorkspace() && !ids.includes(t.id));
      if (here.length) void focusTab(here[here.length - 1]!.id);
      else void openTab("browser");
    }
  };
  const sendTabToWs = async (tabId: number, ws: number) => {
    if (ws === activeWorkspace()) return;
    await sendTabToWorkspace(tabId, ws);
    teardownMoved([tabId]);
  };
  const sendGroupToWs = async (groupId: number, ws: number) => {
    if (ws === activeWorkspace()) return;
    const moved = await sendGroupToWorkspace(groupId, ws);
    teardownMoved(moved);
  };

  // Command palette (#6). It's a centered modal; the native webview is a
  // separate OS layer over the content card, so hide the active page while it's
  // open and show it again on close.
  const openPalette = () => {
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id)) wv(webviewHide(t.id));
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    const t = activeTab();
    // Don't re-show the webview if the files panel is still covering it.
    if (t?.kind === "browser" && openedWebviews.has(t.id) && !isStartUrl(t.url) && !filesPanelOpen() && !mapPanelOpen()) wv(webviewShow(t.id));
  };

  // Files panel — imperative show/hide, matching the palette pattern exactly.
  // The native webview is a separate OS layer; we must hide it when the panel
  // opens and re-show it when the panel closes so it doesn't eat all clicks.
  const openFilesPanel = () => {
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id)) wv(webviewHide(t.id));
    setFilesPanelOpen(true);
  };
  const closeFilesPanel = () => {
    setFilesPanelOpen(false);
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id) && !isStartUrl(t.url) && !paletteOpen()) wv(webviewShow(t.id));
  };
  // Google Maps popout — mirrors the files popout (hide the native webview while
  // the DOM pane is open, re-show on close).
  const openMapPanel = () => {
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id)) wv(webviewHide(t.id));
    setMapPanelOpen(true);
  };
  const closeMapPanel = () => {
    setMapPanelOpen(false);
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id) && !isStartUrl(t.url) && !paletteOpen()) wv(webviewShow(t.id));
  };
  const [mapDraft, setMapDraft] = createSignal(mapQuery());
  // Keyless Google Maps embed — only the `output=embed` endpoint is frameable
  // (the full site sets X-Frame-Options); a `q=` jumps to a place.
  const mapSrc = () => {
    const q = mapQuery().trim();
    return q
      ? `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`
      : `https://www.google.com/maps?output=embed`;
  };
  // Esc closes the map pane while it's open.
  createEffect(() => {
    if (!mapPanelOpen()) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMapPanel(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  // Actions offered by the palette (tab-switching + history are built in).
  const paletteActions = (): PaletteAction[] => [
    { id: "new-tab", label: "New browser tab", icon: "🌐", run: () => void openTab("browser") },
    { id: "new-private", label: "New private tab", icon: "🕶", run: () => void openTab("browser", undefined, true) },
    { id: "new-term", label: "New terminal tab", icon: "⌨", run: () => void openTab("terminal").then(() => setTerminalOpen(true)) },
    { id: "new-files", label: "New files tab", icon: "📁", run: () => void openTab("files") },
    { id: "history", label: "Open History", icon: "🕘", run: () => go(HISTORY_URL) },
    { id: "bookmarks", label: "Open Bookmarks", icon: "🔖", run: () => go(BOOKMARKS_URL) },
    { id: "bookmark-bar", label: bookmarkBarOpen() ? "Hide bookmark bar" : "Show bookmark bar", icon: "🔖", run: () => setBookmarkBarOpen(!bookmarkBarOpen()) },
    { id: "pages-bar", label: pagesBarOpen() ? "Hide pages bar" : "Show pages bar", icon: "🗂️", run: () => setPagesBarOpen(!pagesBarOpen()) },
    { id: "sessions", label: "Open Sessions", icon: "🗃", run: () => go(SESSIONS_URL) },
    { id: "passwords", label: "Open Passwords", icon: "🔑", run: () => go(VAULT_URL) },
    { id: "omni", label: "Open Omni index", icon: "✦", run: () => go(OMNI_URL) },
    { id: "notebook", label: "Open Notebook (ask your notes)", icon: "✦", run: () => go(NOTEBOOK_URL) },
    { id: "find", label: "Find in page", icon: "🔎", run: () => openFind() },
    { id: "reader", label: "Reader mode", icon: "📖", run: () => toggleReader() },
    { id: "focus", label: "Focus mode (hide chrome)", icon: "⤢", run: () => dispatch("focus-mode") },
    { id: "capture", label: "Capture page (screenshot)", icon: "📸", run: () => capturePage() },
    { id: "resources", label: "Open Resource monitor", icon: "📊", run: () => go(RESOURCES_URL) },
    { id: "tasks", label: "Open Task manager", icon: "🗂️", run: () => go(TASKS_URL) },
    { id: "speedtest", label: "Network speed test", icon: "⚡", run: () => go(SPEEDTEST_URL) },
    { id: "permissions", label: "Site permissions", icon: "🔐", run: () => go(PERMISSIONS_URL) },
    { id: "archive-save", label: "Save page for offline (read later)", icon: "📚", run: () => saveToArchive() },
    { id: "archive", label: "Open Archive", icon: "📚", run: () => go(ARCHIVE_URL) },
    { id: "feeds", label: "Open Feeds (RSS reader)", icon: "📰", run: () => go(FEEDS_URL) },
    { id: "sync", label: "Sync (encrypted, across devices)", icon: "🔄", run: () => go(SYNC_URL) },
    { id: "translate", label: `Translate page → ${myLang}`, icon: "🌐", run: () => void translatePage(myLang) },
    ...["English", "Spanish", "French", "German", "Japanese", "Chinese", "Arabic", "Hindi"]
      .filter((l) => l !== myLang)
      .map((l) => ({ id: `translate-${l}`, label: `Translate page → ${l}`, icon: "🌐", run: () => void translatePage(l) })),
    { id: "install-app", label: "Install this site as app", icon: "🧩", run: () => installApp() },
    { id: "apps", label: "Open installed apps", icon: "🧩", run: () => go(APPS_URL) },
    { id: "settings", label: "Open Settings", icon: "⚙", run: () => go(SETTINGS_URL) },
    { id: "sleep-bg", label: "Sleep background tabs", icon: "💤", run: () => sleepBackgroundTabs() },
    { id: "zoom-in", label: "Zoom in", icon: "➕", run: () => dispatch("zoom-in") },
    { id: "zoom-out", label: "Zoom out", icon: "➖", run: () => dispatch("zoom-out") },
    { id: "zoom-reset", label: "Reset zoom", icon: "🔍", run: () => dispatch("zoom-reset") },
    { id: "reload", label: "Reload page", icon: "⟳", run: () => navActive(webviewReload) },
    { id: "tog-term", label: "Toggle terminal", icon: "⌨", run: () => setTerminalOpen((v) => !v) },
    { id: "tog-agent", label: "Toggle agent", icon: "✦", run: () => setAgentOpen((v) => !v) },
    { id: "lens", label: "Identify page (Lens)", icon: "🔍", run: () => { setAgentOpen(true); setPendingLens(true); } },
    { id: "tog-side", label: "Toggle sidebar", icon: "◧", run: () => setSidebarOpen((v) => !v) },
    { id: "close", label: "Close current tab", icon: "✕", run: () => { const id = activeId(); if (id != null) void closeTab(id); } },
  ];

  // Run an app keyboard action — shared by the chrome's keydown listener and
  // the chords forwarded from a focused tab webview (#18).
  const dispatch = (action: string): boolean => {
    switch (action) {
      case "new-tab": void openTab("browser"); return true;
      case "new-terminal": void openTab("terminal").then(() => setTerminalOpen(true)); return true;
      case "close-tab": { const id = activeId(); if (id != null) void closeTab(id); return true; }
      case "next-tab": cycleTab(1); return true;
      case "prev-tab": cycleTab(-1); return true;
      case "toggle-terminal": setTerminalOpen((v) => !v); return true;
      case "toggle-agent": setAgentOpen((v) => !v); return true;
      case "toggle-sidebar": setSidebarOpen((v) => !v); return true;
      case "focus-address": focusAddress(); return true;
      case "palette": if (paletteOpen()) closePalette(); else openPalette(); return true;
      case "find": openFind(); return true;
      case "reload": navActive(webviewReload); return true;
      case "back": navActive(webviewBack); return true;
      case "forward": navActive(webviewForward); return true;
      case "save-to-omni": void saveToOmni(); return true;
      case "zoom-in": zoom("in"); return true;
      case "zoom-out": zoom("out"); return true;
      case "zoom-reset": zoom("reset"); return true;
      case "bookmark-page": toggleBookmark(); return true;
      case "devtools": navActive((id) => webviewDevtools(id)); return true;
      case "focus-mode": {
        const on = !focusMode();
        setFocusMode(on);
        if (on) { setOmniToast("Focus mode — Esc or Ctrl+Shift+F to exit"); window.setTimeout(() => setOmniToast(null), 2600); }
        return true;
      }
      default:
        if (action.startsWith("tab-")) {
          const n = Number(action.slice(4));
          const list = tabs();
          // Ctrl+1..8 → that position; Ctrl+9 → last tab (browser convention).
          const t = n === 9 ? list.at(-1) : list[n - 1];
          if (t) void focusTab(t.id);
          return true;
        }
        return false;
    }
  };

  // Responsive pane-shedding (#28 / ADR 0002 mitigation): when the fixed panes would
  // squeeze the content card below a comfortable minimum, drop them in priority order
  // — terminal, then web panel, then agent, then collapse the sidebar to its icon rail
  // — and restore them as the window grows back. Non-destructive: the user's open
  // intent is untouched (the signals stay set), only the rendered layout adapts.
  const SIDEBAR_RAIL = 72; // --flux-sidebar-w-min
  const MIN_CONTENT = 460; // narrowest content card we'll keep before shedding a pane
  const responsive = createMemo(() => {
    if (focusMode()) return { sidebar: false, panel: false, terminal: false, agent: false };
    // What the user wants open (same conditions as the non-responsive layout used).
    const want = {
      sidebar: sidebarOpen(),
      agent: agentOpen(),
      panel: activePanel() != null || activePanelB() != null,
      // Keep the dev terminal column up even on a terminal *tab* — the column is
      // the persistent shell; a launched TUI app tab lives alongside it.
      terminal: terminalOpen(),
    };
    const out = { sidebar: false, agent: false, panel: false, terminal: false };
    // Content card + the always-present sidebar rail are reserved first.
    let used = MIN_CONTENT + SIDEBAR_RAIL;
    const w = winW();
    // Allocate width in PRIORITY order (kept longest first): the sidebar's expansion,
    // then agent, then web panel, then terminal — the reverse of the shed order.
    const order: [keyof typeof want, number][] = [
      ["sidebar", sidebarW() - SIDEBAR_RAIL], // extra beyond the rail it already has
      ["agent", agentW()],
      ["panel", panelWidth()],
      ["terminal", terminalW()],
    ];
    for (const [k, extra] of order) {
      if (want[k] && used + extra <= w) { out[k] = true; used += extra; }
    }
    return out;
  });

  // The vertical terminal column (the persistent dev shell) shows whenever it's
  // toggled on and there's room — including alongside a terminal *tab*.
  const termColVisible = () => responsive().terminal;
  const panelColVisible = () => responsive().panel;
  const agentColVisible = () => responsive().agent;

  const columns = () =>
    focusMode()
      ? "0px 1fr 0px 0px 0px" // focus/compact mode (#55): content only
      : [
          responsive().sidebar ? `${sidebarW()}px` : "var(--flux-sidebar-w-min)",
          "1fr",
          panelColVisible() ? `${panelWidth()}px` : "0px",
          termColVisible() ? `${terminalW()}px` : "0px",
          agentColVisible() ? `${agentW()}px` : "0px",
        ].join(" ");

  // Drag a pane's splitter. `sign` is +1 when dragging right grows the pane
  // (sidebar), −1 when dragging left grows it (terminal / agent).
  const startPaneResize = (
    e: PointerEvent,
    get: () => number,
    set: (n: number) => void,
    sign: 1 | -1,
    key: string,
    min: number,
    max: number,
  ) => {
    e.preventDefault();
    // Kill the grid-template transition + drop the cursor for the drag so the
    // pane tracks the pointer 1:1 instead of easing behind it (the latency).
    document.body.classList.add("resizing");
    const startX = e.clientX;
    const startW = get();
    const move = (ev: PointerEvent) =>
      set(Math.max(min, Math.min(max, startW + sign * (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem(key, String(get()));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      class="shell"
      style={{
        "grid-template-columns": columns(),
        "grid-template-rows": "var(--flux-titlebar-h) 1fr",
        "grid-template-areas": `"title title title title title" "side content webpanel term agent"`,
      }}
    >
      <TitleBar />
      <Sidebar
        collapsed={!responsive().sidebar}
        terminalOpen={terminalOpen()}
        agentOpen={agentOpen()}
        onNavigate={go}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onToggleAgent={() => setAgentOpen((v) => !v)}
        onSaveToOmni={saveToOmni}
        onToast={(m) => { setOmniToast(m); window.setTimeout(() => setOmniToast(null), 2800); }}
        onAiSearch={(q) => { if (aiAnswersOn()) { setAgentOpen(true); setPendingAsk(q); } }}
        onSwitchWorkspace={switchWorkspace}
        onNewWorkspace={newWorkspace}
        onDeleteWorkspace={removeWorkspace}
        onSendTabToWorkspace={sendTabToWs}
        onSendGroupToWorkspace={sendGroupToWs}
        onZoomReset={() => zoom("reset")}
        onToggleReader={toggleReader}
        onCapture={capturePage}
        onArchive={saveToArchive}
        onTranslate={() => void translatePage(myLang)}
        onToggleBookmark={toggleBookmark}
        isBookmarked={() => bookmarkedId() != null}
        onToggleFilesPanel={() => filesPanelOpen() ? closeFilesPanel() : openFilesPanel()}
        onToggleMapPanel={() => mapPanelOpen() ? closeMapPanel() : openMapPanel()}
      />
      <ContentArea
        onNavigate={go}
        onNewTerminal={() => void openTab("terminal")}
        onToggleAgent={() => setAgentOpen(true)}
        onSleepBackground={sleepBackgroundTabs}
      />
      <Show when={panelColVisible()}>
        <WebPanelPane />
      </Show>
      <Show when={panelColVisible()}>
        <div
          class="pane-splitter panel-divider"
          style={{ right: `${(agentColVisible() ? agentW() : 0) + (termColVisible() ? terminalW() : 0) + panelWidth()}px` }}
          title="Drag to resize the web panel"
          onPointerDown={(e) => {
            e.preventDefault();
            document.body.classList.add("resizing");
            setPanelDragging(true);
            const startX = e.clientX;
            const startW = panelWidth();
            const move = (ev: PointerEvent) => setPanelWidth(startW - (ev.clientX - startX));
            const up = () => {
              setPanelDragging(false);
              document.body.classList.remove("resizing");
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      </Show>
      <Show when={termColVisible()}>
        <TerminalColumn />
      </Show>
      <Show when={agentColVisible()}>
        <Suspense><AgentPanel /></Suspense>
      </Show>

      {/* Pane splitters — drag to resize (BACKLOG #27). */}
      <Show when={responsive().sidebar}>
        <div
          class="pane-splitter"
          style={{ left: `${sidebarW()}px` }}
          onPointerDown={(e) => startPaneResize(e, sidebarW, setSidebarW, 1, "flux.w.sidebar", 180, 460)}
        />
      </Show>
      <Show when={termColVisible()}>
        <div
          class="pane-splitter"
          style={{ right: `${(agentColVisible() ? agentW() : 0) + terminalW()}px` }}
          onPointerDown={(e) => startPaneResize(e, terminalW, setTerminalW, -1, "flux.w.terminal", 280, 820)}
        />
      </Show>
      <Show when={agentColVisible()}>
        <div
          class="pane-splitter"
          style={{ right: `${agentW()}px` }}
          onPointerDown={(e) => startPaneResize(e, agentW, setAgentW, -1, "flux.w.agent", 300, 640)}
        />
      </Show>

      {/* Transient confirmation for "save page to Omni" (Ctrl/Cmd+Shift+O). */}
      <Show when={omniToast()}>
        {(msg) => (
          <div
            style={{
              position: "fixed",
              bottom: "22px",
              left: "50%",
              transform: "translateX(-50%)",
              "z-index": 9999,
              padding: "8px 16px",
              "border-radius": "999px",
              "font-size": "13px",
              color: "var(--flux-text, #eef0fb)",
              background: "var(--glass-fill, rgba(26,22,64,0.85))",
              "backdrop-filter": "blur(20px)",
              border: "1px solid rgba(180,190,255,0.22)",
              "box-shadow": "0 12px 40px -8px rgba(0,0,0,0.6)",
            }}
          >
            {msg()}
          </div>
        )}
      </Show>

      <ResizeHandles />

      {/* Command palette (#6) — overlay; renders above the (hidden) webview. */}
      <Show when={paletteOpen()}>
        <Suspense><CommandPalette actions={paletteActions()} onClose={closePalette} onNavigate={go} /></Suspense>
      </Show>

      {/* Right-click "open in new tab" menu for links in internal DOM pages. */}
      <LinkMenu onOpen={(url, background) => void openTab("browser", isPdfUrl(url) ? pdfViewerUrl(url) : url, false, background).catch(() => {})} />

      {/* Files popout panel — a DOM file explorer over the (hidden) webview; its
          cwd persists so it reopens where you left off. Click outside to close. */}
      <Show when={filesPanelOpen()}>
        <div class="files-panel-backdrop" onClick={() => closeFilesPanel()}>
          <div class="files-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="files-panel-head">
              <span class="files-panel-title">🗁 Files</span>
              <button class="files-panel-x" title="Close (Esc)" onClick={() => closeFilesPanel()}>✕</button>
            </div>
            <div class="files-panel-body">
              <Suspense>
                <FilesView
                  id={FILES_PANEL_ID}
                  path={filesPanelPath() || ""}
                  onPathChange={setFilesPanelPath}
                  onOpenInTab={(url) => { closeFilesPanel(); go(url); }}
                />
              </Suspense>
            </div>
          </div>
        </div>
      </Show>
      {/* Google Maps popout — a bigger floating pane (like the files popout) with
          a Google Maps embed. Click outside / Esc to close. */}
      <Show when={mapPanelOpen()}>
        <div class="map-panel-backdrop" onClick={() => closeMapPanel()}>
          <div class="map-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="map-panel-head">
              <span class="map-panel-title">🗺 Maps</span>
              <form class="map-search" onSubmit={(e) => { e.preventDefault(); setMapQuery(mapDraft().trim()); }}>
                <input
                  class="map-search-input"
                  placeholder="Search a place or address…"
                  value={mapDraft()}
                  onInput={(e) => setMapDraft(e.currentTarget.value)}
                />
              </form>
              <button class="map-panel-x" title="Close (Esc)" onClick={() => closeMapPanel()}>✕</button>
            </div>
            <iframe
              class="map-frame"
              src={mapSrc()}
              title="Google Maps"
              referrerpolicy="no-referrer-when-downgrade"
              loading="lazy"
            />
          </div>
        </div>
      </Show>
    </div>
  );
};

/** Synthetic FilesView id for the popout panel — a large valid u64 that won't
 *  collide with real tab ids (which start at 1). Must be ≥ 0: the fs-watch
 *  command's id param is u64, so a negative sentinel fails deserialization. */
const FILES_PANEL_ID = 2_000_000_000;

// ─── Window chrome (custom — decorations are off) ───────────────────────────

/** Full-width draggable title bar. `deep` makes the whole strip a drag region
 *  (buttons still click through); it lives in its own grid row so no tab
 *  webview can ever cover it — the fix for "nowhere to grab the window". */
const TitleBar: Component = () => (
  <header class="titlebar" data-tauri-drag-region="deep">
    <TrafficLights />
    <span class="titlebar-title">{activeTab()?.title || "Flux"}</span>
  </header>
);

/** macOS-style traffic lights. Glyphs appear on hover (group-hover). */
const TrafficLights: Component = () => (
  <div class="traffic">
    <button class="tl tl-close" onClick={() => win.close()} aria-label="Close">✕</button>
    <button class="tl tl-min" onClick={() => win.minimize()} aria-label="Minimize">−</button>
    <button class="tl tl-max" onClick={() => win.toggleMaximize()} aria-label="Zoom">+</button>
  </div>
);

/** Invisible edge/corner grips that drive native resize on the borderless
 *  window via Tauri's startResizeDragging. */
const ResizeHandles: Component = () => {
  const grip = (dir: ResizeDir, cls: string) => (
    <div
      class={`resize-h ${cls}`}
      onMouseDown={(e) => {
        e.preventDefault();
        win.startResize(dir);
      }}
    />
  );
  return (
    <>
      {grip("North", "rh-n")}
      {grip("South", "rh-s")}
      {grip("West", "rh-w")}
      {grip("East", "rh-e")}
      {grip("NorthWest", "rh-nw")}
      {grip("NorthEast", "rh-ne")}
      {grip("SouthWest", "rh-sw")}
      {grip("SouthEast", "rh-se")}
    </>
  );
};

// ─── Sidebar ────────────────────────────────────────────────────────────────

interface SidebarProps {
  collapsed: boolean;
  terminalOpen: boolean;
  agentOpen: boolean;
  onNavigate: (url: string) => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleAgent: () => void;
  onSaveToOmni: () => void;
  onToast: (msg: string) => void;
  onAiSearch: (query: string) => void;
  onSwitchWorkspace: (id: number) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (id: number) => void;
  onSendTabToWorkspace: (tabId: number, ws: number) => void;
  onSendGroupToWorkspace: (groupId: number, ws: number) => void;
  onZoomReset: () => void;
  onToggleReader: () => void;
  onCapture: () => void;
  onArchive: () => void;
  onTranslate: () => void;
  onToggleBookmark: () => void;
  isBookmarked: () => boolean;
  onToggleFilesPanel: () => void;
  onToggleMapPanel: () => void;
}

type FooterPanel = "bookmarks" | "extensions" | "settings" | "webpanels" | "notes" | "archived" | null;
/** An omnibox suggestion (#32): a local history hit (has `url`) or an engine suggestion. */
type Suggestion = { kind: "history" | "search"; label: string; sub?: string; url?: string };

/** Split an answer into text runs and `[n]` citation markers, so the markers can
 *  render as clickable footnotes inline with the streamed prose. */
type AnswerPart = string | { cite: number };
function answerParts(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ cite: parseInt(m[1]!, 10) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const Sidebar: Component<SidebarProps> = (props) => {
  const [picker, setPicker] = createSignal(false);
  const [address, setAddress] = createSignal("");
  const [panel, setPanel] = createSignal<FooterPanel>(null);
  const [bmFlash, setBmFlash] = createSignal("");
  const [boostsLoaded, setBoostsLoaded] = createSignal(false);
  const [macrosLoaded, setMacrosLoaded] = createSignal(false);
  const [passwordsLoaded, setPasswordsLoaded] = createSignal(false);
  // Per-page notes (#53): the popover edits the active page's note (auto-saved).
  const [noteText, setNoteText] = createSignal("");
  let noteTimer: number | undefined;
  const loadNote = () => {
    const t = activeTab();
    if (t?.kind === "browser" && !isStartUrl(t.url)) void noteGet(t.url).then(setNoteText).catch(() => setNoteText(""));
    else setNoteText("");
  };
  const saveNote = (text: string) => {
    setNoteText(text);
    const t = activeTab();
    if (!t) return;
    const url = t.url;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => void noteSet(url, text).catch(() => {}), 400);
  };
  // Active page's per-host zoom (#36), reactive via the zoom store.
  const activeZoom = (): number => {
    const t = activeTab();
    if (!t || t.kind !== "browser") return 1;
    try { return zoomFor(new URL(t.url).hostname.replace(/^www\./, "")); } catch { return 1; }
  };
  const [engines, setEngines] = createSignal<SearchEngine[]>([]);
  const [defaultEngine, setDefaultEngine] = createSignal("");
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  // Tab drag-reorder (#30).
  const [dragId, setDragId] = createSignal<number | null>(null);
  const [dropId, setDropId] = createSignal<number | null>(null);
  // Tab right-click menu + grouping (#56).
  const [ctxTab, setCtxTab] = createSignal<TabMeta | null>(null);
  const [ctxGroup, setCtxGroup] = createSignal<TabGroup | null>(null);
  const [ctxPos, setCtxPos] = createSignal({ x: 0, y: 0 });
  // Inline rename (window.prompt is a no-op in the webview, so edit in place).
  const [editGroup, setEditGroup] = createSignal<number | null>(null);
  const [editWs, setEditWs] = createSignal<number | null>(null);
  const [editContainer, setEditContainer] = createSignal<number | null>(null);
  const [editFolder, setEditFolder] = createSignal<number | null>(null);
  const [editTab, setEditTab] = createSignal<number | null>(null);
  const openCtx = (e: MouseEvent, tab: TabMeta) => { e.preventDefault(); setCtxTab(tab); setCtxPos({ x: e.clientX, y: e.clientY }); };
  const closeCtx = () => setCtxTab(null);
  // Keep a context menu fully on-screen: after it renders, nudge it left/up if it
  // would overflow the viewport (e.g. a tall menu opened near the bottom).
  const clampMenu = (el: HTMLElement) => {
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const pad = 8;
      let { x, y } = ctxPos();
      // The native tab webview is an OS layer ON TOP of the content card, so a
      // DOM menu (any z-index) that spills over it gets covered — that's the
      // "clipping". Keep the menu left of the content area so it stays within
      // the chrome, where the DOM actually renders on top.
      const webArea = document.getElementById("flux-web-area");
      const rightBound = (webArea ? webArea.getBoundingClientRect().left : window.innerWidth) - pad;
      if (x + r.width > rightBound) x = rightBound - r.width;
      if (y + r.height > window.innerHeight - pad) y = window.innerHeight - r.height - pad;
      el.style.left = `${Math.max(pad, x)}px`;
      el.style.top = `${Math.max(pad, y)}px`;
    });
  };
  // Memoized tab-list derivations (recomputed once per tabs()/groups() change,
  // not per render call): a Set of live group ids, the unpinned tabs bucketed by
  // group, and the ungrouped remainder. Replaces O(tabs×groups) per-render scans.
  const groupIds = createMemo(() => new Set(groups().map((g) => g.id)));
  const membersByGroup = createMemo(() => {
    const m = new Map<number, TabMeta[]>();
    for (const t of unpinnedTabs()) {
      if (t.group != null && groupIds().has(t.group)) {
        const arr = m.get(t.group);
        if (arr) arr.push(t);
        else m.set(t.group, [t]);
      }
    }
    return m;
  });
  const ungroupedTabs = createMemo(() => unpinnedTabs().filter((t) => t.group == null || !groupIds().has(t.group)));
  const GROUP_PALETTE = [0x5bc0eb, 0x9d8df1, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const cycleGroupColor = (g: TabGroup) => {
    const i = GROUP_PALETTE.indexOf(g.color);
    void recolorGroup(g.id, GROUP_PALETTE[(i + 1) % GROUP_PALETTE.length]!);
  };
  const WS_PALETTE = [0x9d8df1, 0x5bc0eb, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const cycleWsColor = (w: Workspace) => {
    const i = WS_PALETTE.indexOf(w.color);
    void recolorWorkspace(w.id, WS_PALETTE[(i + 1) % WS_PALETTE.length]!);
  };

  // One tab row — reused for grouped + ungrouped lists.
  const TabRow: Component<{ tab: TabMeta }> = (p) => (
    <div
      classList={{ "tab-row": true, active: activeId() === p.tab.id, sleeping: isHibernated(p.tab.id), private: p.tab.private, dragging: dragId() === p.tab.id, "drag-over": dropId() === p.tab.id }}
      style={{ "border-left-color": p.tab.container && containerById(p.tab.container) ? containerColor(containerById(p.tab.container)!) : clusterColor(p.tab) }}
      draggable={true}
      onClick={() => focusTab(p.tab.id)}
      onContextMenu={(e) => openCtx(e, p.tab)}
      onDragStart={(e) => { setDragId(p.tab.id); e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/plain", String(p.tab.id)); }}
      onDragOver={(e) => { if (dragId() == null || dragId() === p.tab.id) return; e.preventDefault(); e.dataTransfer!.dropEffect = "move"; setDropId(p.tab.id); }}
      onDragLeave={() => { if (dropId() === p.tab.id) setDropId(null); }}
      onDrop={(e) => {
        e.preventDefault();
        const d = dragId();
        if (d != null && d !== p.tab.id) {
          const r = e.currentTarget.getBoundingClientRect();
          const fx = (e.clientX - r.left) / r.width;
          const fy = (e.clientY - r.top) / r.height;
          const dragged = tabs().find((t) => t.id === d);
          const bothPages = dragged?.kind === "browser" && p.tab.kind === "browser";
          if (fx > 0.6 && bothPages) startSplit(p.tab.id, d); // right side → split (#43)
          else if (fy > 0.25 && fy < 0.75) void groupWithTab(d, p.tab.id); // center → group
          else void reorderTabs(d, p.tab.id, fy >= 0.75); // top/bottom → reorder
        }
        setDragId(null);
        setDropId(null);
      }}
      onDragEnd={() => { setDragId(null); setDropId(null); }}
      title={isHibernated(p.tab.id) ? "sleeping — click to wake" : "drag: top/bottom reorder · middle group · right edge split · right-click for menu"}
    >
      <span class="tab-favicon">{p.tab.private ? "🕶" : isHibernated(p.tab.id) ? "💤" : <Favicon tab={p.tab} />}</span>
      <Show when={editTab() === p.tab.id} fallback={<span class="title" onDblClick={(e) => { e.stopPropagation(); setEditTab(p.tab.id); }}>{tabLabel(p.tab)}</span>}>
        <input
          class="tab-rename"
          value={tabLabel(p.tab)}
          autofocus
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { void renameTab(p.tab.id, e.currentTarget.value.trim()); setEditTab(null); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") setEditTab(null); }}
        />
      </Show>
      <button class="close" title="Close tab" onClick={(e) => { e.stopPropagation(); void closeTab(p.tab.id); }}>✕</button>
    </div>
  );

  // Split view (#43): the two tiled tabs render together as one bracketed unit in
  // the strip (like Chrome's paired split tabs), with a "merge" (un-split) button.
  const SplitPair: Component<{ a: TabMeta; b: TabMeta }> = (p) => (
    <div class="split-pair">
      <div class="split-pair-head">
        <span class="split-pair-label">◧◨ Split</span>
        <button class="split-pair-merge" title="Merge — back to a single tab" onClick={(e) => { e.stopPropagation(); clearSplit(); }}>⤢</button>
      </div>
      <TabRow tab={p.a} />
      <TabRow tab={p.b} />
    </div>
  );

  // The ungrouped strip, with the split pair (when both members are ungrouped &
  // present in this space) folded into a single combined item at the first
  // member's position.
  const ungroupedItems = createMemo((): ({ kind: "tab"; tab: TabMeta } | { kind: "split"; a: TabMeta; b: TabMeta })[] => {
    const list = ungroupedTabs();
    const pair = splitPair();
    const a = pair ? list.find((t) => t.id === pair[0]) : undefined;
    const b = pair ? list.find((t) => t.id === pair[1]) : undefined;
    const combine = !!(a && b);
    const out: ({ kind: "tab"; tab: TabMeta } | { kind: "split"; a: TabMeta; b: TabMeta })[] = [];
    let placed = false;
    for (const t of list) {
      if (combine && (t.id === a!.id || t.id === b!.id)) {
        if (!placed) { out.push({ kind: "split", a: a!, b: b! }); placed = true; }
        continue;
      }
      out.push({ kind: "tab", tab: t });
    }
    return out;
  });

  const openPanel = async (p: FooterPanel) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === "settings") {
      void memStatus().then(setMem).catch(() => {});
      try {
        const [es, d] = await Promise.all([searchEngines(), searchDefault()]);
        setEngines(es);
        setDefaultEngine(d);
      } catch {
        /* preview/offline */
      }
    }
  };
  // Live-ish RAM readout — only polls while the settings panel is actually open
  // (was an always-on 2.5s timer that ran even with the panel closed).
  createEffect(() => {
    if (panel() !== "settings") return;
    void memStatus().then(setMem).catch(() => {});
    const t = window.setInterval(() => void memStatus().then(setMem).catch(() => {}), 2500);
    onCleanup(() => clearInterval(t));
  });

  const pickEngine = async (id: string) => {
    setDefaultEngine(id);
    await searchSetDefault(id).catch(() => {});
  };

  // Seed the address field from the active tab (blank on the start page).
  const currentUrl = () => {
    const u = activeTab()?.url ?? "";
    return isStartUrl(u) ? "" : u;
  };

  // TLS/security state shown left of the omnibox (#31), from the active url.
  const security = (): { icon: string; title: string; cls: string } | null => {
    const u = activeTab()?.url ?? "";
    if (!u || isStartUrl(u)) return null;
    if (u.startsWith("https://")) return { icon: "🔒", title: "Connection is secure (HTTPS)", cls: "sec-secure" };
    if (u.startsWith("http://")) return { icon: "⚠", title: "Not secure — sent over plain HTTP", cls: "sec-insecure" };
    return null;
  };

  // Omnibox live suggestions (#32): local history matches + engine suggestions.
  const [suggestions, setSuggestions] = createSignal<Suggestion[]>([]);
  const [selIdx, setSelIdx] = createSignal(-1);
  let sugTimer: number | undefined;

  // Omnibox AI answer card: a grounded, streamed answer from the Omni index.
  // User-initiated (the "Ask Omni" row or Alt+Enter) — never per-keystroke, so it
  // doesn't spin up the local LLM as you type. Tokens stream in over a Channel.
  type OmniAns = { text: string; sources: OmniAnswerSource[]; streaming: boolean };
  const [omniAns, setOmniAns] = createSignal<OmniAns | null>(null);
  const [addrFocused, setAddrFocused] = createSignal(false);
  let omniGen = 0; // ignore events from a superseded request
  let omniDismissTimer: number | undefined;
  const closeSuggest = () => { setSuggestions([]); setSelIdx(-1); };
  const clearOmniAns = () => {
    omniGen++;
    window.clearTimeout(omniDismissTimer);
    setOmniAns(null);
  };

  // Show the "Ask Omni" affordance for a real query (not a URL / flux:// page).
  const canAsk = () => {
    const q = address().trim();
    return q.length > 2 && !q.startsWith("flux://") && !/^[a-z]+:\/\//i.test(q);
  };

  const startOmniAnswer = (q: string) => {
    const query = q.trim();
    if (!query) return;
    const gen = ++omniGen;
    window.clearTimeout(omniDismissTimer);
    setOmniAns({ text: "", sources: [], streaming: true });
    void omniAnswer(query, (e) => {
      if (gen !== omniGen) return; // a newer ask superseded this stream
      if (e.type === "sources") setOmniAns((a) => (a ? { ...a, sources: e.sources } : a));
      else if (e.type === "token") setOmniAns((a) => (a ? { ...a, text: a.text + e.text } : a));
      else if (e.type === "done") {
        setOmniAns((a) => (a ? { ...a, streaming: false } : a));
        omniDismissTimer = window.setTimeout(() => { if (gen === omniGen) clearOmniAns(); }, 9000);
      }
    }).catch(() => {
      if (gen === omniGen) {
        setOmniAns((a) => (a ? { ...a, streaming: false } : a));
        omniDismissTimer = window.setTimeout(() => { if (gen === omniGen) clearOmniAns(); }, 5000);
      }
    });
  };

  const onAddressInput = (v: string) => {
    setAddress(v);
    setSelIdx(-1);
    clearOmniAns(); // a new query invalidates any shown answer
    clearTimeout(sugTimer);
    const q = v.trim();
    if (!q || q.startsWith("flux://")) { setSuggestions([]); return; }
    sugTimer = window.setTimeout(async () => {
      const hist = await historySearch(q, 5).catch(() => []);
      const out: Suggestion[] = hist.map((h) => ({ kind: "history", label: h.title || h.url, sub: h.url, url: h.url }));
      if (searchSuggestOn()) {
        const sug = await searchSuggest(q).catch(() => []);
        for (const t of sug) {
          if (out.length >= 8) break;
          if (!out.some((x) => x.label.toLowerCase() === t.toLowerCase())) out.push({ kind: "search", label: t });
        }
      }
      // Drop suggestions if the user already moved on / cleared the field.
      if (address().trim() === q) setSuggestions(out.slice(0, 8));
    }, 110);
  };

  const chooseSuggestion = async (s: Suggestion) => {
    closeSuggest();
    clearOmniAns();
    setAddress("");
    if (s.url) props.onNavigate(s.url);
    else {
      const { url } = await searchResolve(s.label);
      props.onNavigate(url);
    }
  };

  const onAddressKeyDown = (e: KeyboardEvent) => {
    const n = suggestions().length;
    if (e.key === "Enter" && e.altKey) { e.preventDefault(); startOmniAnswer(address()); }
    else if (e.key === "ArrowDown" && n) { e.preventDefault(); setSelIdx((i) => (i + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setSelIdx((i) => (i - 1 + n) % n); }
    else if (e.key === "Escape") { closeSuggest(); clearOmniAns(); }
    else if (e.key === "Enter") {
      const s = suggestions()[selIdx()];
      if (s) { e.preventDefault(); void chooseSuggestion(s); }
    }
  };

  const submitAddress = async (e: SubmitEvent) => {
    e.preventDefault();
    closeSuggest();
    clearOmniAns();
    const v = address().trim();
    if (!v) return;
    setAddress("");
    // `flux://…` internal pages (e.g. the Omni dashboard) bypass search.
    if (v.startsWith("flux://")) {
      props.onNavigate(v);
      return;
    }
    // The pluggable search backend (#68) decides navigate-vs-search, applies
    // !bang/keyword routing, and builds the final URL with the default engine;
    // `go` (in App) handles start-page vs. open-tab webview lifecycle.
    const r = await searchResolve(v);
    props.onNavigate(r.url);
    // A genuine search (not a URL) also gets a quick local-AI answer (#ai), and —
    // when opted in — a streamed, grounded answer card from the Omni index.
    if (r.kind === "search") {
      props.onAiSearch(v);
      if (omniAutoAnswer()) startOmniAnswer(v);
    }
  };

  // Nav buttons act on the active browser tab's webview.
  const navActive = (fn: (id: number) => Promise<unknown>) => {
    const tab = activeTab();
    // Swallow the benign "no such tab webview" race instead of an uncaught reject.
    if (tab?.kind === "browser") void fn(tab.id).catch(() => {});
  };

  const create = async (kind: "browser" | "terminal" | "files") => {
    setPicker(false);
    await openTab(kind);
    if (kind === "terminal" && !props.terminalOpen) props.onToggleTerminal();
  };

  return (
    <nav class="sidebar" classList={{ "with-apps": !props.collapsed && panels().length > 0 }}>
      {/* Left app rail (#48 launcher) — Opera-style: pinned web-app panels as
          icons on the sidebar's left edge; click toggles the slide-out panel. */}
      <Show when={!props.collapsed && panels().length > 0}>
        <div class="app-rail">
          <For each={panels()}>
            {(p) => (
              <button
                classList={{ "app-rail-icon": true, active: activePanelId() === p.id }}
                title={p.title || p.url}
                onClick={() => togglePanel(p.id)}
              >
                <PanelIcon url={p.url} />
                <Show when={(panelBadges[p.id] ?? 0) > 0}>
                  <span class="app-rail-badge">{panelBadges[p.id]! > 99 ? "99+" : panelBadges[p.id]}</span>
                </Show>
              </button>
            )}
          </For>
          <button class="app-rail-add" title="Pin a web app (panels)" onClick={() => openPanel("webpanels")}>+</button>
        </div>
      </Show>
      {/* Nav row. Also a drag region (`deep`) for extra grab area; buttons
          still click through. Traffic lights live in the title bar now. */}
      <div
        class="sidebar-controls"
        classList={{ collapsed: props.collapsed }}
        data-tauri-drag-region="deep"
      >
        <button class="icon-btn" title="Toggle sidebar (Ctrl+B)" onClick={props.onToggleSidebar}>
          {props.collapsed ? "»" : "«"}
        </button>
        <Show when={!props.collapsed}>
          <button class="icon-btn" title="Back (Alt+←)" onClick={() => navActive(webviewBack)}>‹</button>
          <button class="icon-btn" title="Forward (Alt+→)" onClick={() => navActive(webviewForward)}>›</button>
          <Show
            when={isLoading(activeId())}
            fallback={<button class="icon-btn" title="Reload (Ctrl+R)" onClick={() => navActive(webviewReload)}>⟳</button>}
          >
            <button class="icon-btn" title="Stop (Esc)" onClick={() => navActive(webviewStop)}>✕</button>
          </Show>
          <button class="icon-btn" title="Home (new tab page)" onClick={() => props.onNavigate("flux://start")}>⌂</button>
          <button classList={{ "icon-btn": true, active: filesPanelOpen() }} title="File explorer" onClick={props.onToggleFilesPanel}>🗁</button>
          <button classList={{ "icon-btn": true, active: mapPanelOpen() }} title="Maps" onClick={props.onToggleMapPanel}>🗺</button>
          <span style={{ flex: 1 }} />
        </Show>
      </div>

      <Show when={!props.collapsed}>
        {/* Address / search pill */}
        <form onSubmit={submitAddress} class="address-row">
          <Show when={security()}>
            {(s) => <span class={`sec ${s().cls}`} title={s().title}>{s().icon}</span>}
          </Show>
          <input
            id="flux-address"
            class="address"
            value={address() || currentUrl()}
            onInput={(e) => onAddressInput(e.currentTarget.value)}
            onFocus={(e) => { e.currentTarget.select(); setAddrFocused(true); }}
            onKeyDown={onAddressKeyDown}
            onBlur={() => { setAddrFocused(false); setTimeout(closeSuggest, 150); }}
            placeholder="Search or enter address  (Ctrl+L)"
            spellcheck={false}
            autocomplete="off"
          />
          {/* Per-site zoom (#36): shown only when ≠ 100%; click to reset. */}
          <Show when={activeZoom() !== 1}>
            <button type="button" class="zoom-pill" title="Reset zoom (Ctrl+0)" onClick={() => props.onZoomReset()}>
              {Math.round(activeZoom() * 100)}%
            </button>
          </Show>
          {/* Loading bar: lives in the sidebar, never under the native webview. */}
          <Show when={isLoading(activeId())}>
            <div class="addr-progress" />
          </Show>
          {/* Live suggestions (#32) — sidebar-resident, so never under the webview.
              Also hosts the Omni AI answer card + its "Ask" trigger. */}
          <Show when={omniAns() !== null || ((suggestions().length > 0 || canAsk()) && addrFocused())}>
            <div class="omni-suggest">
              {/* Streamed, grounded answer from the Omni index. */}
              <Show when={omniAns()}>
                {(a) => (
                  <div class="omni-answer">
                    <div class="omni-answer-head">
                      <span class="spark">✦</span> Omni answer
                      <Show when={a().streaming}><span class="omni-answer-dot" /></Show>
                      <button
                        type="button"
                        class="omni-answer-close"
                        title="Dismiss Omni answer"
                        onMouseDown={(e) => { e.preventDefault(); clearOmniAns(); }}
                      >
                        ×
                      </button>
                    </div>
                    <div class="omni-answer-body">
                      <Show when={a().text} fallback={a().streaming ? "Thinking…" : "No answer."}>
                        <For each={answerParts(a().text)}>
                          {(part) =>
                            typeof part === "string" ? (
                              <span>{part}</span>
                            ) : a().sources[part.cite - 1] ? (
                              <sup
                                class="omni-cite"
                                title={a().sources[part.cite - 1]!.title}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  props.onNavigate(a().sources[part.cite - 1]!.url);
                                }}
                              >
                                {part.cite}
                              </sup>
                            ) : (
                              <span>[{part.cite}]</span>
                            )
                          }
                        </For>
                      </Show>
                    </div>
                    <Show when={a().sources.length > 0}>
                      <div class="omni-answer-src">
                        <For each={a().sources}>
                          {(s) => (
                            <button
                              type="button"
                              class="omni-answer-cite"
                              title={s.url}
                              onMouseDown={(e) => { e.preventDefault(); props.onNavigate(s.url); }}
                            >
                              [{s.n}] {s.title}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
              {/* Ask trigger (until an answer exists for this query). */}
              <Show when={omniAns() === null && canAsk()}>
                <button
                  type="button"
                  class="omni-sug omni-ask"
                  onMouseDown={(e) => { e.preventDefault(); startOmniAnswer(address()); }}
                >
                  <span class="omni-sug-icon">✦</span>
                  <span class="omni-sug-text">
                    <span class="omni-sug-label">Ask Omni: {address().trim()}</span>
                    <span class="omni-sug-sub">grounded answer from your index · Alt+Enter</span>
                  </span>
                </button>
              </Show>
              <For each={suggestions()}>
                {(s, i) => (
                  <button
                    type="button"
                    classList={{ "omni-sug": true, sel: selIdx() === i() }}
                    onMouseDown={(e) => { e.preventDefault(); void chooseSuggestion(s); }}
                    onMouseEnter={() => setSelIdx(i())}
                  >
                    <span class="omni-sug-icon">{s.kind === "history" ? "🕘" : "🔍"}</span>
                    <span class="omni-sug-text">
                      <span class="omni-sug-label">{s.label}</span>
                      <Show when={s.sub}><span class="omni-sug-sub">{s.sub}</span></Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </form>

        {/* Page actions row — bookmark / reader / capture / save-to-Omni, below
            the address bar (only for real web pages). */}
        <Show when={activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url)}>
          <div class="page-actions">
            <button
              type="button"
              classList={{ "icon-btn": true, "bm-star": true, active: props.isBookmarked() }}
              title={props.isBookmarked() ? "Bookmarked — click to remove (Ctrl+D)" : "Bookmark this page (Ctrl+D)"}
              onClick={() => props.onToggleBookmark()}
            >
              {props.isBookmarked() ? "★" : "☆"}
            </button>
            <button type="button" classList={{ "icon-btn": true, active: readerOpen() }} title="Reader mode" onClick={() => props.onToggleReader()}>📖</button>
            <button type="button" class="icon-btn" title="Capture page (screenshot)" onClick={() => props.onCapture()}>📸</button>
            <button type="button" class="icon-btn" title="Translate this page" onClick={() => props.onTranslate()}>🌐</button>
            <button type="button" class="icon-btn" title="Save for offline (read later)" onClick={() => props.onArchive()}>📚</button>
            <button type="button" class="icon-btn" title="Save this page to Omni (Ctrl+Shift+O)" onClick={() => props.onSaveToOmni()}>✦</button>
          </div>
        </Show>

        {/* Find-in-page (#33) — also sidebar-resident, for the same reason. */}
        <Show when={findOpen()}>
          <FindBar />
        </Show>

        {/* Pinned tiles (Arc Favorites) */}
        <Show when={pinnedTabs().length > 0}>
          <div class="pin-grid">
            <For each={pinnedTabs()}>
              {(tab) => (
                <button
                  classList={{ "pin-tile": true, active: activeId() === tab.id }}
                  title={`${tab.title || tab.url} — right-click to unpin`}
                  onClick={() => focusTab(tab.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void togglePin(tab);
                  }}
                >
                  <Favicon tab={tab} />
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* New tab */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setPicker((v) => !v)}
            style={{
              width: "100%",
              padding: "8px 10px",
              "text-align": "left",
              color: "var(--flux-teal)",
              border: "1px solid var(--flux-border)",
            }}
          >
            + New tab
          </button>
          <Show when={picker()}>
            <div class="glass popover" style={{ top: "calc(100% + 6px)", left: 0 }}>
              <button onClick={() => create("browser")}>
                🌐 Browser tab <kbd>Ctrl+T</kbd>
              </button>
              <button onClick={() => { setPicker(false); void openTab("browser", undefined, true); }}>
                🕶 Private tab
              </button>
              <button onClick={() => create("terminal")}>
                ⌨ Terminal tab <kbd>Ctrl+Shift+T</kbd>
              </button>
              <button onClick={() => create("files")}>
                📁 Files tab
              </button>
              <Show when={containers().length > 0}>
                <div class="ctx-sep" />
                <div class="ctx-label">Open in container</div>
                <For each={containers()}>
                  {(c) => (
                    <button onClick={() => { setPicker(false); void openTabInContainer(c.id); }}>
                      <span class="ws-dot" style={{ background: containerColor(c) }} /> {c.name}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>

        {/* Tab list — grouped sections (#56) then ungrouped, all drag-reorderable */}
        <div class="tab-list-head">
          <span class="sidebar-section">Tabs</span>
          <Show when={unpinnedTabs().some((t) => t.cluster) || groups().length > 0}>
            <button class="group-topic" title="Group tabs by topic (from semantic clusters)" onClick={async () => {
              const n = await groupByTopic();
              props.onToast(n > 0 ? `⊞ Grouped tabs into ${n} topic${n === 1 ? "" : "s"}` : "No clear topics yet — open a few related pages, let them load, then try again");
            }}>⊞ Group</button>
          </Show>
        </div>
        <div class="tab-list">
          <For each={groups()}>
            {(g) => {
              const members = () => membersByGroup().get(g.id) ?? [];
              return (
                <Show when={members().length > 0}>
                  <div class="tab-group">
                    <div
                      classList={{ "tab-group-head": true, "drag-over": dropId() === -g.id }}
                      onClick={() => void toggleGroupCollapsed(g)}
                      onContextMenu={(e) => { e.preventDefault(); setCtxGroup(g); setCtxPos({ x: e.clientX, y: e.clientY }); }}
                      onDragOver={(e) => { if (dragId() != null) { e.preventDefault(); e.dataTransfer!.dropEffect = "move"; setDropId(-g.id); } }}
                      onDragLeave={() => { if (dropId() === -g.id) setDropId(null); }}
                      onDrop={(e) => { e.preventDefault(); const d = dragId(); if (d != null) void setTabGroup(d, g.id); setDragId(null); setDropId(null); }}
                    >
                      <span class="tab-group-dot" title="Recolor" style={{ background: groupColor(g) }} onClick={(e) => { e.stopPropagation(); cycleGroupColor(g); }} />
                      <Show
                        when={editGroup() === g.id}
                        fallback={<span class="tab-group-name" title="Double-click to rename" onDblClick={(e) => { e.stopPropagation(); setEditGroup(g.id); }}>{g.name}</span>}
                      >
                        <input
                          class="inline-edit"
                          value={g.name}
                          autofocus
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) void renameGroup(g.id, v); setEditGroup(null); }}
                          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") setEditGroup(null); }}
                        />
                      </Show>
                      <span class="tab-group-count">{members().length}</span>
                      <button class="tab-group-x" title="Ungroup" onClick={(e) => { e.stopPropagation(); void deleteGroup(g.id); }}>✕</button>
                      <span class="tab-group-chev">{g.collapsed ? "▸" : "▾"}</span>
                    </div>
                    <Show when={!g.collapsed}>
                      <div class="tab-group-body" style={{ "border-left-color": groupColor(g) }}>
                        <For each={members()}>{(tab) => <TabRow tab={tab} />}</For>
                      </div>
                    </Show>
                  </div>
                </Show>
              );
            }}
          </For>
          <For each={ungroupedItems()}>
            {(it) => it.kind === "split" ? <SplitPair a={it.a} b={it.b} /> : <TabRow tab={it.tab} />}
          </For>
        </div>
      </Show>

      {/* Tab right-click menu (#56): pin, grouping, close. Portaled to <body> so
          the sidebar's overflow:hidden + backdrop-filter containing block can't
          clip it; clampMenu keeps it on-screen near the panel edges/bottom. */}
      <Show when={ctxTab()}>
        {(t) => (
          <Portal>
            <div class="ctx-backdrop" onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }} />
            <div class="tab-ctx glass" ref={clampMenu} style={{ left: `${ctxPos().x}px`, top: `${ctxPos().y}px` }}>
              <button onClick={() => { void togglePin(t()); closeCtx(); }}>{t().pinned ? "Unpin" : "Pin tab"}</button>
              <button onClick={() => { const id = t().id; closeCtx(); setEditTab(id); }}>Rename tab</button>
              <button onClick={() => { void newGroupWithTab(t().id); closeCtx(); }}>New group with tab</button>
              <Show when={groups().length > 0}>
                <div class="ctx-sep" />
                <div class="ctx-label">Add to group</div>
                <For each={groups()}>
                  {(g) => (
                    <button onClick={() => { void setTabGroup(t().id, g.id); closeCtx(); }}>
                      <span class="tab-group-dot" style={{ background: groupColor(g) }} /> {g.name}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={t().group != null}>
                <button onClick={() => { void setTabGroup(t().id, null); closeCtx(); }}>Remove from group</button>
              </Show>
              <Show when={t().kind === "browser" && !isStartUrl(t().url) && activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url) && activeId() !== t().id}>
                <div class="ctx-sep" />
                <button onClick={() => { startSplit(activeId()!, t().id); closeCtx(); }}>⊟ Split with current tab</button>
              </Show>
              <Show when={splitPair()}>
                <button onClick={() => { clearSplit(); closeCtx(); }}>Exit split view</button>
              </Show>
              <div class="ctx-sep" />
              <div class="ctx-label">Move to folder (sleeps to save RAM)</div>
              <button onClick={() => { void newFolderWithTab(t().id); closeCtx(); }}>+ New folder with tab</button>
              <For each={folders()}>
                {(f) => (
                  <button onClick={() => { void setTabFolder(t().id, f.id); closeCtx(); }}>🗂 {f.name}</button>
                )}
              </For>
              <Show when={t().folder != null}>
                <button onClick={() => { void setTabFolder(t().id, null); closeCtx(); }}>Take out of folder</button>
              </Show>
              <Show when={workspaces().length > 1}>
                <div class="ctx-sep" />
                <div class="ctx-label">Send to workspace</div>
                <For each={workspaces().filter((w) => w.id !== t().workspace)}>
                  {(w) => (
                    <button onClick={() => { props.onSendTabToWorkspace(t().id, w.id); closeCtx(); }}>
                      <span class="ws-dot" style={{ background: workspaceColor(w) }} /> {w.name}
                    </button>
                  )}
                </For>
              </Show>
              <div class="ctx-sep" />
              <button onClick={() => { void closeTab(t().id); closeCtx(); }}>Close tab</button>
            </div>
          </Portal>
        )}
      </Show>

      {/* Group right-click menu (#44/#56): rename, recolor, send-to-workspace. */}
      <Show when={ctxGroup()}>
        {(g) => (
          <Portal>
            <div class="ctx-backdrop" onClick={() => setCtxGroup(null)} onContextMenu={(e) => { e.preventDefault(); setCtxGroup(null); }} />
            <div class="tab-ctx glass" ref={clampMenu} style={{ left: `${ctxPos().x}px`, top: `${ctxPos().y}px` }}>
              <button onClick={() => { setEditGroup(g().id); setCtxGroup(null); }}>Rename group</button>
              <button onClick={() => { cycleGroupColor(g()); setCtxGroup(null); }}>Change color</button>
              <Show when={workspaces().length > 1}>
                <div class="ctx-sep" />
                <div class="ctx-label">Send group to workspace</div>
                <For each={workspaces().filter((w) => w.id !== activeWorkspace())}>
                  {(w) => (
                    <button onClick={() => { props.onSendGroupToWorkspace(g().id, w.id); setCtxGroup(null); }}>
                      <span class="ws-dot" style={{ background: workspaceColor(w) }} /> {w.name}
                    </button>
                  )}
                </For>
              </Show>
              <div class="ctx-sep" />
              <button onClick={() => { void deleteGroup(g().id); setCtxGroup(null); }}>Ungroup</button>
            </div>
          </Portal>
        )}
      </Show>

      {/* Collapsed rail: pinned tiles stack vertically, nothing else. */}
      <Show when={props.collapsed}>
        <div class="tab-list" style={{ "align-items": "center", gap: "6px" }}>
          <For each={pinnedTabs()}>
            {(tab) => (
              <button
                classList={{ "pin-tile": true, active: activeId() === tab.id }}
                style={{ width: "36px" }}
                title={tab.title || tab.url}
                onClick={() => focusTab(tab.id)}
              >
                <Favicon tab={tab} />
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Workspace rail (#44) — a thin vertical strip of colored dots on the
          sidebar's right edge; hover a dot to pop out its name + controls. */}
      <Show when={!props.collapsed}>
        <div class="ws-rail">
          <For each={workspaces()}>
            {(w) => (
              <div classList={{ "ws-rail-item": true, active: activeWorkspace() === w.id }}>
                <button
                  class="ws-rail-dot"
                  style={{ background: workspaceColor(w) }}
                  title={w.name}
                  onClick={() => props.onSwitchWorkspace(w.id)}
                />
                <div class="ws-rail-pop glass">
                  <span class="ws-dot" title="Recolor" style={{ background: workspaceColor(w) }} onClick={(e) => { e.stopPropagation(); cycleWsColor(w); }} />
                  <Show when={editWs() === w.id} fallback={<span class="ws-name" title="Double-click to rename" onDblClick={() => setEditWs(w.id)}>{w.name}</span>}>
                    <input
                      class="inline-edit ws"
                      value={w.name}
                      autofocus
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) void renameWorkspace(w.id, v); setEditWs(null); }}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") setEditWs(null); }}
                    />
                  </Show>
                  <button class="ws-rail-x" title="Delete workspace" onClick={(e) => { e.stopPropagation(); props.onDeleteWorkspace(w.id); }}>✕</button>
                </div>
              </div>
            )}
          </For>
          <button class="ws-rail-add" title="New workspace" onClick={() => props.onNewWorkspace()}>+</button>
        </div>
      </Show>

      {/* Tab folders — collapsible parking buckets above the footer. Members are
          kept hibernated (≈0 RAM); click one to wake + view it. */}
      <Show when={!props.collapsed && folders().length > 0}>
        <div class="folders">
          <For each={folders()}>
            {(f) => {
              const members = () => folderTabs(f.id);
              return (
                <div class="folder">
                  <div class="folder-head" onClick={() => void toggleFolderCollapsed(f)}>
                    <span class="folder-caret">{f.collapsed ? "▸" : "▾"}</span>
                    <span class="folder-icon">🗂</span>
                    <Show
                      when={editFolder() === f.id}
                      fallback={<span class="folder-name" onDblClick={(e) => { e.stopPropagation(); setEditFolder(f.id); }}>{f.name}</span>}
                    >
                      <input
                        class="folder-rename"
                        value={f.name}
                        autofocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) void renameFolder(f.id, v); setEditFolder(null); }}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") setEditFolder(null); }}
                      />
                    </Show>
                    <span class="folder-count">{members().length}</span>
                    <button class="folder-edit" title="Rename folder" onClick={(e) => { e.stopPropagation(); setEditFolder(f.id); }}>✎</button>
                    <button class="folder-x" title="Delete folder (tabs return to the strip)" onClick={(e) => { e.stopPropagation(); void deleteFolder(f.id); }}>✕</button>
                  </div>
                  <Show when={!f.collapsed}>
                    <div class="folder-tabs">
                      <For each={members()}>
                        {(t) => (
                          <div
                            classList={{ "folder-tab": true, active: activeId() === t.id }}
                            title={t.title || t.url}
                            onClick={() => void focusTab(t.id)}
                          >
                            <span class="folder-tab-ico"><Favicon tab={t} /></span>
                            <span class="folder-tab-title">{tabLabel(t)}</span>
                            <button class="folder-tab-out" title="Take out of folder" onClick={(e) => { e.stopPropagation(); void setTabFolder(t.id, null); }}>⏏</button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Footer: tool toggles + bookmarks / extensions / settings (chrome
          melts here — no status bar). */}
      <div
        class="sidebar-footer"
        classList={{ collapsed: props.collapsed }}
        style={{ position: "relative" }}
      >
        <button classList={{ "icon-btn": true, active: props.terminalOpen }} title="Terminal (Ctrl+`)" onClick={props.onToggleTerminal}>⌨</button>
        <button classList={{ "icon-btn": true, active: props.agentOpen }} title="Flux Agent (Ctrl+Shift+A)" onClick={props.onToggleAgent}>✦</button>
        <Shields onNavigate={props.onNavigate} />
        <Show when={boostsLoaded()} fallback={
          <button class="icon-btn" title="Boosts — customize this site with AI" onClick={() => setBoostsLoaded(true)}>✨</button>
        }>
          <Suspense fallback={<button class="icon-btn active" title="Boosts — customize this site with AI">✨</button>}>
            <Boosts initialOpen />
          </Suspense>
        </Show>
        <Show when={macrosLoaded()} fallback={
          <button class="icon-btn" title="Macros — record & replay flows" onClick={() => setMacrosLoaded(true)}>⏺</button>
        }>
          <Suspense fallback={<button class="icon-btn active" title="Macros — record & replay flows">⏺</button>}>
            <Macros initialOpen />
          </Suspense>
        </Show>
        <Show when={passwordsLoaded()} fallback={
          <button class="icon-btn" title="Passwords" onClick={() => setPasswordsLoaded(true)}>🔑</button>
        }>
          <Suspense fallback={<button class="icon-btn active" title="Passwords">🔑</button>}>
            <Passwords initialOpen />
          </Suspense>
        </Show>
        <Downloads />
        <button classList={{ "icon-btn": true, active: panel() === "bookmarks" }} title="Bookmarks" onClick={() => openPanel("bookmarks")}>🔖</button>
        <button classList={{ "icon-btn": true, active: panel() === "notes" }} title="Note for this page" onClick={() => { openPanel("notes"); loadNote(); }}>📝</button>
        <button classList={{ "icon-btn": true, active: panel() === "webpanels" || activePanelId() != null }} title="Web panels — pin a site beside your tabs" onClick={() => openPanel("webpanels")}>◨</button>
        <Show when={archivedTabs().length > 0}>
          <button classList={{ "icon-btn": true, active: panel() === "archived" }} title="Archived tabs — auto-closed stale tabs you can reopen" onClick={() => openPanel("archived")}>🗄</button>
        </Show>
        <button classList={{ "icon-btn": true, active: panel() === "extensions" }} title="Extensions" onClick={() => openPanel("extensions")}>🧩</button>
        <button classList={{ "icon-btn": true, active: panel() === "settings" }} title="Settings" onClick={() => openPanel("settings")}>⚙</button>

        <Show when={panel()}>
          <div class="glass popover footer-pop">
            <Show when={panel() === "settings"}>
              <button class="shields-update" onClick={() => { setPanel(null); props.onNavigate(SETTINGS_URL); }}>⚙ Open full Settings ↗</button>
              <div class="ctx-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Containers <span style={{ color: "var(--flux-text-mute)", "font-weight": 400 }}>· isolated logins</span></div>
              <For each={containers()}>
                {(c) => (
                  <div class="panel-row">
                    <span class="ws-dot" title="Recolor" style={{ background: containerColor(c), "margin-left": "8px", cursor: "pointer" }} onClick={() => void recolorContainer(c.id)} />
                    <Show when={editContainer() === c.id} fallback={
                      <span class="panel-row-open" onDblClick={() => setEditContainer(c.id)} title="Double-click to rename">{c.name}</span>
                    }>
                      <input class="inline-edit" value={c.name} autofocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) void renameContainer(c.id, v); setEditContainer(null); }}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") setEditContainer(null); }} />
                    </Show>
                    <button class="panel-row-x" title="Delete container" onClick={() => void deleteContainer(c.id)}>✕</button>
                  </div>
                )}
              </For>
              <button class="shields-update" onClick={() => void createContainer().then((id) => id && setEditContainer(id))}>＋ New container</button>
              <div class="ctx-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Default search engine</div>
              <For each={engines()}>
                {(e) => (
                  <button onClick={() => pickEngine(e.id)} style={{ "justify-content": "space-between", display: "flex" }}>
                    {e.name}
                    <Show when={defaultEngine() === e.id}><span style={{ color: "var(--flux-teal)" }}>✓</span></Show>
                  </button>
                )}
              </For>
              <Show when={engines().length === 0}>
                <div class="start-empty" style={{ padding: "6px 8px" }}>Engines load in the running app.</div>
              </Show>
              <div class="shields-row" style={{ padding: "4px 8px 2px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="Send what you type to the search engine for live suggestions. History suggestions stay local either way.">Search suggestions</span>
                <button classList={{ "shields-toggle": true, on: searchSuggestOn() }} onClick={() => setSearchSuggestOn(!searchSuggestOn())}>
                  {searchSuggestOn() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="When you search, the local Gemma drafts a quick answer in the agent panel. Runs on-device.">AI answers for searches</span>
                <button classList={{ "shields-toggle": true, on: aiAnswersOn() }} onClick={() => setAiAnswersOn(!aiAnswersOn())}>
                  {aiAnswersOn() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="On every search, stream a grounded answer card from your Omni index in the omnibox (with citations). Off by default — it runs the local LLM each time. The 'Ask Omni' row and Alt+Enter work regardless.">Omni answer on search</span>
                <button classList={{ "shields-toggle": true, on: omniAutoAnswer() }} onClick={() => setOmniAutoAnswer(!omniAutoAnswer())}>
                  {omniAutoAnswer() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="Ask websites to render dark (prefers-color-scheme). Works on most modern sites.">Dark mode (websites)</span>
                <button classList={{ "shields-toggle": true, on: darkMode() }} onClick={() => setDarkMode(!darkMode())}>
                  {darkMode() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Navigation</div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="Press f to label links/buttons, then type the label to click. Also j/k scroll, gg/G top/bottom.">Vim link hints (f)</span>
                <button classList={{ "shields-toggle": true, on: vimHints() }} onClick={() => setVimHints(!vimHints())}>{vimHints() ? "On" : "Off"}</button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="Hold the right mouse button and drag: left = back, right = forward, down = reload, up = top.">Mouse gestures</span>
                <button classList={{ "shields-toggle": true, on: mouseGestures() }} onClick={() => setMouseGestures(!mouseGestures())}>{mouseGestures() ? "On" : "Off"}</button>
              </div>
              <div class="shields-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Memory</div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="Free a background tab's memory by unloading it; it reloads when you return.">Sleep inactive tabs</span>
                <button classList={{ "shields-toggle": true, on: hibernateEnabled() }} onClick={() => setHibernateEnabled(!hibernateEnabled())}>
                  {hibernateEnabled() ? "On" : "Off"}
                </button>
              </div>
              <Show when={hibernateEnabled()}>
                <div class="shields-row" style={{ padding: "2px 8px" }}>
                  <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }}>After</span>
                  <select class="shields-select" value={String(hibernateMins())} onChange={(e) => setHibernateMins(Number(e.currentTarget.value))}>
                    <option value="5">5 min</option>
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                  </select>
                </div>
              </Show>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }} title="When free system memory runs low, sleep the least-recently-used tabs early.">Sleep under memory pressure</span>
                <button classList={{ "shields-toggle": true, on: memEvict() }} onClick={() => setMemEvict(!memEvict())}>
                  {memEvict() ? "On" : "Off"}
                </button>
              </div>
              <Show when={mem()}>
                <div class="shields-stat" style={{ padding: "2px 8px 4px" }}>
                  Flux {mem()!.process_mb} MB · {(mem()!.available_mb / 1024).toFixed(1)} GB free ({mem()!.available_pct}%)
                </div>
              </Show>
            </Show>
            <Show when={panel() === "bookmarks"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Library</div>
              <Show when={activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url)}>
                <button class="shields-update" onClick={() => {
                  const t = activeTab()!;
                  void bookmarkAdd(t.title || t.url, t.url).then(() => { setBmFlash("✓ saved"); window.setTimeout(() => setBmFlash(""), 2000); }).catch(() => {});
                }}>★ Bookmark this page <Show when={bmFlash()}><span class="bm-inline-flash">{bmFlash()}</span></Show></button>
              </Show>
              <button class="shields-update" onClick={() => { setPanel(null); props.onNavigate(BOOKMARKS_URL); }}>🔖 All bookmarks</button>
              <button class="shields-update" onClick={() => { setPanel(null); props.onNavigate(SESSIONS_URL); }}>🗃 Sessions</button>
              <button class="shields-update" onClick={() => { setPanel(null); props.onNavigate(HISTORY_URL); }}>🕘 Browsing history</button>
              <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                Import Chrome bookmarks and open folders as tab groups from the <b>All bookmarks</b> page.
              </div>
            </Show>
            <Show when={panel() === "webpanels"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Web panels</div>
              <Show when={activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url)}>
                <button class="shields-update" onClick={() => {
                  const t = activeTab()!;
                  void pinPanel(t.url, t.title || t.url);
                  setPanel(null);
                }}>＋ Pin this page as a panel</button>
              </Show>
              <Show when={panels().length > 0} fallback={<div class="start-empty" style={{ padding: "4px 10px 8px" }}>Pin a site (chat, docs, music) to keep it in a slim pane beside any tab.</div>}>
                <div class="ctx-sep" />
                <For each={panels()}>
                  {(p) => (
                    <div class="panel-row" classList={{ active: activePanelId() === p.id || activePanelIdB() === p.id }}>
                      <button class="panel-row-open" onClick={() => { togglePanel(p.id); setPanel(null); }} title="Show in panel (top)">
                        <span class="panel-row-title">{p.title || p.url}</span>
                      </button>
                      <button class="panel-slot-btn" classList={{ on: activePanelIdB() === p.id }} title="Stack in bottom split" onClick={(e) => { e.stopPropagation(); togglePanelBottom(p.id); }}>⬓</button>
                      <button class="panel-row-x" title="Unpin" onClick={(e) => { e.stopPropagation(); void unpinPanel(p.id); }}>✕</button>
                    </div>
                  )}
                </For>
                <div class="start-empty" style={{ padding: "6px 10px 4px", "font-size": "11px", opacity: "0.7" }}>Tap a panel for the top; ⬓ stacks it below — e.g. calendar over email.</div>
              </Show>
            </Show>
            <Show when={panel() === "notes"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Note for this page</div>
              <Show when={activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url)} fallback={<div class="start-empty" style={{ padding: "4px 10px 8px" }}>Open a web page to jot a note.</div>}>
                <div class="note-url">{activeTab()!.url}</div>
                <textarea
                  class="note-area"
                  placeholder="Jot a note — saved locally for this page…"
                  value={noteText()}
                  onInput={(e) => saveNote(e.currentTarget.value)}
                />
              </Show>
            </Show>
            <Show when={panel() === "archived"}>
              <div class="sidebar-section" style={{ padding: "4px 8px", display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                <span>Archived tabs</span>
                <Show when={archivedTabs().length > 0}>
                  <button class="panel-row-x" title="Clear all" onClick={() => clearArchived()}>Clear</button>
                </Show>
              </div>
              <Show when={archivedTabs().length > 0} fallback={<div class="start-empty" style={{ padding: "4px 10px 8px" }}>Stale tabs auto-archive here (set the threshold in Settings → Tabs). Reopen any with one tap.</div>}>
                <For each={archivedTabs()}>
                  {(a) => (
                    <div class="panel-row">
                      <button class="panel-row-open" title={a.url} onClick={() => { void restoreArchived(a); setPanel(null); }}>
                        <span class="panel-row-title">{a.title || a.url}</span>
                      </button>
                      <button class="panel-row-x" title="Remove" onClick={(e) => { e.stopPropagation(); removeArchived(a.url); }}>✕</button>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
            <Show when={panel() === "extensions"}>
              <Suspense><Extensions /></Suspense>
            </Show>
          </div>
        </Show>
      </div>
    </nav>
  );
};

// ─── Reader mode (#41) ──────────────────────────────────────────────────────

/** Render one extracted block. Text-only (+ <img src>) — never raw HTML. */
const ReaderBlockView: Component<{ b: ReaderBlock }> = (props) => {
  const b = props.b;
  return (
    <Switch fallback={<p class="reader-p">{b.text}</p>}>
      <Match when={b.kind === "h"}><p classList={{ "reader-h": true, [`h${b.level || 2}`]: true }}>{b.text}</p></Match>
      <Match when={b.kind === "li"}><div class="reader-li">{b.text}</div></Match>
      <Match when={b.kind === "quote"}><blockquote class="reader-quote">{b.text}</blockquote></Match>
      <Match when={b.kind === "pre"}><pre class="reader-pre">{b.text}</pre></Match>
      <Match when={b.kind === "cap"}><div class="reader-cap">{b.text}</div></Match>
      <Match when={b.kind === "img"}><img class="reader-img" src={b.src} alt={b.text} loading="lazy" /></Match>
    </Switch>
  );
};

/** The decluttered article view, shown over the (hidden) webview. TTS via the
 *  Web Speech API. */
const ReaderView: Component = () => {
  const [speaking, setSpeaking] = createSignal(false);
  const speakable = () =>
    readerBlocks().filter((b) => b.kind === "p" || b.kind === "li" || b.kind === "quote" || b.kind === "h").map((b) => b.text).join(". ");
  const toggleSpeak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking()) { synth.cancel(); setSpeaking(false); return; }
    const u = new SpeechSynthesisUtterance(`${readerTitle()}. ${speakable()}`.slice(0, 20000));
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  };
  onCleanup(() => window.speechSynthesis?.cancel());
  return (
    <div class="reader">
      <div class="reader-bar">
        <button class="reader-btn" onClick={toggleSpeak}>{speaking() ? "⏹ Stop" : "🔊 Listen"}</button>
        <span class="reader-count">{readerBlocks().length} blocks</span>
        <button class="reader-btn" onClick={() => closeReader()} title="Close (Esc)">✕ Close</button>
      </div>
      <article class="reader-doc">
        <h1 class="reader-title">{readerTitle()}</h1>
        <For each={readerBlocks()}>{(b) => <ReaderBlockView b={b} />}</For>
      </article>
    </div>
  );
};

// ─── Content card ─────────────────────────────────────────────────────────

/** The floating card. Holds, by active tab: a Terminal PTY, the start-page
 *  dashboard (`flux://start`), or — for a loaded page — a placeholder the
 *  native child webview is positioned over (BACKLOG #2). */
const ContentArea: Component<{
  onNavigate: (url: string) => void;
  onNewTerminal: () => void;
  onToggleAgent: () => void;
  onSleepBackground: () => void;
}> = (props) => {
  // Keyed by id (primitive) so the list is stable across unrelated tab updates.
  const terminalIds = createMemo(() => tabs().filter((t) => t.kind === "terminal").map((t) => t.id));
  return (
  <main class="content">
    {/* Pages bar: quick-access native-page chips docked above the card. A sibling
        (not an overlay) so the card shrinks and the native webview follows it. */}
    <Show when={pagesBarOpen()}>
      <Suspense><PagesBar /></Suspense>
      <Suspense><TuiAppsBar /></Suspense>
    </Show>
    <div class="card" id="flux-web-area">
      {/* Reader mode (#41): a decluttered DOM view over the (hidden) webview. */}
      <Show when={readerOpen()}>
        <ReaderView />
      </Show>
      {/* Split-view seam (#43): sits in the gap between the two tiled webviews
          (the one strip of card the OS webview layers don't cover), so it's
          visible + draggable. Dragging hides the panes (setSplitDragging) so the
          chrome can track the pointer, then re-tiles at the new ratio on release. */}
      <Show when={splitPanes()}>
        <div
          class="pane-splitter"
          style={{ left: `${Math.min(80, Math.max(20, splitRatio() * 100))}%` }}
          title="Drag to resize · double-click to even out"
          onDblClick={() => setSplitRatio(0.5)}
          onPointerDown={(e) => {
            e.preventDefault();
            const card = document.getElementById("flux-web-area");
            if (!card) return;
            const rect = card.getBoundingClientRect();
            setSplitDragging(true);
            const move = (ev: PointerEvent) =>
              setSplitRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)));
            const up = () => {
              setSplitDragging(false);
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      </Show>
      {/* Keep-alive terminal layer (#73): every Terminal tab stays mounted, so
          its PTY + scrollback survive tab switches; only the active one shows.
          (TerminalView only unmounts — and kills its PTY — when the tab closes,
          which removes it from this list.) */}
      <For each={terminalIds()}>
        {(id) => (
          <div class="term-layer" style={{ display: activeTab()?.id === id ? "block" : "none" }}>
            <TerminalView session={id} active={activeTab()?.id === id} />
          </div>
        )}
      </For>
      <Show when={activeTab()?.kind !== "terminal"}>
      <Suspense>
      <Switch
        fallback={
          /* Browser tab with a real page — the native webview overlays this. */
          <span style={{ "text-align": "center", "line-height": 1.8 }}>
            <strong style={{ color: "var(--flux-text)" }}>{activeTab()?.title || "Flux"}</strong>
            <br />
            loading…
          </span>
        }
      >
        <Match when={activeTab()?.kind === "files"}>
          {/* Key on the tab *id* (stable), NOT the tab object: onPathChange
              patches the tab (new object ref), and keying on the object would
              remount FilesView on every navigation → an infinite reload loop.
              The id only changes when you switch tabs, which is when we *do*
              want a fresh mount. */}
          <Show when={activeTab()?.id} keyed>
            {(id) => (
              <FilesView
                id={id}
                path={tabs().find((t) => t.id === id)?.url ?? ""}
                onPathChange={(p) => {
                  updateTabUrl(id, p);
                  updateTabTitle(id, basename(p));
                }}
                onOpenInTab={props.onNavigate}
              />
            )}
          </Show>
        </Match>
        {/* Before the generic start match — `flux://omni` is also a `flux://` url. */}
        <Match when={activeTab()?.url === OMNI_URL}>
          <OmniDashboard onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === NOTEBOOK_URL}>
          <NotebookPage />
        </Match>
        <Match when={activeTab()?.url === VAULT_URL}>
          <VaultPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === HISTORY_URL}>
          <HistoryPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === BOOKMARKS_URL}>
          <BookmarksPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === SESSIONS_URL}>
          <SessionsPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === RESOURCES_URL}>
          <ResourcesPage onNavigate={props.onNavigate} onSleepBackground={props.onSleepBackground} />
        </Match>
        <Match when={activeTab()?.url === TASKS_URL}>
          <TasksPage />
        </Match>
        <Match when={activeTab()?.url === SPEEDTEST_URL}>
          <SpeedtestPage />
        </Match>
        <Match when={activeTab()?.url === PERMISSIONS_URL}>
          <PermissionsPage />
        </Match>
        <Match when={activeTab()?.url?.startsWith(PDF_URL)}>
          <PdfViewer />
        </Match>
        <Match when={activeTab()?.url === ARCHIVE_URL}>
          <ArchivePage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab()?.url === FEEDS_URL}>
          <FeedsPage />
        </Match>
        <Match when={activeTab()?.url === SYNC_URL}>
          <SyncPage />
        </Match>
        <Match when={activeTab()?.url === APPS_URL}>
          <AppsPage />
        </Match>
        <Match when={activeTab()?.url === SETTINGS_URL}>
          <SettingsPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={activeTab() && isStartUrl(activeTab()!.url)}>
          <StartPage
            onNavigate={props.onNavigate}
            onNewTerminal={props.onNewTerminal}
            onToggleAgent={props.onToggleAgent}
          />
        </Match>
      </Switch>
      </Suspense>
      </Show>
    </div>
    {/* Bookmark bar (#22): docked under the card. A sibling (not an overlay), so
        the card shrinks and the native webview relayout follows it. */}
    <Show when={bookmarkBarOpen()}>
      <Suspense><BookmarkBar onNavigate={props.onNavigate} /></Suspense>
    </Show>
  </main>
  );
};

// ─── Web panel column ────────────────────────────────────────────────────────

const WebPanelPane: Component = () => {
  const both = () => activePanel() != null && activePanelB() != null;
  // Drag the horizontal divider to re-balance the top/bottom split. Webviews hide
  // during the drag (panelDragging) so the DOM divider can track the pointer freely.
  const startSplitDrag = (e: PointerEvent) => {
    e.preventDefault();
    const pane = (e.currentTarget as HTMLElement).parentElement;
    if (!pane) return;
    setPanelDragging(true);
    const move = (ev: PointerEvent) => {
      const r = pane.getBoundingClientRect();
      if (r.height > 0) setPanelSplitRatio((ev.clientY - r.top) / r.height);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanelDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const slot = (
    id: string,
    p: WebPanel,
    onClose: () => void,
    grow: () => number,
  ) => (
    <div class="webpanel-surface" id={id} style={{ "flex-grow": String(grow()) }}>
      <div class="panel-toolbar">
        <span class="panel-title" title={p.url}>{p.title || p.url}</span>
        <button class="panel-btn" title="Reload panel" onClick={() => void panelNavigate(p.id, p.url)}>⟳</button>
        <button class="panel-btn" title="Close panel" onClick={onClose}>✕</button>
      </div>
      <div class="panel-placeholder" />
    </div>
  );
  return (
    <aside class="webpanel-pane">
      <Show when={activePanel()}>
        {(p) => slot("flux-panel-area", p(), () => closePanel(), () => (both() ? panelSplitRatio() : 1))}
      </Show>
      <Show when={both()}>
        <div class="webpanel-vdiv" onPointerDown={startSplitDrag} title="Drag to resize split" />
      </Show>
      <Show when={activePanelB()}>
        {(p) => slot("flux-panel-area-b", p(), () => closePanelB(), () => (both() ? 1 - panelSplitRatio() : 1))}
      </Show>
    </aside>
  );
};

// ─── Vertical terminal column ───────────────────────────────────────────────

/** Reserved session-id range for the column's *extra* split panes (#75). Tab ids
 *  start at 1 and climb slowly; PANE_SESSION is 0 — so a high base never collides. */
const COL_PANE_BASE = 0xf000_0000;

/** Right-side vertical terminal (ADR 0002 / 0003): the always-available dev
 *  terminal. The first pane is the persistent PANE_SESSION; #75 adds splits —
 *  the column can hold several PTY panes side-by-side or stacked, each its own
 *  shell, with a hover toolbar to split / flip orientation / close the focused
 *  pane. (Extra panes are session-local; they reset if the column is hidden.) */
const TerminalColumn: Component = () => {
  const [panes, setPanes] = createSignal<number[]>([PANE_SESSION]);
  // Per-pane flex-grow weights, parallel to `panes` — dragging a seam shifts
  // weight between the two neighbours so splits are resizable (#75).
  const [sizes, setSizes] = createSignal<number[]>([1]);
  const [active, setActive] = createSignal(PANE_SESSION);
  const [dir, setDir] = createSignal<"row" | "col">(
    localStorage.getItem("flux.term.split") === "row" ? "row" : "col",
  );
  let paneSeq = COL_PANE_BASE;
  let panesEl!: HTMLDivElement;

  const split = () => {
    const id = ++paneSeq;
    const i = panes().indexOf(active());
    const at = i < 0 ? panes().length : i + 1; // insert after the focused pane
    setPanes((p) => { const n = [...p]; n.splice(at, 0, id); return n; });
    setSizes((s) => { const n = [...s]; n.splice(at, 0, 1); return n; });
    setActive(id);
  };
  const closePane = (id: number) => {
    const p = panes();
    if (p.length <= 1) return; // keep at least one pane alive
    const i = p.indexOf(id);
    const next = p.filter((x) => x !== id);
    setPanes(next);
    setSizes((s) => s.filter((_, k) => k !== i));
    if (active() === id) setActive(next[Math.min(i, next.length - 1)]!);
    // TerminalView's onCleanup kills that pane's PTY on unmount.
  };
  const toggleDir = () =>
    setDir((d) => {
      const n = d === "row" ? "col" : "row";
      localStorage.setItem("flux.term.split", n);
      return n;
    });

  // Drag the seam before pane `idx`, redistributing weight between panes idx-1/idx.
  const startResize = (e: PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const horizontal = dir() === "row";
    const total = horizontal ? panesEl.clientWidth : panesEl.clientHeight;
    if (total <= 0) return;
    const MIN = 60; // px — smallest a pane can shrink to
    const startPos = horizontal ? e.clientX : e.clientY;
    const s0 = sizes();
    const a = s0[idx - 1] ?? 1, b = s0[idx] ?? 1, pair = a + b;
    const totalGrow = s0.reduce((n, v) => n + v, 0) || 1;
    const pairPx = (pair / totalGrow) * total;
    const aPx0 = (a / totalGrow) * total;
    document.body.classList.add("busy"); // drop glass blur while dragging
    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const aPx = Math.max(MIN, Math.min(pairPx - MIN, aPx0 + (pos - startPos)));
      const ratio = aPx / pairPx;
      setSizes((s) => { const n = [...s]; n[idx - 1] = pair * ratio; n[idx] = pair * (1 - ratio); return n; });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("busy");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section class="terminal-col">
      <div ref={panesEl} class="term-col-panes" style={{ "flex-direction": dir() === "row" ? "row" : "column" }}>
        <For each={panes()}>
          {(s, i) => (
            <>
              <Show when={i() > 0}>
                <div
                  classList={{ "term-seam": true, vert: dir() === "row" }}
                  title="Drag to resize"
                  onPointerDown={(e) => startResize(e, i())}
                />
              </Show>
              <div
                classList={{ "term-pane": true, active: panes().length > 1 && active() === s }}
                style={{ "flex-grow": String(sizes()[i()] ?? 1), "flex-basis": "0", "flex-shrink": "1" }}
                onPointerDown={() => setActive(s)}
              >
                <div class="terminal-surface">
                  <TerminalView session={s} active={active() === s} />
                </div>
              </div>
            </>
          )}
        </For>
      </div>
      <div class="term-col-bar">
        <button class="term-col-btn" title="Split terminal" onClick={split}>⊞</button>
        <button
          class="term-col-btn"
          title={dir() === "row" ? "Stack panes vertically" : "Place panes side by side"}
          onClick={toggleDir}
        >
          {dir() === "row" ? "▭" : "▯"}
        </button>
        <Show when={panes().length > 1}>
          <button class="term-col-btn danger" title="Close focused pane" onClick={() => closePane(active())}>✕</button>
        </Show>
      </div>
    </section>
  );
};

// ─── Flux Agent panel ───────────────────────────────────────────────────────

/** The "Liquid AI" surface. Status drives the visual state machine: idle →
 *  violet dot, thinking → kinetic gradient border, acting → magenta line. */
// ─── helpers ────────────────────────────────────────────────────────────────

/** Tab/pin icon: the site's real favicon (#21) once fetched, else a letter
 *  glyph (or ⌨/📁 for terminal/files). Favicons are fetched cookielessly +
 *  cached by Rust per host; the letter shows while loading or when none exists. */
/** Favicon for a bare URL (the app-rail web-panel icons). */
const PanelIcon: Component<{ url: string }> = (props) => {
  const host = (): string | null => {
    try { return new URL(props.url).hostname.replace(/^www\./, "") || null; } catch { return null; }
  };
  createEffect(() => ensureFavicon(host()));
  const data = () => faviconFor(host());
  return (
    <Show when={typeof data() === "string"} fallback={<span class="fav-letter">{(host() ?? "?").charAt(0).toUpperCase()}</span>}>
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

const Favicon: Component<{ tab: TabMeta }> = (props) => {
  const host = (): string | null => {
    const t = props.tab;
    if (t.kind !== "browser" || isStartUrl(t.url)) return null;
    try {
      return new URL(t.url).hostname.replace(/^www\./, "") || null;
    } catch {
      return t.url.split("/")[2]?.replace(/^www\./, "") ?? null;
    }
  };
  createEffect(() => ensureFavicon(host()));
  const data = () => faviconFor(host());
  const letter = () => {
    const t = props.tab;
    if (t.kind === "terminal") return "⌨";
    if (t.kind === "files") return "📁";
    const h = host() ?? t.url.split("/")[2] ?? t.url;
    return (h.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  };
  return (
    <Show when={typeof data() === "string"} fallback={<span class="fav-letter">{letter()}</span>}>
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

/** Last path segment of a filesystem path (Windows or Unix), for the tab title. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function clusterColor(tab: TabMeta): string {
  return tab.cluster ? `#${tab.cluster.color.toString(16).padStart(6, "0")}` : "transparent";
}

export default App;
