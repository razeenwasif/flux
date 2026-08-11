/**
 * Flux's own icon set (#183) — line icons drawn on a 24×24 grid.
 *
 * Replaces the emoji that stood in for the launcher and footer buttons. Emoji
 * were never really icons: they render in the *system's* font, so they arrive
 * multicoloured, at inconsistent optical weights, sized differently per glyph,
 * and looking like a different product on Windows than on Linux. A rail of them
 * reads as a row of stickers rather than a set of controls.
 *
 * The rules that make these look like one family:
 *
 *   * **One grid.** 24×24, artwork inside 3–21, so every icon has the same
 *     optical margin and none looks bigger than its neighbour.
 *   * **One weight.** 1.6 grid-units of stroke, round caps and joins, no fills.
 *     The stroke scales with the box, so a 15px chip and a 32px button are the
 *     same drawing rather than the same line thickness at two scales.
 *   * **`currentColor`, never a literal.** The button already encodes its state
 *     in `color` — dim at rest, bright on hover, accent when active — and an
 *     icon painted `#fff` would ignore all three and glow at rest.
 *
 * Geometry is expressed as path `d` strings plus explicit circles: an arc-based
 * circle in path data is unreadable and easy to get subtly wrong, and these are
 * meant to be edited by hand.
 */
import type { Component } from "solid-js";
import { For, Show } from "solid-js";

type Art = {
  /** Stroked outlines. */
  d: string[];
  /** Circles as `[cx, cy, r]` — clearer than the arc form, and exact. */
  c?: [number, number, number][];
  /** Filled dots, for things that are genuinely dots (a record button). */
  dot?: [number, number, number][];
};

