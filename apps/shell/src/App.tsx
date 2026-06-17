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
  OMNI_URL,
  VAULT_URL,
  HISTORY_URL,
  BOOKMARKS_URL,
  SESSIONS_URL,
  RESOURCES_URL,
  TASKS_URL,
  SPEEDTEST_URL,
  PERMISSIONS_URL,
  PANE_SESSION,
  agentChat,
  agentChatTabs,
  agentExecute,
  agentPlan,
  agentRunAction,
  agentModels,
  noteGet,
  noteSet,
  bookmarkAdd,
  bookmarkRemove,
  bookmarksList,
  webviewDevtools,
  chromeFocus,
  isStartUrl,
  launchIntent,
  onAgentStatus,
  onClustersUpdated,
  onExtOpenTab,
  onFindResult,
  onShortcut,
  onOpenUrl,
  onTabLoaded,
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
  type AgentAction,
  type AgentStatus,
  type MemInfo,
  type Rect,
  type ResizeDir,
  type TabGroup,
  type TabMeta,
  type Workspace,
} from "./ipc";
import TerminalView from "./TerminalView";
import StartPage from "./StartPage";
import { keyToAction } from "./shortcuts";
import FindBar from "./FindBar";
import Passwords from "./Passwords";
import Downloads from "./Downloads";
import Shields from "./Shields";
import type { PaletteAction } from "./CommandPalette";
// Lazy-loaded: not shown on a fresh window, so they stay out of the boot bundle
// and load on first use (instant — assets are local/embedded). #startup
const CommandPalette = lazy(() => import("./CommandPalette"));
const Extensions = lazy(() => import("./Extensions"));
const FilesView = lazy(() => import("./FilesView"));
const OmniDashboard = lazy(() => import("./OmniDashboard"));
const VaultPage = lazy(() => import("./VaultPage"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const BookmarksPage = lazy(() => import("./BookmarksPage"));
const SessionsPage = lazy(() => import("./SessionsPage"));
const ResourcesPage = lazy(() => import("./ResourcesPage"));
const TasksPage = lazy(() => import("./TasksPage"));
const SpeedtestPage = lazy(() => import("./SpeedtestPage"));
const PermissionsPage = lazy(() => import("./PermissionsPage"));
import {
  activeId,
  activeTab,
  activeWorkspace,
  aiAnswersOn,
  applyDarkMode,
  applyNav,
  applyAgentModel,
  agentModelName,
  setAgentModel,
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
  panelWidth,
  setPanelWidth,
  panelDragging,
  setPanelDragging,
  pinPanel,
  unpinPanel,
  togglePanel,
  closePanel,
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
  pendingAsk,
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
  setSearchSuggestOn,
  omniAutoAnswer,
  setOmniAutoAnswer,
  setTabLoading,
  sendTabToWorkspace,
  sendGroupToWorkspace,
  tabs,
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
  const openedWebviews = new Set<number>();
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
  // Web panel (#48) geometry: when a panel is open it occupies a right strip of
  // the card (`panelViewRect`, below a DOM toolbar), and the tabs tile in the
  // remaining `mainRect` to its left.
  const PANEL_GAP = 8;
  const PANEL_TOOLBAR = 34; // DOM toolbar height atop the panel
  const panelPx = (cardW: number) => Math.round(Math.max(280, Math.min(640, Math.min(cardW * 0.6, panelWidth()))));
  const mainRect = (): Rect | null => {
    const r = readRect();
    if (!r) return null;
    if (activePanelId() == null) return r;
    const pw = panelPx(r.width);
    return { x: r.x, y: r.y, width: Math.max(120, r.width - pw - PANEL_GAP), height: r.height };
  };
  const panelViewRect = (): Rect | null => {
    const r = readRect();
    if (!r || activePanelId() == null) return null;
    const pw = panelPx(r.width);
    return { x: r.x + r.width - pw, y: r.y + PANEL_TOOLBAR, width: pw, height: Math.max(0, r.height - PANEL_TOOLBAR) };
  };
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
      if (splitDragging()) return; // panes are hidden mid-drag
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
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
    const unShortcut = await onShortcut((a) => dispatch(a));
    // Page-initiated new windows (window.open / target="_blank" / modified
    // click) → open as a Flux tab; background tabs don't steal focus.
    const unOpenUrl = await onOpenUrl((url, background) => {
      void openTab("browser", url, false, background).catch(() => {});
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
      openedWebviews.delete(id);
      setHibernated(id, true);
      wv(webviewHibernate(id));
    };
    // Background = live browser tabs that aren't currently tiled in the card.
    // (In split view both panes are visible, so neither is hibernatable.)
    const liveBackground = (_act: number | null) => {
      const visible = new Set(paneLayout().map((p) => p.tab.id));
      return tabs().filter((t) => t.kind === "browser" && !visible.has(t.id) && !isStartUrl(t.url) && openedWebviews.has(t.id));
    };
    const hibTimer = window.setInterval(async () => {
      const now = Date.now();
      const act = activeId();
      if (act != null) lastActive.set(act, now);
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
    onCleanup(() => {
      unClusters();
      unExtOpen();
      unShortcut();
      unOpenUrl();
      unFind();
      unLoaded();
    });

    // Track the content-card rect: ResizeObserver catches every layout change
    // (window resize, sidebar collapse, panel toggles, pane resize) in one place.
    const el = document.getElementById("flux-web-area");
    if (el) {
      const measure = () => setContentRect(readRect());
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener("resize", measure);
      measure();
      onCleanup(() => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
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
    splitRatio(); // subscribe: re-tile when the seam moves
    panelWidth(); // subscribe: re-tile when the panel divider moves
    const dragging = splitDragging() || panelDragging();
    const panes = paneLayout();
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
    if (dragging) return; // panes re-show when the drag ends
    let needRelayout = false;
    for (const p of panes) {
      const id = p.tab.id;
      if (openedWebviews.has(id)) {
        if (!shown.has(id)) {
          wv(webviewShow(id)); // only on transition into view
          shown.add(id);
        }
        needRelayout = true; // throttled bounds for resize/seam follow
      } else {
        openedWebviews.add(id);
        shown.add(id);
        setHibernated(id, false); // (re)opening = waking from sleep (#45)
        lastActive.set(id, Date.now());
        const r = p.rect;
        webviewOpen(id, p.tab.url, r)
          .then(() => webviewSetBounds(id, r))
          .catch((e) => console.error("[flux webview] open failed:", e));
      }
    }
    if (needRelayout) scheduleRelayout();
  });

  // Web panel (#48): manage the single open panel's webview — positioned in the
  // right strip, persistent across tab switches (it's not part of the tab
  // lifecycle). Switching panels closes the old one; hidden mid-divider-drag.
  let openedPanel: number | null = null;
  createEffect(() => {
    contentRect();
    panelWidth(); // subscribe: re-position on resize / divider drag
    const p = activePanel();
    const dragging = panelDragging();
    if (openedPanel != null && openedPanel !== (p?.id ?? null)) {
      wv(panelClose(openedPanel));
      openedPanel = null;
    }
    if (!p) return;
    if (dragging || readerOpen()) {
      wv(panelHide(p.id)); // reader covers the card
      return;
    }
    const rect = panelViewRect();
    if (!rect) return;
    if (openedPanel === p.id) {
      wv(panelSetBounds(p.id, rect));
      wv(panelShow(p.id));
    } else {
      openedPanel = p.id;
      wv(panelOpen(p.id, p.url, rect).then(() => panelSetBounds(p.id, rect)));
    }
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
    if (existing != null) {
      void bookmarkRemove(existing).then(() => { setBookmarkedId(null); flash("Bookmark removed"); }).catch(() => {});
    } else {
      void bookmarkAdd(t.title || url, url).then((b) => { setBookmarkedId(b?.id ?? null); flash("★ Bookmarked"); }).catch(() => {});
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
      if (t.kind === "browser" && !visible.has(t.id) && !isStartUrl(t.url) && openedWebviews.has(t.id)) {
        openedWebviews.delete(t.id);
        shown.delete(t.id);
        setHibernated(t.id, true);
        wv(webviewHibernate(t.id));
        n++;
      }
    }
    setOmniToast(n ? `💤 Slept ${n} background tab${n === 1 ? "" : "s"}` : "No background tabs to sleep");
    window.setTimeout(() => setOmniToast(null), 2600);
  };

  // Web capture (#54): screenshot the visible page (async; toast on completion).
  const capturePage = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void webviewCapture(t.id).catch((e) => { setOmniToast(`Capture: ${String(e)}`); window.setTimeout(() => setOmniToast(null), 3000); });
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
      if (t.workspace !== id && openedWebviews.has(t.id)) {
        openedWebviews.delete(t.id);
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
      openedWebviews.delete(tid);
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
      if (openedWebviews.has(id)) {
        openedWebviews.delete(id);
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
    if (t?.kind === "browser" && openedWebviews.has(t.id) && !isStartUrl(t.url)) wv(webviewShow(t.id));
  };
  // Actions offered by the palette (tab-switching + history are built in).
  const paletteActions = (): PaletteAction[] => [
    { id: "new-tab", label: "New browser tab", icon: "🌐", run: () => void openTab("browser") },
    { id: "new-private", label: "New private tab", icon: "🕶", run: () => void openTab("browser", undefined, true) },
    { id: "new-term", label: "New terminal tab", icon: "⌨", run: () => void openTab("terminal").then(() => setTerminalOpen(true)) },
    { id: "new-files", label: "New files tab", icon: "📁", run: () => void openTab("files") },
    { id: "history", label: "Open History", icon: "🕘", run: () => go(HISTORY_URL) },
    { id: "bookmarks", label: "Open Bookmarks", icon: "🔖", run: () => go(BOOKMARKS_URL) },
    { id: "sessions", label: "Open Sessions", icon: "🗃", run: () => go(SESSIONS_URL) },
    { id: "passwords", label: "Open Passwords", icon: "🔑", run: () => go(VAULT_URL) },
    { id: "omni", label: "Open Omni index", icon: "✦", run: () => go(OMNI_URL) },
    { id: "find", label: "Find in page", icon: "🔎", run: () => openFind() },
    { id: "reader", label: "Reader mode", icon: "📖", run: () => toggleReader() },
    { id: "focus", label: "Focus mode (hide chrome)", icon: "⤢", run: () => dispatch("focus-mode") },
    { id: "capture", label: "Capture page (screenshot)", icon: "📸", run: () => capturePage() },
    { id: "resources", label: "Open Resource monitor", icon: "📊", run: () => go(RESOURCES_URL) },
    { id: "tasks", label: "Open Task manager", icon: "🗂️", run: () => go(TASKS_URL) },
    { id: "speedtest", label: "Network speed test", icon: "⚡", run: () => go(SPEEDTEST_URL) },
    { id: "permissions", label: "Site permissions", icon: "🔐", run: () => go(PERMISSIONS_URL) },
    { id: "sleep-bg", label: "Sleep background tabs", icon: "💤", run: () => sleepBackgroundTabs() },
    { id: "zoom-in", label: "Zoom in", icon: "➕", run: () => dispatch("zoom-in") },
    { id: "zoom-out", label: "Zoom out", icon: "➖", run: () => dispatch("zoom-out") },
    { id: "zoom-reset", label: "Reset zoom", icon: "🔍", run: () => dispatch("zoom-reset") },
    { id: "reload", label: "Reload page", icon: "⟳", run: () => navActive(webviewReload) },
    { id: "tog-term", label: "Toggle terminal", icon: "⌨", run: () => setTerminalOpen((v) => !v) },
    { id: "tog-agent", label: "Toggle agent", icon: "✦", run: () => setAgentOpen((v) => !v) },
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

  // The vertical terminal column only shows for browser tabs — a terminal
  // *tab* already fills the content card with a shell.
  const termColVisible = () => terminalOpen() && !focusMode() && activeTab()?.kind !== "terminal";

  const columns = () =>
    focusMode()
      ? "0px 1fr 0px 0px" // focus/compact mode (#55): content only
      : [
          sidebarOpen() ? `${sidebarW()}px` : "var(--flux-sidebar-w-min)",
          "1fr",
          termColVisible() ? `${terminalW()}px` : "0px",
          agentOpen() ? `${agentW()}px` : "0px",
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
        "grid-template-areas": `"title title title title" "side content term agent"`,
      }}
    >
      <TitleBar />
      <Sidebar
        collapsed={!sidebarOpen()}
        terminalOpen={terminalOpen()}
        agentOpen={agentOpen()}
        onNavigate={go}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onToggleAgent={() => setAgentOpen((v) => !v)}
        onSaveToOmni={saveToOmni}
        onAiSearch={(q) => { if (aiAnswersOn()) { setAgentOpen(true); setPendingAsk(q); } }}
        onSwitchWorkspace={switchWorkspace}
        onNewWorkspace={newWorkspace}
        onDeleteWorkspace={removeWorkspace}
        onSendTabToWorkspace={sendTabToWs}
        onSendGroupToWorkspace={sendGroupToWs}
        onZoomReset={() => zoom("reset")}
        onToggleReader={toggleReader}
        onCapture={capturePage}
        onToggleBookmark={toggleBookmark}
        isBookmarked={() => bookmarkedId() != null}
      />
      <ContentArea
        onNavigate={go}
        onNewTerminal={() => void openTab("terminal")}
        onToggleAgent={() => setAgentOpen(true)}
        onSleepBackground={sleepBackgroundTabs}
      />
      <Show when={termColVisible()}>
        <TerminalColumn />
      </Show>
      <Show when={agentOpen() && !focusMode()}>
        <AgentPanel />
      </Show>

      {/* Pane splitters — drag to resize (BACKLOG #27). */}
      <Show when={sidebarOpen()}>
        <div
          class="pane-splitter"
          style={{ left: `${sidebarW()}px` }}
          onPointerDown={(e) => startPaneResize(e, sidebarW, setSidebarW, 1, "flux.w.sidebar", 180, 460)}
        />
      </Show>
      <Show when={termColVisible()}>
        <div
          class="pane-splitter"
          style={{ right: `${(agentOpen() ? agentW() : 0) + terminalW()}px` }}
          onPointerDown={(e) => startPaneResize(e, terminalW, setTerminalW, -1, "flux.w.terminal", 280, 820)}
        />
      </Show>
      <Show when={agentOpen()}>
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
    </div>
  );
};

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
  onAiSearch: (query: string) => void;
  onSwitchWorkspace: (id: number) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (id: number) => void;
  onSendTabToWorkspace: (tabId: number, ws: number) => void;
  onSendGroupToWorkspace: (groupId: number, ws: number) => void;
  onZoomReset: () => void;
  onToggleReader: () => void;
  onCapture: () => void;
  onToggleBookmark: () => void;
  isBookmarked: () => boolean;
}

type FooterPanel = "bookmarks" | "extensions" | "settings" | "webpanels" | "notes" | null;
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
      <span class="title">{p.tab.title || p.tab.url}</span>
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
  const closeSuggest = () => { setSuggestions([]); setSelIdx(-1); };
  const clearOmniAns = () => { omniGen++; setOmniAns(null); };

  // Show the "Ask Omni" affordance for a real query (not a URL / flux:// page).
  const canAsk = () => {
    const q = address().trim();
    return q.length > 2 && !q.startsWith("flux://") && !/^[a-z]+:\/\//i.test(q);
  };

  const startOmniAnswer = (q: string) => {
    const query = q.trim();
    if (!query) return;
    const gen = ++omniGen;
    setOmniAns({ text: "", sources: [], streaming: true });
    void omniAnswer(query, (e) => {
      if (gen !== omniGen) return; // a newer ask superseded this stream
      if (e.type === "sources") setOmniAns((a) => (a ? { ...a, sources: e.sources } : a));
      else if (e.type === "token") setOmniAns((a) => (a ? { ...a, text: a.text + e.text } : a));
      else if (e.type === "done") setOmniAns((a) => (a ? { ...a, streaming: false } : a));
    }).catch(() => {
      if (gen === omniGen) setOmniAns((a) => (a ? { ...a, streaming: false } : a));
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
            <button class="group-topic" title="Group tabs by topic (from semantic clusters)" onClick={() => void groupByTopic()}>⊞ Group</button>
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
        <Passwords />
        <Downloads />
        <button classList={{ "icon-btn": true, active: panel() === "bookmarks" }} title="Bookmarks" onClick={() => openPanel("bookmarks")}>🔖</button>
        <button classList={{ "icon-btn": true, active: panel() === "notes" }} title="Note for this page" onClick={() => { openPanel("notes"); loadNote(); }}>📝</button>
        <button classList={{ "icon-btn": true, active: panel() === "webpanels" || activePanelId() != null }} title="Web panels — pin a site beside your tabs" onClick={() => openPanel("webpanels")}>◨</button>
        <button classList={{ "icon-btn": true, active: panel() === "extensions" }} title="Extensions" onClick={() => openPanel("extensions")}>🧩</button>
        <button classList={{ "icon-btn": true, active: panel() === "settings" }} title="Settings" onClick={() => openPanel("settings")}>⚙</button>

        <Show when={panel()}>
          <div class="glass popover footer-pop">
            <Show when={panel() === "settings"}>
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
                    <div class="panel-row" classList={{ active: activePanelId() === p.id }}>
                      <button class="panel-row-open" onClick={() => { togglePanel(p.id); setPanel(null); }}>
                        <span class="panel-row-title">{p.title || p.url}</span>
                      </button>
                      <button class="panel-row-x" title="Unpin" onClick={(e) => { e.stopPropagation(); void unpinPanel(p.id); }}>✕</button>
                    </div>
                  )}
                </For>
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
      {/* Web panel (#48): a DOM toolbar in the top strip of the panel region (the
          webview sits below it) + a divider to resize. Both are right-anchored so
          they don't need the card width. */}
      <Show when={activePanel()}>
        {(p) => {
          const pw = () => Math.max(280, Math.min(640, panelWidth()));
          return (
            <>
              <div class="panel-toolbar" style={{ width: `${pw()}px` }}>
                <span class="panel-title" title={p().url}>{p().title || p().url}</span>
                <button class="panel-btn" title="Reload panel" onClick={() => void panelNavigate(p().id, p().url)}>⟳</button>
                <button class="panel-btn" title="Close panel" onClick={() => closePanel()}>✕</button>
              </div>
              <div
                class="pane-splitter panel-divider"
                style={{ right: `${pw()}px` }}
                title="Drag to resize the panel"
                onPointerDown={(e) => {
                  e.preventDefault();
                  const card = document.getElementById("flux-web-area");
                  if (!card) return;
                  const rect = card.getBoundingClientRect();
                  setPanelDragging(true);
                  const move = (ev: PointerEvent) => setPanelWidth(rect.right - ev.clientX);
                  const up = () => {
                    setPanelDragging(false);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
              />
            </>
          );
        }}
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
              />
            )}
          </Show>
        </Match>
        {/* Before the generic start match — `flux://omni` is also a `flux://` url. */}
        <Match when={activeTab()?.url === OMNI_URL}>
          <OmniDashboard onNavigate={props.onNavigate} />
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
  </main>
  );
};

// ─── Vertical terminal column ───────────────────────────────────────────────

/** Right-side vertical terminal (ADR 0002 / 0003): a persistent PTY session
 *  (PANE_SESSION) rendered with xterm.js, alongside whatever you're browsing.
 *  This is the always-available dev terminal. */
const TerminalColumn: Component = () => (
  <section class="terminal-col">
    <div class="terminal-surface">
      <TerminalView session={PANE_SESSION} />
    </div>
  </section>
);

// ─── Flux Agent panel ───────────────────────────────────────────────────────

/** The "Liquid AI" surface. Status drives the visual state machine: idle →
 *  violet dot, thinking → kinetic gradient border, acting → magenta line. */
type FeedItem = { role: "user" | "assistant" | "action" | "error" | "plan"; text: string; action?: AgentAction; pending?: boolean };

const AgentPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus>({ state: "idle" });
  const [prompt, setPrompt] = createSignal("");
  const [feed, setFeed] = createSignal<FeedItem[]>([]);
  const [busy, setBusy] = createSignal(false);
  // Chat-with-page/tabs (#34): "page" grounds in the active tab; "tabs" grounds
  // in every open browser tab in the active workspace.
  const [scope, setScope] = createSignal<"page" | "tabs">("page");
  // Model picker (#81): the dropdown of locally-pulled Ollama models.
  const [models, setModels] = createSignal<string[]>([]);
  const [modelMenu, setModelMenu] = createSignal(false);
  const toggleModelMenu = () => {
    const open = !modelMenu();
    setModelMenu(open);
    if (open) void agentModels().then(setModels).catch(() => setModels([]));
  };
  const shortModel = () => {
    const m = agentModelName();
    return m ? m.split(":")[0]! : "gemma";
  };
  let feedEl: HTMLDivElement | undefined;

  const browserTabIds = () =>
    tabs().filter((t) => t.kind === "browser" && t.workspace === activeWorkspace() && !isStartUrl(t.url)).map((t) => t.id);

  onMount(async () => {
    const unlisten = await onAgentStatus(setStatus);
    onCleanup(unlisten);
  });

  // Auto-scroll the feed to the latest message.
  createEffect(() => {
    feed();
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });

  const working = () => busy() || status().state === "thinking";

  // A quick AI answer for a search query, drafted by the local model (#ai).
  // Fed in via `pendingAsk` when the user runs a search with AI answers on.
  const answerSearch = async (query: string) => {
    if (working()) return;
    setFeed((f) => [...f, { role: "user", text: query }]);
    setBusy(true);
    try {
      const reply = await agentChat(`Give a concise, direct answer to this search query: "${query}"`);
      setFeed((f) => [...f, { role: "assistant", text: reply.trim() }]);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  // Consume a queued search query (set by the omnibox) exactly once.
  createEffect(() => {
    const q = pendingAsk();
    if (q) {
      setPendingAsk(null);
      void answerSearch(q);
    }
  });

  const send = async (p: string) => {
    if (!p || working()) return;
    setPrompt("");
    setFeed((f) => [...f, { role: "user", text: p }]);
    setBusy(true);
    try {
      // "/act <…>" (or /do) drives a page action; everything else is chat,
      // grounded in the active page or all open tabs per the scope toggle.
      const act = p.match(/^\/(?:act|do)\s+([\s\S]+)/i);
      if (act?.[1]) {
        // Plan first, then PREVIEW — nothing touches the page until you approve (#8).
        const action = await agentPlan(act[1].trim());
        if (action.action === "refuse") {
          setFeed((f) => [...f, { role: "assistant", text: describeAction(action) }]);
        } else {
          setFeed((f) => [...f, { role: "plan", text: describeAction(action), action, pending: true }]);
        }
      } else {
        const reply = scope() === "tabs" ? await agentChatTabs(p, browserTabIds()) : await agentChat(p);
        setFeed((f) => [...f, { role: "assistant", text: reply.trim() }]);
      }
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const run = (e: SubmitEvent) => { e.preventDefault(); void send(prompt().trim()); };

  // Approve a previewed action → execute it on the page (#8).
  const approve = async (idx: number, action: AgentAction) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false } : it)));
    setBusy(true);
    try {
      await agentRunAction(action);
      setFeed((f) => [...f, { role: "action", text: `✓ ${describeAction(action)}` }]);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const cancelPlan = (idx: number) =>
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false, text: `Skipped: ${it.text}` } : it)));

  return (
    <aside class="agent">
      <div class="agent-inner">
        <header style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span
            classList={{ "ai-thinking": working() }}
            style={{
              width: "10px",
              height: "10px",
              "border-radius": "50%",
              background: working() ? undefined : "var(--flux-violet)",
            }}
          />
          <strong>Flux Agent</strong>
          <div class="agent-model">
            <button class="agent-model-btn" title="Pick the local model (Ollama)" onClick={toggleModelMenu}>
              {shortModel()} · local ▾
            </button>
            <Show when={modelMenu()}>
              <div class="agent-model-menu glass">
                <Show when={models().length > 0} fallback={<div class="agent-model-empty">No Ollama models found (is it running?)</div>}>
                  <For each={models()}>
                    {(m) => (
                      <button classList={{ "agent-model-item": true, on: agentModelName() === m }} onClick={() => { setAgentModel(m); setModelMenu(false); }}>
                        {m}
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        </header>

        <div class="agent-feed" ref={feedEl}>
          <Show
            when={feed().length > 0}
            fallback={
              <div class="agent-empty">
                Chat with your local Gemma — ask anything. Use <kbd>/act</kbd> to control
                the page (e.g. <em>/act click the login button</em>) — you'll preview and
                approve each action before it runs.
              </div>
            }
          >
            <For each={feed()}>
              {(item, i) => (
                <div classList={{ "agent-msg": true, [`agent-${item.role}`]: true }}>
                  <div>{item.text}</div>
                  <Show when={item.role === "plan" && item.pending && item.action}>
                    <div class="agent-approve">
                      <button class="agent-approve-yes" onClick={() => void approve(i(), item.action!)}>✓ Approve</button>
                      <button class="agent-approve-no" onClick={() => cancelPlan(i())}>Skip</button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={status().state === "acting"}>
            <div class="agent-msg agent-action">
              ✦ {(status() as Extract<AgentStatus, { state: "acting" }>).description}
            </div>
          </Show>
        </div>

        {/* Chat-with-page/tabs (#34): scope toggle + one-tap prompts grounded in
            the captured DOM (the agent already receives the page/tab text). */}
        <div class="agent-context">
          <button classList={{ "agent-scope": true, on: scope() === "page" }} title="Answer using the current page" onClick={() => setScope("page")}>📄 This page</button>
          <button classList={{ "agent-scope": true, on: scope() === "tabs" }} title="Answer across all open tabs in this space" onClick={() => setScope("tabs")}>🗂 All tabs <Show when={scope() === "tabs"}><span class="agent-scope-n">{browserTabIds().length}</span></Show></button>
        </div>
        <div class="agent-chips">
          <button class="agent-chip" disabled={working()} onClick={() => void send("Summarize this in a few clear bullet points.")}>Summarize</button>
          <button class="agent-chip" disabled={working()} onClick={() => void send("What are the key points and any action items?")}>Key points</button>
          <button class="agent-chip" disabled={working()} onClick={() => void send("Explain this like I'm new to the topic.")}>Explain</button>
        </div>
        <form onSubmit={run} classList={{ "ai-thinking-border": working() }}>
          <input
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            placeholder={working() ? "thinking…" : scope() === "tabs" ? "Ask across your open tabs · /act for the page" : "Ask about this page · /act to control it"}
            disabled={working()}
            style={{ width: "100%", padding: "10px 12px", border: working() ? "none" : undefined }}
          />
        </form>
      </div>
    </aside>
  );
};

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

function describeAction(a: AgentAction): string {
  switch (a.action) {
    case "click":
      return `✓ clicked ${a.selector} (${a.reason})`;
    case "extract_table":
      return `✓ extracted ${a.selector} → ${a.format}`;
    case "type":
      return `✓ typed into ${a.selector}`;
    case "reveal":
      return `✓ revealed ${a.selector}`;
    case "refuse":
      return `— ${a.reason}`;
  }
}

export default App;
