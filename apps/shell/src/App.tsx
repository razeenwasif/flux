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
import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  NOTEBOOK_URL,
  TRAIL_URL,
  WHITEBOARD_URL,
  OMNI_URL,
  VAULT_URL,
  HISTORY_URL,
  BOOKMARKS_URL,
  SESSIONS_URL,
  RESOURCES_URL,
  TASKS_URL,
  SPEEDTEST_URL,
  PERMISSIONS_URL,
  isPdfUrl,
  pdfViewerUrl,
  ARCHIVE_URL,
  archiveSave,
  FEEDS_URL,
  SYNC_URL,
  APPS_URL,
  SETTINGS_URL,
  pwaInstall,
  agentTranslate,
  bookmarkAdd,
  bookmarkRemove,
  bookmarksList,
  webviewDevtools,
  chromeFocus,
  isStartUrl,
  launchIntent,
  onClustersUpdated,
  onExtOpenTab,
  onPermissionAsk,
  onVaultSaved,
  onVaultSavePrompt,
  onFindResult,
  onFullscreenChanged,
  onShortcut,
  onOpenUrl,
  onTabLoaded,
  onPanelBadge,
  searchSetDefault,
  tabSetUrl,
  webviewBack,
  webviewForward,
  memStatus,
  hibernateRank,
  prefetchRecord,
  prefetchHints,
  sentinelCheckUrl,
  sentinelVerifyUrl,
  sentinelCheckOauth,
  sentinelCheckSensitive,
  sentinelConsentCheck,
  prefetchSetPressure,
  webviewPreconnect,
  webviewCaptureState,
  webviewHibernate,
  webviewHide,
  webviewNavigate,
  webviewReload,
  webviewZoom,
  webviewExtractReader,
  onReader,
  webviewCapture,
  onScreenshot,
  omniIngestActive,
  webviewShow,
  webviewStop,
  webviewFind,
  workspaceActive,
  workspaceDelete,
  workspaceSwitch,
} from "./ipc";
import { setTerminalOpener } from "./terminals";
import Sidebar from "./Sidebar";
import ContentArea from "./ContentArea";
import { installDwellCapture } from "./trail";
import { keyToAction } from "./shortcuts";
// Cold chrome (ADR 0001 budget): overlays/panes that render only behind a
// store-gated <Show>, so their code loads on first open — not at boot.
const MobileChrome = lazy(() => import("./MobileChrome")); // Android-only chrome (ADR 0012); kept out of the desktop bundle
const MobileMenu = lazy(() => import("./MobileMenu")); // mobile drawer (replaces the desktop sidebar on the phone)
const ShellHistory = lazy(() => import("./ShellHistory"));
const SemanticFind = lazy(() => import("./SemanticFind"));
const WatchPanel = lazy(() => import("./WatchPanel"));
const TrackerGraph = lazy(() => import("./TrackerGraph"));
const AppPane = lazy(() => import("./AppPane"));
import AppDock from "./AppDock";
import { FLUX_APPS } from "./apps";
import type { PaletteAction } from "./CommandPalette";
import { LinkMenu } from "./linkMenu";
// Lazy-loaded: not shown on a fresh window, so they stay out of the boot bundle
// and load on first use (instant — assets are local/embedded). #startup
const CommandPalette = lazy(() => import("./CommandPalette"));
const FilesView = lazy(() => import("./FilesView"));
const Playground = lazy(() => import("./playground/Playground"));
const NotebookPage = lazy(() => import("./NotebookPage"));
const ConnectionsRail = lazy(() => import("./ConnectionsRail"));
const MusicBubble = lazy(() => import("./MusicBubble"));
const AgentPanel = lazy(() => import("./AgentPanel"));
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
  playgroundOpen,
  setPlaygroundOpen,
  mapPanelOpen,
  kbPanelOpen,
  setKbPanelOpen,
  shellHistOpen,
  setCalendarPopOpen,
  openMessagingPanel,
  setShellHistOpen,
  setSplitPickerOpen,
  semFindOpen,
  setSemFindOpen,
  watchPanelOpen,
  setWatchPanelOpen,
  trackerGraphOpen,
  setTrackerGraphOpen,
  openAppIds,
  setMapPanelOpen,
  mapQuery,
  setMapQuery,
  closeTab,
  reopenClosedTab,
  createWorkspace,
  activePanel,
  activePanelB,
  panelWidth,
  panelDragging,
  pageOverlayActive,
  pushPermAsk,
  setSavePrompt,
} from "./store";
import { createWebviewTiling } from "./tiling";
import { startClockDriver } from "./clocks";
import { addPluginListener } from "@tauri-apps/api/core";
import { TitleBar, ResizeHandles } from "./Chrome";
import { isMobile } from "./platform";
import WebPanelPane from "./WebPanelPane";
import TerminalColumn from "./TerminalColumn";
import {
  setPanelBadge,
  findOpen,
  focusTab,
  hibernateEnabled,
  hibernateMins,
  isLoading,
  memEvict,
  openTab,
  refreshTabs,
  setActiveWorkspace,
  zoomFor,
  nudgeZoom,
  readerOpen,
  readerTab,
  openReader,
  closeReader,
  clearSplit,
  activeSplit,
  restoreSplits,
  splitDragging,
  workspaces,
  setFindMatches,
  setFindOpen,
  setHibernated,
  setPendingAsk,
  setPendingLens,
  setTabLoading,
  sendTabToWorkspace,
  sendGroupToWorkspace,
  tabs,
  touchTabUrl,
  seedTabAccess,
  unpinnedTabs,
  updateTabUrl,
  updateTabTitle,
  setPhish,
  setOAuth,
  setSensitive,
  setConsent,
} from "./store";

