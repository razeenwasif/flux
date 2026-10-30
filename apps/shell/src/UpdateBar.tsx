// "Restart to update" (#26): a newer Flux is downloaded and its signature
// checked (update.rs). Docked above the content card like the permission bar.
// Later only hides the bar: the update still installs when Flux quits.
import { Component, Show, createSignal } from "solid-js";
import { updateRestart } from "./ipc";
import { setUpdateReady, updateReady } from "./store";

const UpdateBar: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const restart = async () => {
    setBusy(true);
    setError("");
    try {
      await updateRestart();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Show when={updateReady()}>
      {(u) => (
        <div class="perm-bar" role="status">
          <span class="perm-ico">⬆️</span>
          <span class="perm-text" title={u().notes ?? undefined}>
            <b>Flux {u().ready}</b> is ready.{" "}
            {error() ? `It couldn't be installed: ${error()}` : "Restart to start using it."}
          </span>
          <button
            class="perm-btn"
            style={{ "margin-left": "auto" }}
            disabled={busy()}
            onClick={() => setUpdateReady(null)}
            title="Hide this. The update installs when you quit Flux."
          >
            Later
          </button>
          <button class="perm-btn allow" disabled={busy()} onClick={() => void restart()}>
            {busy() ? "Restarting…" : "Restart now"}
          </button>
        </div>
      )}
    </Show>
  );
};

export default UpdateBar;
