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
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  OMNI_URL,
  VAULT_URL,
  HISTORY_URL,
  PANE_SESSION,
  agentChat,
  agentExecute,
  isStartUrl,
  launchIntent,
  onAgentStatus,
  onClustersUpdated,
  onExtOpenTab,
  onDomUpdated,
  onFindResult,
  onShortcut,
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
  webviewDebug,
  webviewForward,
  memStatus,
  webviewCaptureState,
  webviewHibernate,
  webviewHide,
  webviewNavigate,
  webviewOpen,
  webviewReload,
  omniIngestActive,
  webviewSetBounds,
  webviewShow,
  webviewStop,
  webviewFind,
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
import CommandPalette, { type PaletteAction } from "./CommandPalette";
import Extensions from "./Extensions";
import FilesView from "./FilesView";
import OmniDashboard from "./OmniDashboard";
import Passwords from "./Passwords";
import VaultPage from "./VaultPage";
import HistoryPage from "./HistoryPage";
import Downloads from "./Downloads";
import Shields from "./Shields";
import {
  activeId,
  activeTab,
  activeWorkspace,
  aiAnswersOn,
  closeTab,
  createWorkspace,
  deleteGroup,
  ensureFavicon,
  faviconFor,
  findOpen,
  focusTab,
  groupByTopic,
  groupColor,
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
  setTabGroup,
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
  setTabLoading,
  tabs,
  togglePin,
  unpinnedTabs,
  updateTabTitle,
  updateTabUrl,
} from "./store";

