/**
 * The command palette's actions (BACKLOG #6), also the spotlight's toolbar.
 * Built here, inside the lazily loaded palette and spotlight chunks, from a
 * context of App's own signals and handlers: the list is ~1.8 KB gzip of
 * labels and closures that nothing needs until one of them opens.
 */
import type { Accessor, Setter } from "solid-js";

import { askConfirm } from "./ask";
import { design } from "./design";
import { setIndexerPanelOpen } from "./indexerOpen";
import {
  APPS_URL,
  ARCHIVE_URL,
  BOOKMARKS_URL,
  FEEDS_URL,
  HISTORY_URL,
  NOTEBOOK_URL,
  OMNI_URL,
  PERMISSIONS_URL,
  RESOURCES_URL,
  SCRIBE_URL,
  SENTINEL_URL,
  SESSIONS_URL,
  SETTINGS_URL,
  SPEEDTEST_URL,
  SYNC_URL,
  TASKS_URL,
  TRAIL_URL,
  VAULT_URL,
  WHITEBOARD_URL,
  bookmarksImportGecko,
  geckoImportPreview,
  webviewReload,
  type TabMeta,
} from "./ipc";
import { setLauncherOpen } from "./launcherOpen";
import { LAYOUT_PRESETS, type LayoutPreset, type LayoutState } from "./layout";
import {
  activeId,
  activeWorkspace,
  appDockOpen,
  bookmarkBarOpen,
  browserTabsIn,
  clearTile,
  closeTab,
  closeTabs,
  dockOpen,
  editorColOpen,
  openMessagingPanel,
  openTab,
  pagesBarOpen,
  requestWorkspaceRename,
  setAppDockOpen,
  setBookmarkBarOpen,
  setCalendarPopOpen,
  setEditorColOpen,
  setPagesBarOpen,
  setPendingLens,
  setSemFindOpen,
  setShellHistOpen,
  setSplitPickerOpen,
  setTrackerGraphOpen,
  setWatchPanelOpen,
  tileGroup,
  toggleDock,
} from "./store";

export type PaletteAction = { id: string; label: string; icon: string; run: () => void };

/** What the actions need from App: the signals and handlers it owns. */
export type PaletteContext = {
  go: (url: string) => void;
  toggleBookmark: () => void;
  setTerminalOpen: Setter<boolean>;
  connectOpen: Accessor<boolean>;
  setConnectOpen: Setter<boolean>;
  orbOn: Accessor<boolean>;
  setOrbOn: Setter<boolean>;
  setSidebarOpen: Setter<boolean>;
  setAgentOpen: Setter<boolean>;
  setFocusMode: Setter<boolean>;
  openSpotlight: () => void;
  openFind: () => void;
  toggleReader: () => void;
  dispatch: (action: string) => boolean;
  capturePage: () => void;
  saveToArchive: () => void;
  installApp: () => void;
  newWorkspace: () => Promise<void>;
  myLang: string;
  translatePage: (lang: string) => Promise<void>;
  chooseLayout: (preset: LayoutPreset) => void;
  previousLayout: Accessor<LayoutState | null>;
  restoreLayout: () => void;
  sleepBackgroundTabs: () => void;
  navActive: (fn: (id: number) => Promise<unknown>) => void;
  toast: (text: string, kind?: "info" | "ok" | "warn", ms?: number) => void;
};

/** Actions offered by the palette (tab-switching + history are built in). Reads
 *  signals for the toggles' labels, so call it inside a tracking scope. */
