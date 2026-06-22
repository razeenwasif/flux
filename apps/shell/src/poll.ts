// Visibility-aware polling (perf: a minimised / hidden Flux shouldn't keep hitting
// the backend every couple of seconds). The dozens of panel refresh timers all
// went through `setInterval` unconditionally — so a backgrounded window paid the
// full idle poll cost. `visibleInterval` ticks only while the document is visible,
// and refreshes once the moment visibility is regained so the view is fresh when
// you come back.

import { onCleanup } from "solid-js";

/**
 * Run `fn` every `ms` — but only while `document.visibilityState === "visible"`.
 * Fires `fn` immediately on start and on each re-show (so panels repaint on
 * return), pauses entirely while hidden, and tears down the timer + listener when
 * the owning reactive scope disposes. A throw in `fn` is swallowed so one bad poll
 * can't kill the loop. Must be called inside a tracking scope (onMount/createEffect/
 * component body) so `onCleanup` is wired.
 */
export function visibleInterval(fn: () => void, ms: number): void {
  let timer: number | undefined;
  const tick = () => {
    try {
      fn();
    } catch {
      /* a failed poll shouldn't stop future ones */
    }
  };
  const start = () => {
    if (timer != null) return;
    tick();
    timer = window.setInterval(tick, ms);
  };
  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) start();
  onCleanup(() => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  });
}
