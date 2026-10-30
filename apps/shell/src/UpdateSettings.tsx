// Settings → Updates (#26): the running version, a check on demand, and whether
// Flux looks for updates by itself (update.rs).
import { Component, Show, createSignal, onMount } from "solid-js";
import { updateCheck, updateRestart, updateSetAuto, updateStatus, type UpdateStatus } from "./ipc";
import { Row, Toggle } from "./SettingsControls";
import { setUpdateReady } from "./store";

/** "just now", "5 minutes ago", "3 hours ago", or a date. */
const ago = (ms: number): string => {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
};

const UpdateSettings: Component = () => {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(
    () =>
      void updateStatus()
        .then(setStatus)
        .catch(() => {}),
  );

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const s = await updateCheck();
      setStatus(s);
      if (s.ready) setUpdateReady(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };
  const restart = () => void updateRestart().catch((e) => setError(String(e)));

  const hint = (): string => {
    const s = status();
    if (!s) return "";
    if (!s.supported) return "This build doesn't update itself: only release builds of the Mac app do.";
    if (error() || s.error) return `The last check failed: ${error() || s.error}`;
    if (s.ready) return `Flux ${s.ready} is downloaded. It installs when you restart or quit Flux.`;
    if (s.checked_at) return `Up to date. Checked ${ago(s.checked_at)}.`;
    return "Not checked yet.";
  };

  return (
    <Show when={status()}>
      {(s) => (
        <>
          <Row label={`Flux ${s().current}`} hint={hint()}>
            <Show
              when={s().ready}
              fallback={
                <button
                  class="set-link-btn"
                  disabled={!s().supported || checking()}
                  onClick={() => void check()}
                >
                  {checking() ? "Checking…" : "Check now"}
                </button>
              }
            >
              <button class="set-link-btn" onClick={restart}>
                Restart to update
              </button>
            </Show>
          </Row>
          <Row
            label="Check for updates automatically"
            hint="A minute after launch and every six hours, from Flux's GitHub releases. Flux asks before restarting."
          >
            <Toggle
              on={s().auto}
              disabled={!s().supported}
              onClick={() =>
                void updateSetAuto(!s().auto)
                  .then(setStatus)
                  .catch(() => {})
              }
            />
          </Row>
        </>
      )}
    </Show>
  );
};

export default UpdateSettings;
