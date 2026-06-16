/**
 * Command palette (BACKLOG #6). Ctrl+K → a centered fuzzy search over open tabs
 * (switch to), actions (new tab, toggles, open History/Passwords/…), and browsing
 * history. Because it's a centered modal and the native webview is a separate OS
 * layer over the content card, App hides the active webview while it's open.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";
import { historySearch, type HistoryEntry } from "./ipc";
import { activeId, focusTab, tabs } from "./store";

export type PaletteAction = { id: string; label: string; icon: string; run: () => void };
type Item = { key: string; icon: string; label: string; sub: string; run: () => void };

const CommandPalette: Component<{
  actions: PaletteAction[];
  onClose: () => void;
  onNavigate: (url: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [hist, setHist] = createSignal<HistoryEntry[]>([]);
  const [sel, setSel] = createSignal(0);
  let debounce: number | undefined;

  onMount(() => requestAnimationFrame(() => document.getElementById("flux-palette-input")?.focus()));

  const onInput = (v: string) => {
    setQuery(v);
    setSel(0);
    clearTimeout(debounce);
    const q = v.trim();
    if (!q) { setHist([]); return; }
    debounce = window.setTimeout(() => void historySearch(q, 6).then(setHist).catch(() => setHist([])), 120);
  };

  const items = createMemo<Item[]>(() => {
    const q = query().trim().toLowerCase();
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Item[] = [];
    // Switch to an open tab.
    for (const t of tabs()) {
      if (t.id === activeId()) continue;
      if (hit(t.title || t.url) || hit(t.url)) {
        out.push({
          key: `tab-${t.id}`,
          icon: t.kind === "terminal" ? "⌨" : t.kind === "files" ? "📁" : "🗗",
          label: t.title || t.url,
          sub: "Switch to tab",
          run: () => void focusTab(t.id),
        });
      }
    }
    // Actions.
    for (const a of props.actions) {
      if (hit(a.label)) out.push({ key: `act-${a.id}`, icon: a.icon, label: a.label, sub: "Action", run: a.run });
    }
    // History (only when searching).
    for (const h of hist()) {
      out.push({ key: `hist-${h.url}`, icon: "🕘", label: h.title || h.url, sub: h.url, run: () => props.onNavigate(h.url) });
    }
    return out;
  });

  const choose = (it: Item) => { props.onClose(); it.run(); };

  const onKey = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => (n ? (i + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (n ? (i - 1 + n) % n : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items()[sel()]; if (it) choose(it); }
    else if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
  };

  return (
    <div class="palette-backdrop" onClick={props.onClose}>
      <div class="palette glass" onClick={(e) => e.stopPropagation()}>
        <input
          id="flux-palette-input"
          class="palette-input"
          placeholder="Search tabs, actions, history…"
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={onKey}
          spellcheck={false}
          autocomplete="off"
        />
        <div class="palette-list">
          <Show when={items().length > 0} fallback={<div class="palette-empty">No matches</div>}>
            <For each={items()}>
              {(it, i) => (
                <button
                  classList={{ "palette-item": true, sel: sel() === i() }}
                  onMouseEnter={() => setSel(i())}
                  onMouseDown={(e) => { e.preventDefault(); choose(it); }}
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
      </div>
    </div>
  );
};

export default CommandPalette;