/** Every icon Flux draws. Keys are meanings, not pictures. */
export const ICONS = {
  // ── Native pages ─────────────────────────────────────────────────────────
  notebook: {
    d: [
      "M8 3.5h10.5a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H8A2.5 2.5 0 0 1 5.5 18V6A2.5 2.5 0 0 1 8 3.5Z",
      "M11.5 8.5h5M11.5 12.5h5",
    ],
  },
  trail: {
    d: ["m6.7 17.3 3.6-3.6", "m13.7 10.3 3.6-3.6"],
    c: [
      [5.4, 18.6, 1.8],
      [12, 12, 1.8],
      [18.6, 5.4, 1.8],
    ],
  },
  whiteboard: { d: ["M3.5 4.5h17v13h-17z", "M7 13.5c2-4.5 4-4.5 5.5-2.2s3-1.2 4.5-2.3"] },
  scribe: {
    d: ["M4 20c3 1 4-2 7-2s4 1 4 1", "M9 15 18.5 5.5a1.8 1.8 0 0 1 2.6 2.6L11.6 17.6", "M8.6 15.4 11.6 17.6"],
  },
  sessions: { d: ["m12 3 8 4-8 4-8-4 8-4Z", "m4 12 8 4 8-4", "m4 17 8 4 8-4"] },
  archive: { d: ["M3 4h18v4H3z", "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8", "M10 12h4"] },
  feeds: { d: ["M6.8 12.7a4.5 4.5 0 0 1 4.5 4.5", "M6.8 8.2a9 9 0 0 1 9 9"], dot: [[6.8, 17.2, 1.6]] },
  history: { d: ["M3.5 12a8.5 8.5 0 1 0 2.6-6.1", "M3 4v4h4", "M12 8v4.5l3 1.8"] },
  bookmarks: { d: ["M6 3h12v18l-6-4.5L6 21z"] },
  tasks: { d: ["M3 12h3l2.5-6 3.5 13 3-9 2 2h4"] },
  resources: { d: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"] },
  speedtest: { d: ["M4 18a9 9 0 1 1 16 0", "m15 9-3.5 5"], dot: [[11.5, 14, 1.6]] },
  omni: { d: ["m19.4 19.4-4.4-4.4"], c: [[10.4, 10.4, 6.4]] },
  apps: { d: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"] },
  passwords: { d: ["m14 10-8.5 8.5L4 21l3-.7L8.5 18", "M9 15.5 11 17.5"], c: [[16.5, 7.5, 4.5]] },
  sync: { d: ["M20 12a8 8 0 0 1-13.7 5.6", "M4 12a8 8 0 0 1 13.7-5.6", "M17 3v3.6h-3.6", "M7 21v-3.6h3.6"] },
  settings: {
    d: ["M5 7h14M5 12h14M5 17h14"],
    c: [
      [9, 7, 2],
      [15, 12, 2],
      [9, 17, 2],
    ],
  },

  // ── Sidebar footer ───────────────────────────────────────────────────────
  terminal: { d: ["M3 5h18v14H3z", "m7 10 2.5 2L7 14", "M13 14.5h4"] },
  agent: {
    d: [
      "M12 3.5c.7 4.4 1.4 5.1 5.8 5.8-4.4.7-5.1 1.4-5.8 5.8-.7-4.4-1.4-5.1-5.8-5.8 4.4-.7 5.1-1.4 5.8-5.8Z",
      "M18 15.5c.35 2.2.7 2.5 2.9 2.9-2.2.4-2.5.7-2.9 2.9-.35-2.2-.7-2.5-2.9-2.9 2.2-.35 2.5-.7 2.9-2.9Z",
    ],
  },
  calendar: {
    d: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4M16 3v4"],
    dot: [
      [9, 14, 1.1],
      [15, 14, 1.1],
    ],
  },
  mail: { d: ["M3 6h18v12H3z", "m3.5 7 8.5 6.5L20.5 7"] },
  shields: { d: ["M12 3 20 6v6c0 4.5-3.3 7.7-8 9-4.7-1.3-8-4.5-8-9V6l8-3Z"] },
  boosts: { d: ["M13 3 5.5 13.5H12L11 21l7.5-10.5H12L13 3Z"] },
  macros: { d: ["M4 6h16v12H4z"], dot: [[12, 12, 3.2]] },
  note: { d: ["M6 3h8l5 5v13H6z", "M14 3v5h5", "M9.5 13h5M9.5 16.5h3"] },
  panels: { d: ["M3 5h18v14H3z", "M14 5v14", "M17 9h1M17 12h1M17 15h1"] },
  archived: {
    d: ["M3 4h18v4H3z", "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8", "M12 11v5", "m9.5 13.5 2.5 2.5 2.5-2.5"],
  },
  workspaces: { d: ["M3.5 8.5h11v11h-11z", "M8.5 3.5h11v11h-11z"] },
  extensions: { d: ["M4.8 4.8h5.4a1.8 1.8 0 1 1 3.6 0h5.4v5.4a1.8 1.8 0 1 0 0 3.6v5.4H4.8V4.8Z"] },
} satisfies Record<string, Art>;

export type IconName = keyof typeof ICONS;

/**
 * One icon. `size` is the rendered box; the geometry always comes from the same
 * 24-unit grid, so mixing sizes never changes the drawing's proportions.
 */
const Icon: Component<{ name: IconName; size?: number; class?: string }> = (props) => {
  const art = () => ICONS[props.name] as Art;
  const px = () => props.size ?? 18;
  return (
    <svg
      class={props.class ? `flux-icon ${props.class}` : "flux-icon"}
      width={px()}
      height={px()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      // Decorative: every one of these sits in a control that already carries a
      // title/aria-label, so announcing the shape too would just be noise.
      aria-hidden={true}
    >
      <For each={art().d}>{(d) => <path d={d} />}</For>
      <Show when={art().c}>
        <For each={art().c!}>{([cx, cy, r]) => <circle cx={cx} cy={cy} r={r} />}</For>
      </Show>
      <Show when={art().dot}>
        <For each={art().dot!}>
          {([cx, cy, r]) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />}
        </For>
      </Show>
    </svg>
  );
};

export default Icon;
