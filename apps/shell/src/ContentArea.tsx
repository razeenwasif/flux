/**
 * ContentArea — the floating content card (ADR 0002). Holds, by active tab kind:
 * a Terminal PTY, a DOM-rendered internal page (flux://…), or the placeholder the
 * native child webview is positioned over (BACKLOG #2). Split out of App.tsx.
 */
import ClockAlarm from "./ClockAlarm";
import PermissionBar from "./PermissionBar";
import SavePasswordBar from "./SavePasswordBar";
import TerminalView from "./TerminalView";
import {
  APPS_URL,
  ARCHIVE_URL,
  BOOKMARKS_URL,
  FEEDS_URL,
  HISTORY_URL,
  NOTEBOOK_URL,
  OMNI_URL,
  PDF_URL,
  PERMISSIONS_URL,
  SENTINEL_URL,
  RESOURCES_URL,
  SESSIONS_URL,
  SETTINGS_URL,
  SPEEDTEST_URL,
  SYNC_URL,
  TASKS_URL,
  TRAIL_URL,
  WHITEBOARD_URL,
  VAULT_URL,
  isStartUrl,
  type TabMeta,
} from "./ipc";
import {
  activeId,
  activePhish,
  activeOAuth,
  activeSensitive,
  dismissSensitive,
  activeConsent,
  setConsent,
  activeTab,
  bookmarkBarOpen,
  pagesBarOpen,
  setPhish,
  setOAuth,
  readerOpen,
  setSplitDragging,
  setSplitRatio,
  splitPanes,
  splitRatio,
  tabs,
  updateTabTitle,
  updateTabUrl,
} from "./store";
import { basename } from "./tabvisual";
import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createMemo,
  createSignal,
  lazy,
  type Component,
} from "solid-js";

/** Does this URL look like a privacy policy / terms page? Cheap + frontend-side
 *  on purpose: it only decides whether to *offer* the explainer, so a miss costs
 *  nothing and it needs no IPC on every navigation. */
const POLICY_RE = /\/(privacy|terms|tos|legal|policies|policy|conditions|eula|dpa)(\b|[-_/.])/i;

