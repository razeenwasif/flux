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
  PANE_SESSION,
  agentChat,
  agentExecute,
  isStartUrl,
  launchIntent,
  onAgentStatus,
  onClustersUpdated,
  onDomUpdated,
  onTabLoaded,
  searchDefault,
  searchEngines,
  searchResolve,
  searchSetDefault,
  tabSetUrl,
  webviewBack,
  type SearchEngine,
  webviewDebug,
  webviewForward,
  webviewHide,
  webviewNavigate,
  webviewOpen,
  webviewReload,
  webviewSetBounds,
  webviewShow,
  win,
  type AgentAction,
  type AgentStatus,
  type Rect,
  type ResizeDir,
  type TabMeta,
} from "./ipc";
import TerminalView from "./TerminalView";
import StartPage from "./StartPage";
import FilesView from "./FilesView";
import OmniDashboard from "./OmniDashboard";
import Shields from "./Shields";
import {
  activeId,
  activeTab,
  closeTab,
  focusTab,
  openTab,
  pinnedTabs,
  refreshTabs,
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

  // Resizable pane widths (px), persisted across sessions (BACKLOG #27).
  const loadW = (k: string, d: number) => Number(localStorage.getItem(k)) || d;
  const [sidebarW, setSidebarW] = createSignal(loadW("flux.w.sidebar", 252));
  const [terminalW, setTerminalW] = createSignal(loadW("flux.w.terminal", 440));
  const [agentW, setAgentW] = createSignal(loadW("flux.w.agent", 372));

  // Live rect of the content card, in CSS (logical) px relative to the window.
  // Native tab webviews are positioned to match it (BACKLOG #2).
  const [contentRect, setContentRect] = createSignal<Rect | null>(null);
  const openedWebviews = new Set<number>();

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
    // Keep the address bar fresh as pages navigate, and re-apply the active
    // tab's bounds once it finishes loading (defensive: ensures the page sits
    // in the content card even if the initial position didn't stick).
    const unLoaded = await onTabLoaded((tabId, url, phase) => {
      console.log("[flux webview] load", phase, tabId, url); // diagnostic
      updateTabUrl(tabId, url);
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

      <ResizeHandles />
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
}

type FooterPanel = "bookmarks" | "extensions" | "settings" | null;

const Sidebar: Component<SidebarProps> = (props) => {
  const [picker, setPicker] = createSignal(false);
  const [address, setAddress] = createSignal("");
  const [panel, setPanel] = createSignal<FooterPanel>(null);
  const [engines, setEngines] = createSignal<SearchEngine[]>([]);
  const [defaultEngine, setDefaultEngine] = createSignal("");

  const openPanel = async (p: FooterPanel) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === "settings") {
      try {
        const [es, d] = await Promise.all([searchEngines(), searchDefault()]);
        setEngines(es);
        setDefaultEngine(d);
      } catch {
        /* preview/offline */
      }
    }
  };

  const pickEngine = async (id: string) => {
    setDefaultEngine(id);
    await searchSetDefault(id).catch(() => {});
  };

  // Seed the address field from the active tab (blank on the start page).
  const currentUrl = () => {
    const u = activeTab()?.url ?? "";
    return isStartUrl(u) ? "" : u;
  };

  const submitAddress = async (e: SubmitEvent) => {
    e.preventDefault();
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
    const { url } = await searchResolve(v);
    props.onNavigate(url);
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
        <button class="icon-btn" title="Toggle sidebar (⌘S)" onClick={props.onToggleSidebar}>
          {props.collapsed ? "»" : "«"}
        </button>
        <Show when={!props.collapsed}>
          <button class="icon-btn" title="Back" onClick={() => navActive(webviewBack)}>‹</button>
          <button class="icon-btn" title="Forward" onClick={() => navActive(webviewForward)}>›</button>
          <button class="icon-btn" title="Reload" onClick={() => navActive(webviewReload)}>⟳</button>
          <span style={{ flex: 1 }} />
        </Show>
      </div>

      <Show when={!props.collapsed}>
        {/* Address / search pill */}
        <form onSubmit={submitAddress}>
          <input
            class="address"
            value={address() || currentUrl()}
            onInput={(e) => setAddress(e.currentTarget.value)}
            placeholder="Search or enter address"
            spellcheck={false}
          />
        </form>

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
                  {favicon(tab)}
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
                🌐 Browser tab <kbd>⌘T</kbd>
              </button>
              <button onClick={() => create("terminal")}>
                ⌨ Terminal tab <kbd>⌘⇧T</kbd>
              </button>
              <button onClick={() => create("files")}>
                📁 Files tab
              </button>
            </div>
          </Show>
        </div>

        {/* Tab list */}
        <span class="sidebar-section">Tabs</span>
        <div class="tab-list">
          <For each={unpinnedTabs()}>
            {(tab) => (
              <div
                classList={{ "tab-row": true, active: activeId() === tab.id }}
                style={{ "border-left-color": clusterColor(tab) }}
                onClick={() => focusTab(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void togglePin(tab); // → moves to the pinned grid
                }}
                title="right-click to pin"
              >
                <span class="tab-favicon">{favicon(tab)}</span>
                <span class="title">{tab.title || tab.url}</span>
                <button
                  class="close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.id);
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
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
                {favicon(tab)}
              </button>
            )}
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
        <button classList={{ "icon-btn": true, active: props.terminalOpen }} title="Terminal (⌃`)" onClick={props.onToggleTerminal}>⌨</button>
        <button classList={{ "icon-btn": true, active: props.agentOpen }} title="Flux Agent (⌃A)" onClick={props.onToggleAgent}>✦</button>
        <Shields />
        <button classList={{ "icon-btn": true, active: panel() === "bookmarks" }} title="Bookmarks" onClick={() => openPanel("bookmarks")}>🔖</button>
        <button classList={{ "icon-btn": true, active: panel() === "extensions" }} title="Extensions" onClick={() => openPanel("extensions")}>🧩</button>
        <button classList={{ "icon-btn": true, active: panel() === "settings" }} title="Settings" onClick={() => openPanel("settings")}>⚙</button>

        <Show when={panel()}>
          <div class="glass popover" style={{ bottom: "calc(100% + 8px)", left: "6px", "min-width": "230px" }}>
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
            </Show>
            <Show when={panel() === "bookmarks"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Bookmarks</div>
              <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                Bookmark store + Chrome import land in BACKLOG #22. Import data is already parsed by <code>flux-import</code>.
              </div>
            </Show>
            <Show when={panel() === "extensions"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>Extensions</div>
              <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                Chrome extensions can't run in native webviews; Flux maps them to built-ins (BACKLOG #24, #57).
              </div>
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

/** Favicon stand-in (BACKLOG #21): terminal → ⌨, files → 📁, browser → host initial. */
function favicon(tab: TabMeta): string {
  if (tab.kind === "terminal") return "⌨";
  if (tab.kind === "files") return "📁";
  const host = tab.url.split("/")[2] ?? tab.url;
  return (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
}

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
