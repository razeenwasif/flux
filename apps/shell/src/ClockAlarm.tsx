// Ringing timer/alarm banner (BACKLOG #134). Docked ABOVE the content card as a
// sibling (like PermissionBar) so it's visible over any tab — the native webview
// shrinks to make room instead of covering it. The audible beep + OS
// notification (clocks.ts) are the primary alerts; this is the in-app control.
import { type Component, Show } from "solid-js";
import { dismissRing, ringing, snoozeRing } from "./clocks";

const ClockAlarm: Component = () => (
  <Show when={ringing()}>
    {(r) => (
      <div class="perm-bar clock-ring" role="alertdialog" aria-live="assertive">
        <span class="perm-ico">{r().kind === "alarm" ? "⏰" : "⏱"}</span>
        <span class="perm-text">
          <b>{r().kind === "alarm" ? "Alarm" : "Timer"}</b> · {r().label}
        </span>
        <Show when={r().kind === "alarm"}>
          <button class="perm-btn" onClick={() => snoozeRing(5)}>Snooze 5m</button>
        </Show>
        <button class="perm-btn allow" onClick={dismissRing}>Dismiss</button>
      </div>
    )}
  </Show>
);

export default ClockAlarm;
