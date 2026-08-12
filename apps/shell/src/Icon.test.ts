import { describe, expect, it } from "vitest";

import { ICONS } from "./Icon";

/** `satisfies` narrows each entry to exactly the keys it has, so the union has
 *  no `c`/`dot`. The set is uniform in practice; read it through one shape. */
type Art = { d: string[]; c?: [number, number, number][]; dot?: [number, number, number][] };
const art = (n: keyof typeof ICONS): Art => ICONS[n] as Art;

/**
 * An icon that draws nothing fails silently: the SVG renders, the button keeps
 * its size and hover, and the user just sees an empty square. Nothing throws and
 * nothing logs — so the only defence is checking the geometry is there.
 */
describe("icon set", () => {
  const names = Object.keys(ICONS) as (keyof typeof ICONS)[];

  it("draws something for every icon", () => {
    for (const n of names) {
      const a = art(n);
      const marks = a.d.length + (a.c?.length ?? 0) + (a.dot?.length ?? 0);
      expect(marks, `${n} has no geometry`).toBeGreaterThan(0);
    }
  });

  it("only contains path data a renderer will accept", () => {
    for (const n of names) {
      for (const d of art(n).d) {
        // A path must start with a move; anything else is a typo that silently
        // draws nothing rather than erroring.
        expect(d, `${n}: path does not start with a move`).toMatch(/^[Mm]/);
        expect(d.length, `${n}: suspiciously short path`).toBeGreaterThan(4);
        // Letters that aren't valid SVG path commands mean a mangled string.
        const bad = d.replace(/[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]/g, "");
        expect(bad, `${n}: unexpected characters ${JSON.stringify(bad)}`).toBe("");
      }
    }
  });

  it("keeps every drawing inside the 24-unit grid", () => {
    // Artwork that runs off-canvas is clipped without complaint — which is how
    // the first `feeds` icon shipped as two stray arcs, its centre at x = -9.
    for (const n of names) {
      for (const [cx, cy, r] of art(n).c ?? []) {
        expect(cx - r, `${n}: circle escapes left`).toBeGreaterThanOrEqual(-0.5);
        expect(cx + r, `${n}: circle escapes right`).toBeLessThanOrEqual(24.5);
        expect(cy - r, `${n}: circle escapes top`).toBeGreaterThanOrEqual(-0.5);
        expect(cy + r, `${n}: circle escapes bottom`).toBeLessThanOrEqual(24.5);
      }
      for (const d of art(n).d) {
        // Absolute coordinates only — relative segments can't be bounds-checked
        // this cheaply, and the ones that matter here are the absolute moves.
        for (const m of d.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/g)) {
          const x = Number(m[1]);
          const y = Number(m[2]);
          expect(x, `${n}: x=${x} off-grid`).toBeGreaterThanOrEqual(-1);
          expect(x, `${n}: x=${x} off-grid`).toBeLessThanOrEqual(25);
          expect(y, `${n}: y=${y} off-grid`).toBeGreaterThanOrEqual(-1);
          expect(y, `${n}: y=${y} off-grid`).toBeLessThanOrEqual(25);
        }
      }
    }
  });

  it("has an icon for every page the launcher lists", () => {
    // PagesBar is typed against IconName, so a missing icon is a compile error —
    // this pins the ones the footer uses too, which are referenced as literals.
    for (const n of [
      "notebook",
      "trail",
      "whiteboard",
      "scribe",
      "sessions",
      "archive",
      "feeds",
      "history",
      "bookmarks",
      "tasks",
      "resources",
      "speedtest",
      "omni",
      "apps",
      "passwords",
      "sync",
      "settings",
      "terminal",
      "agent",
      "calendar",
      "mail",
      "shields",
      "boosts",
      "macros",
      "note",
      "panels",
      "archived",
      "extensions",
      "workspaces",
    ]) {
      expect(names, `missing icon: ${n}`).toContain(n);
    }
  });
});