const App: Component = () => {
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [agentOpen, setAgentOpen] = createSignal(true);
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
  // Last time each tab was the active one (ms) — drives tab hibernation (#45).
  const lastActive = new Map<number, number>();

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

  // Coalesce webview bounds updates to one IPC call per animation frame — a
  // resize fires dozens of layout changes/sec, and one IPC each was the lag.
  let boundsRaf = 0;
  let boundsId = 0;
  const scheduleBounds = (id: number) => {
    boundsId = id;
    if (boundsRaf) return;
    boundsRaf = requestAnimationFrame(() => {
      boundsRaf = 0;
      const r = readRect();
      if (r) wv(webviewSetBounds(boundsId, r));
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
    const unClusters = await onClustersUpdated(refreshTabs);
    // Diagnostic: fires when a tab's DOM reaches the cache (capture.js works).
    const unDom = await onDomUpdated((tabId) =>
      console.log("[flux] DOM captured for tab", tabId),
    );
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
    const liveBackground = (act: number | null) =>
      tabs().filter((t) => t.kind === "browser" && t.id !== act && !isStartUrl(t.url) && openedWebviews.has(t.id));
    const hibTimer = window.setInterval(async () => {
      const now = Date.now();
      const act = activeId();
      if (act != null) lastActive.set(act, now);
      // Idle-timeout sleep.
      if (hibernateEnabled()) {
        const cutoff = hibernateMins() * 60_000;
        for (const t of liveBackground(act)) {
          if (now - (lastActive.get(t.id) ?? now) > cutoff) hibernateTab(t.id);
        }
      }
      // Memory-pressure eviction — only when free system memory is genuinely
      // low; sleep the LRU few (more when it's critical).
      if (memEvict()) {
        const m = await memStatus().catch(() => null);
        if (m && m.available_pct < 12) {
          const lru = liveBackground(act).sort((a, b) => (lastActive.get(a.id) ?? 0) - (lastActive.get(b.id) ?? 0));
          for (const t of lru.slice(0, m.available_pct < 6 ? 4 : 2)) hibernateTab(t.id);
        }
      }
    }, 30_000);
    onCleanup(() => clearInterval(hibTimer));
    // Find-in-page match count from the active page (#33).
    const unFind = await onFindResult((tabId, count) => {
      if (tabId === activeId()) setFindMatches(count);
    });
    // Keep the address bar fresh as pages navigate, and re-apply the active
    // tab's bounds once it finishes loading (defensive: ensures the page sits
    // in the content card even if the initial position didn't stick).
    const unLoaded = await onTabLoaded((tabId, url, phase) => {
      console.log("[flux webview] load", phase, tabId, url); // diagnostic
      updateTabUrl(tabId, url);
      setTabLoading(tabId, phase === "started"); // stop/reload swap + progress (#31)
      if (phase === "finished") {
        // Sync the live url to the backend so the persisted session (#19)
        // reflects where the tab actually is, not its creation url.
        void tabSetUrl(tabId, url).catch(() => {});
        if (tabId === activeId()) {
          const r = readRect();
          if (r) wv(webviewSetBounds(tabId, r));
        }
      }
    });
    onCleanup(() => {
      unClusters();
      unDom();
      unExtOpen();
      unShortcut();
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

  // Sync native webviews to the active tab + content rect: show the active
  // browser tab's page at the card rect, hide every other tab's webview.
  // `flux://start` tabs get no webview — the dashboard renders in the card.
  createEffect(() => {
    const tab = activeTab();
    contentRect(); // subscribe: re-run on any layout change
    const rect = readRect(); // but always use the freshest DOM measurement
    for (const t of tabs()) {
      if (t.kind === "browser" && t.id !== tab?.id) wv(webviewHide(t.id));
    }
    if (tab?.kind === "browser") {
      if (isStartUrl(tab.url)) {
        if (openedWebviews.has(tab.id)) wv(webviewHide(tab.id));
      } else if (rect) {
        if (openedWebviews.has(tab.id)) {
          scheduleBounds(tab.id); // throttled — follows resizes without lag
          wv(webviewShow(tab.id));
        } else {
          openedWebviews.add(tab.id);
          setHibernated(tab.id, false); // (re)opening = waking from sleep (#45)
          lastActive.set(tab.id, Date.now());
          const id = tab.id;
          const r = rect;
          // Diagnostic for the "page stuck on loading" bug: rect we send,
          // then what Tauri actually applied (after the webview exists).
          console.log(
            `[flux webview] open id=${id} url=${tab.url} ` +
              `rect=${JSON.stringify(r)} dpr=${window.devicePixelRatio} ` +
              `win=${window.innerWidth}x${window.innerHeight}`,
          );
          webviewOpen(id, tab.url, r)
            .then(() => {
              scheduleBounds(id);
              return webviewDebug(id);
            })
            .then((info) => console.log("[flux webview] tauri sees:", info))
            .catch((e) => console.error("[flux webview] open failed:", e));
        }
      }
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

  // Cycle the active tab through the strip order (Ctrl+Tab / Ctrl+Shift+Tab).
  const cycleTab = (dir: 1 | -1) => {
    const list = tabs();
    if (list.length < 2) return;
    const i = list.findIndex((t) => t.id === activeId());
    const next = list[(i + dir + list.length) % list.length];
    if (next) void focusTab(next.id);
  };

  // Focus + select the omnibox (Ctrl+L); open the sidebar first if collapsed.
  const focusAddress = () => {
    setSidebarOpen(true);
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
    { id: "new-term", label: "New terminal tab", icon: "⌨", run: () => void openTab("terminal").then(() => setTerminalOpen(true)) },
    { id: "new-files", label: "New files tab", icon: "📁", run: () => void openTab("files") },
    { id: "history", label: "Open History", icon: "🕘", run: () => go(HISTORY_URL) },
    { id: "passwords", label: "Open Passwords", icon: "🔑", run: () => go(VAULT_URL) },
    { id: "omni", label: "Open Omni index", icon: "✦", run: () => go(OMNI_URL) },
    { id: "find", label: "Find in page", icon: "🔎", run: () => openFind() },
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
  const termColVisible = () => terminalOpen() && activeTab()?.kind !== "terminal";

  const columns = () =>
    [
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
      />
      <ContentArea
        onNavigate={go}
        onNewTerminal={() => void openTab("terminal")}
        onToggleAgent={() => setAgentOpen(true)}
      />
      <Show when={termColVisible()}>
        <TerminalColumn />
      </Show>
      <Show when={agentOpen()}>
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
        <CommandPalette actions={paletteActions()} onClose={closePalette} onNavigate={go} />
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
}

type FooterPanel = "bookmarks" | "extensions" | "settings" | null;
/** An omnibox suggestion (#32): a local history hit (has `url`) or an engine suggestion. */
type Suggestion = { kind: "history" | "search"; label: string; sub?: string; url?: string };

const Sidebar: Component<SidebarProps> = (props) => {
  const [picker, setPicker] = createSignal(false);
  const [address, setAddress] = createSignal("");
  const [panel, setPanel] = createSignal<FooterPanel>(null);
  const [engines, setEngines] = createSignal<SearchEngine[]>([]);
  const [defaultEngine, setDefaultEngine] = createSignal("");
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  // Tab drag-reorder (#30).
  const [dragId, setDragId] = createSignal<number | null>(null);
  const [dropId, setDropId] = createSignal<number | null>(null);
  // Tab right-click menu + grouping (#56).
  const [ctxTab, setCtxTab] = createSignal<TabMeta | null>(null);
  const [ctxPos, setCtxPos] = createSignal({ x: 0, y: 0 });
  const openCtx = (e: MouseEvent, tab: TabMeta) => { e.preventDefault(); setCtxTab(tab); setCtxPos({ x: e.clientX, y: e.clientY }); };
  const closeCtx = () => setCtxTab(null);
  const ungroupedTabs = () => unpinnedTabs().filter((t) => t.group == null || !groups().some((g) => g.id === t.group));
  const GROUP_PALETTE = [0x5bc0eb, 0x9d8df1, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const cycleGroupColor = (g: TabGroup) => {
    const i = GROUP_PALETTE.indexOf(g.color);
    void recolorGroup(g.id, GROUP_PALETTE[(i + 1) % GROUP_PALETTE.length]!);
  };
  const renamePrompt = (g: TabGroup) => {
    const n = window.prompt("Group name", g.name);
    if (n != null && n.trim()) void renameGroup(g.id, n.trim());
  };
  const WS_PALETTE = [0x9d8df1, 0x5bc0eb, 0x7cf5b0, 0xffcc66, 0xff8a8a, 0x2ff3ff];
  const cycleWsColor = (w: Workspace) => {
    const i = WS_PALETTE.indexOf(w.color);
    void recolorWorkspace(w.id, WS_PALETTE[(i + 1) % WS_PALETTE.length]!);
  };

  // One tab row — reused for grouped + ungrouped lists.
  const TabRow: Component<{ tab: TabMeta }> = (p) => (
    <div
      classList={{ "tab-row": true, active: activeId() === p.tab.id, sleeping: isHibernated(p.tab.id), dragging: dragId() === p.tab.id, "drag-over": dropId() === p.tab.id }}
      style={{ "border-left-color": clusterColor(p.tab) }}
      draggable={true}
      onClick={() => focusTab(p.tab.id)}
      onContextMenu={(e) => openCtx(e, p.tab)}
      onDragStart={(e) => { setDragId(p.tab.id); e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/plain", String(p.tab.id)); }}
      onDragOver={(e) => { if (dragId() == null || dragId() === p.tab.id) return; e.preventDefault(); e.dataTransfer!.dropEffect = "move"; setDropId(p.tab.id); }}
      onDragLeave={() => { if (dropId() === p.tab.id) setDropId(null); }}
      onDrop={(e) => { e.preventDefault(); const d = dragId(); if (d != null && d !== p.tab.id) { const r = e.currentTarget.getBoundingClientRect(); void reorderTabs(d, p.tab.id, e.clientY > r.top + r.height / 2); } setDragId(null); setDropId(null); }}
      onDragEnd={() => { setDragId(null); setDropId(null); }}
      title={isHibernated(p.tab.id) ? "sleeping — click to wake" : "drag to reorder · right-click for menu"}
    >
      <span class="tab-favicon">{isHibernated(p.tab.id) ? "💤" : <Favicon tab={p.tab} />}</span>
      <span class="title">{p.tab.title || p.tab.url}</span>
      <button class="close" title="Close tab" onClick={(e) => { e.stopPropagation(); void closeTab(p.tab.id); }}>✕</button>
    </div>
  );

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
  // Live-ish RAM readout while the settings panel is open.
  onMount(() => {
    const t = window.setInterval(() => {
      if (panel() === "settings") void memStatus().then(setMem).catch(() => {});
    }, 2500);
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
  const closeSuggest = () => { setSuggestions([]); setSelIdx(-1); };

  const onAddressInput = (v: string) => {
    setAddress(v);
    setSelIdx(-1);
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
    setAddress("");
    if (s.url) props.onNavigate(s.url);
    else {
      const { url } = await searchResolve(s.label);
      props.onNavigate(url);
    }
  };

  const onAddressKeyDown = (e: KeyboardEvent) => {
    const n = suggestions().length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setSelIdx((i) => (i + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setSelIdx((i) => (i - 1 + n) % n); }
    else if (e.key === "Escape") { closeSuggest(); }
    else if (e.key === "Enter") {
      const s = suggestions()[selIdx()];
      if (s) { e.preventDefault(); void chooseSuggestion(s); }
    }
  };

  const submitAddress = async (e: SubmitEvent) => {
    e.preventDefault();
    closeSuggest();
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
    // A genuine search (not a URL) also gets a quick local-AI answer (#ai).
    if (r.kind === "search") props.onAiSearch(v);
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
    <nav class="sidebar">
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
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={onAddressKeyDown}
            onBlur={() => setTimeout(closeSuggest, 150)}
            placeholder="Search or enter address  (Ctrl+L)"
            spellcheck={false}
            autocomplete="off"
          />
          {/* Save the current page into the Omni index (also Ctrl+Shift+O). */}
          <button
            type="button"
            class="icon-btn"
            title="Save this page to Omni (Ctrl+Shift+O)"
            onClick={() => props.onSaveToOmni()}
          >
            ✦
          </button>
          {/* Loading bar: lives in the sidebar, never under the native webview. */}
          <Show when={isLoading(activeId())}>
            <div class="addr-progress" />
          </Show>
          {/* Live suggestions (#32) — sidebar-resident, so never under the webview. */}
          <Show when={suggestions().length > 0}>
            <div class="omni-suggest">
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
              <button onClick={() => create("terminal")}>
                ⌨ Terminal tab <kbd>Ctrl+Shift+T</kbd>
              </button>
              <button onClick={() => create("files")}>
                📁 Files tab
              </button>
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
              const members = () => unpinnedTabs().filter((t) => t.group === g.id);
              return (
                <Show when={members().length > 0}>
                  <div class="tab-group">
                    <div class="tab-group-head" onClick={() => void toggleGroupCollapsed(g)}>
                      <span class="tab-group-dot" title="Recolor" style={{ background: groupColor(g) }} onClick={(e) => { e.stopPropagation(); cycleGroupColor(g); }} />
                      <span class="tab-group-name" title="Double-click to rename" onDblClick={(e) => { e.stopPropagation(); renamePrompt(g); }}>{g.name}</span>
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
          <For each={ungroupedTabs()}>{(tab) => <TabRow tab={tab} />}</For>
        </div>
      </Show>

      {/* Tab right-click menu (#56): pin, grouping, close. */}
      <Show when={ctxTab()}>
        {(t) => (
          <>
            <div class="ctx-backdrop" onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }} />
            <div class="tab-ctx glass" style={{ left: `${ctxPos().x}px`, top: `${ctxPos().y}px` }}>
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
              <div class="ctx-sep" />
              <button onClick={() => { void closeTab(t().id); closeCtx(); }}>Close tab</button>
            </div>
          </>
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

      {/* Workspace switcher (#44) — Arc-style, above the tools. */}
      <Show when={!props.collapsed}>
        <div class="workspace-bar">
          <For each={workspaces()}>
            {(w) => (
              <button
                classList={{ "ws-pill": true, active: activeWorkspace() === w.id }}
                style={{ "border-color": activeWorkspace() === w.id ? workspaceColor(w) : "transparent" }}
                title={`${w.name} — double-click to rename, right-click to delete`}
                onClick={() => props.onSwitchWorkspace(w.id)}
                onDblClick={() => { const n = window.prompt("Workspace name", w.name); if (n && n.trim()) void renameWorkspace(w.id, n.trim()); }}
                onContextMenu={(e) => { e.preventDefault(); props.onDeleteWorkspace(w.id); }}
              >
                <span class="ws-dot" title="Recolor" style={{ background: workspaceColor(w) }} onClick={(e) => { e.stopPropagation(); cycleWsColor(w); }} />
                <span class="ws-name">{w.name}</span>
              </button>
            )}
          </For>
          <button class="ws-add" title="New workspace" onClick={() => props.onNewWorkspace()}>+</button>
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
        <Shields />
        <Passwords />
        <Downloads />
        <button classList={{ "icon-btn": true, active: panel() === "bookmarks" }} title="Bookmarks" onClick={() => openPanel("bookmarks")}>🔖</button>
        <button classList={{ "icon-btn": true, active: panel() === "extensions" }} title="Extensions" onClick={() => openPanel("extensions")}>🧩</button>
        <button classList={{ "icon-btn": true, active: panel() === "settings" }} title="Settings" onClick={() => openPanel("settings")}>⚙</button>

        <Show when={panel()}>
          <div class="glass popover footer-pop">
            <Show when={panel() === "settings"}>
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
              <button class="shields-update" onClick={() => { setPanel(null); props.onNavigate(HISTORY_URL); }}>🕘 Browsing history</button>
              <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                Bookmark store + Chrome import land in BACKLOG #22. Import data is already parsed by <code>flux-import</code>.
              </div>
            </Show>
            <Show when={panel() === "extensions"}>
              <Extensions />
            </Show>
          </div>
        </Show>
      </div>
    </nav>
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
}> = (props) => {
  // Keyed by id (primitive) so the list is stable across unrelated tab updates.
  const terminalIds = createMemo(() => tabs().filter((t) => t.kind === "terminal").map((t) => t.id));
  return (
  <main class="content">
    <div class="card" id="flux-web-area">
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
        <Match when={activeTab() && isStartUrl(activeTab()!.url)}>
          <StartPage
            onNavigate={props.onNavigate}
            onNewTerminal={props.onNewTerminal}
            onToggleAgent={props.onToggleAgent}
          />
        </Match>
      </Switch>
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
type FeedItem = { role: "user" | "assistant" | "action" | "error"; text: string };

const AgentPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus>({ state: "idle" });
  const [prompt, setPrompt] = createSignal("");
  const [feed, setFeed] = createSignal<FeedItem[]>([]);
  const [busy, setBusy] = createSignal(false);
  let feedEl: HTMLDivElement | undefined;

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

  const run = async (e: SubmitEvent) => {
    e.preventDefault();
    const p = prompt().trim();
    if (!p || working()) return;
    setPrompt("");
    setFeed((f) => [...f, { role: "user", text: p }]);
    setBusy(true);
    try {
      // "/act <…>" (or /do) drives a page action; everything else is chat.
      const act = p.match(/^\/(?:act|do)\s+([\s\S]+)/i);
      if (act?.[1]) {
        const action = await agentExecute(act[1].trim());
        setFeed((f) => [...f, { role: "action", text: describeAction(action) }]);
      } else {
        const reply = await agentChat(p);
        setFeed((f) => [...f, { role: "assistant", text: reply.trim() }]);
      }
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };

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
          <span style={{ "font-size": "11px", color: "var(--flux-text-dim)" }}>gemma · local</span>
        </header>

        <div class="agent-feed" ref={feedEl}>
          <Show
            when={feed().length > 0}
            fallback={
              <div class="agent-empty">
                Chat with your local Gemma — ask anything. Use <kbd>/act</kbd> to control
                the page (e.g. <em>/act click the login button</em>).
              </div>
            }
          >
            <For each={feed()}>
              {(item) => <div classList={{ "agent-msg": true, [`agent-${item.role}`]: true }}>{item.text}</div>}
            </For>
          </Show>
          <Show when={status().state === "acting"}>
            <div class="agent-msg agent-action">
              ✦ {(status() as Extract<AgentStatus, { state: "acting" }>).description}
            </div>
          </Show>
        </div>

        <form onSubmit={run} classList={{ "ai-thinking-border": working() }}>
          <input
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            placeholder={working() ? "thinking…" : "Ask anything · /act to control the page"}
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
