import { describe, expect, it } from "vitest";

import { TRIM_IDLE_MS, planTrim } from "./memtrim";

const bg = (id: number, idleMs: number) => ({ id, idleMs });

describe("background memory trim policy", () => {
  it("trims a tab that has been backgrounded long enough", () => {
    const p = planTrim([bg(1, TRIM_IDLE_MS)], new Set());
    expect(p.trim).toEqual([1]);
    expect(p.forget).toEqual([]);
  });

  it("leaves a freshly backgrounded tab alone", () => {
    // Flicking between two tabs must not force a GC on the one you just left.
    expect(planTrim([bg(1, TRIM_IDLE_MS - 1)], new Set()).trim).toEqual([]);
    expect(planTrim([bg(1, 0)], new Set()).trim).toEqual([]);
  });

  it("trims once per stint, not once per sweep", () => {
    // The whole point of the trimmed set: a forced GC every 60 s forever on
    // every idle tab would cost more than the caches it reclaims.
    const first = planTrim([bg(1, TRIM_IDLE_MS)], new Set());
    expect(first.trim).toEqual([1]);
    const second = planTrim([bg(1, TRIM_IDLE_MS * 10)], new Set(first.trim));
    expect(second.trim, "already trimmed").toEqual([]);
  });

  it("forgets a tab that came back into view, so it can be trimmed again", () => {
    // Rust restores the normal budget in `webview_show`; if the note outlived
    // that, the tab would never be trimmed again for the rest of the session.
    const back = planTrim([], new Set([1]));
    expect(back.forget).toEqual([1]);

    const later = planTrim([bg(1, TRIM_IDLE_MS)], new Set());
    expect(later.trim, "eligible again after returning").toEqual([1]);
  });

  it("forgets a tab that was hibernated or closed", () => {
    // Same branch as returning to view, and it matters just as much: a
    // hibernated tab's webview is destroyed, so the id must not linger.
    expect(planTrim([bg(2, 0)], new Set([1, 2])).forget).toEqual([1]);
  });

  it("handles a mixed sweep in one pass", () => {
    const plan = planTrim([bg(1, TRIM_IDLE_MS * 2), bg(2, 500), bg(3, TRIM_IDLE_MS)], new Set([3, 9]));
    expect(plan.trim, "1 is idle and unmarked; 2 too fresh; 3 already done").toEqual([1]);
    expect(plan.forget, "9 is no longer backgrounded").toEqual([9]);
  });
});
