/**
 * Shared right-click menu for links inside Flux's internal DOM pages (archive,
 * feeds, history, bookmarks…). Real web pages get WebView2's own context menu;
 * these DOM pages had none, so a navigable item couldn't be opened in a new tab.
 *
 * Usage: on any element that represents a URL, add
 *   onContextMenu={(e) => openLinkMenu(e, url)}
 * and render <LinkMenu/> once at the app root.
 */
import { For, Show, createSignal, onCleanup, type Component } from "solid-js";
import { peekOpen } from "./ipc";

interface MenuState { x: number; y: number; url: string }
const [menu, setMenu] = createSignal<MenuState | null>(null);

/** Open the link menu at the cursor for `url` (suppresses the browser menu). */
export function openLinkMenu(e: MouseEvent, url: string): void {
  if (!url) return;
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, url });
}
export const closeLinkMenu = () => setMenu(null);

export const LinkMenu: Component<{
  onOpen: (url: string, background?: boolean) => void;
}> = (props) => {
  // Close on any *outside* interaction. This listener is capture-phase (it must
  // beat Solid's delegated bubble-phase onClick to catch clicks elsewhere), so a
  // click on a menu item would otherwise close the menu — unmounting the button —
  // before its own handler runs. Guard by target: clicks inside `.link-menu` are
  // left for the item handler, which closes the menu itself afterwards.
  const onDocClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest(".link-menu")) return;
    closeLinkMenu();
  };
  const onScroll = () => closeLinkMenu();
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeLinkMenu(); };
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("keydown", onKey, true);
  });

  const items = (m: MenuState) => [
    { label: "Open in new tab", run: () => props.onOpen(m.url, false) },
    { label: "Open in new background tab", run: () => props.onOpen(m.url, true) },
    { label: "Peek (glance window)", run: () => void peekOpen(m.url).catch(() => {}) },
    { label: "Copy link", run: () => void navigator.clipboard?.writeText(m.url).catch(() => {}) },
  ];

  return (
    <Show when={menu()}>
      {(m) => {
        // Clamp so the menu stays on-screen.
        const left = Math.min(m().x, window.innerWidth - 220);
        const top = Math.min(m().y, window.innerHeight - 120);
        return (
          <div class="link-menu glass" style={{ left: `${left}px`, top: `${top}px` }} onClick={(e) => e.stopPropagation()}>
            <For each={items(m())}>
              {(it) => (
                <button class="link-menu-item" onClick={() => { it.run(); closeLinkMenu(); }}>{it.label}</button>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
};
