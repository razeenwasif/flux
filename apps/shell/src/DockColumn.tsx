/**
 * The dock column — calendar above, mail below, in a layout column of their own.
 *
 * Both used to compete for the web panel: docking the calendar there left a
 * pinned site sharing the same strip, so you couldn't have calendar, mail *and*
 * something else. Giving the pair their own column frees the web panel entirely.
 *
 * Structurally this is the `rightstack` column (agent over terminal) again — one
 * width charged once, a draggable horizontal seam between two slots — and it
 * deliberately reuses that CSS rather than growing a parallel set.
 */
import { Show, Suspense, lazy, type Component } from "solid-js";

import { calendarInDock, dockRatio, setDockRatio } from "./store";

const CalendarPop = lazy(() => import("./CalendarPop"));
const MailPane = lazy(() => import("./MailPane"));

const DockColumn: Component = () => {
  /** Drag the seam between calendar (top) and mail (bottom). */
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const col = (e.currentTarget as HTMLElement).parentElement;
    if (!col) return;
    const box = col.getBoundingClientRect();
    const move = (me: PointerEvent) => {
      if (box.height <= 0) return;
      setDockRatio((me.clientY - box.top) / box.height);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div class="rightstack dock-col">
      {/* Only when the calendar's placement is *this* column. Keying off
          "is the calendar open" would draw it here AND in the web panel when it's
          docked there. Closing it hands the whole column to mail rather than
          leaving a dead half. */}
      <Show when={calendarInDock()}>
        <div class="rightstack-slot" style={{ "flex-grow": String(dockRatio()) }}>
          <Suspense>
            <CalendarPop docked />
          </Suspense>
        </div>
        <div class="rightstack-seam" title="Drag to resize" onPointerDown={startDrag} />
      </Show>
      <div class="rightstack-slot" style={{ "flex-grow": String(calendarInDock() ? 1 - dockRatio() : 1) }}>
        <Suspense>
          <MailPane />
        </Suspense>
      </div>
    </div>
  );
};

export default DockColumn;
