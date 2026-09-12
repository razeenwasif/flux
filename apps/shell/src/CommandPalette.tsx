/**
 * Command palette (BACKLOG #6). Ctrl+K → a centered fuzzy search over open tabs
 * (switch to), actions (new tab, toggles, open History/Passwords/…), and browsing
 * history. Because it's a centered modal and the native webview is a separate OS
 * layer over the content card, App hides the active webview while it's open.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import { omniSearch, type OmniHit } from "./ipc";
import { activeId, focusTab, tabs } from "./store";
import { latestQuery } from "./latestQuery";
import Modal from "./Modal";

export type PaletteAction = { id: string; label: string; icon: string; run: () => void };
type Item = { key: string; icon: string; label: string; sub: string; run: () => void };

const CommandPalette: Component<{
  actions: PaletteAction[];
  onClose: () => void;
  onNavigate: (url: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  // Unified semantic results (#66): tabs by content + bookmarks + history, ranked
  // together by the local embedder. Fetched (debounced) only when searching.
  const [results, setResults] = createSignal<OmniHit[]>([]);
  const [sel, setSel] = createSignal(0);
  const [searchState, setSearchState] = createSignal<"idle" | "loading" | "error">("idle");
  const search = latestQuery(
    (q) => omniSearch(q, 14),
    (hits) => {
      setResults(hits);
      setSearchState("idle");
    },
    () => {
      setResults([]);
      setSearchState("error");
    },
  );
  onCleanup(search.cancel);

  const onInput = (v: string) => {
    setQuery(v);
    setSel(0);
    const q = v.trim();
    setResults([]);
    setSearchState(q ? "loading" : "idle");
    search.search(q);
  };

  const items = createMemo<Item[]>(() => {
    const q = query().trim().toLowerCase();
    const out: Item[] = [];
    // Actions (lexical, local) always come first — they're commands, not content.
    for (const a of props.actions) {
      if (!q || a.label.toLowerCase().includes(q)) {
        out.push({ key: `act-${a.id}`, icon: a.icon, label: a.label, sub: "Action", run: a.run });
      }
    }
    if (!q) {
      // Browse mode: list open tabs to switch to.
      for (const t of tabs()) {
        if (t.id === activeId()) continue;
        out.push({
          key: `tab-${t.id}`,
          icon: t.kind === "terminal" ? "⌨" : t.kind === "files" ? "📁" : "🗗",
          label: t.title || t.url,
          sub: "Switch to tab",
          run: () => void focusTab(t.id),
        });
      }
      return out;
    }
    // Search mode: one ranked list across tabs (by content), bookmarks, history.
    for (const h of results()) {
      const icon = h.kind === "tab" ? "🗗" : h.kind === "bookmark" ? "🔖" : "🕘";
      const sub =
        h.snippet || (h.kind === "tab" ? "Switch to tab" : h.kind === "bookmark" ? "Bookmark" : h.url);
      out.push({
        key: `${h.kind}-${h.tab_id ?? h.url}`,
        icon,
        label: h.title || h.url,
        sub,
        run:
          h.kind === "tab" && h.tab_id != null
            ? () => void focusTab(h.tab_id!)
            : () => props.onNavigate(h.url),
      });
    }
    return out;
  });

  createEffect(() => {
    const count = items().length;
    setSel((i) => Math.min(i, Math.max(0, count - 1)));
    document.getElementById(`palette-result-${sel()}`)?.scrollIntoView({ block: "nearest" });
  });

  const choose = (it: Item) => {
    props.onClose();
    it.run();
  };

  const onKey = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items()[sel()];
      if (it) choose(it);
    }
  };

  return (
    <Modal
      label="Search tabs and commands"
      backdropClass="palette-backdrop"
      class="palette glass"
      onClose={props.onClose}
    >
      <input
        id="flux-palette-input"
        class="palette-input"
        placeholder="Search everything — tabs, page text, bookmarks, history…"
        value={query()}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={onKey}
        spellcheck={false}
        autocomplete="off"
        role="combobox"
        aria-label="Search tabs and commands"
        aria-expanded="true"
        aria-controls="palette-results"
        aria-autocomplete="list"
        aria-activedescendant={items().length ? `palette-result-${sel()}` : undefined}
      />
      <div
        class="palette-list"
        id="palette-results"
        role="listbox"
        aria-label="Tabs and commands"
        aria-busy={searchState() === "loading"}
      >
        <Show when={items().length > 0}>
          <For each={items()}>
            {(it, i) => (
              <button
                id={`palette-result-${i()}`}
                role="option"
                aria-selected={sel() === i()}
                tabIndex={-1}
                classList={{ "palette-item": true, sel: sel() === i() }}
                onMouseEnter={() => setSel(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(it)}
              >
                <span class="palette-icon">{it.icon}</span>
                <span class="palette-text">
                  <span class="palette-label">{it.label}</span>
                  <span class="palette-sub">{it.sub}</span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
      <Show when={searchState() !== "idle" || items().length === 0}>
        <div class="palette-empty" role="status">
          {searchState() === "loading"
            ? "Searching…"
            : searchState() === "error"
              ? "Search unavailable. Try again."
              : "No matches"}
        </div>
      </Show>
    </Modal>
  );
};

export default CommandPalette;
