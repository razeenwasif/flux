/**
 * Bookmark bar (BACKLOG #22) — a chip row docked under the content card, so your
 * bookmarks are one click away without opening flux://bookmarks. Rendered as a
 * sibling *below* the card (not over it), so it never collides with the native
 * tab webview (which is an OS layer over the card) — the card shrinks and the
 * webview relayout follows.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { bookmarkRemove, bookmarkRename, bookmarksList, type Bookmark } from "./ipc";
import { attachHScroll } from "./hscroll";
import { openLinkMenu } from "./linkMenu";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** Letter stand-in favicon (matches the start page / tab strip convention). */
function letter(b: Bookmark): string {
  return (hostOf(b.url)[0] ?? "?").toUpperCase();
}

const BookmarkBar: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([]);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [draft, setDraft] = createSignal("");

  const refresh = () =>
    void bookmarksList()
      .then((b) => setBookmarks(b ?? []))
      .catch(() => {});

  onMount(() => {
    refresh();
    // Other surfaces (star button / Ctrl+D / bookmarks page) emit this on change.
    const onChange = () => refresh();
    window.addEventListener("flux:bookmarks-changed", onChange);
    onCleanup(() => window.removeEventListener("flux:bookmarks-changed", onChange));
  });

  const remove = (id: number, e: MouseEvent) => {
    e.stopPropagation();
    void bookmarkRemove(id)
      .then(() => {
        refresh();
        window.dispatchEvent(new Event("flux:bookmarks-changed"));
      })
      .catch(() => {});
  };

  const startEdit = (b: Bookmark, e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDraft(b.title || hostOf(b.url));
    setEditing(b.id);
  };
  const commitEdit = (id: number) => {
    if (editing() !== id) return; // already committed/cancelled
    const title = draft();
    setEditing(null);
    void bookmarkRename(id, title)
      .then(() => {
        refresh();
        window.dispatchEvent(new Event("flux:bookmarks-changed"));
      })
      .catch(() => {});
  };

  // `hscroll`: a vertical wheel scrolls the strip. The scrollbar itself is back
  // in CSS — between them, the bar is reachable with a mouse again.
  return (
    <div class="bookmark-bar hscroll" ref={(el) => onCleanup(attachHScroll(el))}>
      <Show
        when={bookmarks().length > 0}
        fallback={
          <span class="bookmark-bar-empty">
            No bookmarks yet — press <kbd>Ctrl+D</kbd> to pin the current page here.
          </span>
        }
      >
        <For each={bookmarks()}>
          {(b) => (
            <Show
              when={editing() === b.id}
              fallback={
                <button
                  class="bookmark-chip"
                  title={`${b.url}\n(double-click to rename)`}
                  onClick={() => props.onNavigate(b.url)}
                  onDblClick={(e) => startEdit(b, e)}
                  onContextMenu={(e) => openLinkMenu(e, b.url)}
                >
                  <span class="bookmark-chip-ico">{letter(b)}</span>
                  <span class="bookmark-chip-label">{b.title || hostOf(b.url)}</span>
                  <span class="bookmark-chip-x" title="Remove bookmark" onClick={(e) => remove(b.id, e)}>
                    ×
                  </span>
                </button>
              }
            >
              <input
                class="bookmark-chip-edit"
                autofocus
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={() => commitEdit(b.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") setEditing(null);
                }}
              />
            </Show>
          )}
        </For>
      </Show>
    </div>
  );
};

export default BookmarkBar;
