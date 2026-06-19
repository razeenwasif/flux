/**
 * flux://archive — offline archive + semantic search (BACKLOG #69). Saved pages
 * (read-later) you can browse and **semantically search** entirely offline, and
 * read in a clean text view with no remote resources. Master-detail: a
 * searchable list on the left, the selected article on the right.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { archiveDelete, archiveGet, archiveList, archiveSearch, type ArchiveEntry, type ArchiveMeta } from "./ipc";
import { activeId, updateTabTitle } from "./store";
import { openLinkMenu } from "./linkMenu";

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const ArchivePage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createSignal<ArchiveMeta[]>([]);
  const [open, setOpen] = createSignal<ArchiveEntry | null>(null);
  let debounce: number | undefined;

  const refresh = (q: string) => {
    void archiveSearch(q, 200).then((r) => setRows(r ?? [])).catch(() => setRows([]));
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Archive");
    refresh("");
  });
  const onInput = (q: string) => {
    setQuery(q);
    clearTimeout(debounce);
    debounce = window.setTimeout(() => refresh(q), 180);
  };
  const read = (id: number) => void archiveGet(id).then((e) => { if (e) setOpen(e); }).catch(() => {});
  const remove = async (id: number, e: MouseEvent) => {
    e.stopPropagation();
    await archiveDelete(id);
    if (open()?.id === id) setOpen(null);
    refresh(query());
  };

  // Split the saved visible-text into paragraphs for a readable column.
  const paragraphs = (text: string) => text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);

  return (
    <div class="hist-page arch-page">
      <header class="hist-head">
        <div class="hist-title">📚 Archive</div>
        <input
          class="arch-search"
          placeholder="Search saved pages…"
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <span class="res-mem">{rows().length} saved</span>
      </header>

      <div class="arch-body">
        <div class="arch-list">
          <Show when={rows().length > 0} fallback={<div class="hist-empty">{query() ? "No matches." : "No saved pages yet. Use “Save page for offline” (⌘K) on any article."}</div>}>
            <For each={rows()}>
              {(r) => (
                <div classList={{ "arch-row": true, active: open()?.id === r.id }} onClick={() => read(r.id)} onContextMenu={(e) => openLinkMenu(e, r.url)} title="Right-click to open the original in a new tab">
                  <div class="arch-row-top">
                    <span class="arch-row-title">{r.title || hostOf(r.url)}</span>
                    <Show when={query() && r.score > 0}><span class="arch-score">{r.score}%</span></Show>
                  </div>
                  <div class="arch-row-meta">{hostOf(r.url)} · {when(r.saved_ms)}</div>
                  <div class="arch-row-snip">{r.snippet}</div>
                  <button class="arch-del" title="Remove" onClick={(e) => void remove(r.id, e)}>✕</button>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="arch-read">
          <Show when={open()} fallback={<div class="hist-empty">Select a page to read offline.</div>}>
            {(e) => (
              <article class="arch-article">
                <h1 class="arch-art-title">{e().title || hostOf(e().url)}</h1>
                <div class="arch-art-meta">
                  <button class="arch-art-link" onClick={() => props.onNavigate(e().url)} onContextMenu={(ev) => openLinkMenu(ev, e().url)} title={e().url}>{hostOf(e().url)} ↗</button>
                  <span>· saved {when(e().saved_ms)}</span>
                </div>
                <For each={paragraphs(e().text)}>{(p) => <p class="arch-art-p">{p}</p>}</For>
              </article>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};

export default ArchivePage;
