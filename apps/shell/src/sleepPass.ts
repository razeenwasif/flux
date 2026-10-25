/**
 * One pass of tab sleep (sleepPolicy.ts has the rules): read the pressure,
 * ask the engine about the tabs that are due, and suspend or unload them.
 * Its own chunk, loaded on the first pass: nothing here is needed to paint
 * the window.
 */
import { hibernateRank, memStatus, prefetchSetPressure, tabSleepCheck, webviewSuspend } from "./ipc";
import { isMac } from "./platform";
import { dueForCheck, planSleep, type Pressure, type SleepOptions } from "./sleepPolicy";

export interface SleepPassInput {
  /** Live background tabs, with how long each has been idle. */
  tabs: { id: number; url: string; idleMs: number }[];
  activeUrl: string;
  /** What the system reported (macOS); elsewhere free memory is read here. */
  pressure: Pressure;
  settings: Omit<SleepOptions, "pressure">;
  /** Still in the background once the checks are back. */
  stillBackground: () => Set<number>;
  unload: (id: number) => void;
}

export async function sleepPass(input: SleepPassInput): Promise<void> {
  let level = input.pressure;
  if (input.settings.pressureEvicts && !isMac) {
    const m = await memStatus().catch(() => null);
    if (m) level = m.available_pct < 6 ? "critical" : m.available_pct < 12 ? "warn" : "normal";
  }
  // Gate predictive prefetch (#103) on real memory pressure.
  void prefetchSetPressure(level !== "normal").catch(() => {});
  const opts: SleepOptions = { ...input.settings, pressure: level };
  const due = dueForCheck(input.tabs, opts);
  if (due.length === 0) return;
  const checks = await tabSleepCheck(due).catch(() => []);
  // #106: under pressure, the tabs the Markov model expects you back on next
  // stay warm, ahead of merely recent ones.
  let protect = new Set<number>();
  if (level !== "normal") {
    const ranked = await hibernateRank(
      input.activeUrl,
      input.tabs.map((c) => ({ tab_id: c.id, url: c.url, idle_secs: Math.round(c.idleMs / 1000) })),
    ).catch(() => null);
    if (ranked) protect = new Set(ranked.filter((r) => r.protected).map((r) => r.tab_id));
  }
  // A tab brought on screen while the checks ran is out.
  const still = input.stillBackground();
  const plan = planSleep(
    input.tabs
      .filter((c) => still.has(c.id))
      .map((c) => ({ id: c.id, idleMs: c.idleMs, protect: protect.has(c.id) })),
    checks,
    opts,
  );
  for (const id of plan.suspend) void webviewSuspend(id).catch(() => {});
  for (const id of plan.discard) input.unload(id);
}
