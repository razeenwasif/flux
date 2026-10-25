import { shortcutLabel } from "./platform";
import { setLauncherOpen } from "./launcherOpen";
/**
 * Sidebar — the Arc-style left rail (ADR 0002): tab strip (pinned tiles, groups,
 * folders, split-view pairs), omnibox + suggestions, workspaces, footer panels
 * (bookmarks, extensions, downloads, shields, notes, …). Split out of App.tsx.
 */
import Downloads from "./Downloads";
import Shields from "./Shields";
import type { FooterPanel } from "./SidebarPanels";
import {
  calEvents,
  historySearch,
  isStartUrl,
  omniAnswer,
  searchResolve,
  searchSuggest,
  watchAdd,
  watchIsWatched,
  webviewBack,
  webviewForward,
  webviewReload,
  webviewStop,
  type OmniAnswerSource,
  type TabGroup,
  type TabMeta,
  type Workspace,
} from "./ipc";
import {
  activeId,
  activePanelId,
  activeTab,
  activeWorkspace,
  bookmarkBarOpen,
  findOpen,
  archivedTabs,
  archivedBranches,
  calendarPopOpen,
  calendarOverlayOpen,
  setCalendarPopOpen,
  dockOpen,
  toggleDock,
  clearTile,
  closeTab,
  containerById,
  containerColor,
  containers,
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
  isHibernated,
  isLoading,
  kbPanelOpen,
  newFolderWithTab,
  newGroupWithTab,
  omniAutoAnswer,
  openTab,
  openTabInContainer,
  panelBadges,
  panels,
  pinnedTabs,
  playgroundOpen,
  readerOpen,
  recolorGroup,
  recolorWorkspace,
  renameFolder,
  renameGroup,
  renameTab,
  renameWorkspace,
  wsRenameRequest,
  clearWorkspaceRename,
  reorderPanels,
  reorderTabs,
  searchSuggestOn,
  setSplitPickerOpen,
  setTabFolder,
  setTabGroup,
  setWatchPanelOpen,
  setTile,
  setTileLayout,
  tileGroup,
  tileGroups,
  untile,
  splitPickerOpen,
  tabLabel,
  tabs,
  toggleGroupCollapsed,
  togglePanel,
  togglePin,
  unpinnedTabs,
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
import { design } from "./design";
import { mailUnread, setTabMode, tabMode, TAB_MODES, type TabMode } from "./tabMode";
import { visibleInterval } from "./poll";
import { attachHScroll } from "./hscroll";
import RailTip, { hideTip, showTip } from "./RailTip";
import Modal from "./Modal";
import { latestQuery } from "./latestQuery";
import { lastAccessForUrl } from "./store";
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
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";

// Footer panels / overlays — lazy: their chunks load on first open (ADR 0001).
const SidebarPanels = lazy(() => import("./SidebarPanels"));
const TabModePanel = lazy(() => import("./TabModePanel"));
const BookmarkBar = lazy(() => import("./BookmarkBar"));
const OmniAnswerCard = lazy(() => import("./OmniAnswerCard"));
const Boosts = lazy(() => import("./Boosts"));
const Macros = lazy(() => import("./Macros"));
const Passwords = lazy(() => import("./Passwords"));
const FindBar = lazy(() => import("./FindBar"));
const CalendarPop = lazy(() => import("./CalendarPop"));

// The pinned web-app rail folds away like the toolbar and footer (#150), giving
// its 32px gutter back to the tab list. Persisted, default open. Kept here
// rather than in store.ts: only the sidebar reads it, and store.ts is in the
// entry chunk.
const [appRailOpen, setAppRailRaw] = createSignal(localStorage.getItem("flux.sidebar.apprail") !== "0");
function setAppRailOpen(on: boolean): void {
  setAppRailRaw(on);
  localStorage.setItem("flux.sidebar.apprail", on ? "1" : "0");
}
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
  /** The connections column (your notes, System, Trail), which Context mode
   *  holds when it's closed and can open again. */
  connectOpen: boolean;
  onToggleConnect: () => void;
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
/** An omnibox suggestion (#32): a local history hit (has `url`) or an engine suggestion. */
type Suggestion = { kind: "history" | "search"; label: string; sub?: string; url?: string };

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
  // null = not editing: show the active tab's URL. "" is a real (emptied) edit
  // and must stay empty instead of snapping back to the URL.
  const [address, setAddress] = createSignal<string | null>(null);
  const [panel, setPanel] = createSignal<FooterPanel>(null);
  // Split-view picker (#43 follow-up) — choose which open tab tiles beside this one.
  // Store-backed so the webview-gating effects can hide the page beneath it.
  const splitPicker = splitPickerOpen;
  const setSplitPicker = setSplitPickerOpen;
  const [splitQuery, setSplitQuery] = createSignal("");
  createEffect(() => {
    if (splitPicker()) setSplitQuery("");
  });
  // Page-watch (#128) — is the active page being monitored? Re-checked when the
  // active page's url changes; a memo, so title ticks and load events (each a
  // new active-tab object) don't each cost an IPC round trip.
  const [watched, setWatched] = createSignal(false);
  const watchableUrl = createMemo(() => {
    const t = activeTab();
    return t?.kind === "browser" && !isStartUrl(t.url) ? t.url : null;
  });
  createEffect(() => {
    const url = watchableUrl();
    if (url)
      void watchIsWatched(url)
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
  const splitContext = (t: TabMeta) =>
    [folders().find((f) => f.id === t.folder)?.name, groups().find((g) => g.id === t.group)?.name]
      .filter(Boolean)
      .join(" · ");
  const splitCandidates = createMemo(() => {
    // Access timestamps are intentionally lightweight; refresh ordering on open.
    splitPicker();
    const query = splitQuery().trim().toLowerCase();
    return tabs()
      .filter((t) => t.workspace === activeWorkspace() && t.id !== activeId())
      .filter((t) => !query || `${tabLabel(t)} ${t.url} ${splitContext(t)}`.toLowerCase().includes(query))
      .sort((a, b) => lastAccessForUrl(b.url) - lastAccessForUrl(a.url));
  });
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
  // Velvet Paper lays the pane out as its boards draw it: modes at the top, the
  // site's tools in the address field, find inside it, workspace chips and
  // two-line rows. Classic keeps the layout it always had.
  const vp = () => design() === "velvet-paper";
  /** Just the site, for the address field at rest. */
  const siteOf = (u: string) => {
    if (!/^https?:\/\//.test(u)) return u;
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };
  /** A tab row's second line: where the tab is, and how long it has slept. */
  const tabWhere = (t: TabMeta) => {
    const where =
      t.kind === "terminal"
        ? "Terminal"
        : t.kind === "files"
          ? "Files"
          : t.url.startsWith("flux://")
            ? "Flux"
            : siteOf(t.url);
    if (!isHibernated(t.id)) return where;
    const mins = (Date.now() - lastAccessForUrl(t.url)) / 60_000;
    const ago =
      mins < 60
        ? `${Math.max(1, Math.round(mins))} m`
        : mins < 1440
          ? `${Math.round(mins / 60)} h`
          : `${Math.round(mins / 1440)} d`;
    return lastAccessForUrl(t.url) ? `asleep ${ago} · ${where}` : `asleep · ${where}`;
  };
  // Find lives inside the address field: ⌘F (or the actions row's ⌕) turns the
  // field into the find bar until the search is cleared or the address is asked for.
  const [findFocus, setFindFocus] = createSignal(false);
  const finding = () => vp() && (findOpen() || findFocus()) && !addrFocused();
  const MODE_INFO: Record<TabMode, { label: string; icon: "tabs" | "calendar" | "mail" | "note" | "trail" }> =
    {
      tabs: { label: "Tabs", icon: "tabs" },
      calendar: { label: "Calendar", icon: "calendar" },
      mail: { label: "Mail", icon: "mail" },
      notes: { label: "Notes", icon: "note" },
      context: { label: "Context", icon: "trail" },
    };
  // The legend in the pane's edge names the mode.
  const legend = () => {
    const m = tabMode();
    if (!vp() || m === "tabs") return `Tabs · ${activeWorkspaceName()}`;
    if (m === "mail") return mailUnread() ? `Mail · Inbox · ${mailUnread()} new` : "Mail · Inbox";
    if (m === "notes") return "Notes & to-do";
    if (m === "context") return "Context · this page";
    return `Calendar · ${new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
  };
  // The switch's thumb travels to the picked segment, measured once it's laid out.
  let modesEl: HTMLDivElement | undefined;
  const [thumb, setThumb] = createSignal<{ x: number; w: number } | null>(null);
  const placeThumb = () => {
    const b = modesEl?.querySelector<HTMLElement>(".tab-mode.on");
    if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth });
  };
  // After the change has laid out (a timeout, not a frame: a hidden window gets
  // no frames, and the thumb must still be right when it's shown again).
  createEffect(on([tabMode, vp, () => props.collapsed], () => setTimeout(placeThumb, 0)));
  // A change of mode: the thumb stretches like liquid on its way and the
  // legend's new word fades in. Not on the first shape.
  let navEl: HTMLElement | undefined;
  createEffect(
    on(
      tabMode,
      () => {
        if (!vp() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        modesEl
          ?.querySelector(".tab-modes-thumb")
          ?.animate([{ scale: "1 1" }, { scale: "1.22 0.94", offset: 0.4 }, { scale: "1 1" }], {
            duration: 220,
            easing: "ease-out",
          });
        try {
          navEl?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 220,
            easing: "ease-out",
            pseudoElement: "::after",
          });
        } catch {
          /* no pseudo-element animation: the word just changes */
        }
      },
      { defer: true },
    ),
  );
  // Leaving the tabs needs the panel's chunk; it stays mounted after that.
  const [modesLoaded, setModesLoaded] = createSignal(false);
  createEffect(() => {
    if (tabMode() !== "tabs") setModesLoaded(true);
  });
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
    if (tileSel().length >= MAX_PANES) return;
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
        // Cancel a rename first: unmounting its field fires blur on WebView2,
        // which would otherwise commit it.
        setEditWs(null);
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
  const [editFolder, setEditFolder] = createSignal<number | null>(null);
  // The folder whose tabs are showing under the icon strip; one at a time.
  const [openFolderId, setOpenFolderId] = createSignal<number | null>(null);
  const openFolder = () => folders().find((f) => f.id === openFolderId());
  const [editTab, setEditTab] = createSignal<number | null>(null);
  // The tab-rename draft lives outside the row: rows are keyed on TabMeta
  // objects, so an update to the tab re-creates its row (and field) mid-edit.
  const [tabDraft, setTabDraft] = createSignal("");
  let tabDraftFrom = "";
  const beginTabRename = (t: TabMeta) => {
    tabDraftFrom = tabLabel(t);
    setTabDraft(tabDraftFrom);
    setEditTab(t.id);
  };
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

  /** A tab row's inline rename field (its draft is `tabDraft`). */
  const TabRename: Component<{ tab: TabMeta }> = (p) => {
    // Disposal runs before the old field leaves the DOM, so this is already set
    // when Chromium/WebView2 fires blur on it: a rebuilt row must not commit.
    let disposed = false;
    onCleanup(() => (disposed = true));
    return (
      <input
        class="tab-rename"
        value={tabDraft()}
        // Focused on every mount rather than by autofocus, which Chromium honours
        // once per document: a rebuilt row re-creates this field mid-edit.
        ref={(el) => queueMicrotask(() => el.focus())}
        onClick={(e) => e.stopPropagation()}
        onInput={(e) => setTabDraft(e.currentTarget.value)}
        onBlur={() => {
          // Escape already cleared editTab; a disposed field is being rebuilt.
          if (disposed || editTab() !== p.tab.id) return;
          setEditTab(null);
          const v = tabDraft().trim();
          // Unchanged → no-op: committing the shown title would store it as a
          // custom name and freeze the label across later navigations.
          if (v !== tabDraftFrom.trim()) void renameTab(p.tab.id, v);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setEditTab(null);
        }}
      />
    );
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
          if (fx > 0.6 && bothPages) {
            // setTile() rebuilds the *active* tab's group. Make the drop target
            // active first, so an unrelated split on screen isn't the one replaced.
            void focusTab(p.tab.id);
            setTile([p.tab.id, d], "cols"); // right side → split (#43)
          } else if (fy > 0.25 && fy < 0.75)
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
      <span class="tab-favicon" data-tab-id={p.tab.id}>
        {p.tab.private ? "🕶" : isHibernated(p.tab.id) && !vp() ? "💤" : <Favicon tab={p.tab} />}
      </span>
      <Show
        when={editTab() === p.tab.id}
        fallback={
          <span
            class="title"
            onDblClick={(e) => {
              e.stopPropagation();
              beginTabRename(p.tab);
            }}
          >
            {tabLabel(p.tab)}
          </span>
        }
      >
        <TabRename tab={p.tab} />
      </Show>
      <Show when={vp()}>
        <span class="tab-where">{tabWhere(p.tab)}</span>
        <Show when={isHibernated(p.tab.id)}>
          <span class="tab-moon" title="Sleeping — click to wake">
            <Icon name="moon" />
          </span>
        </Show>
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
          // Exit THIS split. clearTile() only knows the active tab's group, so on
          // any other pair it dissolved the wrong split or did nothing.
          for (const id of groupOf(p.members[0]!.id)?.tabs ?? []) untile(id);
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

  const openPanel = (p: FooterPanel) => setPanel((cur) => (cur === p ? null : p));

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

  // Omnibox AI answer card: a grounded, streamed answer from the Omni index.
  // User-initiated (the "Ask Omni" row or Alt+Enter) — never per-keystroke, so it
  // doesn't spin up the local LLM as you type. Tokens stream in over a Channel.
  type OmniAns = { text: string; sources: OmniAnswerSource[]; streaming: boolean };
  const [omniAns, setOmniAns] = createSignal<OmniAns | null>(null);
  const [addrFocused, setAddrFocused] = createSignal(false);
  let omniGen = 0; // ignore events from a superseded request
  let omniDismissTimer: number | undefined;
  const closeSuggest = () => {
    addressSearch.cancel();
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
    const q = (address() ?? "").trim();
    return q.length > 2 && !q.startsWith("flux://") && !/^[a-z]+:\/\//i.test(q);
  };

  const startOmniAnswer = (q: string) => {
    const query = q.trim();
    if (!query) return;
    const gen = ++omniGen;
    window.clearTimeout(omniDismissTimer);
    setOmniAns({ text: "", sources: [], streaming: true });
    // Settle the card however the stream ends: a `done` frame, the command
    // resolving without one (Omni hung up or timed out mid-answer), or an error.
    const finish = (ms: number) => {
      if (gen !== omniGen) return;
      setOmniAns((a) => (a ? { ...a, streaming: false } : a));
      window.clearTimeout(omniDismissTimer);
      omniDismissTimer = window.setTimeout(() => {
        if (gen === omniGen) clearOmniAns();
      }, ms);
    };
    void omniAnswer(query, (e) => {
      if (gen !== omniGen) return; // a newer ask superseded this stream
      if (e.type === "sources") setOmniAns((a) => (a ? { ...a, sources: e.sources } : a));
      else if (e.type === "token") setOmniAns((a) => (a ? { ...a, text: a.text + e.text } : a));
      else if (e.type === "done") finish(9000);
    }).then(
      () => finish(9000),
      () => finish(5000),
    );
  };

  const addressSearch = latestQuery(
    async (q) => {
      const tabId = activeId();
      const hist = await historySearch(q, 5).catch(() => []);
      const out: Suggestion[] = hist.map((h) => ({
        kind: "history",
        label: h.title || h.url,
        sub: h.url,
        url: h.url,
      }));
      // Re-check after local history resolves: focus/consent may have changed.
      if (activeId() === tabId && searchSuggestOn()) {
        const remote = await searchSuggest(q, { enabled: searchSuggestOn(), tabId }).catch(() => []);
        for (const label of remote) {
          if (out.length >= 8) break;
          if (!out.some((x) => x.label.toLowerCase() === label.toLowerCase()))
            out.push({ kind: "search", label });
        }
      }
      return out.slice(0, 8);
    },
    setSuggestions,
    () => setSuggestions([]),
    110,
  );
  onCleanup(addressSearch.cancel);
  createEffect(() => {
    activeId();
    searchSuggestOn();
    closeSuggest();
  });

  const onAddressInput = (v: string) => {
    setAddress(v);
    setSelIdx(-1);
    setSuggestions([]);
    clearOmniAns();
    const q = v.trim();
    addressSearch.search(q.startsWith("flux://") ? "" : q);
  };

  const chooseSuggestion = async (s: Suggestion) => {
    closeSuggest();
    clearOmniAns();
    setAddress(null);
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
      startOmniAnswer(address() ?? "");
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setSelIdx((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setSelIdx((i) => (i - 1 + n) % n);
    } else if (e.key === "Escape") {
      closeSuggest();
      clearOmniAns();
      setAddress(null); // revert to the page URL
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
    const v = (address() ?? "").trim();
    if (!v) return;
    setAddress(null);
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

  // Files, Playground and Notebook: in the nav row in Classic, with the footer's
  // tools in Velvet Paper.
  const pageTools = () => (
    <>
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
    </>
  );

  return (
    <nav
      ref={navEl}
      class="sidebar"
      // Velvet Paper (design.ts) sets this into the pane's top edge.
      data-legend={legend()}
      data-mode={vp() && !props.collapsed ? tabMode() : undefined}
      classList={{
        "with-apps": !props.collapsed && panels().length > 0 && appRailOpen(),
        collapsed: props.collapsed,
      }}
    >
      {/* The one hover label for every icon-only rail: the pages and TUI bars
          and this sidebar's folder icons. Mounted here because the sidebar is
          always present and the bars column can be hidden. */}
      <RailTip />
      {/* Left app rail (#48 launcher) — Opera-style: pinned web-app panels as
          icons on the sidebar's left edge; click toggles the slide-out panel. */}
      <Show when={!props.collapsed && panels().length > 0 && appRailOpen()}>
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
        <button
          class="icon-btn"
          title={shortcutLabel("Toggle sidebar (Ctrl+B)")}
          onClick={props.onToggleSidebar}
        >
          {props.collapsed ? "»" : "«"}
        </button>
        {/* Folds the pinned web-app rail. Open, it sits in the rail's own gutter
            above the icons (see .app-rail-toggle); folded, it's a plain toolbar
            button here, since the gutter it lived in is gone. */}
        <Show when={!props.collapsed && panels().length > 0}>
          <button
            classList={{ "icon-btn": true, "app-rail-toggle": appRailOpen() }}
            aria-expanded={appRailOpen()}
            title={appRailOpen() ? "Hide the web-app rail" : "Show the web-app rail"}
            onClick={() => setAppRailOpen(!appRailOpen())}
          >
            {appRailOpen() ? "‹" : "›"}
          </button>
        </Show>
        <Show when={props.collapsed}>
          <button
            class="icon-btn"
            aria-label="Open launcher"
            title="Open launcher"
            onClick={() => setLauncherOpen(true)}
          >
            <Icon name="omni" />
          </button>
        </Show>
        {/* The nav tools fold away (#150). The sidebar-toggle above stays put in
            both states — folding must never be a way to lose the control that
            unfolds, and the caret at the end of the row is the other half of
            that contract. */}
        <Show when={!props.collapsed && toolbarOpen()}>
          <button
            class="icon-btn"
            title={shortcutLabel("Back (Alt+←)")}
            onClick={() => navActive(webviewBack)}
          >
            ‹
          </button>
          <button
            class="icon-btn"
            title={shortcutLabel("Forward (Alt+→)")}
            onClick={() => navActive(webviewForward)}
          >
            ›
          </button>
          <Show
            when={isLoading(activeId())}
            fallback={
              <button
                class="icon-btn"
                title={shortcutLabel("Reload (Ctrl+R)")}
                onClick={() => navActive(webviewReload)}
              >
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
          {/* Velvet Paper keeps these three with the other tools in the footer. */}
          <Show when={!vp()}>{pageTools()}</Show>
        </Show>
        {/* Directly after the tools, not pushed to the right end by a flex
            spacer: the row wraps, and a spacer would strand the caret alone on
            a line of its own. */}
        <Show when={!props.collapsed}>
          {/* Outside the fold: the launcher is how you reach every page and
              app, so hiding the toolbar mustn't hide it. */}
          <button
            class="icon-btn"
            aria-label="Open launcher"
            title="Launcher — pages & apps"
            onClick={() => {
              setPicker(false);
              setLauncherOpen(true);
            }}
          >
            <Icon name="omni" />
          </button>
          <button
            class="icon-btn sidebar-fold"
            title={toolbarOpen() ? "Hide the toolbar" : "Show the toolbar"}
            onClick={() => setToolbarOpen(!toolbarOpen())}
          >
            {toolbarOpen() ? "▴" : "▾"}
          </button>
        </Show>
      </div>
      {/* Modes (Velvet Paper): the pane is the tab list, a calendar or the inbox.
          The thumb travels to the picked segment; leaving the tabs folds the
          list into a rail of favicons beside the mode's panel (TabModePanel). */}
      <Show when={vp() && !props.collapsed}>
        <div
          class="tab-modes"
          role="tablist"
          aria-label="Tabs pane"
          ref={(el) => {
            modesEl = el;
            const ro = new ResizeObserver(placeThumb);
            ro.observe(el);
            onCleanup(() => ro.disconnect());
          }}
        >
          <span
            class="tab-modes-thumb"
            aria-hidden="true"
            style={
              thumb()
                ? { transform: `translateX(${thumb()!.x}px)`, width: `${thumb()!.w}px` }
                : { opacity: 0 }
            }
          />
          <For each={TAB_MODES}>
            {(m, i) => (
              <button
                role="tab"
                classList={{ "tab-mode": true, on: tabMode() === m }}
                aria-selected={tabMode() === m}
                title={`${MODE_INFO[m].label} (${shortcutLabel(`Alt+${i() + 1}`)})`}
                onClick={() => setTabMode(m)}
              >
                <Icon name={MODE_INFO[m].icon} />
                <span class="tab-mode-label">{MODE_INFO[m].label}</span>
                <Show when={m === "calendar" && calSoon()}>
                  <span class="tab-mode-dot" title="An event starts within 30 minutes" />
                </Show>
                <Show when={m === "mail" && (mailUnread() ?? 0) > 0}>
                  <span class="tab-mode-count">{mailUnread()! > 99 ? "99+" : mailUnread()}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!props.collapsed}>
        {/* Address / search pill. In Velvet Paper the find bar shares its place:
            it takes the field over while a search is on (see `finding`). */}
        <div
          classList={{ "addr-stack": true, finding: finding() }}
          style={vp() ? undefined : { display: "contents" }}
          onFocusIn={(e) => {
            if ((e.target as HTMLElement).id === "flux-find") setFindFocus(true);
          }}
          onFocusOut={(e) => {
            if ((e.target as HTMLElement).id === "flux-find") setFindFocus(false);
          }}
        >
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
              value={address() ?? (vp() && !addrFocused() ? siteOf(currentUrl()) : currentUrl())}
              onInput={(e) => onAddressInput(e.currentTarget.value)}
              onFocus={(e) => {
                // Focused first: in Velvet Paper that swaps the site for the full
                // address, and the selection has to cover what's then in the field.
                setAddrFocused(true);
                e.currentTarget.select();
              }}
              onKeyDown={onAddressKeyDown}
              onBlur={() => {
                setAddrFocused(false);
                setTimeout(closeSuggest, 150);
              }}
              placeholder={shortcutLabel("Search or enter address  (Ctrl+L)")}
              spellcheck={false}
              autocomplete="off"
            />
            {/* Velvet Paper: the page's own tools sit inside the field. */}
            <Show when={vp()}>
              <span class="addr-tray">
                <Show when={isWebPage()}>
                  <button
                    type="button"
                    classList={{ "icon-btn": true, "bm-star": true, active: props.isBookmarked() }}
                    title={shortcutLabel(
                      props.isBookmarked()
                        ? "Bookmarked — click to remove (Ctrl+D)"
                        : "Bookmark this page (Ctrl+D)",
                    )}
                    onClick={() => props.onToggleBookmark()}
                  >
                    {props.isBookmarked() ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    classList={{ "icon-btn": true, active: readerOpen() }}
                    title="Reader mode"
                    onClick={() => props.onToggleReader()}
                  >
                    <Icon name="reader" />
                  </button>
                </Show>
                <Shields onNavigate={props.onNavigate} />
              </span>
            </Show>
            {/* Per-site zoom (#36): shown only when ≠ 100%; click to reset. */}
            <Show when={activeZoom() !== 1}>
              <button
                type="button"
                class="zoom-pill"
                title={shortcutLabel("Reset zoom (Ctrl+0)")}
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
                {/* Streamed, grounded answer from the Omni index (lazy: drawn once asked). */}
                <Show when={omniAns()}>
                  {(a) => (
                    <Suspense>
                      <OmniAnswerCard ans={a()} onDismiss={clearOmniAns} onNavigate={props.onNavigate} />
                    </Suspense>
                  )}
                </Show>
                {/* Ask trigger (until an answer exists for this query). */}
                <Show when={omniAns() === null && canAsk()}>
                  <button
                    type="button"
                    class="omni-sug omni-ask"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      startOmniAnswer(address() ?? "");
                    }}
                  >
                    <span class="omni-sug-icon">✦</span>
                    <span class="omni-sug-text">
                      <span class="omni-sug-label">Ask Omni: {(address() ?? "").trim()}</span>
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
        </div>

        {/* Page actions row, below the address bar. Split view applies to *any*
            page — Flux's own pages, a terminal, a file browser — so the row shows
            for every tab and only the web-page actions (bookmark, reader, capture,
            translate…) are gated. It used to be gated as a whole, which left an
            internal page with no ◫ at all and tileable only from the palette. */}
        <Show when={activeTab()}>
          <div class="page-actions">
            <Show when={isWebPage() && !vp()}>
              <button
                type="button"
                classList={{ "icon-btn": true, "bm-star": true, active: props.isBookmarked() }}
                title={shortcutLabel(
                  props.isBookmarked()
                    ? "Bookmarked — click to remove (Ctrl+D)"
                    : "Bookmark this page (Ctrl+D)",
                )}
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
            <Show when={vp()}>
              <button
                type="button"
                class="icon-btn"
                title={shortcutLabel("Find in page (Ctrl+F)")}
                onClick={() => document.getElementById("flux-find")?.focus()}
              >
                <Icon name="find" />
              </button>
            </Show>
            <Show when={isWebPage()}>
              <Show when={!vp()}>
                <button
                  type="button"
                  classList={{ "icon-btn": true, active: readerOpen() }}
                  title="Reader mode"
                  onClick={() => props.onToggleReader()}
                >
                  <Icon name="reader" />
                </button>
              </Show>
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
                title={shortcutLabel("Save this page to Omni (Ctrl+Shift+O)")}
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
          <Modal
            label="Split view"
            backdropClass="split-picker-backdrop"
            class="split-picker glass"
            onClose={() => setSplitPicker(false)}
          >
            <div class="split-picker-head">
              ◫ Tile up to {MAX_PANES} pages
              <Show when={tileGroup()}>
                <button class="split-picker-clear" onClick={() => clearTile()}>
                  Exit split
                </button>
              </Show>
            </div>
            <input
              class="split-picker-search"
              data-autofocus
              aria-label="Search tabs to split"
              placeholder="Search tabs, sites or groups…"
              value={splitQuery()}
              onInput={(e) => setSplitQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && splitCandidates().length) {
                  e.preventDefault();
                  toggleTiled(splitCandidates()[0]!.id);
                }
              }}
            />
            {/* Layout row — only meaningful once two panes are chosen. */}
            <Show when={(tileGroup()?.tabs.length ?? 0) >= 2}>
              <div class="split-picker-layouts">
                <For each={layoutsFor(tileGroup()!.tabs.length)}>
                  {(l) => (
                    <button
                      classList={{ "split-layout": true, on: tileGroup()?.layout === l }}
                      aria-pressed={tileGroup()?.layout === l}
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
                fallback={
                  <div class="split-picker-empty" role="status">
                    {splitQuery()
                      ? "No matching tabs. Try another search."
                      : "No other pages open to split with."}
                  </div>
                }
              >
                {(t) => (
                  <button
                    classList={{ "split-picker-item": true, on: tileSel().includes(t.id) }}
                    aria-pressed={tileSel().includes(t.id)}
                    disabled={!tileSel().includes(t.id) && tileSel().length >= MAX_PANES}
                    onClick={() => toggleTiled(t.id)}
                  >
                    <Favicon tab={t} />
                    <span class="split-picker-text">
                      <span class="split-picker-label">{tabLabel(t)}</span>
                      <span class="split-picker-context">{splitContext(t) || t.url}</span>
                    </span>
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
            </div>
            <div class="split-picker-actions">
              <button
                class="split-picker-item split-picker-new"
                disabled={tileSel().length >= MAX_PANES}
                onClick={doSplitNew}
              >
                <span class="split-picker-newico">＋</span>
                <span class="split-picker-label">New blank tab</span>
              </button>
              <button class="split-picker-clear" onClick={() => setSplitPicker(false)}>
                Done
              </button>
            </div>
          </Modal>
        </Show>

        {/* Workspaces as chips (Velvet Paper): one click to switch; right-click
            opens the workspace panel to rename, recolour or delete. */}
        <Show when={vp()}>
          <div class="ws-chips hscroll" ref={(el) => onCleanup(attachHScroll(el))}>
            <For each={workspaces()}>
              {(w) => (
                <button
                  classList={{ "ws-chip": true, on: w.id === activeWorkspace() }}
                  style={{ "--ws-color": workspaceColor(w) }}
                  title={`${w.name} — right-click to rename, recolour or delete`}
                  onClick={() => props.onSwitchWorkspace(w.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!wsPanelOpen())
                      document.querySelector<HTMLButtonElement>(".sidebar .ws-btn")?.click();
                  }}
                >
                  {w.name}
                </button>
              )}
            </For>
            <button
              class="ws-chip add"
              title="New workspace"
              aria-label="New workspace"
              onClick={() => props.onNewWorkspace()}
            >
              +
            </button>
          </div>
        </Show>

        {/* Pinned tiles (Arc Favorites) */}
        <Show when={pinnedTabs().length > 0}>
          <div class="pin-grid">
            <For each={pinnedTabs()}>
              {(tab) => (
                <button
                  classList={{ "pin-tile": true, active: activeId() === tab.id }}
                  data-tab-id={tab.id}
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

        {/* Bookmarks (Velvet Paper): the bookmark bar as one row of chips under the
            pinned tiles, folders opening downward, so the page card keeps the
            full height. Classic docks it under the card. Same Settings switch. */}
        <Show when={vp() && bookmarkBarOpen()}>
          <Suspense>
            <BookmarkBar onNavigate={props.onNavigate} inPane />
          </Suspense>
        </Show>

        {/* New tab */}
        <div
          class="new-tab-control"
          onKeyDown={(e) => {
            if (e.key === "Escape" && picker()) {
              e.preventDefault();
              e.stopPropagation();
              setPicker(false);
              e.currentTarget.querySelector<HTMLButtonElement>(".new-tab-options")?.focus();
            }
          }}
        >
          <button class="new-tab-primary" onClick={() => void create("browser")}>
            + New tab
          </button>
          <button
            class="new-tab-options"
            aria-label="More tab types"
            aria-expanded={picker()}
            aria-controls="new-tab-options"
            onClick={() => setPicker((v) => !v)}
          >
            ▾
          </button>
          <Show when={picker()}>
            <div id="new-tab-options" class="glass popover" style={{ top: "calc(100% + 6px)", left: 0 }}>
              <button onClick={() => create("browser")}>
                🌐 Browser tab <kbd>{shortcutLabel("Ctrl+T")}</kbd>
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
                            if (editGroup() !== g.id) return; // Escape cancelled it
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
                  const tab = t();
                  closeCtx();
                  beginTabRename(tab);
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
                  never offered it either. Not offered for a tab already tiled
                  with the current one: toggleTiled would take it OUT, dissolving
                  a two-pane split. A full split disables it, as in the picker. */}
              <Show when={activeTab() != null && activeId() !== t().id && !tileSel().includes(t().id)}>
                <div class="ctx-sep" />
                <button
                  disabled={tileSel().length >= MAX_PANES}
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
                    data-tab-id={tab.id}
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
                    data-tab-id={tab.id}
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
                        if (editWs() !== w.id) return; // Escape cancelled it
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

      {/* Tab folders — parking buckets above the footer. Members are kept
          hibernated (≈0 RAM); click one to wake + view it. The strip is icons
          only, named on hover; a click opens that folder's tabs beneath it. */}
      <Show when={!props.collapsed && folders().length > 0}>
        <div class="folders">
          <div class="folder-chips hscroll" ref={(el) => onCleanup(attachHScroll(el))}>
            <For each={folders()}>
              {(f) => {
                const label = () => {
                  const n = folderTabs(f.id).length;
                  return `${f.name} · ${n} tab${n === 1 ? "" : "s"}`;
                };
                return (
                  <button
                    classList={{ "folder-chip": true, open: openFolderId() === f.id }}
                    title={label()}
                    aria-label={label()}
                    aria-expanded={openFolderId() === f.id}
                    onMouseEnter={(e) => showTip(e.currentTarget, label())}
                    onMouseLeave={hideTip}
                    onClick={() => {
                      hideTip();
                      setEditFolder(null);
                      setOpenFolderId(openFolderId() === f.id ? null : f.id);
                    }}
                  >
                    <Icon name="files" />
                  </button>
                );
              }}
            </For>
          </div>
          <Show when={openFolder()}>
            {(f) => {
              const members = () => folderTabs(f().id);
              return (
                <div class="folder">
                  <div class="folder-head">
                    <Show
                      when={editFolder() === f().id}
                      fallback={
                        <span class="folder-name" onDblClick={() => setEditFolder(f().id)}>
                          {f().name}
                        </span>
                      }
                    >
                      <input
                        class="folder-rename"
                        value={f().name}
                        autofocus
                        onBlur={(e) => {
                          if (editFolder() !== f().id) return; // Escape cancelled it
                          const v = e.currentTarget.value.trim();
                          if (v) void renameFolder(f().id, v);
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
                    <button class="folder-edit" title="Rename folder" onClick={() => setEditFolder(f().id)}>
                      ✎
                    </button>
                    <button
                      class="folder-x"
                      title="Delete folder (tabs return to the strip)"
                      onClick={() => {
                        setOpenFolderId(null);
                        void deleteFolder(f().id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div class="folder-tabs">
                    <For each={members()} fallback={<div class="folder-empty">Empty folder</div>}>
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
                </div>
              );
            }}
          </Show>
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
            title={shortcutLabel("Terminal (Ctrl+`)")}
            onClick={props.onToggleTerminal}
          >
            <Icon name="terminal" />
          </button>
          <button
            classList={{ "icon-btn": true, active: editorColOpen() }}
            title={shortcutLabel("Editor / Nvim Column (Ctrl+Shift+E)")}
            onClick={() => setEditorColOpen(!editorColOpen())}
          >
            <Icon name="editor" />
          </button>
          <button
            classList={{ "icon-btn": true, active: props.agentOpen }}
            title={shortcutLabel("Flux Agent (Ctrl+Shift+A)")}
            onClick={props.onToggleAgent}
          >
            <Icon name="agent" />
          </button>
          {/* Velvet Paper: Calendar and Mail are the pane's modes (the switch at the
              top, which also reaches the overlay and the column), Shields sits in
              the address field, and Files/Playground/Notebook join the tools. */}
          <Show when={vp()}>{pageTools()}</Show>
          <Show when={!vp()}>
            {/* Calendar (#114 follow-up): glanceable agenda from anywhere. The dot
            marks an event starting within 30 minutes. Popover body is lazy. */}
            <button
              classList={{ "icon-btn": true, active: calendarPopOpen() }}
              title={shortcutLabel("Calendar — today & upcoming (also in Ctrl+K)")}
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
              title={shortcutLabel(
                dockOpen()
                  ? "Hide the calendar + mail column"
                  : "Calendar + mail in their own column (also in Ctrl+K)",
              )}
              onClick={() => toggleDock()}
            >
              <Icon name="mail" />
            </button>
          </Show>
          {/* Overlay mode only — the docked pane renders inside the web-panel
            column (WebPanelPane) so it sits beside the page, not over it. */}
          <Show when={calendarOverlayOpen()}>
            <CalendarPop />
          </Show>
          <Show when={!vp()}>
            <Shields onNavigate={props.onNavigate} />
          </Show>
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
            onClick={() => openPanel("notes")}
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
          <Suspense>
            <SidebarPanels
              panel={panel}
              onClose={() => setPanel(null)}
              onNavigate={props.onNavigate}
              onSwitchWorkspace={props.onSwitchWorkspace}
            />
          </Suspense>
        </Show>
      </div>
      {/* Calendar and Mail (Velvet Paper). Lazy, and kept once loaded so the next
          switch can morph straight away; it lays itself over the list between
          the switch and the footer, so the list underneath never re-renders. */}
      <Show when={vp() && !props.collapsed && modesLoaded()}>
        <Suspense>
          <TabModePanel
            onNavigate={props.onNavigate}
            connectOpen={props.connectOpen}
            onToggleConnect={props.onToggleConnect}
          />
        </Suspense>
      </Show>
    </nav>
  );
};

export default Sidebar;
