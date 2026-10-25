/**
 * Hover label for icon-only rails (#154).
 *
 * An icon-only launcher needs its names back on hover, and the obvious two ways
 * both fail here:
 *   • the native `title` tooltip is ~1s late, unstyled, and on WebKitGTK often
 *     lands in the wrong place entirely;
 *   • a label absolutely positioned inside the chip is clipped, because the bars
 *     scroll (`overflow-y: auto`) and that clips on *both* axes.
 *
 * So: one `position: fixed` element portaled to <body>, driven by a module-level
 * signal and positioned from the hovered element's own rect. One node for the
 * whole column rather than one per chip, and nothing to clip it.
 *
 * `title` stays on the chips as well — it's what a screen reader and a
 * long-press read, and it costs nothing.
 */
import { Show, createSignal, type Component } from "solid-js";
import { Portal } from "solid-js/web";

const [tip, setTip] = createSignal<{ text: string; x: number; y: number; left: boolean } | null>(null);

/** Where native pages draw: the page card while it shows a web page, and the
 *  web panels. A web page is an OS layer above all of Flux's HTML, so a label
 *  there is cut off under it. */
const UNDER_PAGES = ".card[data-native-page], .webpanel-surface";

/**
 * Show the label beside `el`, vertically centred on it: 8px to its right, or to
 * its left when a page would cover the right (the rail beside the page's right
 * edge). With pages on both sides there's nowhere to draw it, and the chip's
 * own `title` — the system's tooltip, which nothing covers — says it instead.
 */
export function showTip(el: Element, text: string): void {
  const r = el.getBoundingClientRect();
  const y = Math.round(r.top + r.height / 2);
  const w = Math.min(260, text.length * 7.2 + 26); // near enough: the text plus padding, to .railtip's max-width
  const covered = (x0: number) =>
    x0 < 0 ||
    x0 + w > window.innerWidth ||
    Array.from(document.querySelectorAll(UNDER_PAGES)).some((n) => {
      const b = n.getBoundingClientRect();
      return b.width > 0 && x0 < b.right && x0 + w > b.left && y - 14 < b.bottom && y + 14 > b.top;
    });
  const right = Math.round(r.right + 8);
  const left = Math.round(r.left - 8 - w);
  if (!covered(right)) setTip({ text, x: right, y, left: false });
  else if (!covered(left)) setTip({ text, x: Math.round(window.innerWidth - r.left + 8), y, left: true });
  else setTip(null);
}

export function hideTip(): void {
  setTip(null);
}

const RailTip: Component = () => (
  <Show when={tip()}>
    {(t) => (
      <Portal>
        {/* Not interactive: the pointer is over the chip, and a label that can
            take a hover would flicker as it appears under the cursor. */}
        <div
          class="railtip glass"
          style={
            t().left ? { right: `${t().x}px`, top: `${t().y}px` } : { left: `${t().x}px`, top: `${t().y}px` }
          }
          role="presentation"
        >
          {t().text}
        </div>
      </Portal>
    )}
  </Show>
);

export default RailTip;
