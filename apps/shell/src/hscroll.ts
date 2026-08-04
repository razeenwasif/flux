/**
 * Vertical wheel → horizontal scroll, for the chip strips (#157): the bookmark
 * bar and the tab folders.
 *
 * Both are horizontal-only scrollers. BACKLOG #140 standardised these strips on
 * `scrollbar-width: none`, which settled a genuine Windows/Linux disagreement
 * and, in the same stroke, removed the only way to scroll them — there was
 * nothing left to drag, and a horizontal-only scroller is not obliged to
 * translate a vertical wheel. Everything past the first screenful of bookmarks
 * or tab folders became unreachable.
 *
 * The scrollbars are back in CSS (drawn by the one global treatment, not
 * re-styled per component). This is the other half: with a plain mouse, a
 * vertical wheel is all you have, and it should move the strip.
 *
 * Call from a Solid `ref` and hand the returned disposer to `onCleanup`.
 */
export function attachHScroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    if (el.scrollWidth <= el.clientWidth) return; // nothing to scroll
    // A genuine horizontal gesture (trackpad swipe, tilt wheel) already does
    // the right thing — only translate a vertical one.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };

  // Non-passive: a passive listener cannot preventDefault, and without that the
  // wheel keeps scrolling whatever is behind while the strip stays put.
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}