const App: Component = () => {
  // Narrow screen (phone / Termux-X11 portrait — ADR 0012 rung B): the desktop
  // chrome assumes width, so the side surfaces start collapsed and the user
  // opens what they need. One-shot at boot; rotating mid-session keeps state.
  // Mobile always boots with side surfaces collapsed (the drawer closed) — the
  // Android WebView can report a wide innerWidth before layout, so key off isMobile.
  const narrow = isMobile || window.innerWidth < 760;
  const [sidebarOpen, setSidebarOpen] = createSignal(!narrow);
  // Mobile Chrome-style tab switcher (ADR 0012).
  const [mobileTabsOpen, setMobileTabsOpen] = createSignal(false);
  // Terminal column open by default (persisted — toggling off sticks).
  const [terminalOpen, setTerminalOpen] = createSignal(
    !narrow && localStorage.getItem("flux.term.open") !== "0",
  );
  // Persist only on real toggles — the initial run would otherwise write the
  // narrow-screen collapse back and poison the desktop default.
  let termPersist = false;
  createEffect(() => {
    const v = terminalOpen();
    if (termPersist) localStorage.setItem("flux.term.open", v ? "1" : "0");
    termPersist = true;
  });
  // Let the agent bring up a terminal before running a command in it (#65).
  setTerminalOpener(() => setTerminalOpen(true));
  // The Trail (ADR 0011 step 1): snapshot + embed a page once it's been engaged
  // past the dwell threshold. Owned by this component's lifetime.
  installDwellCapture();
  const [agentOpen, setAgentOpen] = createSignal(!narrow);
  // Ambient connections rail (#123) — on by default; toggled via the palette.
  const [connectOpen, setConnectOpen] = createSignal(
    !narrow && localStorage.getItem("flux.connect.open") !== "0",
  );
  let connPersist = false;
  createEffect(() => {
    const v = connectOpen();
    if (connPersist) localStorage.setItem("flux.connect.open", v ? "1" : "0");
    connPersist = true;
  });
  // Floating music bubble (#125) — on by default; toggled via the palette.
  const [musicOpen, setMusicOpen] = createSignal(localStorage.getItem("flux.music.open") !== "0");
  createEffect(() => localStorage.setItem("flux.music.open", musicOpen() ? "1" : "0"));
  // Focus/compact mode (#55): hide all chrome, content only. Esc or Ctrl+Shift+F exits.
  const [focusMode, setFocusMode] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  // Overlay registry (store.ts pageOverlayActive) + the one App-local overlay
  // flag. Every webview show/hide decision reads THESE, never a hand-rolled
  // boolean chain — chains drifted apart and dropped newer flags (the split-view
  // and home-widget hide bugs).
  const overlayActive = () => pageOverlayActive() || paletteOpen();
  const uiDragging = () => splitDragging() || panelDragging();

  // Resizable pane widths (px), persisted across sessions (BACKLOG #27).
  const loadW = (k: string, d: number) => Number(localStorage.getItem(k)) || d;
  const [sidebarW, setSidebarW] = createSignal(loadW("flux.w.sidebar", 252));
  const [terminalW, setTerminalW] = createSignal(loadW("flux.w.terminal", 440));
  const [agentW, setAgentW] = createSignal(loadW("flux.w.agent", 372));
  const [connectW] = createSignal(loadW("flux.w.connect", 212));

  // Window width drives the responsive pane-shedding (#28). Tracked from the window
  // resize event only (not layout changes) so it can't feed back into the columns
  // it sizes. Initialised to the current width.
  const [winW, setWinW] = createSignal(window.innerWidth);
  // #46: track per-URL last-access (keyed by URL so it survives restarts) and seed
  // restored tabs so they aren't treated as stale on the first auto-archive sweep.
  createEffect(() => {
    const t = activeTab();
    if (t?.kind === "browser") touchTabUrl(t.url);
  });
  createEffect(() => {
    seedTabAccess(
      tabs()
        .filter((t) => t.kind === "browser")
        .map((t) => t.url),
    );
  });
  // Webview tiling (rect math, measurement, show/hide reconciliation, panel
  // slots) lives in tiling.ts — App supplies its local overlay/drag/focus
  // accessors and keeps the returned liveness bookkeeping for hibernation,
  // navigation and workspace switches.
  const {
    openedWebviews,
    openingWebviews,
    lastActive,
    wv,
    forgetWebview,
    scheduleRelayout,
    forceRelayout,
    paneLayout,
  } = createWebviewTiling({ overlayActive, uiDragging, focusMode });
  // Last finished URL per tab — the "from" of the next navigation, for training
  // the predictive-prefetch Markov model (#103).
  const prevUrlByTab = new Map<number, string>();

  // Materialize CLI launch intent exactly once (`flux <url> -t`).
  onMount(async () => {
    startClockDriver(); // #134: timers/alarms fire regardless of the active tab
    await refreshTabs();
    restoreSplits(); // #43: re-tile any split pairs saved from the last session
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
    // A page hit a permission Ask (#38) — queue it for the permission bar,
    // which answers the deferred engine request.
    const unPermAsk = await onPermissionAsk(pushPermAsk);
    // The password sentinel saved a sign-up credential (#61) — confirm it.
    const unVaultSaved = await onVaultSaved((host) => {
      setOmniToast(`🔑 Password for ${host} saved to your vault`);
      window.setTimeout(() => setOmniToast(null), 2800);
    });
    // Sentinel captured a manually-typed login (#61) — raise the save bar.
    const unSavePrompt = await onVaultSavePrompt(setSavePrompt);
    // App keyboard shortcuts (#18). Capture phase so we win over child widgets
    // (e.g. xterm's own key handler) when the chrome/terminal is focused; the
    // injected shortcuts.js handles the case where a page webview has focus and
    // forwards the action over `flux://shortcut`.
    // While the terminal (xterm) is focused, plain Ctrl+letter chords are
    // readline/tmux bindings (Ctrl+R search, Ctrl+W delete-word, Ctrl+L clear,
    // Ctrl+B tmux prefix, …) and must reach the shell. Only claim chords that
    // don't collide — shifted/alt variants, the terminal toggle, and tab nav.
    const terminalSafe = new Set([
      "toggle-terminal",
      "toggle-agent",
      "new-terminal",
      "next-tab",
      "prev-tab",
      "back",
      "forward",
      "shell-history",
    ]);
    const inTerminal = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
    const onKey = (e: KeyboardEvent) => {
      // The command palette (#6) is modal: only Ctrl+K (to toggle it closed) is
      // a chrome shortcut while it's open; everything else goes to its input.
      if (paletteOpen()) {
        if (keyToAction(e) === "palette") {
          e.preventDefault();
          e.stopPropagation();
          dispatch("palette");
        }
        return;
      }
      // Esc closes the find bar (#33), else stops the active page load (#31).
      // Handled outside the chord table so it isn't forwarded from focused pages
      // (they use Esc themselves).
      if (e.key === "Escape" && !inTerminal()) {
        if (playgroundOpen()) return; // Playground owns Esc (game → hub → close)
        if (filesPanelOpen() || mapPanelOpen() || kbPanelOpen()) {
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
    onCleanup(() => {
      window.removeEventListener("resize", onWinResize);
      clearTimeout(busyTimer);
    });
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
      return tabs().filter(
        (t) =>
          t.kind === "browser" &&
          !visible.has(t.id) &&
          !isStartUrl(t.url) &&
          (openedWebviews.has(t.id) || openingWebviews.has(t.id)),
      );
    };
    const hibTimer = window.setInterval(async () => {
      const now = Date.now();
      const act = activeId();
      if (act != null) lastActive.set(act, now);
      // Auto-archive (#46, branch-aware): stale tabs that form a Trail-connected
      // "rabbit hole" archive together as ONE named branch; loners go to the flat
      // list. Runs BEFORE the live-bg bail (stale tabs are usually hibernated).
      // Lazily imported — sweep logic stays out of the boot bundle.
      void import("./staleSweep").then((m) => m.runStaleSweep(now));
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
              : bgNow
                  .sort((a, b) => (lastActive.get(a.id) ?? 0) - (lastActive.get(b.id) ?? 0))
                  .map((t) => t.id);
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
      if (phase === "started") {
        setPhish(tabId, null); // clear stale phishing verdict while navigating
        setOAuth(tabId, null); // …and any prior OAuth consent review
        setSensitive(tabId, null); // …and any containerization offer
        setConsent(tabId, null); // …and any cookie-consent decode
      }
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
          // Sentinel phishing/impersonation check (ADR 0013, Pillar 1). The
          // deterministic layer answers instantly; if it flags the page, wake the
          // local model to read the rendered text and confirm/clear the banner
          // (M3) — only then, so the model never runs on clean pages. Give
          // capture.js a moment to deliver the page text, and drop the result if
          // the tab has since navigated away (stale-banner race).
          void sentinelCheckUrl(url)
            .then((v) => {
              setPhish(tabId, v);
              if (!v) return;
              setTimeout(() => {
                if (tabs().find((t) => t.id === tabId)?.url !== url) return;
                const title = tabs().find((t) => t.id === tabId)?.title ?? "";
                void sentinelVerifyUrl(url, title)
                  .then((refined) => {
                    if (tabs().find((t) => t.id === tabId)?.url === url) setPhish(tabId, refined);
                  })
                  .catch(() => {});
              }, 1500);
            })
            .catch(() => {});
          // OAuth consent review (M3): genuine provider, but decode the scopes an
          // app is requesting — surfaced only when something sensitive is asked.
          void sentinelCheckOauth(url)
            .then((c) => setOAuth(tabId, c))
            .catch(() => {});
          // Containerization offer (M4): bank/health/gov sessions are worth an
          // isolated cookie jar. Deterministic, and rare enough not to nag.
          void sentinelCheckSensitive(url)
            .then((s) => setSensitive(tabId, s, url))
            .catch(() => {});
          // Cookie-consent decoder (M5): needs the captured page text, so it
          // runs on the same deferred pass as the phishing refinement.
          setTimeout(() => {
            if (tabs().find((t) => t.id === tabId)?.url !== url) return;
            void sentinelConsentCheck()
              .then((c) => {
                if (tabs().find((t) => t.id === tabId)?.url === url) setConsent(tabId, c);
              })
              .catch(() => {});
          }, 1500);
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
      unPermAsk();
      unVaultSaved();
      unSavePrompt();
      unShortcut();
      unFullscreen();
      unOpenUrl();
      unFind();
      unLoaded();
      unBadge();
    });
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
    // Mobile's omnibox lives in the top bar, not the sidebar — auto-opening the
    // drawer on the start page (and pulling focus into it) is desktop-only.
    if (!isMobile && t && t.kind === "browser" && isStartUrl(t.url)) {
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
    if (!url) {
      setBookmarkedId(null);
      return;
    }
    void bookmarksList()
      .then((bms) => setBookmarkedId(bms.find((b) => b.url === url)?.id ?? null))
      .catch(() => setBookmarkedId(null));
  });
  const toggleBookmark = () => {
    const t = activeTab();
    const url = bookmarkableUrl();
    if (!t || !url) return;
    const flash = (m: string) => {
      setOmniToast(m);
      window.setTimeout(() => setOmniToast(null), 1800);
    };
    const existing = bookmarkedId();
    const notify = () => window.dispatchEvent(new Event("flux:bookmarks-changed"));
    if (existing != null) {
      void bookmarkRemove(existing)
        .then(() => {
          setBookmarkedId(null);
          flash("Bookmark removed");
          notify();
        })
        .catch(() => {});
    } else {
      void bookmarkAdd(t.title || url, url)
        .then((b) => {
          setBookmarkedId(b?.id ?? null);
          flash("★ Bookmarked");
          notify();
        })
        .catch(() => {});
    }
  };

  // Per-site zoom (#36). Ctrl +/-/0 step the active page's zoom, persisted per host.
  const hostOfUrl = (url: string): string | null => {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || null;
    } catch {
      return null;
    }
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
      if (
        t.kind === "browser" &&
        !visible.has(t.id) &&
        !isStartUrl(t.url) &&
        (openedWebviews.has(t.id) || openingWebviews.has(t.id))
      ) {
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
      openReader(
        t.id,
        `Translated · ${lang}`,
        blocks.length ? blocks : [{ kind: "p", text, level: 0, src: "" }],
      );
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
    } catch {
      return "English";
    }
  })();

  // Web capture (#54): screenshot the visible page (async; toast on completion).
  const capturePage = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void webviewCapture(t.id).catch((e) => {
      setOmniToast(`Capture: ${String(e)}`);
      window.setTimeout(() => setOmniToast(null), 3000);
    });
  };

  // Install-site-as-app (#42): open the active site in its own window + save it.
  const installApp = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    void pwaInstall(t.url, t.title || t.url)
      .then(() => {
        setOmniToast("🧩 Installed as app");
        window.setTimeout(() => setOmniToast(null), 2400);
      })
      .catch((e) => {
        setOmniToast(`Install: ${String(e)}`);
        window.setTimeout(() => setOmniToast(null), 3000);
      });
  };

  // Offline archive / read-later (#69): save the active page's text for offline
  // reading + semantic search.
  const saveToArchive = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    const flash = (m: string) => {
      setOmniToast(m);
      window.setTimeout(() => setOmniToast(null), 2400);
    };
    void archiveSave()
      .then((m) => flash(m ? `📚 Saved “${m.title || "page"}” for offline` : "Nothing to save"))
      .catch((e) => flash(`Archive: ${String(e)}`));
  };

  // Reader mode (#41): inject the extractor (result arrives via onReader → opens
  // the reader view), or close it if already open.
  const toggleReader = () => {
    if (readerOpen()) {
      closeReader();
      return;
    }
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
    const next =
      i < 0 ? (dir === 1 ? list[0] : list[list.length - 1]) : list[(i + dir + list.length) % list.length];
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

  // Card-covering panels (palette, files, map, Notebook, Playground, …) are DOM
  // overlays, but each tab's page is a NATIVE webview layer ABOVE the card — so
  // opening one must hide the active page and closing must re-show it, BUT only
  // if nothing else still covers it. Every panel funnels through these two, so
  // the "is anything else open?" guard lives in exactly ONE place
  // (`pageOverlayActive` already aggregates every overlay). A drifting per-panel
  // guard is what regressed split view + buried the expanded home widgets before.
  const hideActivePage = () => {
    const t = activeTab();
    if (t?.kind === "browser" && openedWebviews.has(t.id)) wv(webviewHide(t.id));
  };
  const showActivePageIfClear = () => {
    const t = activeTab();
    if (
      t?.kind === "browser" &&
      openedWebviews.has(t.id) &&
      !isStartUrl(t.url) &&
      !pageOverlayActive() &&
      !paletteOpen() &&
      // Mobile: the drawer, the full-screen agent, and the tab switcher are HTML
      // overlays the native page would otherwise cover (ADR 0012, Milestone 2).
      !(isMobile && (sidebarOpen() || agentOpen() || mobileTabsOpen()))
    )
      wv(webviewShow(t.id));
  };
  // Mobile: react to the drawer / agent / tab-switcher opening + closing so the
  // native tab WebView (which sits above the shell) doesn't cover them.
  if (isMobile) {
    createEffect(() => {
      if (sidebarOpen() || agentOpen() || mobileTabsOpen()) hideActivePage();
      else showActivePageIfClear();
    });
    onMount(() => {
      // Default the search engine to Google on the phone (one-time; respects a
      // later user change).
      if (!localStorage.getItem("flux.mobileSearchDefaulted")) {
        void searchSetDefault("google").catch(() => {});
        localStorage.setItem("flux.mobileSearchDefaulted", "1");
      }
      // Bridge native WebView events (Kotlin `trigger`): page title/url → the tab
      // (omnibox + switcher), and the Android back gesture → close the topmost
      // overlay (the native side handles WebView back itself; see FluxWebViewPlugin).
      type NavEvent = { id: number; url: string; title: string };
      void addPluginListener<NavEvent>("flux-webview", "nav", (e) => {
        const tab = tabs().find((t) => t.id === e.id);
        if (!tab) return;
        if (e.url && e.url !== tab.url) {
          updateTabUrl(e.id, e.url);
          void tabSetUrl(e.id, e.url, e.title || undefined).catch(() => {});
        }
        if (e.title && e.title !== tab.title) updateTabTitle(e.id, e.title);
      }).catch(() => {});
      void addPluginListener("flux-webview", "back", () => {
        if (mobileTabsOpen()) setMobileTabsOpen(false);
        else if (agentOpen()) setAgentOpen(false);
        else if (sidebarOpen()) setSidebarOpen(false);
      }).catch(() => {});
    });
  }

  // Command palette (#6) — centered modal over the (hidden) page.
  const openPalette = () => {
    hideActivePage();
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    showActivePageIfClear();
  };
  // Files / Maps / Notebook / Playground popouts — same native-layer dance.
  const openFilesPanel = () => {
    hideActivePage();
    setFilesPanelOpen(true);
  };
  const closeFilesPanel = () => {
    setFilesPanelOpen(false);
    showActivePageIfClear();
  };
  const openMapPanel = () => {
    hideActivePage();
    setMapPanelOpen(true);
  };
  const openKbPanel = () => {
    hideActivePage();
    setKbPanelOpen(true);
  };
  const closeKbPanel = () => {
    setKbPanelOpen(false);
    showActivePageIfClear();
  };
  const openPlayground = () => {
    hideActivePage();
    setPlaygroundOpen(true);
  };
  const closePlayground = () => {
    setPlaygroundOpen(false);
    showActivePageIfClear();
  };
  // Promote the pane to a full tab (⤢) — focus an open Notebook tab or open one.
  const openNotebookTab = () => {
    closeKbPanel();
    const existing = tabs().find((t) => t.url === NOTEBOOK_URL);
    if (existing) void focusTab(existing.id);
    else void openTab("browser", NOTEBOOK_URL);
  };
  const closeMapPanel = () => {
    setMapPanelOpen(false);
    showActivePageIfClear();
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMapPanel();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  // Esc closes the Notebook (KB) pane while it's open.
  createEffect(() => {
    if (!kbPanelOpen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeKbPanel();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  // Actions offered by the palette (tab-switching + history are built in).
  const paletteActions = (): PaletteAction[] => [
    { id: "new-tab", label: "New browser tab", icon: "🌐", run: () => void openTab("browser") },
    {
      id: "new-private",
      label: "New private tab",
      icon: "🕶",
      run: () => void openTab("browser", undefined, true),
    },
    {
      id: "new-term",
      label: "New terminal tab",
      icon: "⌨",
      run: () => void openTab("terminal").then(() => setTerminalOpen(true)),
    },
    { id: "new-files", label: "New files tab", icon: "📁", run: () => void openTab("files") },
    { id: "history", label: "Open History", icon: "🕘", run: () => go(HISTORY_URL) },
    { id: "bookmarks", label: "Open Bookmarks", icon: "🔖", run: () => go(BOOKMARKS_URL) },
    {
      id: "bookmark-bar",
      label: bookmarkBarOpen() ? "Hide bookmark bar" : "Show bookmark bar",
      icon: "🔖",
      run: () => setBookmarkBarOpen(!bookmarkBarOpen()),
    },
    {
      id: "pages-bar",
      label: pagesBarOpen() ? "Hide pages bar" : "Show pages bar",
      icon: "🗂️",
      run: () => setPagesBarOpen(!pagesBarOpen()),
    },
    {
      id: "connect-rail",
      label: connectOpen() ? "Hide connections rail" : "Show connections rail",
      icon: "✦",
      run: () => setConnectOpen(!connectOpen()),
    },
    {
      id: "music-bubble",
      label: musicOpen() ? "Hide music bubble" : "Show music bubble",
      icon: "🎵",
      run: () => setMusicOpen(!musicOpen()),
    },
    { id: "sessions", label: "Open Sessions", icon: "🗃", run: () => go(SESSIONS_URL) },
    { id: "passwords", label: "Open Passwords", icon: "🔑", run: () => go(VAULT_URL) },
    { id: "omni", label: "Open Omni index", icon: "✦", run: () => go(OMNI_URL) },
    { id: "notebook", label: "Open Notebook (ask your notes)", icon: "✦", run: () => go(NOTEBOOK_URL) },
    { id: "trail", label: "Open the Trail (your browsing graph)", icon: "🧭", run: () => go(TRAIL_URL) },
    { id: "whiteboard", label: "Open whiteboard", icon: "🎨", run: () => go(WHITEBOARD_URL) },
    {
      id: "calendar",
      label: "Open calendar (today & upcoming)",
      icon: "📅",
      run: () => {
        setSidebarOpen(true);
        setCalendarPopOpen(true);
      },
    },
    { id: "discord", label: "Open Discord panel", icon: "💬", run: () => void openMessagingPanel("discord") },
    { id: "teams", label: "Open Teams panel", icon: "💬", run: () => void openMessagingPanel("teams") },
    { id: "find", label: "Find in page", icon: "🔎", run: () => openFind() },
    {
      id: "semantic-find",
      label: "Semantic find (by meaning · across tabs)",
      icon: "✦",
      run: () => setSemFindOpen(true),
    },
    {
      id: "shell-history",
      label: "Search shell history (by meaning)",
      icon: "⌘",
      run: () => setShellHistOpen(true),
    },
    { id: "watches", label: "Watched pages (change monitor)", icon: "👁", run: () => setWatchPanelOpen(true) },
    {
      id: "tracker-graph",
      label: "Tracker graph (privacy viz)",
      icon: "🕸",
      run: () => setTrackerGraphOpen(true),
    },
    {
      id: "split",
      label: activeSplit() != null ? "Exit split view" : "Split view (tile with another tab)",
      icon: "◫",
      run: () => (activeSplit() != null ? clearSplit() : setSplitPickerOpen(true)),
    },
    { id: "reader", label: "Reader mode", icon: "📖", run: () => toggleReader() },
    { id: "focus", label: "Focus mode (hide chrome)", icon: "⤢", run: () => dispatch("focus-mode") },
    { id: "capture", label: "Capture page (screenshot)", icon: "📸", run: () => capturePage() },
    { id: "resources", label: "Open Resource monitor", icon: "📊", run: () => go(RESOURCES_URL) },
    { id: "tasks", label: "Open Task manager", icon: "🗂️", run: () => go(TASKS_URL) },
    { id: "speedtest", label: "Network speed test", icon: "⚡", run: () => go(SPEEDTEST_URL) },
    { id: "permissions", label: "Site permissions", icon: "🔐", run: () => go(PERMISSIONS_URL) },
    {
      id: "archive-save",
      label: "Save page for offline (read later)",
      icon: "📚",
      run: () => saveToArchive(),
    },
    { id: "archive", label: "Open Archive", icon: "📚", run: () => go(ARCHIVE_URL) },
    { id: "feeds", label: "Open Feeds (RSS reader)", icon: "📰", run: () => go(FEEDS_URL) },
    { id: "sync", label: "Sync (encrypted, across devices)", icon: "🔄", run: () => go(SYNC_URL) },
    {
      id: "translate",
      label: `Translate page → ${myLang}`,
      icon: "🌐",
      run: () => void translatePage(myLang),
    },
    ...["English", "Spanish", "French", "German", "Japanese", "Chinese", "Arabic", "Hindi"]
      .filter((l) => l !== myLang)
      .map((l) => ({
        id: `translate-${l}`,
        label: `Translate page → ${l}`,
        icon: "🌐",
        run: () => void translatePage(l),
      })),
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
    {
      id: "lens",
      label: "Identify page (Lens)",
      icon: "🔍",
      run: () => {
        setAgentOpen(true);
        setPendingLens(true);
      },
    },
    { id: "tog-side", label: "Toggle sidebar", icon: "◧", run: () => setSidebarOpen((v) => !v) },
    {
      id: "close",
      label: "Close current tab",
      icon: "✕",
      run: () => {
        const id = activeId();
        if (id != null) void closeTab(id);
      },
    },
  ];

  // Run an app keyboard action — shared by the chrome's keydown listener and
  // the chords forwarded from a focused tab webview (#18).
  const dispatch = (action: string): boolean => {
    switch (action) {
      case "new-tab":
        void openTab("browser");
        return true;
      case "new-terminal":
        void openTab("terminal").then(() => setTerminalOpen(true));
        return true;
      case "reopen-tab":
        void reopenClosedTab();
        return true;
      case "close-tab": {
        const id = activeId();
        if (id != null) void closeTab(id);
        return true;
      }
      case "next-tab":
        cycleTab(1);
        return true;
      case "prev-tab":
        cycleTab(-1);
        return true;
      case "toggle-terminal":
        setTerminalOpen((v) => !v);
        return true;
      case "toggle-agent":
        setAgentOpen((v) => !v);
        return true;
      case "toggle-sidebar":
        setSidebarOpen((v) => !v);
        return true;
      case "focus-address":
        focusAddress();
        return true;
      case "palette":
        if (paletteOpen()) closePalette();
        else openPalette();
        return true;
      case "find":
        openFind();
        return true;
      case "reload":
        navActive(webviewReload);
        return true;
      case "back":
        navActive(webviewBack);
        return true;
      case "forward":
        navActive(webviewForward);
        return true;
      case "save-to-omni":
        void saveToOmni();
        return true;
      case "shell-history":
        setShellHistOpen(true);
        return true;
      case "zoom-in":
        zoom("in");
        return true;
      case "zoom-out":
        zoom("out");
        return true;
      case "zoom-reset":
        zoom("reset");
        return true;
      case "bookmark-page":
        toggleBookmark();
        return true;
      case "devtools":
        navActive((id) => webviewDevtools(id));
        return true;
      case "focus-mode": {
        const on = !focusMode();
        setFocusMode(on);
        if (on) {
          setOmniToast("Focus mode — Esc or Ctrl+Shift+F to exit");
          window.setTimeout(() => setOmniToast(null), 2600);
        }
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
    if (focusMode()) return { sidebar: false, panel: false, terminal: false, agent: false, connect: false };
    // What the user wants open (same conditions as the non-responsive layout used).
    const want = {
      sidebar: sidebarOpen(),
      agent: agentOpen(),
      panel: activePanel() != null || activePanelB() != null,
      // Keep the dev terminal column up even on a terminal *tab* — the column is
      // the persistent shell; a launched TUI app tab lives alongside it.
      terminal: terminalOpen(),
      connect: connectOpen(),
    };
    const out = { sidebar: false, agent: false, panel: false, terminal: false, connect: false };
    // Content card + the always-present sidebar rail are reserved first.
    let used = MIN_CONTENT + SIDEBAR_RAIL;
    const w = winW();
    // Allocate width in PRIORITY order (kept longest first): the sidebar's expansion,
    // then agent, then web panel, then terminal, then the connections rail (shed first).
    const order: [keyof typeof want, number][] = [
      ["sidebar", sidebarW() - SIDEBAR_RAIL], // extra beyond the rail it already has
      ["agent", agentW()],
      ["panel", panelWidth()],
      ["terminal", terminalW()],
      ["connect", connectW()],
    ];
    for (const [k, extra] of order) {
      if (want[k] && used + extra <= w) {
        out[k] = true;
        used += extra;
      }
    }
    return out;
  });

  // The vertical terminal column (the persistent dev shell) shows whenever it's
  // toggled on and there's room — including alongside a terminal *tab*.
  const termColVisible = () => responsive().terminal;
  const panelColVisible = () => responsive().panel;
  const agentColVisible = () => responsive().agent;
  const connectColVisible = () => responsive().connect;

  const columns = () =>
    focusMode()
      ? "0px 1fr 0px 0px 0px 0px" // focus/compact mode (#55): content only
      : [
          responsive().sidebar ? `${sidebarW()}px` : "var(--flux-sidebar-w-min)",
          "1fr",
          panelColVisible() ? `${panelWidth()}px` : "0px",
          termColVisible() ? `${terminalW()}px` : "0px",
          agentColVisible() ? `${agentW()}px` : "0px",
          connectColVisible() ? `${connectW()}px` : "0px",
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
      classList={{ mobile: isMobile, "drawer-open": isMobile && sidebarOpen() }}
      style={
        isMobile
          ? // Phone: a Chrome-style top bar row over one full-bleed content cell.
            // The top bar sits in its OWN row so the native page WebView (bounds =
            // the content card) never covers it. Sidebar → drawer, agent → overlay
            // (see .shell.mobile in theme.css); terminal/connections/web-panel
            // columns are hidden (ADR 0012).
            {
              "grid-template-columns": "1fr",
              "grid-template-rows": "auto 1fr",
              "grid-template-areas": `"topbar" "content"`,
            }
          : {
              "grid-template-columns": columns(),
              "grid-template-rows": "var(--flux-titlebar-h) 1fr",
              "grid-template-areas": `"title title title title title title" "side content webpanel term agent connect"`,
            }
      }
    >
      <Show when={!isMobile}>
        <TitleBar />
      </Show>
      <Show when={isMobile}>
        <Suspense>
          <MobileChrome
            go={go}
            onMenu={() => setSidebarOpen(true)}
            tabsOpen={mobileTabsOpen}
            setTabsOpen={setMobileTabsOpen}
          />
        </Suspense>
      </Show>
      {/* Phone: the sidebar is replaced by a purpose-built menu drawer (the Arc
          sidebar is empty on mobile — tabs + omnibox live in MobileChrome). */}
      <Show
        when={!isMobile}
        fallback={
          <Suspense>
            <MobileMenu onNavigate={go} onClose={() => setSidebarOpen(false)} />
          </Suspense>
        }
      >
      <Sidebar
        collapsed={!responsive().sidebar}
        terminalOpen={terminalOpen()}
        agentOpen={agentOpen()}
        onNavigate={go}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onToggleAgent={() => setAgentOpen((v) => !v)}
        onSaveToOmni={saveToOmni}
        onToast={(m) => {
          setOmniToast(m);
          window.setTimeout(() => setOmniToast(null), 2800);
        }}
        onAiSearch={(q) => {
          if (aiAnswersOn()) {
            setAgentOpen(true);
            setPendingAsk(q);
          }
        }}
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
        onToggleFilesPanel={() => (filesPanelOpen() ? closeFilesPanel() : openFilesPanel())}
        onOpenPlayground={() => (playgroundOpen() ? closePlayground() : openPlayground())}
        onOpenNotebook={() => (kbPanelOpen() ? closeKbPanel() : openKbPanel())}
      />
      </Show>
      <ContentArea
        onNavigate={go}
        onNewTerminal={() => void openTab("terminal")}
        onToggleAgent={() => setAgentOpen(true)}
        onOpenMap={openMapPanel}
        onSleepBackground={sleepBackgroundTabs}
      />
      <Show when={panelColVisible()}>
        <WebPanelPane />
      </Show>
      <Show when={termColVisible()}>
        <TerminalColumn />
      </Show>
      <Show when={agentColVisible()}>
        <Suspense>
          <AgentPanel />
        </Suspense>
      </Show>
      <Show when={connectColVisible()}>
        <Suspense>
          <ConnectionsRail />
        </Suspense>
      </Show>
      {/* Floating music bubble (#125) — position:fixed, lives over the chrome. */}
      <Show when={musicOpen() && !focusMode()}>
        <Suspense>
          <MusicBubble />
        </Suspense>
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

      <Show when={!isMobile}>
        <ResizeHandles />
      </Show>

      {/* Mobile: the ⋮ menu (in MobileChrome's top bar) opens the sidebar as a
          drawer holding all Flux destinations; a backdrop closes it. */}
      <Show when={isMobile && sidebarOpen()}>
        <div class="mobile-drawer-backdrop" onClick={() => setSidebarOpen(false)} />
      </Show>

      {/* Command palette (#6) — overlay; renders above the (hidden) webview. */}
      <Show when={paletteOpen()}>
        <Suspense>
          <CommandPalette actions={paletteActions()} onClose={closePalette} onNavigate={go} />
        </Suspense>
      </Show>
      {/* The overlays below are lazy + store-gated: their chunks load on first
        open, keeping them out of the boot bundle (ADR 0001 chrome-JS budget). */}
      {/* Semantic shell-history search (#122) — Ctrl+Shift+R. */}
      <Show when={shellHistOpen()}>
        <ShellHistory />
      </Show>
      {/* Semantic find (#126) — find-by-meaning in-page / across tabs. */}
      <Show when={semFindOpen()}>
        <SemanticFind />
      </Show>
      {/* Watched pages (#128) — semantic change monitor list. */}
      <Show when={watchPanelOpen()}>
        <WatchPanel />
      </Show>
      {/* Tracker graph (#129) — privacy viz of third-party requests. */}
      <Show when={trackerGraphOpen()}>
        <TrackerGraph />
      </Show>
      {/* Pinned apps (#131): bottom-right launcher + a floating pane per open app. */}
      <AppDock />
      <For each={openAppIds()}>
        {(id, i) => {
          const app = FLUX_APPS.find((a) => a.id === id);
          return app ? <AppPane app={app} index={i()} /> : null;
        }}
      </For>

      {/* Right-click "open in new tab" menu for links in internal DOM pages. */}
      <LinkMenu
        onOpen={(url, background) =>
          void openTab("browser", isPdfUrl(url) ? pdfViewerUrl(url) : url, false, background).catch(() => {})
        }
      />

      {/* Files popout panel — a DOM file explorer over the (hidden) webview; its
          cwd persists so it reopens where you left off. Click outside to close. */}
      <Show when={filesPanelOpen()}>
        <div class="files-panel-backdrop" onClick={() => closeFilesPanel()}>
          <div class="files-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="files-panel-head">
              <span class="files-panel-title">🗁 Files</span>
              <button class="files-panel-x" title="Close (Esc)" onClick={() => closeFilesPanel()}>
                ✕
              </button>
            </div>
            <div class="files-panel-body">
              <Suspense>
                <FilesView
                  id={FILES_PANEL_ID}
                  path={filesPanelPath() || ""}
                  onPathChange={setFilesPanelPath}
                  onOpenInTab={(url) => {
                    closeFilesPanel();
                    go(url);
                  }}
                />
              </Suspense>
            </div>
          </div>
        </div>
      </Show>
      {/* Playground popout (#133) — offline arcade over the hidden webview. The
          component owns Esc (game → hub → close); click the backdrop to close. */}
      <Show when={playgroundOpen()}>
        <div class="files-panel-backdrop" onClick={() => closePlayground()}>
          <div class="playground-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="files-panel-head">
              <span class="files-panel-title">🎮 Playground</span>
              <span style={{ flex: 1 }} />
              <button class="files-panel-x" title="Close (Esc)" onClick={() => closePlayground()}>
                ✕
              </button>
            </div>
            <div class="playground-panel-body">
              <Suspense>
                <Playground onClose={closePlayground} />
              </Suspense>
            </div>
          </div>
        </div>
      </Show>
      {/* Notebook (KB) popout — the Onyx + Scroll second brain in a glass pane,
          like the files popout. ⤢ promotes it to a full tab; click outside / Esc closes. */}
      <Show when={kbPanelOpen()}>
        <div class="files-panel-backdrop" onClick={() => closeKbPanel()}>
          <div class="kb-panel glass" onClick={(e) => e.stopPropagation()}>
            <div class="files-panel-head">
              <span class="files-panel-title">📓 Notebook</span>
              <span style={{ flex: 1 }} />
              <button class="files-panel-x" title="Open as a full tab" onClick={() => openNotebookTab()}>
                ⤢
              </button>
              <button class="files-panel-x" title="Close (Esc)" onClick={() => closeKbPanel()}>
                ✕
              </button>
            </div>
            <div class="files-panel-body">
              <Suspense>
                <NotebookPage />
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
              <form
                class="map-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  setMapQuery(mapDraft().trim());
                }}
              >
                <input
                  class="map-search-input"
                  placeholder="Search a place or address…"
                  value={mapDraft()}
                  onInput={(e) => setMapDraft(e.currentTarget.value)}
                />
              </form>
              <button class="map-panel-x" title="Close (Esc)" onClick={() => closeMapPanel()}>
                ✕
              </button>
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

export default App;
