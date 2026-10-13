// Clocks widget (BACKLOG #134) — a single start-page card with Stopwatch /
// Timer / Alarm tabs. All state lives in clocks.ts (module-level), so leaving
// the start page doesn't stop a running timer or drop your alarms; this is just
// the control surface. A local tick refreshes the readouts while one is running.
import { type Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  type Alarm,
  addAlarm,
  alarms,
  clockRevision,
  removeAlarm,
  toggleAlarm,
  fmtClock,
  fmtStopwatch,
  swElapsed,
  swLap,
  swLaps,
  swReset,
  swRunning,
  swToggle,
  setTimerDuration,
  startClockDriver,
  timerBump,
  timerRemaining,
  timerReset,
  timerRunning,
  timerStartPause,
  timerTotal,
} from "./clocks";

const PRESETS = [1, 3, 5, 10, 25];

const ClockWidget: Component = () => {
  // App starts the driver once the window is idle; a start page shown at boot
  // can get here first, and needs the saved alarms loaded (and a timer started
  // here armed) now. Starting it twice is a no-op.
  startClockDriver();
  const [tab, setTab] = createSignal<"stopwatch" | "timer" | "alarm">("timer");
  const [tick, setTick] = createSignal(0);
  const [newTime, setNewTime] = createSignal("07:00");
  const [newLabel, setNewLabel] = createSignal("");
  const [customMin, setCustomMin] = createSignal("");

  // Re-render the readouts every 60 ms only while one is moving. A stopped
  // stopwatch and a paused timer change only when you press something, and
  // `clockRevision` covers those; the interval used to run for as long as the
  // start page was open, card shown or not.
  createEffect(() => {
    if (!swRunning() && !timerRunning()) return;
    const iv = window.setInterval(() => setTick((t) => t + 1), 60);
    onCleanup(() => clearInterval(iv));
  });

  const swDisplay = createMemo(() => (tick(), clockRevision(), fmtStopwatch(swElapsed())));
  const timerDisplay = createMemo(() => (tick(), clockRevision(), fmtClock(timerRemaining())));
  const timerPct = createMemo(
    () => (tick(), clockRevision(), timerTotal() > 0 ? (1 - timerRemaining() / timerTotal()) * 100 : 0),
  );

  const startPreset = (min: number) => {
    setTimerDuration(min * 60_000);
    timerStartPause();
  };
  const startCustom = () => {
    const m = parseFloat(customMin());
    if (Number.isFinite(m) && m > 0) {
      setTimerDuration(Math.round(m * 60_000));
      timerStartPause();
      setCustomMin("");
    }
  };
  const doAddAlarm = () => {
    addAlarm(newTime(), newLabel());
    setNewLabel("");
  };

  return (
    <div class="clock-card">
      <div class="clock-tabs">
        <button
          classList={{ "clock-tab": true, on: tab() === "stopwatch" }}
          onClick={() => setTab("stopwatch")}
        >
          Stopwatch
        </button>
        <button classList={{ "clock-tab": true, on: tab() === "timer" }} onClick={() => setTab("timer")}>
          Timer
        </button>
        <button classList={{ "clock-tab": true, on: tab() === "alarm" }} onClick={() => setTab("alarm")}>
          Alarm
        </button>
      </div>

      {/* Stopwatch */}
      <Show when={tab() === "stopwatch"}>
        <div class="clock-face">{swDisplay()}</div>
        <div class="clock-btns">
          <button class="clock-btn primary" onClick={swToggle}>
            {swRunning() ? "Stop" : "Start"}
          </button>
          <button class="clock-btn" onClick={swLap} disabled={!swRunning() && swElapsed() === 0}>
            Lap
          </button>
          <button class="clock-btn" onClick={swReset} disabled={swElapsed() === 0}>
            Reset
          </button>
        </div>
        <Show when={swLaps().length > 0}>
          <div class="clock-laps">
            <For each={swLaps()}>
              {(lap, i) => (
                <div class="clock-lap">
                  <span>Lap {swLaps().length - i()}</span>
                  <span>{fmtStopwatch(lap)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Timer */}
      <Show when={tab() === "timer"}>
        <div classList={{ "clock-face": true, done: timerRemaining() <= 0 && !timerRunning() }}>
          {timerDisplay()}
        </div>
        <div class="clock-progress">
          <span style={{ width: `${timerPct()}%` }} />
        </div>
        <div class="clock-presets">
          <For each={PRESETS}>
            {(m) => (
              <button class="clock-chip" onClick={() => startPreset(m)}>
                {m}m
              </button>
            )}
          </For>
        </div>
        <div class="clock-btns">
          <button class="clock-btn primary" onClick={timerStartPause}>
            {timerRunning() ? "Pause" : "Start"}
          </button>
          <button class="clock-btn" onClick={() => timerBump(60_000)}>
            +1:00
          </button>
          <button class="clock-btn" onClick={timerReset}>
            Reset
          </button>
        </div>
        <form
          class="clock-custom"
          onSubmit={(e) => {
            e.preventDefault();
            startCustom();
          }}
        >
          <input
            class="clock-input"
            type="number"
            min="0"
            step="0.5"
            placeholder="min"
            value={customMin()}
            onInput={(e) => setCustomMin(e.currentTarget.value)}
          />
          <button class="clock-btn" type="submit">
            Set
          </button>
        </form>
      </Show>

      {/* Alarm */}
      <Show when={tab() === "alarm"}>
        <div class="clock-alarms">
          <Show when={alarms().length > 0} fallback={<div class="clock-empty">No alarms set.</div>}>
            <For each={alarms()}>
              {(a: Alarm) => (
                <div classList={{ "clock-alarm-row": true, off: !a.enabled }}>
                  <span class="clock-alarm-time">{a.time}</span>
                  <span class="clock-alarm-label">{a.label || "Alarm"}</span>
                  <button
                    class="clock-toggle"
                    title={a.enabled ? "Disable" : "Enable"}
                    onClick={() => toggleAlarm(a.id)}
                  >
                    {a.enabled ? "on" : "off"}
                  </button>
                  <button class="clock-x" title="Remove" onClick={() => removeAlarm(a.id)}>
                    ✕
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
        <form
          class="clock-add"
          onSubmit={(e) => {
            e.preventDefault();
            doAddAlarm();
          }}
        >
          <input
            class="clock-input"
            type="time"
            value={newTime()}
            onInput={(e) => setNewTime(e.currentTarget.value)}
          />
          <input
            class="clock-input grow"
            type="text"
            placeholder="Label (optional)"
            value={newLabel()}
            onInput={(e) => setNewLabel(e.currentTarget.value)}
          />
          <button class="clock-btn primary" type="submit">
            Add
          </button>
        </form>
        <div class="clock-hint">Alarms ring daily while Flux is running.</div>
      </Show>
    </div>
  );
};

export default ClockWidget;
