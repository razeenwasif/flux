/**
 * Arcade cabinet art (#183) — one icon per Playground game.
 *
 * Deliberately **not** in the shared `Icon.tsx`. That set is eager chrome: the
 * sidebar and the launcher rail paint on the first frame, so everything in it is
 * paid for at boot by every session. The Playground is a lazy chunk, and 23 game
 * icons only matter to someone who opened it — so they ride along with it and
 * cost the other 99% of launches nothing.
 *
 * Same grid and weight as the chrome set (24×24, 1.6 stroke, `currentColor`), so
 * a cabinet tile still looks like part of Flux rather than a sticker sheet. The
 * games each have an `accent`, and `currentColor` is what lets the tile tint its
 * icon to match.
 */
import type { Component } from "solid-js";
import { For, Show } from "solid-js";

type Art = { d: string[]; c?: [number, number, number][]; dot?: [number, number, number][] };

export const GAME_ICONS = {
  snake: { d: ["M6.5 18.5h6.5a3.4 3.4 0 0 0 0-6.8H9.5a3.4 3.4 0 0 1 0-6.8h3.6"], dot: [[15, 5, 1.5]] },
  tetris: { d: ["M3.5 8.5h7v7h-7z", "M10.5 8.5h7v-5h-7", "M10.5 15.5h7v5h-7"] },
  breakout: {
    d: [
      "M3.5 4h6v3.2h-6zM10.5 4h4v3.2h-4zM15.5 4h5v3.2h-5z",
      "M3.5 8.4h4v3.2h-4zM8.5 8.4h6v3.2h-6zM15.5 8.4h5v3.2h-5z",
      "M7.5 19.8h6",
    ],
    dot: [[15.5, 15.8, 1.5]],
  },
  pong: { d: ["M4 7.5v9M20 7.5v9", "M12 4v2.5M12 10.5v3M12 17.5V20"], dot: [[12, 12, 1.5]] },
  invaders: {
    d: ["M8 6.5h8v3h2.5v5H16v3H8v-3H5.5v-5H8v-3Z", "M8 20.5h2M14 20.5h2"],
    dot: [
      [10, 11, 1],
      [14, 11, 1],
    ],
  },
  flappy: { d: ["M14.5 3.5h6v7h-6z", "M14.5 20.5h6v-6h-6z"], dot: [[7.5, 12, 2.4]] },
  asteroids: { d: ["m12 3.5 6.6 15.4L12 15.2l-6.6 3.7 6.6-15.4Z"] },
  "2048": { d: ["M3.5 3.5h17v17h-17z", "M3.5 12h17M12 3.5v17"] },
  minesweeper: { d: ["M8.5 4v16", "m8.5 4.8 8 2.8-8 2.8", "M5.5 20h8"] },
  pacman: { d: ["M20 7.5A8.5 8.5 0 1 0 20 16.5L12 12l8-4.5Z"], dot: [[10.5, 8, 1.2]] },
  dino: {
    d: [
      "M12 20.5V5.5",
      "M12 13H9.2A2.6 2.6 0 0 1 9.2 7.8",
      "M12 15.2h2.8A2.6 2.6 0 0 0 14.8 10",
      "M9 20.5h6",
    ],
  },
  stack: { d: ["M5.5 17.5h13v3h-13z", "M7 13h10v3.5H7z", "M8.5 8.5h7V12h-7z", "M10 4h4v3.5h-4z"] },
  frogger: {
    d: ["M5.5 17c0-3.9 2.9-6.4 6.5-6.4s6.5 2.5 6.5 6.4z", "m6.4 17.6-2 3M17.6 17.6l2 3"],
    c: [
      [9.2, 8.4, 2.1],
      [14.8, 8.4, 2.1],
    ],
  },
  whack: { d: ["m11 12.5-6 6a2.1 2.1 0 0 0 3 3l6-6", "M13 4.5 20.5 12l1-1a3.4 3.4 0 0 0-5-5l-3.5 -1.5Z"] },
  doodle: { d: ["M4 19.8h6.5M13.5 14.4h6.5M4.5 9h6.5"], dot: [[15.5, 10.6, 2]] },
  simon: {
    d: [
      "M12 3.5a8.5 8.5 0 0 1 8.5 8.5H12V3.5Z",
      "M12 12h8.5a8.5 8.5 0 0 1-8.5 8.5V12Z",
      "M12 12v8.5A8.5 8.5 0 0 1 3.5 12H12Z",
      "M12 12H3.5A8.5 8.5 0 0 1 12 3.5V12Z",
    ],
  },
  columns: { d: ["m12 3.5 4 4-4 4-4-4 4-4Z", "m12 12.5 4 4-4 4-4-4 4-4Z"] },
  missile: { d: ["M12 20.5V11", "m12 3.5 3 5h-6l3-5Z", "M4 20.5h16", "m7 20.5 2-4M17 20.5l-2-4"] },
  bubble: {
    d: ["M12 20.5V15"],
    c: [
      [8, 8, 3.6],
      [16, 8, 3.6],
      [12, 13, 2.4],
    ],
  },
  bejeweled: { d: ["m12 3.5 5 4-5 12-5-12 5-4Z", "M7 7.5h10M12 3.5 9 7.5M12 3.5l3 4"] },
  centipede: {
    d: ["M4.5 15.5h3M9 15.5h3M13.5 15.5h3", "m18 12-1.5 2 1.5 2", "M6 12v-1.5M10.5 12v-1.5M15 12v-1.5"],
    c: [
      [6, 15.5, 2.2],
      [10.5, 15.5, 2.2],
      [15, 15.5, 2.2],
    ],
  },
  connect4: {
    d: ["M3.5 4.5h17v15h-17z"],
    c: [
      [8, 9, 1.9],
      [16, 9, 1.9],
      [8, 15, 1.9],
    ],
    dot: [[16, 15, 1.9]],
  },
  reversi: {
    d: ["M3.5 3.5h17v17h-17z", "M3.5 12h17M12 3.5v17"],
    c: [
      [7.7, 7.7, 2.4],
      [16.3, 16.3, 2.4],
    ],
    dot: [
      [16.3, 7.7, 2.4],
      [7.7, 16.3, 2.4],
    ],
  },
} satisfies Record<string, Art>;

export type GameIconName = keyof typeof GAME_ICONS;

/** True for a game id the set has art for. */
export const hasGameIcon = (s: string): s is GameIconName => s in GAME_ICONS;

const GameIcon: Component<{ name: GameIconName; size?: number; class?: string }> = (props) => {
  const art = () => GAME_ICONS[props.name] as Art;
  const px = () => props.size ?? 22;
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

export default GameIcon;
