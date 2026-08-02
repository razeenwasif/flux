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
import { For, Show, createSignal, onMount, type Component } from "solid-js";

import type { PaletteAction } from "./CommandPalette";
import { START_URL, searchResolve, searchSuggest } from "./ipc";
import { activeId, openTab, setTile } from "./store";
import { MAX_PANES, layoutsFor } from "./tiles";

/** The toolbar is a curated set, not `actions.slice(0, n)` — taking the first
 *  few produced two identical 🔖 (Open Bookmarks and Show bookmark bar) and a
 *  couple of toggles, which read as noise in an icon-only row. These are
 *  destinations you'd plausibly want *instead of* searching, in that order;
 *  anything missing from `actions` is skipped rather than rendered dead. */
const TOOLBAR_IDS = [
  "new-tab",
  "new-private",
  "scribe",
  "notebook",
  "trail",
  "history",
  "bookmarks",
  "new-term",
];

const SearchSpotlight: Component<{
  actions: PaletteAction[];
  onClose: () => void;
  onNavigate: (url: string) => void;
  onAiSearch: (q: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [related, setRelated] = createSignal<string[]>([]);
  const [sel, setSel] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);
  let debounce: number | undefined;

  const toolbar = () =>
    TOOLBAR_IDS.map((id) => props.actions.find((a) => a.id === id)).filter(
      (a): a is PaletteAction => a != null,
    );

  onMount(() => requestAnimationFrame(() => document.getElementById("flux-spot-input")?.focus()));

  const onInput = (v: string) => {
    setQuery(v);
    setSel(-1);
    clearTimeout(debounce);
    const q = v.trim();
    // A URL isn't a search: completing one returns noise, and it would hand the
    // address you're navigating to over to the suggest endpoint.
    if (!q || /^[a-z]+:\/\//i.test(q)) {
      setRelated([]);
      return;
    }
    debounce = window.setTimeout(
      () =>
        void searchSuggest(q)
          .then((s) => setRelated(s.slice(0, 8)))
          .catch(() => setRelated([])),
      140,
    );
  };

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
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div class="spot-backdrop" onClick={props.onClose}>
      <div class="spot glass" onClick={(e) => e.stopPropagation()}>
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
            title="Open beside the current page (Shift+Enter)"
            disabled={!effective()}
            onClick={() => void runSplit(effective())}
          >
            ▤
          </button>
          <button
            class="spot-btn primary"
            title="Search (Enter)"
            disabled={!effective()}
            onClick={() => void run(effective())}
          >
            ⌕
          </button>
        </div>

        <Show when={related().length > 0}>
          <div class="spot-related">
            <div class="spot-related-head">Related searches</div>
            <For each={related()}>
              {(s, i) => (
                <button
                  classList={{ "spot-related-item": true, sel: sel() === i() }}
                  onMouseEnter={() => setSel(i())}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void run(s);
                  }}
                >
                  <span class="spot-related-glyph">⌕</span>
                  <span class="spot-related-text">{s}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SearchSpotlight;
