/**
 * Sidebar — the Arc-style left rail (ADR 0002): tab strip (pinned tiles, groups,
 * folders, split-view pairs), omnibox + suggestions, workspaces, footer panels
 * (bookmarks, extensions, downloads, shields, notes, …). Split out of App.tsx.
 */
import Downloads from "./Downloads";
import Shields from "./Shields";
import {
  SETTINGS_URL,
  calEvents,
  historySearch,
  isStartUrl,
  PDF_URL,
  memStatus,
  noteGet,
  noteSet,
  omniAnswer,
  searchDefault,
  searchEngines,
  searchResolve,
  searchSetDefault,
  searchSuggest,
  watchAdd,
  watchIsWatched,
  webviewBack,
  webviewForward,
  webviewReload,
  webviewStop,
  type MemInfo,
  type OmniAnswerSource,
  type SearchEngine,
  type TabGroup,
  type TabMeta,
  type Workspace,
} from "./ipc";
import {
  activeId,
  activePanelId,
  activePanelIdB,
  activeTab,
  activeWorkspace,
  aiAnswersOn,
  archivedTabs,
  archivedBranches,
  calendarPopOpen,
  calendarOverlayOpen,
  setCalendarPopOpen,
  dockOpen,
  toggleDock,
  restoreBranch,
  removeBranch,
  clearArchived,
  clearTile,
  closeTab,
  containerById,
  containerColor,
  containers,
  createContainer,
  darkMode,
  deleteContainer,
  deleteFolder,
  deleteGroup,
  editorColOpen,
  setEditorColOpen,
  filesPanelOpen,
  focusTab,
  folderTabs,
  folders,
  groupByTopic,
  groupColor,
  groupWithTab,
  groups,
  hibernateEnabled,
  hibernateMins,
  isHibernated,
  isLoading,
  kbPanelOpen,
  memEvict,
  mouseGestures,
  newFolderWithTab,
  newGroupWithTab,
  omniAutoAnswer,
  openTab,
  openTabInContainer,
  panelBadges,
  panels,
  pinPanel,
  pinnedTabs,
  playgroundOpen,
  readerOpen,
  recolorContainer,
  recolorGroup,
  recolorWorkspace,
  removeArchived,
  renameContainer,
  renameFolder,
  renameGroup,
  renameTab,
  renameWorkspace,
  wsRenameRequest,
  clearWorkspaceRename,
  reorderPanels,
  reorderTabs,
  restoreArchived,
  searchSuggestOn,
  setAiAnswersOn,
  setDarkMode,
  setHibernateEnabled,
  setHibernateMins,
  setMemEvict,
  setMouseGestures,
  setOmniAutoAnswer,
  setSearchSuggestOn,
  setSplitPickerOpen,
  setTabFolder,
  setTabGroup,
  setVimHints,
  setWatchPanelOpen,
  setTile,
  setTileLayout,
  tileGroup,
  tileGroups,
  untile,
  splitPickerOpen,
  tabLabel,
  tabs,
  toggleFolderCollapsed,
  toggleGroupCollapsed,
  togglePanel,
  togglePanelBottom,
  togglePin,
  unpinPanel,
  unpinnedTabs,
  vimHints,
  workspaceColor,
  workspaces,
  wsPanelOpen,
  setWsPanelOpen,
  toolbarOpen,
  setToolbarOpen,
  footerOpen,
  setFooterOpen,
  zoomFor,
} from "./store";
import Icon from "./Icon";
import { visibleInterval } from "./poll";
import { attachHScroll } from "./hscroll";
import { Favicon, PanelIcon, clusterColor } from "./tabvisual";
import { LAYOUT_LABEL, MAX_PANES, layoutsFor, stripRows, type StripRow } from "./tiles";
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
import { Portal } from "solid-js/web";

// Footer panels / overlays — lazy: their chunks load on first open (ADR 0001).
const Extensions = lazy(() => import("./Extensions"));
const Boosts = lazy(() => import("./Boosts"));
const Macros = lazy(() => import("./Macros"));
const Passwords = lazy(() => import("./Passwords"));
const FindBar = lazy(() => import("./FindBar"));
const CalendarPop = lazy(() => import("./CalendarPop"));
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
  onOpenPlayground: () => void;
  onOpenNotebook: () => void;
}

