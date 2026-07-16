/**
 * Find-in-page bar (BACKLOG #33). Permanently visible in the sidebar, right
 * under the omnibox — the native tab webview is a separate OS layer that
 * overlays the content card, so an in-page find bar would be hidden behind it.
 * Typing drives the engine's native `window.find()` (via `webviewFind`), which
 * highlights + scrolls to matches; the match count comes back over
 * `flux://find-result` into `findMatches`.
 *
 * `findOpen` now means "a find session is active" (query present / focused):
 * Ctrl+F focuses the input, Escape — here or globally — clears the query and
 * the page highlight but the bar itself never unmounts.
 */
import { Show, createEffect, createSignal, type Component } from "solid-js";
import { webviewFind } from "./ipc";
import { activeId, findMatches, findOpen, setFindMatches, setFindOpen, setSemFindOpen } from "./store";

const FindBar: Component = () => {
  const [query, setQuery] = createSignal("");
  let debounce: number | undefined;
  let input!: HTMLInputElement;

  const run = (forward = true) => {
    const id = activeId();
    if (id != null) void webviewFind(id, query(), forward).catch(() => {});
  };

  const onInput = (v: string) => {
    setQuery(v);
    setFindOpen(v.length > 0);
    clearTimeout(debounce);
    if (!v) {
      setFindMatches(null);
      run(true); // clears the highlight
      return;
    }
    debounce = window.setTimeout(() => run(true), 150);
  };

  // Clear the session: query, highlight, match count. The bar stays.
  const clear = () => {
    const id = activeId();
    if (id != null) void webviewFind(id, "").catch(() => {});
    setQuery("");
    setFindMatches(null);
    setFindOpen(false);
    input.blur();
  };

  // The global Escape chain (App) ends a find session via setFindOpen(false) —
  // sync the local query so the input doesn't show stale text over no highlight.
  createEffect(() => {
    if (!findOpen() && query()) {
      setQuery("");
      setFindMatches(null);
    }
  });

  const count = () => {
    const n = findMatches();
    if (!query() || n === null) return "";
    return n === 0 ? "no matches" : n === 1 ? "1 match" : `${n} matches`;
  };

  return (
    <div class="find-bar">
      <input
        id="flux-find"
        ref={input}
        class="find-input"
        placeholder="Find in page  (Ctrl+F)"
        value={query()}
        spellcheck={false}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(!e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            clear();
          }
        }}
      />
      <Show when={count()}>
        <span class="find-count" classList={{ none: findMatches() === 0 }}>
          {count()}
        </span>
      </Show>
      <Show when={query()}>
        <button class="find-nav" title="Previous (Shift+Enter)" onClick={() => run(false)}>
          ‹
        </button>
        <button class="find-nav" title="Next (Enter)" onClick={() => run(true)}>
          ›
        </button>
        <button class="find-nav" title="Clear (Esc)" onClick={clear}>
          ✕
        </button>
      </Show>
      <button
        class="find-nav find-sem"
        title="Semantic find — by meaning, across tabs"
        onClick={() => setSemFindOpen(true)}
      >
        ✦
      </button>
    </div>
  );
};

export default FindBar;
