/**
 * Semantic find (BACKLOG #126) — find where a page *discusses* something by
 * meaning, not exact string, in the current page or across every open tab. Ranks
 * passages with the local embedder; picking one switches to its tab and uses the
 * same native `window.find` the string find-bar uses to scroll + highlight it.
 */
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import { semFindOpen, setSemFindOpen, tabs, activeId, activeWorkspace, focusTab } from "./store";
import { isStartUrl, semanticFind, webviewFind, type FindHit } from "./ipc";

/** A verbatim prefix of the passage, for `window.find` to locate (it matches exact text). */
const findKey = (passage: string): string => {
  let s = passage.slice(0, 90);
  const lastSpace = s.lastIndexOf(" ");
  if (lastSpace > 40) s = s.slice(0, lastSpace);
  return s;
};

const SemanticFind: Component = () => {
  const [scope, setScope] = createSignal<"page" | "tabs">("page");
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<FindHit[]>([]);
  const [sel, setSel] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  let inputEl: HTMLInputElement | undefined;
  let timer: number | undefined;
  let runId = 0;

  const tabIdsFor = (): number[] => {
    if (scope() === "page") { const a = activeId(); return a != null ? [a] : []; }
    return tabs().filter((t) => t.kind === "browser" && t.workspace === activeWorkspace() && !isStartUrl(t.url)).map((t) => t.id);
  };

  const runSearch = (q: string) => {
    const ids = tabIdsFor();
    if (!q.trim() || !ids.length) { setHits([]); setErr(null); setBusy(false); return; }
    const my = ++runId;
    setBusy(true); setErr(null);
    void semanticFind(q, ids, 40)
      .then((h) => { if (my === runId) { setHits(h); setSel(0); } })
      .catch((e) => { if (my === runId) { setHits([]); setErr(String(e)); } })
      .finally(() => { if (my === runId) setBusy(false); });
  };

  createEffect(() => {
    if (!semFindOpen()) return;
    setQuery(""); setHits([]); setSel(0); setErr(null);
    requestAnimationFrame(() => inputEl?.focus());
  });

  const onInput = (v: string) => {
    setQuery(v);
    clearTimeout(timer);
    timer = window.setTimeout(() => runSearch(v), 200);
  };
  const switchScope = (s: "page" | "tabs") => { setScope(s); runSearch(query()); };

  const close = () => setSemFindOpen(false);
  const choose = (h: FindHit) => {
    close();
    const go = () => void webviewFind(h.tab_id, findKey(h.passage)).catch(() => {});
    if (h.tab_id !== activeId()) { void focusTab(h.tab_id); window.setTimeout(go, 220); }
    else { window.setTimeout(go, 60); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits().length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const h = hits()[sel()]; if (h) choose(h); }
  };

  onCleanup(() => clearTimeout(timer));

  return (
    <Show when={semFindOpen()}>
      <Portal>
        <div class="semfind-backdrop" onClick={close}>
          <div class="semfind glass" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
            <div class="semfind-head">
              <span class="semfind-ico">✦</span>
              <input
                ref={inputEl}
                class="semfind-input"
                placeholder="Find by meaning… e.g. “where does it explain the pricing”"
                value={query()}
                onInput={(e) => onInput(e.currentTarget.value)}
                spellcheck={false}
                autocomplete="off"
              />
              <div class="semfind-scope">
                <button classList={{ on: scope() === "page" }} onClick={() => switchScope("page")}>This page</button>
                <button classList={{ on: scope() === "tabs" }} onClick={() => switchScope("tabs")}>All tabs</button>
              </div>
            </div>
            <div class="semfind-list">
              <Show when={!err()} fallback={<div class="semfind-empty">{err()}</div>}>
                <For
                  each={hits()}
                  fallback={<div class="semfind-empty">{busy() ? "Searching…" : query().trim() ? "No relevant passages." : "Type to search the page's meaning."}</div>}
                >
                  {(h, i) => (
                    <button classList={{ "semfind-item": true, sel: sel() === i() }} onMouseEnter={() => setSel(i())} onClick={() => choose(h)}>
                      <span class="semfind-passage">{h.passage}</span>
                      <Show when={scope() === "tabs"}><span class="semfind-tab">{h.title}</span></Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <div class="semfind-foot">↑↓ navigate · ↵ jump + highlight · esc close</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default SemanticFind;
