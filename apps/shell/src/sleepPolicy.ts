/**
 * Tab sleep in three steps (tabsleep.rs has the engine side). A background
 * tab is throttled by the engine as soon as it's hidden; this decides the
 * other two steps, once a minute and whenever memory pressure changes:
 *
 * - **suspend** after five idle minutes: its scripts, timers and media stop,
 *   but it stays in memory, so coming back is instant;
 * - **discard** (unload, waking from a snapshot) beyond a warm set of the four
 *   most recent background tabs, when its page uses more than 256 MB, or past
 *   the idle time set in Settings.
 *
 * A tab playing sound or using the camera, microphone or screen is left alone.
 * One with unsaved edits or a leave-page prompt is suspended but not unloaded,
 * unless memory is critical. Under pressure the warm set shrinks (two on a
 * warning, none when critical) and the idle wait shortens.
 *
 * Pure: the caller supplies idle times and the engine's checks, and acts on
 * the lists.
 */
import type { SleepCheck } from "./ipc";

export type Pressure = "normal" | "warn" | "critical";

export const SUSPEND_AFTER_MS = 5 * 60_000;
export const WARM_SET = 4;
export const HEAVY_MB = 256;
/** How long a tab must be idle before pressure may unload it. */
const PRESSURE_IDLE_MS: Record<Pressure, number> = { normal: SUSPEND_AFTER_MS, warn: 60_000, critical: 0 };
const WARM: Record<Pressure, number> = { normal: WARM_SET, warn: 2, critical: 0 };

export interface SleepCandidate {
  id: number;
  idleMs: number;
  /** Likely to be wanted next (the #106 ranking): kept warm first. */
  protect?: boolean;
}

export interface SleepOptions {
  /** Sleeping tabs is on in Settings. Off, only memory pressure unloads. */
  enabled: boolean;
  /** Settings' "Unload after": unload any tab idle this long. */
  discardAfterMs: number;
  pressure: Pressure;
  /** Settings' "Sleep under memory pressure". */
  pressureEvicts: boolean;
}

export interface SleepPlan {
  suspend: number[];
  discard: number[];
}

/** Which background tabs need the engine's check before planning: those
 *  idle long enough for either step, or every one under pressure. */
export function dueForCheck(tabs: SleepCandidate[], opts: SleepOptions): number[] {
  const underPressure = opts.pressureEvicts && opts.pressure !== "normal";
  if (!opts.enabled && !underPressure) return [];
  const wait = underPressure ? PRESSURE_IDLE_MS[opts.pressure] : SUSPEND_AFTER_MS;
  return tabs.filter((t) => t.idleMs >= Math.min(wait, SUSPEND_AFTER_MS)).map((t) => t.id);
}

export function planSleep(tabs: SleepCandidate[], checks: SleepCheck[], opts: SleepOptions): SleepPlan {
  const byId = new Map(checks.map((c) => [c.tab_id, c]));
  const underPressure = opts.pressureEvicts && opts.pressure !== "normal";
  const plan: SleepPlan = { suspend: [], discard: [] };
  if (!opts.enabled && !underPressure) return plan;

  const pressure = underPressure ? opts.pressure : "normal";
  // The warm set is the background tabs most worth keeping (the likely-next
  // ones, then the most recently used), checked or not.
  const order = [...tabs].sort((a, b) => Number(!!b.protect) - Number(!!a.protect) || a.idleMs - b.idleMs);
  const warm = new Set(order.slice(0, WARM[pressure]).map((t) => t.id));

  for (const t of order) {
    // Only tabs the engine checked: an unchecked one may be playing something.
    const c = byId.get(t.id);
    if (!c || c.keep_awake) continue;
    const mayUnload = !c.keep_loaded || pressure === "critical";
    let discard = false;
    if (mayUnload) {
      if (opts.enabled && t.idleMs >= SUSPEND_AFTER_MS) {
        discard ||= !warm.has(t.id);
        discard ||= (c.memory_mb ?? 0) > HEAVY_MB;
        discard ||= t.idleMs >= opts.discardAfterMs;
      }
      if (pressure !== "normal" && t.idleMs >= PRESSURE_IDLE_MS[pressure]) discard ||= !warm.has(t.id);
    }
    if (discard) plan.discard.push(t.id);
    else if (opts.enabled && !c.suspended && t.idleMs >= SUSPEND_AFTER_MS) plan.suspend.push(t.id);
  }
  return plan;
}
