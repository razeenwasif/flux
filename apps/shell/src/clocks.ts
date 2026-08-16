// Timer / stopwatch / alarm state + firing (BACKLOG #134). Module-level so it
// survives leaving the start page — the widget is only the control surface. A
// single driver (started from App) checks for elapsed timers/alarms and rings;
// it runs only while something is actually scheduled, see `syncDriver` below.
// Timings are stored as absolute targets (endsAt / epoch) so they're immune to
// interval throttling when the window is backgrounded.
import { createSignal } from "solid-js";
import { osNotify } from "./ipc";

const pad = (n: number) => String(n).padStart(2, "0");

// ── Stopwatch ────────────────────────────────────────────────────────────────
const [swRunning, setSwRunning] = createSignal(false);
const [swLaps, setSwLaps] = createSignal<number[]>([]);
let swBase = 0; // accumulated ms across pauses
let swStart = 0; // performance.now() at last resume
export { swRunning, swLaps };

export function swElapsed(): number {
  return swRunning() ? swBase + (performance.now() - swStart) : swBase;
}
export function swToggle(): void {
  if (swRunning()) {
    swBase = swElapsed();
    setSwRunning(false);
  } else {
    swStart = performance.now();
    setSwRunning(true);
  }
}
export function swReset(): void {
  setSwRunning(false);
  swBase = 0;
  setSwLaps([]);
}
export function swLap(): void {
  if (swRunning() || swBase > 0) setSwLaps((l) => [swElapsed(), ...l]);
}

// ── Timer ────────────────────────────────────────────────────────────────────
const [timerRunning, setTimerRunning] = createSignal(false);
const [timerEndsAt, setTimerEndsAt] = createSignal<number | null>(null);
const [timerTotal, setTimerTotal] = createSignal(5 * 60_000);
let timerPaused = 5 * 60_000; // ms remaining while paused
export { timerRunning, timerTotal };

export function timerRemaining(now = Date.now()): number {
  return timerRunning() && timerEndsAt() != null ? Math.max(0, timerEndsAt()! - now) : timerPaused;
}
/** Set the timer length (stops it and arms it at the new length). */
export function setTimerDuration(ms: number): void {
  const clamped = Math.max(1000, Math.min(ms, 100 * 3600_000));
  setTimerTotal(clamped);
  timerPaused = clamped;
  setTimerRunning(false);
  setTimerEndsAt(null);
  persist();
}
export function timerStartPause(): void {
  if (timerRunning()) {
    timerPaused = timerRemaining();
    setTimerRunning(false);
    setTimerEndsAt(null);
  } else {
    const rem = timerPaused > 0 ? timerPaused : timerTotal();
    setTimerEndsAt(Date.now() + rem);
    setTimerRunning(true);
  }
  syncDriver();
}
export function timerReset(): void {
  setTimerRunning(false);
  setTimerEndsAt(null);
  timerPaused = timerTotal();
  syncDriver();
}
export function timerBump(ms: number): void {
  if (timerRunning() && timerEndsAt() != null) setTimerEndsAt(Math.max(Date.now(), timerEndsAt()! + ms));
  else timerPaused = Math.max(0, timerPaused + ms);
}
function fireTimer(): void {
  setTimerRunning(false);
  setTimerEndsAt(null);
  timerPaused = 0;
  ring("timer", "Timer finished");
}

// ── Alarms ───────────────────────────────────────────────────────────────────
export interface Alarm {
  id: string;
  time: string;
  label: string;
  enabled: boolean;
  lastMin: number;
}
const [alarms, setAlarms] = createSignal<Alarm[]>([]);
export { alarms };

// Alarm ids were `a${Date.now()}`, which collides for two alarms created in the
// same millisecond — and since removeAlarm/toggleAlarm match by id, the collision
// deletes or toggles both. Unreachable by hand, reachable by anything scripted.
let alarmSeq = 0;