// NB: full-page destinations (bookmarks/history/sessions/…) live on the
// PagesBar + ⌘K, not here — the footer holds only act-in-context panels.
type FooterPanel = "extensions" | "settings" | "webpanels" | "notes" | "archived" | null;
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
  // Upcoming-event badge (#114): true when something starts within 30 minutes.
  // Polled every 10 min (cal_events fetches the ICS feeds — keep it rare).
  const [calSoon, setCalSoon] = createSignal(false);
  onMount(() =>
    visibleInterval(() => {
      void calEvents()
        .then((evs) => {
          const now = new Date();
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const mins = now.getHours() * 60 + now.getMinutes();
          setCalSoon(
            evs.some((e) => {
              if (e.date !== today || !e.time) return false;
              const [h, m] = e.time.split(":").map(Number);
              const t = (h ?? 0) * 60 + (m ?? 0);
              return t >= mins && t - mins <= 30;
            }),
          );
        })
        .catch(() => {});
    }, 600_000),
  );
  const [picker, setPicker] = createSignal(false);
  const [address, setAddress] = createSignal("");
  const [panel, setPanel] = createSignal<FooterPanel>(null);
  // Split-view picker (#43 follow-up) — choose which open tab tiles beside this one.
  // Store-backed so the webview-gating effects can hide the page beneath it.
  const splitPicker = splitPickerOpen;
  const setSplitPicker = setSplitPickerOpen;
  // Page-watch (#128) — is the active page being monitored? Re-checked on tab change.
  const [watched, setWatched] = createSignal(false);
  createEffect(() => {
    const t = activeTab();
    if (t?.kind === "browser" && !isStartUrl(t.url))
      void watchIsWatched(t.url)
        .then(setWatched)
        .catch(() => setWatched(false));
    else setWatched(false);
  });
  const toggleWatch = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) return;
    if (watched()) {
      setWatchPanelOpen(true);
      return;
    } // already watching → manage in the panel
    void watchAdd(t.url, t.title || t.url)
      .then(() => setWatched(true))
      .catch(() => {});
  };
  /** Every open tab in the workspace can be tiled: web pages get a native webview
   *  over their slot, Files tabs and Flux's own pages render through `pageFor`,
   *  and a terminal's keep-alive layer (#73) is positioned into its slot. */
  const splitCandidates = () =>
    tabs().filter((t) => t.workspace === activeWorkspace() && t.id !== activeId());
  /** Can this page be pinned as a panel?
   *
   *  Web pages get a native webview; Flux's own pages render as DOM through
   *  `InternalPage`. The one exclusion is the PDF viewer, which resolves its file
   *  from the *tab* it belongs to — a panel has no tab, so it would open empty.
   *  Files tabs are excluded by `kind` for the same reason. */
  const canPinAsPanel = () => {
    const t = activeTab();
    if (!t || t.kind !== "browser") return false;
    return !t.url.startsWith(PDF_URL);
  };

  /** The group holding `id`, if any. Distinct from `tileGroup()`, which is only
   *  the group the *active* tab is in: the tab strip and the context menu have to
   *  reflect every split, not just the one currently on screen. */
  const groupOf = (id: number) => tileGroups().find((g) => g.tabs.includes(id)) ?? null;
  /** Tabs already tiled in a *different* group. Picking one moves it here, since a
   *  tab belongs to at most one tiling — flagged so that isn't a surprise. */
  const tiledElsewhere = (id: number) => {
    const g = groupOf(id);
    return g != null && g !== tileGroup();
  };
  /** A real web page, i.e. one with a native webview behind the card. Flux's own
   *  pages (any flux:// url) and files tabs are DOM. */
  const isWebPage = () => {
    const t = activeTab();
    return t?.kind === "browser" && !isStartUrl(t.url);
  };
  /** Tabs currently in the tiling, active tab first — the picker's selection. */
  const tileSel = () => {
    const g = tileGroup();
    const a = activeId();
    if (g?.tabs.length) return g.tabs;
    return a != null ? [a] : [];
  };
  /** Toggle a tab in or out of the tiling, capped at MAX_PANES. The picker stays
   *  open: choosing several panes and a layout is one continuous act. */
  const toggleTiled = (id: number) => {
    const cur = tileSel();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, MAX_PANES);
    if (next.length < 2) {
      clearTile();
      return;
    }
    const g = tileGroup();
    const layouts = layoutsFor(next.length);
    // Keep the chosen layout when it still fits the new pane count.
    const layout = g && layouts.includes(g.layout) ? g.layout : layouts[0]!;
    setTile(next, layout);
  };
  const doSplitNew = async () => {
    const left = activeId();
    setSplitPicker(false);
    if (left == null) return;
    // Open a real (navigable) blank webview in the background, then tile it on the right.
    try {
      const t = await openTab("browser", "about:blank", false, true);
      const next = [...tileSel(), t.id].slice(0, MAX_PANES);
      setTile(next, layoutsFor(next.length)[0]!);
    } catch (err) {
      console.error("split: new tab", err);
    }
  };
  // Drag-to-reorder pinned web panels in the app rail.
  const [dragPanel, setDragPanel] = createSignal<number | null>(null);
  const [dropPanel, setDropPanel] = createSignal<number | null>(null);
  const dropOnPanel = (targetId: number) => {
    const from = dragPanel();
    setDragPanel(null);
    setDropPanel(null);
    if (from == null || from === targetId) return;
    const ids = panels()
      .map((p) => p.id)
      .filter((i) => i !== from);
    const at = ids.indexOf(targetId);
    ids.splice(at < 0 ? ids.length : at, 0, from);
    reorderPanels(ids);
  };
  const [boostsLoaded, setBoostsLoaded] = createSignal(false);
  const [macrosLoaded, setMacrosLoaded] = createSignal(false);
  const [passwordsLoaded, setPasswordsLoaded] = createSignal(false);
  // Per-page notes (#53): the popover edits the active page's note (auto-saved).
  const [noteText, setNoteText] = createSignal("");
  let noteTimer: number | undefined;
  const loadNote = () => {
    const t = activeTab();
    if (t?.kind === "browser" && !isStartUrl(t.url))
      void noteGet(t.url)
        .then(setNoteText)
        .catch(() => setNoteText(""));
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
    try {
      return zoomFor(new URL(t.url).hostname.replace(/^www\./, ""));
    } catch {
      return 1;
    }
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
  const activeWs = () => workspaces().find((w) => w.id === activeWorkspace());
  const activeWorkspaceName = () => activeWs()?.name ?? "Workspace";
  const activeWorkspaceColor = () => {
    const w = activeWs();
    return w ? workspaceColor(w) : "transparent";
  };
  // Expanding the sidebar takes the button that opened this panel off screen,
  // which would otherwise strand it with no way back.
  createEffect(() => {
    if (!props.collapsed) setWsPanelOpen(false);
  });
  createEffect(() => {
    if (!wsPanelOpen()) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setWsPanelOpen(false);
      }
    };
    // Capture phase: the app's global shortcut handler also listens for Escape
    // (stop loading), and dismissing the panel should win while it's open.
    document.addEventListener("keydown", esc, true);
    onCleanup(() => document.removeEventListener("keydown", esc, true));
  });
  // The command palette can ask for a rename. The editor lives inside the
  // workspace panel now (#151), so the request has to open it as well — setting
  // `editWs` alone would put the input somewhere nothing is rendering, and
  // "Rename workspace" would silently do nothing.
  createEffect(() => {
    const id = wsRenameRequest();
    if (id == null) return;
    setEditWs(id);
    setWsPanelOpen(true);
    clearWorkspaceRename();
  });
  const [editContainer, setEditContainer] = createSignal<number | null>(null);
  const [editFolder, setEditFolder] = createSignal<number | null>(null);
  const [editTab, setEditTab] = createSignal<number | null>(null);
  const openCtx = (e: MouseEvent, tab: TabMeta) => {
    e.preventDefault();
    setCtxTab(tab);
    setCtxPos({ x: e.clientX, y: e.clientY });
  };
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
  const ungroupedTabs = createMemo(() =>
    unpinnedTabs().filter((t) => t.group == null || !groupIds().has(t.group)),
  );
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
      classList={{
        "tab-row": true,
        active: activeId() === p.tab.id,
        sleeping: isHibernated(p.tab.id),
        private: p.tab.private,
        dragging: dragId() === p.tab.id,
        "drag-over": dropId() === p.tab.id,
      }}
      style={{
        "border-left-color":
          p.tab.container && containerById(p.tab.container)
            ? containerColor(containerById(p.tab.container)!)
            : clusterColor(p.tab),
      }}
      draggable={true}
      onClick={() => focusTab(p.tab.id)}
      onContextMenu={(e) => openCtx(e, p.tab)}
      onDragStart={(e) => {
        setDragId(p.tab.id);
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", String(p.tab.id));
      }}
      onDragOver={(e) => {
        if (dragId() == null || dragId() === p.tab.id) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        setDropId(p.tab.id);
      }}
      onDragLeave={() => {
        if (dropId() === p.tab.id) setDropId(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const d = dragId();
        if (d != null && d !== p.tab.id) {
          const r = e.currentTarget.getBoundingClientRect();
          const fx = (e.clientX - r.left) / r.width;
          const fy = (e.clientY - r.top) / r.height;
          const dragged = tabs().find((t) => t.id === d);
          const bothPages = dragged?.kind === "browser" && p.tab.kind === "browser";
          if (fx > 0.6 && bothPages)
            setTile([p.tab.id, d], "cols"); // right side → split (#43)
          else if (fy > 0.25 && fy < 0.75)
            void groupWithTab(d, p.tab.id); // center → group
          else void reorderTabs(d, p.tab.id, fy >= 0.75); // top/bottom → reorder
        }
        setDragId(null);
        setDropId(null);
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropId(null);
      }}
      title={
        isHibernated(p.tab.id)
          ? "sleeping — click to wake"
          : "drag: top/bottom reorder · middle group · right edge split · right-click for menu"
      }
    >
      <span class="tab-favicon">
        {p.tab.private ? "🕶" : isHibernated(p.tab.id) ? "💤" : <Favicon tab={p.tab} />}
      </span>
      <Show
        when={editTab() === p.tab.id}
        fallback={
          <span
            class="title"
            onDblClick={(e) => {
              e.stopPropagation();
              setEditTab(p.tab.id);
            }}
          >
            {tabLabel(p.tab)}
          </span>
        }
      >
        <input
          class="tab-rename"
          value={tabLabel(p.tab)}
          autofocus
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            void renameTab(p.tab.id, e.currentTarget.value.trim());
            setEditTab(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setEditTab(null);
          }}
        />
      </Show>
      <button
        class="close"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(p.tab.id);
        }}
      >
        ✕
      </button>
    </div>
  );

  // Split view (#43): the two tiled tabs render together as one bracketed unit in
  // the strip (like Chrome's paired split tabs), with a "merge" (un-split) button.
  const SplitPair: Component<{ members: TabMeta[] }> = (p) => (
    <div class="split-pair" title={`Split view — ${p.members.length} tiled tabs`}>
      <button
        class="split-pair-merge"
        title="Exit split view"
        onClick={(e) => {
          e.stopPropagation();
          clearTile();
        }}
      >
        ⤢
      </button>
      <For each={p.members}>{(t) => <TabRow tab={t} />}</For>
    </div>
  );

  /** Tabs in the strip, with each split collected into one row so it reads as a
   *  unit rather than as scattered siblings.
   *
   *  **Every** group gets a row, keyed off `tileGroups()` rather than the active
   *  one. Using `tileGroup()` here meant a split visually dissolved the moment you
   *  clicked away to an unrelated tab and re-formed when you clicked back, and a
   *  second split could never be seen at all — only one row was ever emitted. */
  const ungroupedItems = createMemo((): StripRow<TabMeta>[] => stripRows(ungroupedTabs(), tileGroups()));

  const openPanel = async (p: FooterPanel) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === "settings") {
      void memStatus()
        .then(setMem)
        .catch(() => {});
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
    void memStatus()
      .then(setMem)
      .catch(() => {});
    const t = window.setInterval(
      () =>
        void memStatus()
          .then(setMem)
          .catch(() => {}),
      2500,
    );
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
    if (u.startsWith("https://"))
      return { icon: "🔒", title: "Connection is secure (HTTPS)", cls: "sec-secure" };
    if (u.startsWith("http://"))
      return { icon: "⚠", title: "Not secure — sent over plain HTTP", cls: "sec-insecure" };
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
  const closeSuggest = () => {
    setSuggestions([]);
    setSelIdx(-1);
  };
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
        omniDismissTimer = window.setTimeout(() => {
          if (gen === omniGen) clearOmniAns();
        }, 9000);
      }
    }).catch(() => {
      if (gen === omniGen) {
        setOmniAns((a) => (a ? { ...a, streaming: false } : a));
        omniDismissTimer = window.setTimeout(() => {
          if (gen === omniGen) clearOmniAns();
        }, 5000);
      }
    });
  };

  const onAddressInput = (v: string) => {
    setAddress(v);
    setSelIdx(-1);
    clearOmniAns(); // a new query invalidates any shown answer
    clearTimeout(sugTimer);
    const q = v.trim();
    if (!q || q.startsWith("flux://")) {
      setSuggestions([]);
      return;
    }
    sugTimer = window.setTimeout(async () => {
      const hist = await historySearch(q, 5).catch(() => []);
      const out: Suggestion[] = hist.map((h) => ({
        kind: "history",
        label: h.title || h.url,
        sub: h.url,
        url: h.url,
      }));
      if (searchSuggestOn()) {
        const sug = await searchSuggest(q).catch(() => []);
        for (const t of sug) {
          if (out.length >= 8) break;
          if (!out.some((x) => x.label.toLowerCase() === t.toLowerCase()))
            out.push({ kind: "search", label: t });
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
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      startOmniAnswer(address());
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setSelIdx((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setSelIdx((i) => (i - 1 + n) % n);
    } else if (e.key === "Escape") {
      closeSuggest();
      clearOmniAns();
    } else if (e.key === "Enter") {
      const s = suggestions()[selIdx()];
      if (s) {
        e.preventDefault();
        void chooseSuggestion(s);
      }
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
    <nav
      class="sidebar"
      classList={{
        "with-apps": !props.collapsed && panels().length > 0,
        collapsed: props.collapsed,
      }}
    >
      {/* Left app rail (#48 launcher) — Opera-style: pinned web-app panels as
          icons on the sidebar's left edge; click toggles the slide-out panel. */}
      <Show when={!props.collapsed && panels().length > 0}>
        <div class="app-rail">
          <For each={panels()}>
            {(p) => (
              <button
                classList={{
                  "app-rail-icon": true,
                  active: activePanelId() === p.id,
                  dragging: dragPanel() === p.id,
                  "drop-into": dropPanel() === p.id,
                }}
                title={p.title || p.url}
                draggable={true}
                onClick={() => togglePanel(p.id)}
                onDragStart={(e) => {
                  setDragPanel(p.id);
                  e.dataTransfer!.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragPanel() != null) {
                    e.preventDefault();
                    setDropPanel(p.id);
                  }
                }}
                onDragLeave={() => {
                  if (dropPanel() === p.id) setDropPanel(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnPanel(p.id);
                }}
                onDragEnd={() => {
                  setDragPanel(null);
                  setDropPanel(null);
                }}
              >
                <PanelIcon url={p.url} />
                <Show when={(panelBadges[p.id] ?? 0) > 0}>
                  <span class="app-rail-badge">{panelBadges[p.id]! > 99 ? "99+" : panelBadges[p.id]}</span>
                </Show>
              </button>
            )}
          </For>
          <button class="app-rail-add" title="Pin a web app (panels)" onClick={() => openPanel("webpanels")}>
            +
          </button>
        </div>
      </Show>
      {/* Nav row. Also a drag region (`deep`) for extra grab area; buttons
          still click through. Traffic lights live in the title bar now. */}
      <div class="sidebar-controls" classList={{ collapsed: props.collapsed }} data-tauri-drag-region="deep">
        <button class="icon-btn" title="Toggle sidebar (Ctrl+B)" onClick={props.onToggleSidebar}>
          {props.collapsed ? "»" : "«"}
        </button>
        {/* The nav tools fold away (#150). The sidebar-toggle above stays put in
            both states — folding must never be a way to lose the control that
            unfolds, and the caret at the end of the row is the other half of
            that contract. */}
        <Show when={!props.collapsed && toolbarOpen()}>
          <button class="icon-btn" title="Back (Alt+←)" onClick={() => navActive(webviewBack)}>
            ‹
          </button>
          <button class="icon-btn" title="Forward (Alt+→)" onClick={() => navActive(webviewForward)}>
            ›
          </button>
          <Show
            when={isLoading(activeId())}
            fallback={
              <button class="icon-btn" title="Reload (Ctrl+R)" onClick={() => navActive(webviewReload)}>
                ⟳
              </button>
            }
          >
            <button class="icon-btn" title="Stop (Esc)" onClick={() => navActive(webviewStop)}>
              ✕
            </button>
          </Show>
          <button
            class="icon-btn"
            title="Home (new tab page)"
            onClick={() => props.onNavigate("flux://start")}
          >
            ⌂
          </button>
          <button
            classList={{ "icon-btn": true, active: filesPanelOpen() }}
            title="File explorer"
            onClick={props.onToggleFilesPanel}
          >
            <Icon name="files" />
          </button>
          <button
            classList={{ "icon-btn": true, active: playgroundOpen() }}
            title="Playground — offline arcade"
            onClick={props.onOpenPlayground}
          >
            <Icon name="playground" />
          </button>
          <button
            classList={{ "icon-btn": true, active: kbPanelOpen() }}
            title="Notebook — your knowledge base (Onyx + Scroll)"
            onClick={props.onOpenNotebook}
          >
            <Icon name="notebook" />
          </button>
        </Show>
        {/* Directly after the tools, not pushed to the right end by a flex
            spacer: the row wraps, and a spacer would strand the caret alone on
            a line of its own. */}
        <Show when={!props.collapsed}>
          <button
            class="icon-btn sidebar-fold"
            title={toolbarOpen() ? "Hide the toolbar" : "Show the toolbar"}
            onClick={() => setToolbarOpen(!toolbarOpen())}
          >
            {toolbarOpen() ? "▴" : "▾"}
          </button>
        </Show>
      </div>

      <Show when={!props.collapsed}>
        {/* Address / search pill */}
        <form onSubmit={submitAddress} class="address-row">
          <Show when={security()}>
            {(s) => (
              <span class={`sec ${s().cls}`} title={s().title}>
                {s().icon}
              </span>
            )}
          </Show>
          <input
            id="flux-address"
            class="address"
            value={address() || currentUrl()}
            onInput={(e) => onAddressInput(e.currentTarget.value)}
            onFocus={(e) => {
              e.currentTarget.select();
              setAddrFocused(true);
            }}
            onKeyDown={onAddressKeyDown}
            onBlur={() => {
              setAddrFocused(false);
              setTimeout(closeSuggest, 150);
            }}
            placeholder="Search or enter address  (Ctrl+L)"
            spellcheck={false}
            autocomplete="off"
          />
          {/* Per-site zoom (#36): shown only when ≠ 100%; click to reset. */}
          <Show when={activeZoom() !== 1}>
            <button
              type="button"
              class="zoom-pill"
              title="Reset zoom (Ctrl+0)"
              onClick={() => props.onZoomReset()}
            >
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
                      <Show when={a().streaming}>
                        <span class="omni-answer-dot" />
                      </Show>
                      <button
                        type="button"
                        class="omni-answer-close"
                        title="Dismiss Omni answer"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          clearOmniAns();
                        }}
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
                              onMouseDown={(e) => {
                                e.preventDefault();
                                props.onNavigate(s.url);
                              }}
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
                  onMouseDown={(e) => {
                    e.preventDefault();
                    startOmniAnswer(address());
                  }}
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
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void chooseSuggestion(s);
                    }}
                    onMouseEnter={() => setSelIdx(i())}
                  >
                    <span class="omni-sug-icon">{s.kind === "history" ? "🕘" : "🔍"}</span>
                    <span class="omni-sug-text">
                      <span class="omni-sug-label">{s.label}</span>
                      <Show when={s.sub}>
                        <span class="omni-sug-sub">{s.sub}</span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </form>

        {/* Find-in-page (#33) — permanently visible under the search bar; the
            native webview overlays the card, so it must live here. Lazy chunk
            (fetched right after boot, off the eager bundle). */}
        <FindBar />

        {/* Page actions row, below the address bar. Split view applies to *any*
            page — Flux's own pages, a terminal, a file browser — so the row shows
            for every tab and only the web-page actions (bookmark, reader, capture,
            translate…) are gated. It used to be gated as a whole, which left an
            internal page with no ◫ at all and tileable only from the palette. */}
        <Show when={activeTab()}>
          <div class="page-actions">
            <Show when={isWebPage()}>
              <button
                type="button"
                classList={{ "icon-btn": true, "bm-star": true, active: props.isBookmarked() }}
                title={
                  props.isBookmarked()
                    ? "Bookmarked — click to remove (Ctrl+D)"
                    : "Bookmark this page (Ctrl+D)"
                }
                onClick={() => props.onToggleBookmark()}
              >
                {props.isBookmarked() ? "★" : "☆"}
              </button>
            </Show>
            <button
              type="button"
              classList={{ "icon-btn": true, active: tileGroup() != null }}
              title={
                tileGroup()
                  ? "Split view — change the layout, add a pane, or exit"
                  : "Split view — tile this page with up to three others"
              }
              onClick={() => setSplitPicker(true)}
            >
              <Icon name="split" />
            </button>
            <Show when={isWebPage()}>
              <button
                type="button"
                classList={{ "icon-btn": true, active: readerOpen() }}
                title="Reader mode"
                onClick={() => props.onToggleReader()}
              >
                <Icon name="reader" />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Capture page (screenshot)"
                onClick={() => props.onCapture()}
              >
                <Icon name="screenshot" />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Translate this page"
                onClick={() => props.onTranslate()}
              >
                <Icon name="translate" />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Save for offline (read later)"
                onClick={() => props.onArchive()}
              >
                <Icon name="offline" />
              </button>
              <button
                type="button"
                classList={{ "icon-btn": true, active: watched() }}
                title={watched() ? "Watching for changes — click to manage" : "Watch this page for changes"}
                onClick={toggleWatch}
              >
                <Icon name="watch" />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Save this page to Omni (Ctrl+Shift+O)"
                onClick={() => props.onSaveToOmni()}
              >
                ✦
              </button>
            </Show>
          </div>
        </Show>

        {/* Split-view picker — pick a tab to tile beside the current page, or open a
            fresh blank pane. Portaled to <body> so the glass card isn't clipped. */}
        <Show when={splitPicker()}>
          <Portal>
            <div
              class="split-picker-backdrop"
              onClick={() => setSplitPicker(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSplitPicker(false);
              }}
            >
              <div class="split-picker glass" onClick={(e) => e.stopPropagation()}>
                <div class="split-picker-head">
                  ◫ Tile up to {MAX_PANES} pages
                  <Show when={tileGroup()}>
                    <button class="split-picker-clear" onClick={() => clearTile()}>
                      Exit split
                    </button>
                  </Show>
                </div>
                {/* Layout row — only meaningful once two panes are chosen. */}
                <Show when={(tileGroup()?.tabs.length ?? 0) >= 2}>
                  <div class="split-picker-layouts">
                    <For each={layoutsFor(tileGroup()!.tabs.length)}>
                      {(l) => (
                        <button
                          classList={{ "split-layout": true, on: tileGroup()?.layout === l }}
                          title={LAYOUT_LABEL[l]}
                          onClick={() => setTileLayout(l)}
                        >
                          <span class={`split-layout-ico ico-${l}`} />
                          <span>{LAYOUT_LABEL[l]}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="split-picker-list">
                  <For
                    each={splitCandidates()}
                    fallback={<div class="split-picker-empty">No other pages open to split with.</div>}
                  >
                    {(t) => (
                      <button
                        classList={{ "split-picker-item": true, on: tileSel().includes(t.id) }}
                        onClick={() => toggleTiled(t.id)}
                      >
                        <Favicon tab={t} />
                        <span class="split-picker-label">{t.title || t.url}</span>
                        <Show when={tiledElsewhere(t.id) && !tileSel().includes(t.id)}>
                          <span
                            class="split-picker-elsewhere"
                            title="Already in another split — adding it here moves it"
                          >
                            <Icon name="split" />
                          </span>
                        </Show>
                        <Show when={tileSel().includes(t.id)}>
                          <span class="split-picker-tick">✓</span>
                        </Show>
                      </button>
                    )}
                  </For>
                  <button class="split-picker-item split-picker-new" onClick={doSplitNew}>
                    <span class="split-picker-newico">＋</span>
                    <span class="split-picker-label">New blank tab</span>
                  </button>
                </div>
              </div>
            </div>
          </Portal>
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
              <button
                onClick={() => {
                  setPicker(false);
                  void openTab("browser", undefined, true);
                }}
              >
                🕶 Private tab
              </button>
              <button onClick={() => create("terminal")}>⌨ Terminal tab</button>
              <button onClick={() => create("files")}>📁 Files tab</button>
              <Show when={containers().length > 0}>
                <div class="ctx-sep" />
                <div class="ctx-label">Open in container</div>
                <For each={containers()}>
                  {(c) => (
                    <button
                      onClick={() => {
                        setPicker(false);
                        void openTabInContainer(c.id);
                      }}
                    >
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
            <button
              class="group-topic"
              title="Group tabs by topic (from semantic clusters)"
              onClick={async () => {
                const n = await groupByTopic();
                props.onToast(
                  n > 0
                    ? `⊞ Grouped tabs into ${n} topic${n === 1 ? "" : "s"}`
                    : "No clear topics yet — open a few related pages, let them load, then try again",
                );
              }}
            >
              ⊞ Group
            </button>
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxGroup(g);
                        setCtxPos({ x: e.clientX, y: e.clientY });
                      }}
                      onDragOver={(e) => {
                        if (dragId() != null) {
                          e.preventDefault();
                          e.dataTransfer!.dropEffect = "move";
                          setDropId(-g.id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropId() === -g.id) setDropId(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const d = dragId();
                        if (d != null) void setTabGroup(d, g.id);
                        setDragId(null);
                        setDropId(null);
                      }}
                    >
                      <span
                        class="tab-group-dot"
                        title="Recolor"
                        style={{ background: groupColor(g) }}
                        onClick={(e) => {
                          e.stopPropagation();
                          cycleGroupColor(g);
                        }}
                      />
                      <Show
                        when={editGroup() === g.id}
                        fallback={
                          <span
                            class="tab-group-name"
                            title="Double-click to rename"
                            onDblClick={(e) => {
                              e.stopPropagation();
                              setEditGroup(g.id);
                            }}
                          >
                            {g.name}
                          </span>
                        }
                      >
                        <input
                          class="inline-edit"
                          value={g.name}
                          autofocus
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const v = e.currentTarget.value.trim();
                            if (v) void renameGroup(g.id, v);
                            setEditGroup(null);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") e.currentTarget.blur();
                            else if (e.key === "Escape") setEditGroup(null);
                          }}
                        />
                      </Show>
                      <span class="tab-group-count">{members().length}</span>
                      <button
                        class="tab-group-edit"
                        title="Rename group"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditGroup(g.id);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        class="tab-group-x"
                        title="Ungroup"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteGroup(g.id);
                        }}
                      >
                        ✕
                      </button>
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
            {(it) => (it.kind === "split" ? <SplitPair members={it.members} /> : <TabRow tab={it.tab} />)}
          </For>
        </div>
      </Show>

      {/* Tab right-click menu (#56): pin, grouping, close. Portaled to <body> so
          the sidebar's overflow:hidden + backdrop-filter containing block can't
          clip it; clampMenu keeps it on-screen near the panel edges/bottom. */}
      <Show when={ctxTab()}>
        {(t) => (
          <Portal>
            <div
              class="ctx-backdrop"
              onClick={closeCtx}
              onContextMenu={(e) => {
                e.preventDefault();
                closeCtx();
              }}
            />
            <div
              class="tab-ctx glass"
              ref={clampMenu}
              style={{ left: `${ctxPos().x}px`, top: `${ctxPos().y}px` }}
            >
              <button
                onClick={() => {
                  void togglePin(t());
                  closeCtx();
                }}
              >
                {t().pinned ? "Unpin" : "Pin tab"}
              </button>
              <button
                onClick={() => {
                  const id = t().id;
                  closeCtx();
                  setEditTab(id);
                }}
              >
                Rename tab
              </button>
              <button
                onClick={() => {
                  void newGroupWithTab(t().id);
                  closeCtx();
                }}
              >
                New group with tab
              </button>
              <Show when={groups().length > 0}>
                <div class="ctx-sep" />
                <div class="ctx-label">Add to group</div>
                <For each={groups()}>
                  {(g) => (
                    <button
                      onClick={() => {
                        void setTabGroup(t().id, g.id);
                        closeCtx();
                      }}
                    >
                      <span class="tab-group-dot" style={{ background: groupColor(g) }} /> {g.name}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={t().group != null}>
                <button
                  onClick={() => {
                    void setTabGroup(t().id, null);
                    closeCtx();
                  }}
                >
                  Remove from group
                </button>
              </Show>
              {/* Both pages must be tileable — the same rule the ◫ and the picker
                  use. This was gated on "is a real web page" too, so a Flux page
                  never offered it either. */}
              <Show when={activeTab() != null && activeId() !== t().id}>
                <div class="ctx-sep" />
                <button
                  onClick={() => {
                    toggleTiled(t().id);
                    closeCtx();
                  }}
                >
                  ⊟ Split with current tab
                </button>
              </Show>
              <Show when={groupOf(t().id) != null}>
                <button
                  onClick={() => {
                    untile(t().id);
                    closeCtx();
                  }}
                >
                  Exit split view
                </button>
              </Show>
              <div class="ctx-sep" />
              <div class="ctx-label">Move to folder (sleeps to save RAM)</div>
              <button
                onClick={() => {
                  void newFolderWithTab(t().id);
                  closeCtx();
                }}
              >
                + New folder with tab
              </button>
              <For each={folders()}>
                {(f) => (
                  <button
                    onClick={() => {
                      void setTabFolder(t().id, f.id);
                      closeCtx();
                    }}
                  >
                    🗂 {f.name}
                  </button>
                )}
              </For>
              <Show when={t().folder != null}>
                <button
                  onClick={() => {
                    void setTabFolder(t().id, null);
                    closeCtx();
                  }}
                >
                  Take out of folder
                </button>
              </Show>
              <Show when={workspaces().length > 1}>
                <div class="ctx-sep" />
                <div class="ctx-label">Send to workspace</div>
                <For each={workspaces().filter((w) => w.id !== t().workspace)}>
                  {(w) => (
                    <button
                      onClick={() => {
                        props.onSendTabToWorkspace(t().id, w.id);
                        closeCtx();
                      }}
                    >
                      <span class="ws-dot" style={{ background: workspaceColor(w) }} /> {w.name}
                    </button>
                  )}
                </For>
              </Show>
              <div class="ctx-sep" />
              <button
                onClick={() => {
                  void closeTab(t().id);
                  closeCtx();
                }}
              >
                Close tab
              </button>
            </div>
          </Portal>
        )}
      </Show>

      {/* Group right-click menu (#44/#56): rename, recolor, send-to-workspace. */}
      <Show when={ctxGroup()}>
        {(g) => (
          <Portal>
            <div
              class="ctx-backdrop"
              onClick={() => setCtxGroup(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxGroup(null);
              }}
            />
            <div
              class="tab-ctx glass"
              ref={clampMenu}
              style={{ left: `${ctxPos().x}px`, top: `${ctxPos().y}px` }}
            >
              <button
                onClick={() => {
                  setEditGroup(g().id);
                  setCtxGroup(null);
                }}
              >
                Rename group
              </button>
              <button
                onClick={() => {
                  cycleGroupColor(g());
                  setCtxGroup(null);
                }}
              >
                Change color
              </button>
              <Show when={workspaces().length > 1}>
                <div class="ctx-sep" />
                <div class="ctx-label">Send group to workspace</div>
                <For each={workspaces().filter((w) => w.id !== activeWorkspace())}>
                  {(w) => (
                    <button
                      onClick={() => {
                        props.onSendGroupToWorkspace(g().id, w.id);
                        setCtxGroup(null);
                      }}
                    >
                      <span class="ws-dot" style={{ background: workspaceColor(w) }} /> {w.name}
                    </button>
                  )}
                </For>
              </Show>
              <div class="ctx-sep" />
              <button
                onClick={() => {
                  void deleteGroup(g().id);
                  setCtxGroup(null);
                }}
              >
                Ungroup
              </button>
            </div>
          </Portal>
        )}
      </Show>

      {/* Collapsed rail. Used to show pinned tiles and nothing else, which made
          collapsing a way to *lose* your open tabs rather than a way to reclaim
          width — you had to expand again to switch. Now it mirrors the expanded
          sidebar's order: pinned, open, workspaces, footer, separated by hairline
          rules so the groups read as groups at 36px wide. */}
      <Show when={props.collapsed}>
        <div class="rail">
          <Show when={pinnedTabs().length > 0}>
            <div class="rail-group">
              <For each={pinnedTabs()}>
                {(tab) => (
                  <button
                    classList={{ "pin-tile": true, active: activeId() === tab.id }}
                    title={tab.title || tab.url}
                    onClick={() => focusTab(tab.id)}
                  >
                    <Favicon tab={tab} />
                  </button>
                )}
              </For>
            </div>
          </Show>

          {/* Only the open-tab group scrolls. Pinned tabs and the workspace
              button stay put, so the two things you reach for by muscle memory
              don't move when a page opens. */}
          <Show when={unpinnedTabs().length > 0}>
            <Show when={pinnedTabs().length > 0}>
              <div class="rail-rule" />
            </Show>
            <div class="rail-group rail-scroll">
              <For each={unpinnedTabs()}>
                {(tab) => (
                  <button
                    classList={{ "pin-tile": true, active: activeId() === tab.id }}
                    title={tab.title || tab.url}
                    onClick={() => focusTab(tab.id)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        void closeTab(tab.id);
                      }
                    }}
                  >
                    <Favicon tab={tab} />
                  </button>
                )}
              </For>
            </div>
          </Show>

          {/* Workspaces used to get their own button down here. They're in the
              footer now, which renders in both sidebar states — two buttons for
              one list, 30px apart, was just a way to make the rail taller. */}
        </div>
      </Show>

      {/* The workspace panel (#151), opened by the footer button in either
          sidebar state. Portaled to <body>: a position:fixed panel inside the
          sidebar's glass (backdrop-filter) card gets clipped to it.
          It carries every control the hover-dot rail used to — switch, recolour,
          rename, delete — because it is now the only place they exist. */}
      <Show when={wsPanelOpen()}>
        <Portal>
          <div class="rail-ws-scrim" onClick={() => setWsPanelOpen(false)} />
          <div class="rail-ws-panel glass">
            <div class="rail-ws-head">Workspaces</div>
            <For each={workspaces()}>
              {(w) => (
                <div classList={{ "rail-ws-row": true, active: activeWorkspace() === w.id }}>
                  <span
                    class="ws-dot rail-ws-swatch"
                    title="Recolor"
                    style={{ background: workspaceColor(w) }}
                    onClick={() => cycleWsColor(w)}
                  />
                  <Show
                    when={editWs() === w.id}
                    fallback={
                      <button
                        classList={{ "rail-ws-item": true, active: activeWorkspace() === w.id }}
                        title={`Switch to ${w.name}`}
                        onDblClick={() => setEditWs(w.id)}
                        onClick={() => {
                          props.onSwitchWorkspace(w.id);
                          setWsPanelOpen(false);
                        }}
                      >
                        <span class="rail-ws-name">{w.name}</span>
                      </button>
                    }
                  >
                    <input
                      class="inline-edit ws"
                      value={w.name}
                      autofocus
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim();
                        if (v) void renameWorkspace(w.id, v);
                        setEditWs(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") e.currentTarget.blur();
                        else if (e.key === "Escape") setEditWs(null);
                      }}
                    />
                  </Show>
                  {/* Rename was double-click-only on the old rail, which left the
                      destructive action as the only visible control. Give the
                      safe one an affordance too. */}
                  <button class="rail-ws-edit" title="Rename workspace" onClick={() => setEditWs(w.id)}>
                    ✎
                  </button>
                  <button
                    class="rail-ws-x"
                    title="Delete workspace"
                    onClick={() => props.onDeleteWorkspace(w.id)}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
            <button
              class="rail-ws-item rail-ws-add"
              onClick={() => {
                props.onNewWorkspace();
                setWsPanelOpen(false);
              }}
            >
              <span class="ws-dot rail-ws-plus">+</span>
              <span class="rail-ws-name">New workspace</span>
            </button>
          </div>
        </Portal>
      </Show>

      {/* Tab folders — collapsible parking buckets above the footer. Members are
          kept hibernated (≈0 RAM); click one to wake + view it. */}
      <Show when={!props.collapsed && folders().length > 0}>
        {/* Horizontal strip of 164px cards: past two or three it scrolls, and
            until #157 there was no way to reach the rest. */}
        <div class="folders hscroll" ref={(el) => onCleanup(attachHScroll(el))}>
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
                      fallback={
                        <span
                          class="folder-name"
                          onDblClick={(e) => {
                            e.stopPropagation();
                            setEditFolder(f.id);
                          }}
                        >
                          {f.name}
                        </span>
                      }
                    >
                      <input
                        class="folder-rename"
                        value={f.name}
                        autofocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim();
                          if (v) void renameFolder(f.id, v);
                          setEditFolder(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") e.currentTarget.blur();
                          else if (e.key === "Escape") setEditFolder(null);
                        }}
                      />
                    </Show>
                    <span class="folder-count">{members().length}</span>
                    <button
                      class="folder-edit"
                      title="Rename folder"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditFolder(f.id);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      class="folder-x"
                      title="Delete folder (tabs return to the strip)"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteFolder(f.id);
                      }}
                    >
                      ✕
                    </button>
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
                            <span class="folder-tab-ico">
                              <Favicon tab={t} />
                            </span>
                            <span class="folder-tab-title">{tabLabel(t)}</span>
                            <button
                              class="folder-tab-out"
                              title="Take out of folder"
                              onClick={(e) => {
                                e.stopPropagation();
                                void setTabFolder(t.id, null);
                              }}
                            >
                              ⏏
                            </button>
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
          melts here — no status bar).
          Folds to just the workspace + caret pair (#150), in BOTH sidebar
          states: the collapsed rail drew all of these as a two-column icon grid,
          which is exactly the height the rail was collapsed to reclaim. */}
      <div
        class="sidebar-footer"
        classList={{ collapsed: props.collapsed, folded: !footerOpen() }}
        style={{ position: "relative" }}
      >
        <Show when={footerOpen()}>
          <button
            classList={{ "icon-btn": true, active: props.terminalOpen }}
            title="Terminal (Ctrl+`)"
            onClick={props.onToggleTerminal}
          >
            <Icon name="terminal" />
          </button>
          <button
            classList={{ "icon-btn": true, active: editorColOpen() }}
            title="Editor / Nvim Column (Ctrl+Shift+E)"
            onClick={() => setEditorColOpen(!editorColOpen())}
          >
            <Icon name="editor" />
          </button>
          <button
            classList={{ "icon-btn": true, active: props.agentOpen }}
            title="Flux Agent (Ctrl+Shift+A)"
            onClick={props.onToggleAgent}
          >
            <Icon name="agent" />
          </button>
          {/* Calendar (#114 follow-up): glanceable agenda from anywhere. The dot
            marks an event starting within 30 minutes. Popover body is lazy. */}
          <button
            classList={{ "icon-btn": true, active: calendarPopOpen() }}
            title="Calendar — today & upcoming (also in ⌘K)"
            onClick={() => setCalendarPopOpen(!calendarPopOpen())}
          >
            <Icon name="calendar" />
            <Show when={calSoon()}>
              <span class="cal-soon-dot" title="An event starts within 30 minutes" />
            </Show>
          </button>
          {/* The calendar+mail column. Every other column has a button here; this
            one had only a palette entry, which made it effectively invisible. */}
          <button
            classList={{ "icon-btn": true, active: dockOpen() }}
            title={
              dockOpen()
                ? "Hide the calendar + mail column"
                : "Calendar + mail in their own column (also in ⌘K)"
            }
            onClick={() => toggleDock()}
          >
            <Icon name="mail" />
          </button>
          {/* Overlay mode only — the docked pane renders inside the web-panel
            column (WebPanelPane) so it sits beside the page, not over it. */}
          <Show when={calendarOverlayOpen()}>
            <CalendarPop />
          </Show>
          <Shields onNavigate={props.onNavigate} />
          <Show
            when={boostsLoaded()}
            fallback={
              <button
                class="icon-btn"
                title="Boosts — customize this site with AI"
                onClick={() => setBoostsLoaded(true)}
              >
                <Icon name="boosts" />
              </button>
            }
          >
            <Suspense
              fallback={
                <button class="icon-btn active" title="Boosts — customize this site with AI">
                  <Icon name="boosts" />
                </button>
              }
            >
              <Boosts initialOpen />
            </Suspense>
          </Show>
          <Show
            when={macrosLoaded()}
            fallback={
              <button
                class="icon-btn"
                title="Macros — record & replay flows"
                onClick={() => setMacrosLoaded(true)}
              >
                <Icon name="macros" />
              </button>
            }
          >
            <Suspense
              fallback={
                <button class="icon-btn active" title="Macros — record & replay flows">
                  <Icon name="macros" />
                </button>
              }
            >
              <Macros initialOpen />
            </Suspense>
          </Show>
          <Show
            when={passwordsLoaded()}
            fallback={
              <button class="icon-btn" title="Passwords" onClick={() => setPasswordsLoaded(true)}>
                <Icon name="passwords" />
              </button>
            }
          >
            <Suspense
              fallback={
                <button class="icon-btn active" title="Passwords">
                  <Icon name="passwords" />
                </button>
              }
            >
              <Passwords initialOpen />
            </Suspense>
          </Show>
          <Downloads />
          <button
            classList={{ "icon-btn": true, active: panel() === "notes" }}
            title="Note for this page"
            onClick={() => {
              openPanel("notes");
              loadNote();
            }}
          >
            <Icon name="note" />
          </button>
          <button
            classList={{ "icon-btn": true, active: panel() === "webpanels" || activePanelId() != null }}
            title="Web panels — pin a site beside your tabs"
            onClick={() => openPanel("webpanels")}
          >
            <Icon name="panels" />
          </button>
          <Show when={archivedTabs().length > 0 || archivedBranches().length > 0}>
            <button
              classList={{ "icon-btn": true, active: panel() === "archived" }}
              title="Archived tabs — auto-closed stale tabs & research branches you can reopen"
              onClick={() => openPanel("archived")}
            >
              <Icon name="archived" />
            </button>
          </Show>
          <button
            classList={{ "icon-btn": true, active: panel() === "extensions" }}
            title="Extensions"
            onClick={() => openPanel("extensions")}
          >
            <Icon name="extensions" />
          </button>
          <button
            classList={{ "icon-btn": true, active: panel() === "settings" }}
            title="Settings"
            onClick={() => openPanel("settings")}
          >
            <Icon name="settings" />
          </button>
        </Show>

        {/* Always shown, folded or not. Workspaces replaced the dot rail (#151):
            a strip of colour-only dots said nothing about which workspace was
            which until you hovered one, and it charged a 22px gutter down the
            whole sidebar for the privilege. */}
        <button
          classList={{ "icon-btn": true, "ws-btn": true, active: wsPanelOpen() }}
          title={`Workspaces — ${activeWorkspaceName()}`}
          onClick={(e) => {
            // Measure rather than guess: the footer's height depends on how many
            // toggles are enabled and on whether it's folded, and the sidebar's
            // width on whether it's collapsed — a fixed offset drifts on all
            // four. Anchored to the footer's top edge and the sidebar's left,
            // not to the button's own box: rising from the button alone put the
            // panel over the rest of the footer's icons.
            const r = e.currentTarget.getBoundingClientRect();
            const side = e.currentTarget.closest(".sidebar")?.getBoundingClientRect();
            const foot = e.currentTarget.closest(".sidebar-footer")?.getBoundingClientRect();
            const root = document.documentElement.style;
            root.setProperty(
              "--rail-ws-bottom",
              `${Math.max(8, window.innerHeight - (foot?.top ?? r.top) + 8)}px`,
            );
            root.setProperty("--rail-ws-left", `${Math.round((side?.left ?? r.left) + 10)}px`);
            setWsPanelOpen(!wsPanelOpen());
          }}
        >
          <Icon name="workspaces" />
          <span class="rail-ws-dot" style={{ background: activeWorkspaceColor() }} />
        </button>
        <button
          class="icon-btn sidebar-fold"
          title={footerOpen() ? "Hide the footer tools" : "Show the footer tools"}
          onClick={() => {
            const v = !footerOpen();
            setFooterOpen(v);
            // The popover anchors to buttons that are about to be unmounted —
            // leaving it open would strand it over the page with no owner.
            if (!v) setPanel(null);
          }}
        >
          {footerOpen() ? "▾" : "▴"}
        </button>

        <Show when={panel()}>
          <div class="glass popover footer-pop">
            <Show when={panel() === "settings"}>
              <button
                class="shields-update"
                onClick={() => {
                  setPanel(null);
                  props.onNavigate(SETTINGS_URL);
                }}
              >
                ⚙ Open full Settings ↗
              </button>
              <div class="ctx-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Containers{" "}
                <span style={{ color: "var(--flux-text-mute)", "font-weight": 400 }}>· isolated logins</span>
              </div>
              <For each={containers()}>
                {(c) => (
                  <div class="panel-row">
                    <span
                      class="ws-dot"
                      title="Recolor"
                      style={{ background: containerColor(c), "margin-left": "8px", cursor: "pointer" }}
                      onClick={() => void recolorContainer(c.id)}
                    />
                    <Show
                      when={editContainer() === c.id}
                      fallback={
                        <span
                          class="panel-row-open"
                          onDblClick={() => setEditContainer(c.id)}
                          title="Double-click to rename"
                        >
                          {c.name}
                        </span>
                      }
                    >
                      <input
                        class="inline-edit"
                        value={c.name}
                        autofocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim();
                          if (v) void renameContainer(c.id, v);
                          setEditContainer(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") e.currentTarget.blur();
                          else if (e.key === "Escape") setEditContainer(null);
                        }}
                      />
                    </Show>
                    <button
                      class="panel-row-edit"
                      title="Rename container"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditContainer(c.id);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      class="panel-row-x"
                      title="Delete container"
                      onClick={() => void deleteContainer(c.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
              <button
                class="shields-update"
                onClick={() => void createContainer().then((id) => id && setEditContainer(id))}
              >
                ＋ New container
              </button>
              <div class="ctx-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Default search engine
              </div>
              <For each={engines()}>
                {(e) => (
                  <button
                    onClick={() => pickEngine(e.id)}
                    style={{ "justify-content": "space-between", display: "flex" }}
                  >
                    {e.name}
                    <Show when={defaultEngine() === e.id}>
                      <span style={{ color: "var(--flux-teal)" }}>✓</span>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={engines().length === 0}>
                <div class="start-empty" style={{ padding: "6px 8px" }}>
                  Engines load in the running app.
                </div>
              </Show>
              <div class="shields-row" style={{ padding: "4px 8px 2px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="Send what you type to the search engine for live suggestions. History suggestions stay local either way."
                >
                  Search suggestions
                </span>
                <button
                  classList={{ "shields-toggle": true, on: searchSuggestOn() }}
                  onClick={() => setSearchSuggestOn(!searchSuggestOn())}
                >
                  {searchSuggestOn() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="When you search, the local Gemma drafts a quick answer in the agent panel. Runs on-device."
                >
                  AI answers for searches
                </span>
                <button
                  classList={{ "shields-toggle": true, on: aiAnswersOn() }}
                  onClick={() => setAiAnswersOn(!aiAnswersOn())}
                >
                  {aiAnswersOn() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="On every search, stream a grounded answer card from your Omni index in the omnibox (with citations). Off by default — it runs the local LLM each time. The 'Ask Omni' row and Alt+Enter work regardless."
                >
                  Omni answer on search
                </span>
                <button
                  classList={{ "shields-toggle": true, on: omniAutoAnswer() }}
                  onClick={() => setOmniAutoAnswer(!omniAutoAnswer())}
                >
                  {omniAutoAnswer() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="Ask websites to render dark (prefers-color-scheme). Works on most modern sites."
                >
                  Dark mode (websites)
                </span>
                <button
                  classList={{ "shields-toggle": true, on: darkMode() }}
                  onClick={() => setDarkMode(!darkMode())}
                >
                  {darkMode() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Navigation
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="Press f to label links/buttons, then type the label to click. Also j/k scroll, gg/G top/bottom."
                >
                  Vim link hints (f)
                </span>
                <button
                  classList={{ "shields-toggle": true, on: vimHints() }}
                  onClick={() => setVimHints(!vimHints())}
                >
                  {vimHints() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="Hold the right mouse button and drag: left = back, right = forward, down = reload, up = top."
                >
                  Mouse gestures
                </span>
                <button
                  classList={{ "shields-toggle": true, on: mouseGestures() }}
                  onClick={() => setMouseGestures(!mouseGestures())}
                >
                  {mouseGestures() ? "On" : "Off"}
                </button>
              </div>
              <div class="shields-sep" />
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Memory
              </div>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="Free a background tab's memory by unloading it; it reloads when you return."
                >
                  Sleep inactive tabs
                </span>
                <button
                  classList={{ "shields-toggle": true, on: hibernateEnabled() }}
                  onClick={() => setHibernateEnabled(!hibernateEnabled())}
                >
                  {hibernateEnabled() ? "On" : "Off"}
                </button>
              </div>
              <Show when={hibernateEnabled()}>
                <div class="shields-row" style={{ padding: "2px 8px" }}>
                  <span class="shields-label" style={{ "font-weight": 500, "font-size": "12px" }}>
                    After
                  </span>
                  <select
                    class="shields-select"
                    value={String(hibernateMins())}
                    onChange={(e) => setHibernateMins(Number(e.currentTarget.value))}
                  >
                    <option value="5">5 min</option>
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                  </select>
                </div>
              </Show>
              <div class="shields-row" style={{ padding: "2px 8px" }}>
                <span
                  class="shields-label"
                  style={{ "font-weight": 500, "font-size": "12px" }}
                  title="When free system memory runs low, sleep the least-recently-used tabs early."
                >
                  Sleep under memory pressure
                </span>
                <button
                  classList={{ "shields-toggle": true, on: memEvict() }}
                  onClick={() => setMemEvict(!memEvict())}
                >
                  {memEvict() ? "On" : "Off"}
                </button>
              </div>
              <Show when={mem()}>
                <div class="shields-stat" style={{ padding: "2px 8px 4px" }}>
                  Flux {mem()!.process_mb} MB · {(mem()!.available_mb / 1024).toFixed(1)} GB free (
                  {mem()!.available_pct}%)
                </div>
              </Show>
            </Show>
            <Show when={panel() === "webpanels"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Web panels
              </div>
              <Show when={canPinAsPanel()}>
                <button
                  class="shields-update"
                  onClick={() => {
                    const t = activeTab()!;
                    void pinPanel(t.url, t.title || t.url);
                    setPanel(null);
                  }}
                >
                  ＋ Pin this page as a panel
                </button>
              </Show>
              <Show
                when={panels().length > 0}
                fallback={
                  <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                    Pin a site (chat, docs, music) to keep it in a slim pane beside any tab.
                  </div>
                }
              >
                <div class="ctx-sep" />
                <For each={panels()}>
                  {(p) => (
                    <div
                      class="panel-row"
                      classList={{ active: activePanelId() === p.id || activePanelIdB() === p.id }}
                    >
                      <button
                        class="panel-row-open"
                        onClick={() => {
                          togglePanel(p.id);
                          setPanel(null);
                        }}
                        title="Show in panel (top)"
                      >
                        <span class="panel-row-title">{p.title || p.url}</span>
                      </button>
                      <button
                        class="panel-slot-btn"
                        classList={{ on: activePanelIdB() === p.id }}
                        title="Stack in bottom split"
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePanelBottom(p.id);
                        }}
                      >
                        ⬓
                      </button>
                      <button
                        class="panel-row-x"
                        title="Unpin"
                        onClick={(e) => {
                          e.stopPropagation();
                          void unpinPanel(p.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
                <div
                  class="start-empty"
                  style={{ padding: "6px 10px 4px", "font-size": "11px", opacity: "0.7" }}
                >
                  Tap a panel for the top; ⬓ stacks it below — e.g. calendar over email.
                </div>
              </Show>
            </Show>
            <Show when={panel() === "notes"}>
              <div class="sidebar-section" style={{ padding: "4px 8px" }}>
                Note for this page
              </div>
              <Show
                when={activeTab()?.kind === "browser" && !isStartUrl(activeTab()!.url)}
                fallback={
                  <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                    Open a web page to jot a note.
                  </div>
                }
              >
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
              <div
                class="sidebar-section"
                style={{
                  padding: "4px 8px",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                }}
              >
                <span>Archived tabs</span>
                <Show when={archivedTabs().length > 0}>
                  <button class="panel-row-x" title="Clear all" onClick={() => clearArchived()}>
                    Clear
                  </button>
                </Show>
              </div>
              {/* Rabbit-hole branches (#46 upgrade): a whole Trail-connected
                  research thread archived as one named, restorable unit. */}
              <For each={archivedBranches()}>
                {(b) => (
                  <div class="arch-branch">
                    <div class="panel-row">
                      <button
                        class="panel-row-open"
                        title={`${b.tabs.length} pages · archived ${new Date(b.ts).toLocaleDateString()}\nClick to reopen all`}
                        onClick={() => {
                          // Restores into the branch's original workspace —
                          // follow it there so the tabs aren't reopened out of
                          // sight.
                          void restoreBranch(b).then((ws) => {
                            if (ws != null) props.onSwitchWorkspace(ws);
                          });
                          setPanel(null);
                        }}
                      >
                        <span class="panel-row-title">
                          🌿 {b.summary || `Research branch · ${b.tabs.length} pages`}
                          <span class="arch-branch-n">{b.tabs.length}</span>
                        </span>
                      </button>
                      <button
                        class="panel-row-x"
                        title="Remove branch"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeBranch(b.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <div class="arch-branch-tabs">
                      <For each={b.tabs.slice(0, 6)}>
                        {(t) => (
                          <span class="arch-branch-tab" title={t.url}>
                            {t.title}
                          </span>
                        )}
                      </For>
                      <Show when={b.tabs.length > 6}>
                        <span class="arch-branch-tab">+{b.tabs.length - 6} more</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
              <Show
                when={archivedTabs().length > 0}
                fallback={
                  <Show when={archivedBranches().length === 0}>
                    <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
                      Stale tabs auto-archive here (set the threshold in Settings → Tabs); a whole research
                      branch archives together, named. Reopen any with one tap.
                    </div>
                  </Show>
                }
              >
                <For each={archivedTabs()}>
                  {(a) => (
                    <div class="panel-row">
                      <button
                        class="panel-row-open"
                        title={a.url}
                        onClick={() => {
                          void restoreArchived(a).then((ws) => {
                            if (ws != null) props.onSwitchWorkspace(ws);
                          });
                          setPanel(null);
                        }}
                      >
                        <span class="panel-row-title">{a.title || a.url}</span>
                      </button>
                      <button
                        class="panel-row-x"
                        title="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeArchived(a.url);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
            <Show when={panel() === "extensions"}>
              <Suspense>
                <Extensions />
              </Suspense>
            </Show>
          </div>
        </Show>
      </div>
    </nav>
  );
};

export default Sidebar;
