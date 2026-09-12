/**
 * Search spotlight (flux-plan1) — the web-facing counterpart to the command
 * palette.
 *
 * The palette answers "find something I already have" (open tabs, page text,
 * bookmarks, history, actions). This answers "search the web", which was
 * otherwise only reachable through the omnibox — and the omnibox lives in the
 * sidebar, so it disappears the moment you collapse it.
 *
 * Layout follows the sketch: a row of quick actions, the query field with
 * home / split / search on its right, and the engine's related searches below.
 * Related searches come from the configured engine's suggest endpoint (#32),
 * so this respects whichever engine is default rather than hardcoding Google.
 *
 * Like the palette, it's a centered modal, and the native webview is an OS layer
 * *over* the content card — App hides the active webview while it's open, or the
 * page would paint straight through this.
 */
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js";

import type { PaletteAction } from "./CommandPalette";
import { START_URL, searchResolve, searchSuggest } from "./ipc";
import { activeId, openTab, searchSuggestOn, setTile } from "./store";
import { MAX_PANES, layoutsFor } from "./tiles";
import { latestQuery } from "./latestQuery";
import Modal from "./Modal";

/** The toolbar carries the sidebar's *page tools* — things you do to the page
 *  you're on — rather than destinations, which the palette already lists and
 *  the toolbar can't label anyway.
 *
 *  Curated, not `actions.slice(0, n)`: the first few produced two identical 🔖
 *  (Open Bookmarks and Show bookmark bar) and a couple of toggles, which in an
 *  icon-only row reads as noise. Anything missing from `actions` is skipped
 *  rather than rendered dead. */
const TOOLBAR_IDS = [
  "bookmark-page",
  "reader",
  "archive-save",
  "translate",
  "capture",
  "find",
  "watches",
  "install-app",
];

const SearchSpotlight: Component<{
  actions: PaletteAction[];
  onClose: () => void;
  onNavigate: (url: string) => void;
  onAiSearch: (q: string) => void;
  onOpenFiles: () => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [related, setRelated] = createSignal<string[]>([]);
  const [sel, setSel] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const suggestions = latestQuery(
    (q) => searchSuggest(q, { enabled: searchSuggestOn(), tabId: activeId() }),
    (items) => setRelated(items.slice(0, 8)),
    () => setRelated([]),
    140,
  );
  onCleanup(suggestions.cancel);

  const toolbar = () =>
    TOOLBAR_IDS.map((id) => props.actions.find((a) => a.id === id)).filter(
      (a): a is PaletteAction => a != null,
    );

  const onInput = (v: string) => {
    setQuery(v);
    setSel(-1);
    setError("");
    setRelated([]);
    const q = v.trim();
    // A URL isn't a search: completing one returns noise, and it would hand the
    // address you're navigating to over to the suggest endpoint.
    if (!searchSuggestOn() || !q || /^[a-z]+:\/\//i.test(q)) {
      suggestions.cancel();
      return;
    }
    suggestions.search(q);
  };

  createEffect(() => {
    activeId();
    searchSuggestOn();
    suggestions.cancel();
    setRelated([]);
    setSel(-1);
  });

  /** The text a given selection would run: a highlighted suggestion, else what
   *  was typed. */
  const effective = () => {
    const i = sel();
    const r = related();
    return i >= 0 && i < r.length ? r[i]! : query().trim();
  };

  /** Resolve through the pluggable search backend (#68), so !bangs, keyword
   *  routing and navigate-vs-search all behave exactly as they do in the
   *  omnibox rather than being re-decided here. */
  const resolve = async (text: string) => {
    if (text.startsWith("flux://")) return { url: text, kind: "url" as const };
    const r = await searchResolve(text);
    return { url: r.url, kind: r.kind };
  };

  const run = async (text: string) => {
    const t = text.trim();
    if (!t || busy()) return;
    setBusy(true);
    try {
      const r = await resolve(t);
      props.onClose();
      props.onNavigate(r.url);
      if (r.kind === "search") props.onAiSearch(t);
    } catch {
      setBusy(false);
      setError("Could not open this search. Please try again.");
    }
  };

  /** Open the result beside the current page instead of replacing it. */
  const runSplit = async (text: string) => {
    const t = text.trim();
    if (!t || busy()) return;
    setBusy(true);
    try {
      const r = await resolve(t);
      const cur = activeId();
      const tab = await openTab("browser", r.url, false, true);
      props.onClose();
      if (cur == null) return;
      const panes = [cur, tab.id].slice(0, MAX_PANES);
      setTile(panes, layoutsFor(panes.length)[0]!);
    } catch {
      setBusy(false);
      setError("Could not create a split. Please try again.");
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const n = related().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => (n ? Math.min(i + 1, n - 1) : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // Back past the first suggestion returns to what you typed, so an
      // accidental arrow-down isn't a one-way trip.
      setSel((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Shift+Enter mirrors the split button, the way it does in the omnibox.
      void (e.shiftKey ? runSplit(effective()) : run(effective()));
    }
  };

  return (
    <Modal label="Search the web" backdropClass="spot-backdrop" class="spot glass" onClose={props.onClose}>
      {/* Quick actions. Icon-only and capped to one row — this is a shortcut
            strip, not a menu; ⌘K is where the full labelled list lives. */}
      <div class="spot-toolbar">
        <For each={toolbar()}>
          {(a) => (
            <button
              class="spot-tool"
              title={a.label}
              onClick={() => {
                props.onClose();
                a.run();
              }}
            >
              {a.icon}
            </button>
          )}
        </For>
      </div>

      <div class="spot-field">
        <span class="spot-glyph">⌕</span>
        <input
          id="flux-spot-input"
          class="spot-input"
          placeholder="Search the web, or enter an address"
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={onKey}
          spellcheck={false}
          autocomplete="off"
          data-autofocus
          role="combobox"
          aria-label="Search the web or enter an address"
          aria-expanded={related().length > 0}
          aria-controls="spot-results"
          aria-autocomplete="list"
          aria-activedescendant={sel() >= 0 ? `spot-result-${sel()}` : undefined}
        />
        <button
          class="spot-btn"
          title="Home — the start page"
          onClick={() => {
            props.onClose();
            props.onNavigate(START_URL);
          }}
        >
          ⌂
        </button>
        <button
          class="spot-btn"
          title="File explorer"
          onClick={() => {
            props.onClose();
            props.onOpenFiles();
          }}
        >
          🗁
        </button>
        <button
          class="spot-btn"
          title="Open beside the current page (Shift+Enter)"
          disabled={busy() || !effective()}
          onClick={() => void runSplit(effective())}
        >
          ▤
        </button>
        <button
          class="spot-btn primary"
          title="Search (Enter)"
          disabled={busy() || !effective()}
          onClick={() => void run(effective())}
        >
          ⌕
        </button>
      </div>

      <Show when={related().length > 0}>
        <div class="spot-related" id="spot-results" role="listbox" aria-label="Related searches">
          <div class="spot-related-head">Related searches</div>
          <For each={related()}>
            {(s, i) => (
              <button
                id={`spot-result-${i()}`}
                role="option"
                aria-selected={sel() === i()}
                tabIndex={-1}
                classList={{ "spot-related-item": true, sel: sel() === i() }}
                onMouseEnter={() => setSel(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void run(s)}
              >
                <span class="spot-related-glyph">⌕</span>
                <span class="spot-related-text">{s}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <div class="palette-empty" role="alert">
          {error()}
        </div>
      </Show>
    </Modal>
  );
};

export default SearchSpotlight;
