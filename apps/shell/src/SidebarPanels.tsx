/**
 * The sidebar footer's popover panels: settings, web panels, the page note,
 * archived tabs and extensions. Split out of Sidebar.tsx so the boot bundle
 * carries only the buttons; this chunk loads the first time one is opened.
 */
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
  type Component,
} from "solid-js";

import {
  SETTINGS_URL,
  isStartUrl,
  PDF_URL,
  memStatus,
  noteGet,
  noteSet,
  searchDefault,
  searchEngines,
  searchSetDefault,
  type MemInfo,
  type SearchEngine,
} from "./ipc";
import {
  activePanelId,
  activePanelIdB,
  activeTab,
  aiAnswersOn,
  archivedBranches,
  archivedTabs,
  clearArchived,
  containerColor,
  containers,
  createContainer,
  darkMode,
  deleteContainer,
  hibernateEnabled,
  hibernateMins,
  memEvict,
  mouseGestures,
  omniAutoAnswer,
  panels,
  pinPanel,
  recolorContainer,
  removeArchived,
  removeBranch,
  renameContainer,
  restoreArchived,
  restoreBranch,
  searchSuggestOn,
  setAiAnswersOn,
  setDarkMode,
  setHibernateEnabled,
  setHibernateMins,
  setMemEvict,
  setMouseGestures,
  setOmniAutoAnswer,
  setSearchSuggestOn,
  setVimHints,
  togglePanel,
  togglePanelBottom,
  unpinPanel,
  vimHints,
} from "./store";

const Extensions = lazy(() => import("./Extensions"));

export type FooterPanel = "extensions" | "settings" | "webpanels" | "notes" | "archived" | null;

const SidebarPanels: Component<{
  panel: () => FooterPanel;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onSwitchWorkspace: (id: number) => void;
}> = (props) => {
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

  // Per-page notes (#53): the popover edits the active page's note (auto-saved).
  // It stays open across tab switches and navigation, so the text is tied to the
  // page it was loaded for: an edit is saved there, and a new page under the
  // popover gets its own note loaded rather than inheriting the previous text.
  const [noteText, setNoteText] = createSignal("");
  // Read-only until the page's note has loaded, so nothing typed can start from
  // the previous page's text.
  const [noteLoaded, setNoteLoaded] = createSignal(false);
  let noteTimer: number | undefined;
  let noteUrl: string | null = null;
  let notePending: { url: string; text: string } | null = null;
  const flushNote = () => {
    clearTimeout(noteTimer);
    const p = notePending;
    notePending = null;
    if (p) void noteSet(p.url, p.text).catch(() => {});
  };
  const loadNote = () => {
    flushNote(); // the previous page's last edit is written, not dropped
    const t = activeTab();
    const url = t?.kind === "browser" && !isStartUrl(t.url) ? t.url : null;
    noteUrl = url;
    setNoteLoaded(false);
    setNoteText("");
    if (!url) return;
    const show = (s: string) => {
      if (noteUrl !== url) return; // the popover has moved to another page since
      setNoteText(s);
      setNoteLoaded(true);
    };
    void noteGet(url)
      .then(show)
      .catch(() => show(""));
  };
  const saveNote = (text: string) => {
    setNoteText(text);
    if (!noteUrl) return;
    notePending = { url: noteUrl, text };
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(flushNote, 400);
  };
  // Reload whenever the page under the open popover changes. Keyed on the URL
  // string, so a title tick (a fresh activeTab object) can't reload the note
  // being typed.
  const noteTarget = createMemo(() => (props.panel() === "notes" ? (activeTab()?.url ?? "") : null));
  createEffect(
    on(noteTarget, (url) => {
      if (url != null) loadNote();
    }),
  );

  const [engines, setEngines] = createSignal<SearchEngine[]>([]);
  const [defaultEngine, setDefaultEngine] = createSignal("");
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  const [editContainer, setEditContainer] = createSignal<number | null>(null);
  // Settings: the engines once per opening, and a live-ish RAM readout that
  // only polls while the panel is showing.
  createEffect(() => {
    if (props.panel() !== "settings") return;
    void Promise.all([searchEngines(), searchDefault()])
      .then(([es, d]) => {
        setEngines(es);
        setDefaultEngine(d);
      })
      .catch(() => {}); // preview/offline
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

  return (
    <div class="glass popover footer-pop">
      <Show when={props.panel() === "settings"}>
        <button
          class="shields-update"
          onClick={() => {
            props.onClose();
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
                    if (editContainer() !== c.id) return; // Escape cancelled it
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
              <button class="panel-row-x" title="Delete container" onClick={() => void deleteContainer(c.id)}>
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
            role="switch"
            aria-label="Search suggestions"
            aria-checked={searchSuggestOn()}
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
            role="switch"
            aria-label="AI answers for searches"
            aria-checked={aiAnswersOn()}
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
            role="switch"
            aria-label="Omni answer on search"
            aria-checked={omniAutoAnswer()}
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
            role="switch"
            aria-label="Dark mode (websites)"
            aria-checked={darkMode()}
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
            role="switch"
            aria-label="Vim link hints (f)"
            aria-checked={vimHints()}
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
            role="switch"
            aria-label="Mouse gestures"
            aria-checked={mouseGestures()}
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
            role="switch"
            aria-label="Sleep inactive tabs"
            aria-checked={hibernateEnabled()}
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
            role="switch"
            aria-label="Sleep under memory pressure"
            aria-checked={memEvict()}
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
      <Show when={props.panel() === "webpanels"}>
        <div class="sidebar-section" style={{ padding: "4px 8px" }}>
          Web panels
        </div>
        <Show when={canPinAsPanel()}>
          <button
            class="shields-update"
            onClick={() => {
              const t = activeTab()!;
              void pinPanel(t.url, t.title || t.url);
              props.onClose();
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
                    props.onClose();
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
          <div class="start-empty" style={{ padding: "6px 10px 4px", "font-size": "11px", opacity: "0.7" }}>
            Tap a panel for the top; ⬓ stacks it below — e.g. calendar over email.
          </div>
        </Show>
      </Show>
      <Show when={props.panel() === "notes"}>
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
            readOnly={!noteLoaded()}
            onInput={(e) => saveNote(e.currentTarget.value)}
          />
        </Show>
      </Show>
      <Show when={props.panel() === "archived"}>
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
                    props.onClose();
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
                Stale tabs auto-archive here (set the threshold in Settings → Tabs); a whole research branch
                archives together, named. Reopen any with one tap.
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
                    props.onClose();
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
      <Show when={props.panel() === "extensions"}>
        <Suspense>
          <Extensions />
        </Suspense>
      </Show>
    </div>
  );
};

export default SidebarPanels;
