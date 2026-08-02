/**
 * Flux's own pages, rendered as DOM.
 *
 * Extracted from ContentArea so more than one surface can host them. A web page
 * is a native webview the chrome positions; a `flux://` page is a Solid component
 * with no URL for a webview to load — which is why "pin the Trail as a web panel"
 * needed this to exist rather than being a URL change.
 *
 * Parameterized by tab, not by "the active tab": split view renders several of
 * these at once, and the web-panel column renders one that isn't active at all.
 * Every component here is lazy, so a surface pays only for the page it shows.
 */
import { Match, Show, Switch, createEffect, lazy, onCleanup, onMount, type Component } from "solid-js";

import {
  isStartUrl,
  APPS_URL,
  ARCHIVE_URL,
  BOOKMARKS_URL,
  FEEDS_URL,
  HISTORY_URL,
  NOTEBOOK_URL,
  OMNI_URL,
  PDF_URL,
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
} from "./ipc";
import { domPublishInternal } from "./ipc";
import { tabs, updateTabTitle, updateTabUrl } from "./store";
import { basename } from "./tabvisual";
import type { TabMeta } from "./ipc";

const AppsPage = lazy(() => import("./AppsPage"));
const ArchivePage = lazy(() => import("./ArchivePage"));
const BookmarksPage = lazy(() => import("./BookmarksPage"));
const FeedsPage = lazy(() => import("./FeedsPage"));
const FilesView = lazy(() => import("./FilesView"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const NotebookPage = lazy(() => import("./NotebookPage"));
const OmniDashboard = lazy(() => import("./OmniDashboard"));
const PdfViewer = lazy(() => import("./PdfViewer"));
const PermissionsPage = lazy(() => import("./PermissionsPage"));
const ResourcesPage = lazy(() => import("./ResourcesPage"));
const ScribePage = lazy(() => import("./ScribePage"));
const SentinelAuditPage = lazy(() => import("./SentinelAuditPage"));
const SessionsPage = lazy(() => import("./SessionsPage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const SpeedtestPage = lazy(() => import("./SpeedtestPage"));
const StartPage = lazy(() => import("./StartPage"));
const SyncPage = lazy(() => import("./SyncPage"));
const TasksPage = lazy(() => import("./TasksPage"));
const TrailPage = lazy(() => import("./TrailPage"));
const VaultPage = lazy(() => import("./VaultPage"));
const WhiteboardPage = lazy(() => import("./WhiteboardPage"));

export type InternalPageProps = {
  /** The tab to render. An accessor so navigation stays reactive without
   *  remounting the page component. */
  tab: () => TabMeta | null | undefined;
  onNavigate: (url: string) => void;
  onNewTerminal: () => void;
  onToggleAgent: () => void;
  onOpenMap: () => void;
  onSleepBackground: () => void;
};

/** True when this tab has an internal page at all — i.e. rendering it here shows
 *  something rather than the placeholder a native webview covers. */
export const isInternalPage = (url: string | undefined | null): boolean => !!url && isStartUrl(url);

/** Longest snapshot we'll send. Matches what the backend caps at anyway, and
 *  keeps a long Files listing from dominating the agent's context. */
const MAX_TEXT = 40_000;
/** A live page (the task manager, the speedtest) mutates constantly; without a
 *  floor it would republish forever. */
const MIN_INTERVAL_MS = 5_000;

const InternalPage: Component<InternalPageProps> = (props) => {
  const tab = () => props.tab();

  // ── make Flux's own pages readable by the agent (#108 follow-up) ──
  //
  // `display: contents` so this wrapper adds no box and cannot affect any page's
  // layout; the text is read from its children, which are the real page roots.
  let host: HTMLDivElement | undefined;
  let timer: number | undefined;
  let lastText = "";
  let lastAt = 0;

  const publish = () => {
    const t = tab();
    if (!t || !host) return;
    const text = Array.from(host.children)
      .map((c) => (c as HTMLElement).innerText ?? "")
      .join("\n")
      .trim()
      .slice(0, MAX_TEXT);
    // Unchanged text is not worth an IPC round trip, and a live-updating page
    // would otherwise republish on every tick.
    if (!text || text === lastText || Date.now() - lastAt < MIN_INTERVAL_MS) return;
    lastText = text;
    lastAt = Date.now();
    void domPublishInternal(t.id, t.url, text).catch(() => {});
  };

  const schedule = () => {
    clearTimeout(timer);
    // Long enough that a page still settling (lazy chunk, first fetch) is read
    // once it has something to say, rather than while it says "loading…".
    timer = window.setTimeout(publish, 900);
  };

  onMount(() => {
    const mo = new MutationObserver(schedule);
    if (host) mo.observe(host, { childList: true, subtree: true, characterData: true });
    schedule();
    onCleanup(() => {
      mo.disconnect();
      clearTimeout(timer);
    });
  });
  // Navigating this surface to another internal page is a different document.
  createEffect(() => {
    tab()?.url;
    lastText = "";
    lastAt = 0;
    schedule();
  });

  return (
    <div ref={host} style={{ display: "contents" }}>
      <Switch
        fallback={
          <span style={{ "text-align": "center", "line-height": 1.8 }}>
            <strong style={{ color: "var(--flux-text)" }}>{tab()?.title || "Flux"}</strong>
            <br />
            loading…
          </span>
        }
      >
        <Match when={tab()?.kind === "files"}>
          {/* Key on the tab id (stable) so navigation patching the tab object doesn't
          remount FilesView into a reload loop — only a tab switch should. */}
          <Show when={tab()?.id} keyed>
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
        <Match when={tab()?.url === OMNI_URL}>
          <OmniDashboard onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === NOTEBOOK_URL}>
          <NotebookPage />
        </Match>
        <Match when={tab()?.url === TRAIL_URL}>
          <TrailPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === WHITEBOARD_URL}>
          <WhiteboardPage />
        </Match>
        <Match when={tab()?.url === SCRIBE_URL}>
          <ScribePage />
        </Match>
        <Match when={tab()?.url === VAULT_URL}>
          <VaultPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === HISTORY_URL}>
          <HistoryPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === BOOKMARKS_URL}>
          <BookmarksPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === SESSIONS_URL}>
          <SessionsPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === RESOURCES_URL}>
          <ResourcesPage onNavigate={props.onNavigate} onSleepBackground={props.onSleepBackground} />
        </Match>
        <Match when={tab()?.url === TASKS_URL}>
          <TasksPage />
        </Match>
        <Match when={tab()?.url === SPEEDTEST_URL}>
          <SpeedtestPage />
        </Match>
        <Match when={tab()?.url === PERMISSIONS_URL}>
          <PermissionsPage />
        </Match>
        <Match when={tab()?.url === SENTINEL_URL}>
          <SentinelAuditPage />
        </Match>
        <Match when={tab()?.url?.startsWith(PDF_URL)}>
          {/* Keyed on the tab id (a primitive — never the tab object, which would
          remount in a loop) so each PDF tab gets its OWN viewer. Sharing one
          instance made every PDF tab show whichever file was opened last. */}
          <Show when={tab()?.id} keyed>
            {(id) => <PdfViewer tabId={id} />}
          </Show>
        </Match>
        <Match when={tab()?.url === ARCHIVE_URL}>
          <ArchivePage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab()?.url === FEEDS_URL}>
          <FeedsPage />
        </Match>
        <Match when={tab()?.url === SYNC_URL}>
          <SyncPage />
        </Match>
        <Match when={tab()?.url === APPS_URL}>
          <AppsPage />
        </Match>
        <Match when={tab()?.url === SETTINGS_URL}>
          <SettingsPage onNavigate={props.onNavigate} />
        </Match>
        <Match when={tab() && isStartUrl(tab()!.url)}>
          <StartPage
            onNavigate={props.onNavigate}
            onNewTerminal={props.onNewTerminal}
            onToggleAgent={props.onToggleAgent}
            onOpenMap={props.onOpenMap}
          />
        </Match>
      </Switch>
    </div>
  );
};

export default InternalPage;
