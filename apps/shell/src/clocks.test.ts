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

/** Put the wall clock at a local time (8 Oct 2026 unless `day` says otherwise). */
const setClock = (h: number, m: number, s = 0, ms = 0, day = 8) =>
  vi.setSystemTime(new Date(2026, 9, day, h, m, s, ms));

/**
 * Ticks are 500 ms apart only while the window is awake and unthrottled. An
 * alarm used to ring only if a tick happened to land inside its exact minute,
 * so sleep, App Nap or a hidden window's throttled timers skipped it silently.
 */
describe("alarm ringing", () => {
  it("rings once when a tick lands in the alarm's minute", async () => {
    const c = await load();
    setClock(7, 59, 59, 600);
    c.startClockDriver();
    c.addAlarm("08:00", "Lecture");
    tick();
    expect(c.ringing()).toBeNull();

    setClock(8, 0, 0, 100);
    tick();
    expect(c.ringing()?.label).toBe("Lecture");

    c.dismissRing();
    setClock(8, 0, 0, 600);
    tick();
    expect(c.ringing(), "the same minute must not ring twice").toBeNull();
  });

  it("still rings when its minute fell between two ticks", async () => {
    const c = await load();
    setClock(7, 58);
    c.startClockDriver();
    c.addAlarm("08:00", "Lecture");
    tick();

    // Nothing ran during 08:00 (the lid was shut); the next tick is at 08:01:10.
    setClock(8, 1, 10);
    tick();
    expect(c.ringing()?.label, "a missed alarm rings late rather than never").toBe("Lecture");

    c.dismissRing();
    setClock(8, 1, 10, 500);
    tick();
    expect(c.ringing(), "and only once").toBeNull();
  });

  it("catches a 23:59 alarm missed across midnight", async () => {
    const c = await load();
    setClock(23, 58, 30);
    c.startClockDriver();
    c.addAlarm("23:59", "");
    tick();

    setClock(0, 3, 0, 0, 9);
    tick();
    expect(c.ringing()?.label).toBe("Alarm · 23:59");
  });

  it("lets an alarm missed by hours stay missed", async () => {
    const c = await load();
    setClock(7, 0);
    c.startClockDriver();
    c.addAlarm("08:00", "Lecture");
    tick();

    setClock(11, 0);
    tick();
    expect(c.ringing(), "waking hours later shouldn't ring the morning's alarms").toBeNull();
  });

  it("doesn't ring an alarm added after its time", async () => {
    const c = await load();
    setClock(8, 5);
    c.startClockDriver();
    c.addAlarm("08:00", "Lecture");
    tick();
    expect(c.ringing()).toBeNull();
  });
});
