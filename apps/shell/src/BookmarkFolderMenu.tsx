/**
 * A bookmark-bar folder, opened (BookmarkBar.tsx): its subfolders, which walk
 * in, and its bookmarks. It rises over the content card, so while it's open
 * the page hides (bookmarkMenuOpen is in the store's overlay registry: the
 * native page would cover it otherwise). Lazy: loads on the first open.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import type { Bookmark } from "./ipc";
import { setBookmarkMenuOpen } from "./bookmarkMenuOpen";
import type { Folder } from "./bookmarkTree";
import Icon from "./Icon";
import { openLinkMenu } from "./linkMenu";
import { openTab, openUrlsAsGroup } from "./store";
import "./BookmarkBar.css";

const BookmarkFolderMenu: Component<{
  start: string;
  left: number;
  /** Below its chip (the tabs pane) or above it (under the page card). */
  top?: number;
  bottom?: number;
  byPath: Map<string, Folder>;
  onClose: () => void;
  onNavigate: (url: string) => void;
  /** How the bar names and marks a bookmark, so the menu draws them the same
   *  (passed in: importing them would fold the bar's chunk into a shared one). */
  label: (b: Bookmark) => string;
  mark: (b: Bookmark) => string;
}> = (props) => {
  const [trail, setTrail] = createSignal([props.start]);
  const shown = () => props.byPath.get(trail()[trail().length - 1]!);
  const back = () => setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));
  const go = (b: Bookmark, e: MouseEvent) => {
    props.onClose();
    if (e.metaKey || e.ctrlKey || e.button === 1) void openTab("browser", b.url);
    else props.onNavigate(b.url);
  };
  onMount(() => {
    setBookmarkMenuOpen(true);
    const outside = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest(".bm-menu") && !t?.closest(".bookmark-folder")) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (trail().length > 1) back();
      else props.onClose();
    };
    const away = () => props.onClose();
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", away);
    onCleanup(() => {
      setBookmarkMenuOpen(false);
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", away);
    });
  });

  return (
    <Show when={shown()}>
      {(f) => (
        <Portal>
          <div
            class="bm-menu"
            role="menu"
            aria-label={f().name}
            style={
              props.top != null
                ? {
                    left: `${props.left}px`,
                    top: `${props.top}px`,
                    "max-height": `calc(100vh - ${props.top + 16}px)`,
                  }
                : { left: `${props.left}px`, bottom: `${props.bottom}px` }
            }
          >
            <div class="bm-menu-head">
              <Show when={trail().length > 1}>
                <button class="bm-menu-back" title="Back" aria-label="Back" onClick={back}>
                  ‹
                </button>
              </Show>
              <span class="bm-menu-title">{f().name}</span>
              <Show when={f().items.length > 1}>
                <button
                  class="bm-menu-group"
                  title="Open this folder's bookmarks as a tab group"
                  onClick={() => {
                    props.onClose();
                    void openUrlsAsGroup(
                      f().name,
                      f().items.map((b) => b.url),
                    );
                  }}
                >
                  Open all
                </button>
              </Show>
            </div>
            <div class="bm-menu-list">
              <For each={f().folders}>
                {(sub) => (
                  <button
                    class="bm-menu-row"
                    role="menuitem"
                    onClick={() => setTrail((t) => [...t, sub.path])}
                  >
                    <span class="bm-menu-ico">
                      <Icon name="files" />
                    </span>
                    <span class="bm-menu-name">{sub.name}</span>
                    <span class="bm-menu-n">{sub.count}</span>
                    <span class="bm-menu-more">›</span>
                  </button>
                )}
              </For>
              <For each={f().items}>
                {(b) => (
                  <button
                    class="bm-menu-row"
                    role="menuitem"
                    title={b.url}
                    onClick={(e) => go(b, e)}
                    onAuxClick={(e) => e.button === 1 && go(b, e)}
                    onContextMenu={(e) => {
                      props.onClose();
                      openLinkMenu(e, b.url);
                    }}
                  >
                    <span class="bm-menu-ico bm-menu-letter">{props.mark(b)}</span>
                    <span class="bm-menu-name">{props.label(b)}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
};

export default BookmarkFolderMenu;