// Internal flux:// pages — lazy, DOM-rendered in the card (no webview). One
// chunk each, fetched on first visit (ADR 0001 chrome-JS budget).
const SentinelBanner = lazy(() => import("./SentinelBanner")); // shown only on a phishing verdict
const OAuthConsentBanner = lazy(() => import("./OAuthConsentBanner")); // shown only on a sensitive OAuth grant
const SensitiveSiteBanner = lazy(() => import("./SensitiveSiteBanner")); // shown only on a bank/health/gov site
const PolicyFlagsBanner = lazy(() => import("./PolicyFlagsBanner")); // shown only on a policy/ToS page
const ConsentBanner = lazy(() => import("./ConsentBanner")); // shown only when a consent banner is detected
const StartPage = lazy(() => import("./StartPage"));
const FilesView = lazy(() => import("./FilesView"));
const OmniDashboard = lazy(() => import("./OmniDashboard"));
const NotebookPage = lazy(() => import("./NotebookPage"));
const TrailPage = lazy(() => import("./TrailPage"));
const WhiteboardPage = lazy(() => import("./WhiteboardPage"));
const VaultPage = lazy(() => import("./VaultPage"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const BookmarksPage = lazy(() => import("./BookmarksPage"));
const SessionsPage = lazy(() => import("./SessionsPage"));
const ResourcesPage = lazy(() => import("./ResourcesPage"));
const TasksPage = lazy(() => import("./TasksPage"));
const SpeedtestPage = lazy(() => import("./SpeedtestPage"));
const PermissionsPage = lazy(() => import("./PermissionsPage"));
const SentinelAuditPage = lazy(() => import("./SentinelAuditPage"));
const PdfViewer = lazy(() => import("./PdfViewer"));
const ArchivePage = lazy(() => import("./ArchivePage"));
const FeedsPage = lazy(() => import("./FeedsPage"));
const SyncPage = lazy(() => import("./SyncPage"));
const AppsPage = lazy(() => import("./AppsPage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const ReaderView = lazy(() => import("./ReaderView"));
const BookmarkBar = lazy(() => import("./BookmarkBar"));
const PagesBar = lazy(() => import("./PagesBar"));
const TuiAppsBar = lazy(() => import("./TuiAppsBar"));
// ─── Content card ─────────────────────────────────────────────────────────

/** The floating card. Holds, by active tab: a Terminal PTY, the start-page
 *  dashboard (`flux://start`), or — for a loaded page — a placeholder the
 *  native child webview is positioned over (BACKLOG #2). */
const ContentArea: Component<{
  onNavigate: (url: string) => void;
  onNewTerminal: () => void;
  onToggleAgent: () => void;
  onOpenMap: () => void;
  onSleepBackground: () => void;
}> = (props) => {
  // Dismissal is keyed to the URL, so it resets on navigation rather than
  // silencing the explainer for the rest of the session.
  const [policyDismissed, setPolicyDismissed] = createSignal("");
  const policyPage = createMemo(() => {
    const u = activeTab()?.url ?? "";
    return u.startsWith("http") && POLICY_RE.test(u) && policyDismissed() !== u;
  });
  // Keyed by id (primitive) so the list is stable across unrelated tab updates.
  const terminalIds = createMemo(() =>
    tabs()
      .filter((t) => t.kind === "terminal")
      .map((t) => t.id),
  );

  // The internal (DOM) page for a tab — Flux's own pages render here; a real web
  // page falls through to the placeholder its native webview overlays. Parameterized
  // by tab so split view can render BOTH panes' pages, not just the active one (#43).
  const pageFor = (tab: () => TabMeta | null | undefined) => (
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
        <PdfViewer />
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
  );
  return (
    <main class="content">
      {/* Pages bar: quick-access native-page chips docked above the card. A sibling
        (not an overlay) so the card shrinks and the native webview follows it. */}
      <Show when={pagesBarOpen()}>
        <Suspense>
          <PagesBar />
        </Suspense>
        <Suspense>
          <TuiAppsBar />
        </Suspense>
      </Show>
      {/* Permission bar (#38): answers a deferred engine permission Ask. Also a
        sibling — never an overlay over the native webview. */}
      <PermissionBar />
      <SavePasswordBar />
      <ClockAlarm />
      {/* Sentinel phishing warning (ADR 0013) — a sibling strip above the card,
          in the chrome layer the page can't spoof. */}
      <Show when={activePhish()}>
        {(v) => (
          <Suspense>
            <SentinelBanner
              verdict={v()}
              onLeave={() => props.onNavigate("flux://start")}
              onDismiss={() => setPhish(activeId() ?? -1, null)}
            />
          </Suspense>
        )}
      </Show>
      {/* Cookie-consent decoder (ADR 0013, M5) — give the refuse button back. */}
      <Show when={activeConsent()}>
        {(c) => (
          <Suspense>
            <ConsentBanner
              consent={c()}
              tabId={activeId() ?? -1}
              onDismiss={() => setConsent(activeId() ?? -1, null)}
            />
          </Suspense>
        )}
      </Show>
      {/* Policy / ToS explainer (ADR 0013, M5). The trigger is a cheap URL
          heuristic — it only decides whether to OFFER; the model runs on click. */}
      <Show when={policyPage()} keyed>
        <Suspense>
          <PolicyFlagsBanner onDismiss={() => setPolicyDismissed(activeTab()?.url ?? "")} />
        </Suspense>
      </Show>
      {/* Sentinel containerization offer (ADR 0013, M4) — not a warning, an upgrade. */}
      <Show when={activeSensitive()}>
        {(s) => (
          <Suspense>
            <SensitiveSiteBanner
              site={s()}
              url={activeTab()?.url ?? ""}
              onDismiss={() => dismissSensitive(activeId() ?? -1, activeTab()?.url ?? "")}
            />
          </Suspense>
        )}
      </Show>
      {/* Sentinel OAuth consent review (ADR 0013, M3) — genuine provider, risky grant. */}
      <Show when={activeOAuth()}>
        {(c) => (
          <Suspense>
            <OAuthConsentBanner consent={c()} onDismiss={() => setOAuth(activeId() ?? -1, null)} />
          </Suspense>
        )}
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
              {/* Only the visible terminal tab draws the WebGL backdrop — hidden
                keep-alive tabs would otherwise each hold a WebGL2 context (#75). */}
              <TerminalView
                session={id}
                active={activeTab()?.id === id}
                background={activeTab()?.id === id}
              />
            </div>
          )}
        </For>
        <Show when={activeTab()?.kind !== "terminal"}>
          <Suspense>
            {/* Split view (#43): two DOM halves, each rendering its tab's internal page
            (a real web page falls through to the placeholder its tiled webview
            overlays). Accessors keep navigation reactive without remounting. */}
            <Show when={splitPanes()} fallback={pageFor(activeTab)}>
              <div
                class="split-dom-pane"
                style={{ left: "0", width: `calc(${Math.min(80, Math.max(20, splitRatio() * 100))}% - 4px)` }}
              >
                {pageFor(() => splitPanes()?.[0])}
              </div>
              <div
                class="split-dom-pane"
                style={{ left: `calc(${Math.min(80, Math.max(20, splitRatio() * 100))}% + 4px)`, right: "0" }}
              >
                {pageFor(() => splitPanes()?.[1])}
              </div>
            </Show>
          </Suspense>
        </Show>
      </div>
      {/* Bookmark bar (#22): docked under the card. A sibling (not an overlay), so
        the card shrinks and the native webview relayout follows it. */}
      <Show when={bookmarkBarOpen()}>
        <Suspense>
          <BookmarkBar onNavigate={props.onNavigate} />
        </Suspense>
      </Show>
    </main>
  );
};

export default ContentArea;
