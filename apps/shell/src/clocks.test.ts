/**
 * The clock driver's arming policy.
 *
 * The driver used to be a 500 ms interval started at boot and never stopped —
 * two CPU wakeups a second for the life of the session, running a scan that
 * finds nothing unless a timer, a snooze, or an enabled alarm is pending. It now
 * arms and disarms itself instead, which is cheaper and strictly riskier: the
 * failure mode of getting it wrong is an alarm that never rings, and nothing
 * about that is visible until the moment you needed it.
 *
 * So these tests are about the arming, not the ringing. `window` is stubbed
 * because the module reaches for `window.setInterval` and the suite runs in
 * node; the stub also lets the interval be counted directly, which is the thing
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module notifies the OS when something fires — irrelevant here, and it
// would drag the whole Tauri IPC surface into a pure-logic test.
vi.mock("./ipc", () => ({ osNotify: () => Promise.resolve() }));

/** Live intervals by handle. The ringer registers one too (a 1600 ms beep), so
 *  they're kept with their delay and the driver is identified by its 500 ms. */
let live: Map<number, { fn: () => void; ms: number }>;
let nextId: number;

/** Number of clock drivers currently running — the thing under test. */
const drivers = () => [...live.values()].filter((t) => t.ms === 500).length;

/** Run one driver tick, as the real interval would. */
const tick = () => {
  for (const t of [...live.values()]) if (t.ms === 500) t.fn();
};

beforeEach(() => {
  vi.resetModules(); // each test gets its own copy of the module-level driver
  vi.useFakeTimers(); // Date.now() is the timer's clock; tests advance it
  live = new Map();
  nextId = 1;
  const stub = {
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      live.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id: number) => {
      live.delete(id);
    },
    setTimeout: () => 0,
  };
  vi.stubGlobal("window", stub);
  vi.stubGlobal("clearInterval", stub.clearInterval);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Fresh module instance — the driver's state is module-level on purpose. */
const load = async () => await import("./clocks");

describe("clock driver arming", () => {
  it("does not run when nothing is scheduled", async () => {
    const c = await load();
    c.startClockDriver();
    expect(drivers(), "idle boot should leave no interval running").toBe(0);
  });

  it("runs while a timer is counting down, and stops when it is reset", async () => {
    const c = await load();
    c.startClockDriver();

    c.timerStartPause();
    expect(c.timerRunning()).toBe(true);
    expect(drivers(), "a running timer needs the driver").toBe(1);

    c.timerReset();
    expect(drivers(), "a reset timer should stand the driver down").toBe(0);
  });

  it("does not start a second interval when more work arrives", async () => {
    const c = await load();
    c.startClockDriver();

    c.timerStartPause();
    c.addAlarm("07:30", "Lecture");
    expect(drivers(), "one driver, however much is pending").toBe(1);
  });

  it("runs for an enabled alarm and stops once it is disabled", async () => {
    const c = await load();
    c.startClockDriver();

    c.addAlarm("07:30", "Lecture");
    expect(drivers()).toBe(1);

    const id = c.alarms()[0]!.id;
    c.toggleAlarm(id);
    expect(c.alarms()[0]!.enabled).toBe(false);
    expect(drivers(), "a disabled alarm can't fire, so nothing needs watching").toBe(0);

    c.toggleAlarm(id);
    expect(drivers(), "re-enabling has to bring the driver back").toBe(1);
  });

  it("stops once the last alarm is removed", async () => {
    const c = await load();
    c.startClockDriver();

    c.addAlarm("07:30", "Lecture");
    c.addAlarm("08:00", "Tutorial");
    expect(drivers()).toBe(1);

    c.removeAlarm(c.alarms()[0]!.id);
    expect(drivers(), "one alarm left, still armed").toBe(1);
    c.removeAlarm(c.alarms()[0]!.id);
    expect(drivers(), "no alarms left").toBe(0);
  });

  it("keeps running for a snooze, after the thing that rang is gone", async () => {
    const c = await load();
    c.startClockDriver();

    // Ring a real timer: snoozeRing reads the live `ringing` state, so a snooze
    // can't be faked into existence from outside.
    c.setTimerDuration(1000);
    c.timerStartPause();
    vi.advanceTimersByTime(1500);
    tick();
    expect(c.ringing(), "the timer should have fired").not.toBeNull();
    expect(c.timerRunning(), "and stopped itself").toBe(false);

    c.snoozeRing(5);
    // Nothing else is pending now — no timer, no alarms. The snooze alone has to
    // keep the driver alive, or it will never come back.
    expect(drivers(), "a pending snooze still has to fire").toBe(1);

    c.dismissRing();
    expect(drivers(), "dismissing the ring doesn't cancel the snooze").toBe(1);
  });
});