export function addAlarm(time: string, label: string): void {
  if (!/^\d{2}:\d{2}$/.test(time)) return;
  const id = `a${Date.now()}-${alarmSeq++}`;
  setAlarms((a) =>
    [...a, { id, time, label: label.trim(), enabled: true, lastMin: 0 }].sort((x, y) =>
      x.time.localeCompare(y.time),
    ),
  );
  persist();
}
export function removeAlarm(id: string): void {
  setAlarms((a) => a.filter((x) => x.id !== id));
  persist();
}
export function toggleAlarm(id: string): void {
  setAlarms((a) => a.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
  persist();
}

// ── Ringing / alert ──────────────────────────────────────────────────────────
const [ringing, setRinging] = createSignal<{ kind: "timer" | "alarm"; label: string } | null>(null);
const [snoozeUntil, setSnoozeUntil] = createSignal<{ at: number; label: string } | null>(null);
export { ringing };

function ring(kind: "timer" | "alarm", label: string): void {
  const r = { kind, label };
  setRinging(r);
  void osNotify(kind === "alarm" ? "⏰ Alarm" : "⏱ Timer", label).catch(() => {});
  startBeeping();
  // Stop ringing on its own after a minute if nobody's around to dismiss it.
  window.setTimeout(() => {
    if (ringing() === r) dismissRing();
  }, 60_000);
}
export function dismissRing(): void {
  setRinging(null);
  stopBeeping();
}
export function snoozeRing(min = 5): void {
  const r = ringing();
  dismissRing();
  if (r) setSnoozeUntil({ at: Date.now() + min * 60_000, label: r.label });
  syncDriver();
}

let actx: AudioContext | null = null;
let beepTimer = 0;
function tone(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    actx = actx || new Ctx();
    const t0 = actx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = i === 2 ? 1100 : 880;
      o.connect(g);
      g.connect(actx.destination);
      const t = t0 + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.start(t);
      o.stop(t + 0.22);
    }
  } catch {
    /* audio blocked — the banner still shows */
  }
}
function startBeeping(): void {
  tone();
  if (!beepTimer) beepTimer = window.setInterval(tone, 1600);
}
function stopBeeping(): void {
  if (beepTimer) {
    clearInterval(beepTimer);
    beepTimer = 0;
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────
// The driver runs only while something can actually fire. It used to be a 500 ms
// interval started at boot and never stopped — two CPU wakeups a second for the
// whole session, running a scan that finds nothing unless you have a running
// timer, a pending snooze, or an enabled alarm. Free enough on a plugged-in
// desktop; not free on a phone.
//
// Arming is driven by `syncDriver()` rather than a reactive effect, because this
// module is evaluated outside any Solid root and an effect here would have no
// owner. Every mutator calls it, and so does the end of each tick — so the timer
// stands itself down as soon as the last piece of work clears.
let driver = 0;
let booted = false;

/** True while a timer, a snooze, or an enabled alarm could still fire. */
function hasPendingWork(): boolean {
  return timerRunning() || snoozeUntil() != null || alarms().some((a) => a.enabled);
}

function syncDriver(): void {
  // Before startClockDriver() the persisted state isn't loaded yet, so any
  // answer here would be about an empty store.
  if (!booted) return;
  const want = hasPendingWork();
  if (want && !driver) driver = window.setInterval(clockTick, 500);
  else if (!want && driver) {
    clearInterval(driver);
    driver = 0;
  }
}

export function startClockDriver(): void {
  if (booted) return;
  booted = true;
  loadPersisted();
  syncDriver();
}
function clockTick(): void {
  if (timerRunning() && timerRemaining() <= 0) fireTimer();

  const s = snoozeUntil();
  if (s && Date.now() >= s.at) {
    setSnoozeUntil(null);
    ring("alarm", s.label);
  }

  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const minKey = Math.floor(Date.now() / 60_000);
  for (const a of alarms()) {
    if (a.enabled && a.time === hhmm && a.lastMin !== minKey) {
      setAlarms((list) => list.map((x) => (x.id === a.id ? { ...x, lastMin: minKey } : x)));
      persist();
      ring("alarm", a.label || `Alarm · ${a.time}`);
    }
  }

  // A timer that just fired, or a snooze that just elapsed, may have been the
  // only thing keeping the driver alive.
  syncDriver();
}

// ── Persistence (alarms + configured timer length) ───────────────────────────
function persist(): void {
  // Every alarm mutation and the timer-length setter funnel through here, so
  // this is the one place that has to notice an alarm being added or disabled.
  syncDriver();
  try {
    localStorage.setItem("flux.clocks", JSON.stringify({ alarms: alarms(), timerTotal: timerTotal() }));
  } catch {
    /* private */
  }
}
function loadPersisted(): void {
  try {
    const raw = localStorage.getItem("flux.clocks");
    if (!raw) return;
    const v = JSON.parse(raw) as { alarms?: Alarm[]; timerTotal?: number };
    if (Array.isArray(v.alarms)) setAlarms(v.alarms.map((a) => ({ ...a, lastMin: 0 })));
    if (typeof v.timerTotal === "number") {
      setTimerTotal(v.timerTotal);
      timerPaused = v.timerTotal;
    }
  } catch {
    /* ignore */
  }
}

// ── Formatting helpers (shared with the widget) ──────────────────────────────
export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
export function fmtStopwatch(ms: number): string {
  const cs = Math.floor((ms % 1000) / 10);
  return `${fmtClock(ms)}.${pad(cs)}`;
}
