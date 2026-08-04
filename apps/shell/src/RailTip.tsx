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

const [tip, setTip] = createSignal<{ text: string; x: number; y: number } | null>(null);

/** Show the label beside `el`. Vertically centred on it, 8px to its right. */
export function showTip(el: Element, text: string): void {
  const r = el.getBoundingClientRect();
  setTip({ text, x: Math.round(r.right + 8), y: Math.round(r.top + r.height / 2) });
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
        <div class="railtip glass" style={{ left: `${t().x}px`, top: `${t().y}px` }} role="presentation">
          {t().text}
        </div>
      </Portal>
    )}
  </Show>
);

export default RailTip;
