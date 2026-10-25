import { describe, expect, it } from "vitest";

import type { SleepCheck } from "./ipc";
import { dueForCheck, planSleep, type SleepCandidate, type SleepOptions } from "./sleepPolicy";

const MIN = 60_000;
const on: SleepOptions = {
  enabled: true,
  discardAfterMs: 60 * MIN,
  pressure: "normal",
  pressureEvicts: true,
};
const check = (tab_id: number, more: Partial<SleepCheck> = {}): SleepCheck => ({
  tab_id,
  memory_mb: 120,
  keep_awake: null,
  keep_loaded: null,
  suspended: false,
  ...more,
});
const tab = (id: number, idleMin: number, protect = false): SleepCandidate => ({
  id,
  idleMs: idleMin * MIN,
  protect,
});

describe("planSleep", () => {
  it("leaves recent tabs alone and suspends after five idle minutes", () => {
    const tabs = [tab(1, 2), tab(2, 6)];
    const plan = planSleep(tabs, [check(1), check(2)], on);
    expect(plan).toEqual({ suspend: [2], discard: [] });
  });

  it("doesn't suspend a tab twice", () => {
    const plan = planSleep([tab(1, 9)], [check(1, { suspended: true })], on);
    expect(plan).toEqual({ suspend: [], discard: [] });
  });

  it("unloads idle tabs beyond the four most recent", () => {
    const tabs = [tab(1, 6), tab(2, 7), tab(3, 8), tab(4, 9), tab(5, 10), tab(6, 11)];
    const plan = planSleep(
      tabs,
      tabs.map((t) => check(t.id)),
      on,
    );
    expect(plan.discard).toEqual([5, 6]);
    expect(plan.suspend).toEqual([1, 2, 3, 4]);
  });

  it("counts recent, unchecked tabs toward the warm set", () => {
    const tabs = [tab(1, 1), tab(2, 1), tab(3, 2), tab(4, 6), tab(5, 7), tab(6, 8)];
    const plan = planSleep(tabs, [check(4), check(5), check(6)], on);
    expect(plan.discard).toEqual([5, 6]);
    expect(plan.suspend).toEqual([4]);
  });

  it("keeps a likely-next tab warm over a more recent one", () => {
    const tabs = [tab(1, 6), tab(2, 7), tab(3, 8), tab(4, 9), tab(5, 30, true)];
    const plan = planSleep(
      tabs,
      tabs.map((t) => check(t.id)),
      on,
    );
    expect(plan.discard).toEqual([4]);
  });

  it("unloads a heavy page, and any past Settings' idle time", () => {
    const plan = planSleep([tab(1, 6), tab(2, 61)], [check(1, { memory_mb: 300 }), check(2)], on);
    expect(plan.discard.sort()).toEqual([1, 2]);
  });

  it("never touches a tab playing sound or capturing", () => {
    const tabs = [tab(1, 90)];
    const plan = planSleep(tabs, [check(1, { keep_awake: "playing audio", memory_mb: 900 })], {
      ...on,
      pressure: "critical",
    });
    expect(plan).toEqual({ suspend: [], discard: [] });
  });

  it("doesn't unload unsaved edits unless memory is critical", () => {
    const tabs = [tab(1, 90)];
    const edits = [check(1, { keep_loaded: "unsaved edits", memory_mb: 900 })];
    expect(planSleep(tabs, edits, on)).toEqual({ suspend: [1], discard: [] });
    expect(planSleep(tabs, edits, { ...on, pressure: "critical" }).discard).toEqual([1]);
  });

  it("leaves a tab the engine didn't check", () => {
    expect(planSleep([tab(1, 90)], [], on)).toEqual({ suspend: [], discard: [] });
  });

  it("shrinks the warm set under pressure", () => {
    const tabs = [tab(1, 2), tab(2, 2), tab(3, 3), tab(4, 4)];
    const checks = tabs.map((t) => check(t.id));
    expect(planSleep(tabs, checks, { ...on, pressure: "warn" }).discard).toEqual([3, 4]);
    expect(planSleep(tabs, checks, { ...on, pressure: "critical" }).discard).toEqual([1, 2, 3, 4]);
  });

  it("with sleep off, only pressure unloads, and only when Settings allows it", () => {
    const tabs = [tab(1, 120), tab(2, 1)];
    const checks = tabs.map((t) => check(t.id));
    const off = { ...on, enabled: false };
    expect(planSleep(tabs, checks, off)).toEqual({ suspend: [], discard: [] });
    expect(planSleep(tabs, checks, { ...off, pressure: "critical" })).toEqual({
      suspend: [],
      discard: [2, 1],
    });
    expect(planSleep(tabs, checks, { ...off, pressure: "critical", pressureEvicts: false })).toEqual({
      suspend: [],
      discard: [],
    });
  });
});

describe("dueForCheck", () => {
  it("asks only about tabs idle long enough, or all of them under pressure", () => {
    const tabs = [tab(1, 1), tab(2, 5), tab(3, 20)];
    expect(dueForCheck(tabs, on)).toEqual([2, 3]);
    expect(dueForCheck(tabs, { ...on, pressure: "critical" })).toEqual([1, 2, 3]);
    expect(dueForCheck(tabs, { ...on, enabled: false })).toEqual([]);
  });
});