export function paletteActions(ctx: PaletteContext): PaletteAction[] {
  const {
    go,
    toggleBookmark,
    setTerminalOpen,
    connectOpen,
    setConnectOpen,
    orbOn,
    setOrbOn,
    setSidebarOpen,
    setAgentOpen,
    setFocusMode,
    openSpotlight,
    openFind,
    toggleReader,
    dispatch,
    capturePage,
    saveToArchive,
    installApp,
    newWorkspace,
    myLang,
    translatePage,
    chooseLayout,
    previousLayout,
    restoreLayout,
    sleepBackgroundTabs,
    navActive,
    toast,
  } = ctx;
  const vp = design() === "velvet-paper";

  /** Confirm, close, and say what happened + how to undo. */
  const closeMany = async (targets: TabMeta[], where: string) => {
    const n = targets.length;
    if (!n) {
      toast(`No tabs open ${where}.`);
      return;
    }
    const undoable = Math.min(n, 25);
    const ok = await askConfirm({
      title: `Close ${n} tab${n === 1 ? "" : "s"} ${where}?`,
      hint:
        n > undoable
          ? `Ctrl+Shift+T can reopen the last ${undoable} of them, one at a time.`
          : "Ctrl+Shift+T reopens them one at a time.",
      confirm: "Close",
    });
    if (!ok) return;
    const closed = await closeTabs(targets.map((t) => t.id));
    toast(`Closed ${closed} tab${closed === 1 ? "" : "s"}`, "ok");
  };

  return [
    { id: "launcher", label: "Open launcher", icon: "⌕", run: () => setLauncherOpen(true) },
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
      id: "import-zen",
      label: "Import bookmarks from Zen",
      icon: "🔖",
      // The profile Zen opens, straight in; Bookmarks → Import… lists the others.
      run: () =>
        void geckoImportPreview()
          .then((all) => {
            const zen =
              all.find((p) => p.browser === "Zen" && p.in_use) ?? all.find((p) => p.browser === "Zen");
            if (!zen) {
              toast("No Zen profile found on this machine.", "warn");
              return;
            }
            return bookmarksImportGecko(zen.dir, "Zen").then((n) => {
              window.dispatchEvent(new Event("flux:bookmarks-changed"));
              toast(
                n
                  ? `Imported ${n} bookmark${n === 1 ? "" : "s"} from Zen (${zen.name}), under “Zen”.`
                  : `Nothing new: your Zen bookmarks are already here.`,
                "ok",
              );
            });
          })
          .catch((e) => toast(`Couldn't import from Zen: ${String(e).replace(/^Error:\s*/, "")}`, "warn")),
    },
    // Bookmarking the current page was reachable only by Ctrl+D — no palette
    // entry, so it was undiscoverable and unusable from the spotlight.
    { id: "bookmark-page", label: "Bookmark this page", icon: "🔖", run: () => toggleBookmark() },
    {
      id: "bookmark-bar",
      label: bookmarkBarOpen() ? "Hide bookmark bar" : "Show bookmark bar",
      icon: "🔖",
      run: () => setBookmarkBarOpen(!bookmarkBarOpen()),
    },
    {
      id: "pages-bar",
      label: pagesBarOpen() ? "Hide launcher column" : "Show launcher column",
      icon: "🗂️",
      run: () => setPagesBarOpen(!pagesBarOpen()),
    },
    {
      id: "editor-col",
      label: editorColOpen() ? "Hide editor column" : "Show editor column",
      icon: "📝",
      run: () => setEditorColOpen(!editorColOpen()),
    },
    {
      id: "app-dock",
      label: appDockOpen() ? "Collapse app dock" : "Expand app dock",
      icon: "⌘",
      run: () => setAppDockOpen(!appDockOpen()),
    },
    {
      id: "connect-rail",
      label: connectOpen() ? "Hide connections rail" : "Show connections rail",
      icon: "✦",
      run: () => setConnectOpen(!connectOpen()),
    },
    // Velvet Paper has no orb (the Indexer opens from the Context column).
    ...(vp
      ? []
      : [
          {
            id: "indexer-orb",
            label: orbOn() ? "Hide the Indexer orb" : "Show the Indexer orb",
            icon: "🔮",
            run: () => setOrbOn(!orbOn()),
          },
        ]),
    {
      id: "indexer-ask",
      label: "Ask your notes (Indexer)",
      icon: "🔮",
      run: () => {
        setOrbOn(true);
        setIndexerPanelOpen(true);
      },
    },
    { id: "sessions", label: "Open Sessions", icon: "🗃", run: () => go(SESSIONS_URL) },
    { id: "passwords", label: "Open Passwords", icon: "🔑", run: () => go(VAULT_URL) },
    { id: "omni", label: "Open Omni index", icon: "✦", run: () => go(OMNI_URL) },
    { id: "notebook", label: "Open Notebook (ask your notes)", icon: "✦", run: () => go(NOTEBOOK_URL) },
    { id: "trail", label: "Open the Trail (your browsing graph)", icon: "🧭", run: () => go(TRAIL_URL) },
    { id: "whiteboard", label: "Open whiteboard", icon: "🎨", run: () => go(WHITEBOARD_URL) },
    { id: "scribe", label: "Open Scribe (handwritten notebooks)", icon: "✍️", run: () => go(SCRIBE_URL) },
    {
      id: "calendar",
      label: "Open calendar (today & upcoming)",
      icon: "📅",
      // Velvet Paper's calendar is a mode of the tab bar; Classic's is the popover.
      run: () => {
        if (vp) return void dispatch("mode-calendar");
        setSidebarOpen(true);
        setCalendarPopOpen(true);
      },
    },
    { id: "discord", label: "Open Discord panel", icon: "💬", run: () => void openMessagingPanel("discord") },
    { id: "teams", label: "Open Teams panel", icon: "💬", run: () => void openMessagingPanel("teams") },
    {
      id: "spotlight",
      label: "Search the web (spotlight)",
      icon: "⌕",
      run: () => openSpotlight(),
    },
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
      id: "dock-col",
      label: dockOpen() ? "Hide calendar + mail column" : "Show calendar + mail column",
      icon: "🗓",
      run: () => toggleDock(),
    },
    {
      id: "split",
      label: tileGroup() != null ? "Exit split view" : "Split view (tile up to four tabs)",
      icon: "◫",
      run: () => (tileGroup() != null ? clearTile() : setSplitPickerOpen(true)),
    },
    { id: "reader", label: "Reader mode", icon: "📖", run: () => toggleReader() },
    { id: "focus", label: "Focus mode (hide chrome)", icon: "⤢", run: () => dispatch("focus-mode") },
    { id: "capture", label: "Capture page (screenshot)", icon: "📸", run: () => capturePage() },
    { id: "resources", label: "Open Resource monitor", icon: "📊", run: () => go(RESOURCES_URL) },
    { id: "tasks", label: "Open Task manager", icon: "🗂️", run: () => go(TASKS_URL) },
    { id: "speedtest", label: "Network speed test", icon: "⚡", run: () => go(SPEEDTEST_URL) },
    { id: "permissions", label: "Site permissions", icon: "🔐", run: () => go(PERMISSIONS_URL) },
    { id: "sentinel", label: "Agent activity log", icon: "🛡", run: () => go(SENTINEL_URL) },
    // Workspaces had no palette entry at all, and rename was a double-click on a
    // hover popover — effectively undiscoverable.
    {
      id: "ws-rename",
      label: "Rename workspace",
      icon: "✎",
      run: () => {
        setFocusMode(false); // the rail is hidden in focus mode
        setSidebarOpen(true); // …and when the sidebar is collapsed
        requestWorkspaceRename(activeWorkspace());
      },
    },
    { id: "ws-new", label: "New workspace", icon: "🗂", run: () => void newWorkspace() },
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
    ...Object.entries(LAYOUT_PRESETS).map(([id, preset]) => ({
      id: `layout-${id}`,
      label: `Use ${preset.label} layout`,
      icon: "▦",
      run: () => chooseLayout(id as LayoutPreset),
    })),
    ...(previousLayout()
      ? [{ id: "layout-restore", label: "Restore previous layout", icon: "↶", run: restoreLayout }]
      : []),
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
    // Bulk closes confirm, and say the count: restoring a session opens dozens
    // of tabs across workspaces, and the reopen stack only holds 25 — so past
    // that this isn't fully undoable and shouldn't happen on a mis-click.
    {
      id: "close-workspace-tabs",
      label: "Close all tabs in this workspace",
      icon: "✕",
      run: () => void closeMany(browserTabsIn(activeWorkspace()), "in this workspace"),
    },
    {
      id: "close-all-tabs",
      label: "Close every tab (all workspaces)",
      icon: "✕",
      run: () => void closeMany(browserTabsIn(), "across all workspaces"),
    },
  ];
}
