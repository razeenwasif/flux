/**
 * Bookmark bar (BACKLOG #22) — a chip row docked under the content card, so your
 * bookmarks are one click away without opening flux://bookmarks. Rendered as a
 * sibling *below* the card (not over it), so it never collides with the native
 * tab webview (which is an OS layer over the card) — the card shrinks and the
 * webview relayout follows.
 */
import {
  For,
  Show,
  Suspense,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { bookmarkRemove, bookmarkRename, bookmarksList, type Bookmark } from "./ipc";
import { attachHScroll } from "./hscroll";
import { openLinkMenu } from "./linkMenu";
import { buildTree, hostOf, letter, type Folder } from "./bookmarkTree";
import Icon from "./Icon";
import { shortcutLabel } from "./platform";

const BookmarkFolderMenu = lazy(() => import("./BookmarkFolderMenu"));

/** `inPane`: Velvet Paper's place for it, a row in the tabs pane; folders open
 *  downward from there, rather than up from under the page card. */
const BookmarkBar: Component<{ onNavigate: (url: string) => void; inPane?: boolean }> = (props) => {
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([]);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [draft, setDraft] = createSignal("");
  // A double-click starts with two clicks: hold the navigation briefly so the
  // rename gesture doesn't first navigate the active tab away (twice).
  let navTimer: number | undefined;
  onCleanup(() => clearTimeout(navTimer));

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

  // The bar is the top level of the tree, folders as chips that open, in the
  // order things were added (an import keeps its browser's toolbar order).
  const tree = createMemo(() => buildTree(bookmarks()));
  const order = createMemo(() => new Map(bookmarks().map((b, i) => [b.id, i])));
  type Entry =
    { folder: Folder; b?: undefined; at: number } | { b: Bookmark; folder?: undefined; at: number };
  const entries = createMemo<Entry[]>(() => {
    const { root } = tree();
    return [
      ...root.folders.map((folder) => ({ folder, at: folder.first })),
      ...root.items.map((b) => ({ b, at: order().get(b.id) ?? 0 })),
    ].sort((a, z) => a.at - z.at);
  });

  // The folder menu rises from its chip over the page; its own chunk loads on
  // the first open (the bar is on every window's boot path).
  const [menu, setMenu] = createSignal<{ path: string; left: number; top?: number; bottom?: number } | null>(
    null,
  );
  const openMenu = (f: Folder, chip: HTMLElement) => {
    if (menu()?.path === f.path) return setMenu(null);
    const r = chip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 308));
    setMenu(
      props.inPane
        ? { path: f.path, left, top: r.bottom + 6 }
        : { path: f.path, left, bottom: window.innerHeight - r.top + 6 },
    );
  };

  function FolderChip(p: { f: Folder }) {
    return (
      <button
        classList={{ "bookmark-chip": true, "bookmark-folder": true, open: menu()?.path === p.f.path }}
        title={`${p.f.name} · ${p.f.count} bookmark${p.f.count === 1 ? "" : "s"}`}
        aria-haspopup="menu"
        aria-expanded={menu()?.path === p.f.path}
        onClick={(e) => openMenu(p.f, e.currentTarget)}
      >
        <span class="bookmark-chip-ico bookmark-folder-ico">
          <Icon name="files" />
        </span>
        <span class="bookmark-chip-label">{p.f.name}</span>
        <span class="bookmark-folder-caret">▾</span>
      </button>
    );
  }

  function Chip(p: { b: Bookmark }) {
    const b = p.b;
    return (
      <Show
        when={editing() === b.id}
        fallback={
          <button
            class="bookmark-chip"
            title={`${b.url}\n(double-click to rename)`}
            onClick={(e) => {
              if (e.detail > 1) return; // the 2nd click of a double-click
              clearTimeout(navTimer);
              navTimer = window.setTimeout(() => props.onNavigate(b.url), 250);
            }}
            onDblClick={(e) => {
              clearTimeout(navTimer);
              startEdit(b, e);
            }}
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
    );
  }

  // `hscroll`: a vertical wheel scrolls the strip. The scrollbar itself is back
  // in CSS — between them, the bar is reachable with a mouse again.
  return (
    <div
      classList={{ "bookmark-bar": true, hscroll: true, "in-pane": !!props.inPane }}
      ref={(el) => onCleanup(attachHScroll(el))}
    >
      <Show
        when={bookmarks().length > 0}
        fallback={
          <span class="bookmark-bar-empty">
            {props.inPane ? (
              <>
                Bookmarks: <kbd>{shortcutLabel("Ctrl+D")}</kbd> adds this page
              </>
            ) : (
              <>
                No bookmarks yet — press <kbd>{shortcutLabel("Ctrl+D")}</kbd> to pin the current page here.
              </>
            )}
          </span>
        }
      >
        <For each={entries()}>
          {(e) => (
            <Show when={e.b} fallback={<FolderChip f={e.folder!} />}>
              {(b) => <Chip b={b()} />}
            </Show>
          )}
        </For>
      </Show>
      <Show when={menu()} keyed>
        {(m) => (
          <Suspense>
            <BookmarkFolderMenu
              start={m.path}
              left={m.left}
              top={m.top}
              bottom={m.bottom}
              byPath={tree().byPath}
              onClose={() => setMenu(null)}
              onNavigate={props.onNavigate}
              label={(b) => b.title || hostOf(b.url)}
              mark={letter}
            />
          </Suspense>
        )}
      </Show>
    </div>
  );
};

export default BookmarkBar;
