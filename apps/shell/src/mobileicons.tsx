/**
 * Line icons for the phone chrome (ADR 0012): the bottom bar, the tab grid and
 * the menu sheet. Drawn on a 24-unit grid with round 1.8 strokes in
 * currentColor, the weight of iOS's own toolbar glyphs, so they sit with the
 * system's UI rather than against it. Only the phone build loads this.
 */
import type { Component } from "solid-js";

const P = {
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  reload: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  stop: "M6 6l12 12M18 6L6 18",
  tabs: "M7.5 7.5V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-1.5M4 9.5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  more: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  plus: "M12 5v14M5 12h14",
  share:
    "M12 3.5v11M8 7l4-3.5L16 7M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1",
  lock: "M7.5 11V8a4.5 4.5 0 0 1 9 0v3M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z",
  globe:
    "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z",
  search: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM15.5 15.5L20 20",
  home: "M4.5 10.5L12 4l7.5 6.5M6.5 9v10.5h4v-6h3v6h4V9",
  close: "M7 7l10 10M17 7L7 17",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2",
  star: "M12 4l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z",
  book: "M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 8h6",
  compass: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM15.5 8.5l-2 5-5 2 2-5z",
  archive: "M4 5h16v4H4zM5.5 9v10h13V9M10 13h4",
  rss: "M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8M6 19h.01",
  layers: "M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5",
  check: "M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5",
  gauge: "M4.5 17a8.5 8.5 0 1 1 15 0M12 13l3.5-4",
  bolt: "M13 3L5.5 13.5H12L11 21l7.5-10.5H12z",
  sparkle:
    "M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6L4.5 11l5.6-1.9zM18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  grid: "M5 5h5.5v5.5H5zM13.5 5H19v5.5h-5.5zM5 13.5h5.5V19H5zM13.5 13.5H19V19h-5.5z",
  key: "M14.5 13.5a5 5 0 1 0-4.6-3L4 16.4V20h3.5v-2h2v-2h2l1.4-1.4c.5.2 1 .4 1.6.4zM16 8h.01",
  sync: "M19.5 9A7.5 7.5 0 0 0 6 6.8L4.5 8.5M4.5 4.5v4h4M4.5 15A7.5 7.5 0 0 0 18 17.2l1.5-1.7M19.5 19.5v-4h-4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 13.4v-2.8l-2-.6-.6-1.4 1-1.9-2-2-1.9 1-1.4-.6-.6-2h-2.8l-.6 2-1.4.6-1.9-1-2 2 1 1.9L5 10l-2 .6v2.8l2 .6.6 1.4-1 1.9 2 2 1.9-1 1.4.6.6 2h2.8l.6-2 1.4-.6 1.9 1 2-2-1-1.9.6-1.4z",
  shield: "M12 3.5l7 2.5v5.5c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

export type IconName = keyof typeof P;

export const Icon: Component<{ name: IconName; size?: number; class?: string }> = (props) => (
  <svg
    class={props.class}
    width={props.size ?? 22}
    height={props.size ?? 22}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={P[props.name]} />
  </svg>
);
