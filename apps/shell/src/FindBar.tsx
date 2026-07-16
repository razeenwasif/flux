/**
 * Find-in-page bar (BACKLOG #33). Rendered in the sidebar — the native tab
 * webview is a separate OS layer that overlays the content card, so an in-page
 * find bar would be hidden behind it. Typing drives the engine's native
 * `window.find()` (via `webviewFind`), which highlights + scrolls to matches;
 * the match count comes back over `flux://find-result` into `findMatches`.
 */
import { Show, createSignal, type Component } from "solid-js";
import { webviewFind } from "./ipc";
import { activeId, findMatches, setFindMatches, setFindOpen, setSemFindOpen } from "./store";

const FindBar: Component = () => {
  const [query, setQuery] = createSignal("");
  let debounce: number | undefined;

  const run = (forward = true) => {
    const id = activeId();
    if (id != null) void webviewFind(id, query(), forward).catch(() => {});
  };

  const onInput = (v: string) => {
    setQuery(v);
    clearTimeout(debounce);
    if (!v) {
      setFindMatches(null);
      run(true); // clears the highlight
      return;
    }
    debounce = window.setTimeout(() => run(true), 150);
  };

  const close = () => {
    const id = activeId();
    if (id != null) void webviewFind(id, "").catch(() => {}); // clear highlight
    setFindMatches(null);
    setFindOpen(false);
  };

  const count = () => {
    const n = findMatches();
    if (!query() || n === null) return "";
    return n === 0 ? "no matches" : n === 1 ? "1 match" : `${n} matches`;
  };

  return (
    <div class="find-bar">
      <input
        id="flux-find"
        class="find-input"
        placeholder="Find in page"
        value={query()}
        autofocus
        spellcheck={false}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(!e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <Show when={count()}>
        <span class="find-count" classList={{ none: findMatches() === 0 }}>
          {count()}
        </span>
      </Show>
      <button class="find-nav" title="Previous (Shift+Enter)" onClick={() => run(false)}>
        ‹
      </button>
      <button class="find-nav" title="Next (Enter)" onClick={() => run(true)}>
        ›
      </button>
      <button
        class="find-nav find-sem"
        title="Semantic find — by meaning, across tabs"
        onClick={() => {
          close();
          setSemFindOpen(true);
        }}
      >
        ✦
      </button>
      <button class="find-nav" title="Close (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  );
};

export default FindBar;
