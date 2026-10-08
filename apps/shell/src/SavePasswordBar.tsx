// "Save password?" bar (BACKLOG #61 follow-up). The page sentinel captured a
// manually-typed login on submit; Rust holds the password and raised this
// prompt. Docked ABOVE the content card as a sibling (like PermissionBar) — the
// card + its native webview shrink to make room, so nothing fights the OS
// webview layer. Reuses the .perm-* styles.
import { Component, Show, createEffect, createSignal, on } from "solid-js";
import { onVaultSaved, vaultNeverSave, vaultSaveConfirm, vaultSaveDismiss } from "./ipc";
import { savePrompt, setSavePrompt } from "./store";

const SavePasswordBar: Component = () => {
  const p = () => savePrompt();
  /** Why the last Save/Update failed; a new prompt starts clean. */
  const [err, setErr] = createSignal<string | null>(null);
  createEffect(on(savePrompt, () => setErr(null)));
  const close = () => setSavePrompt(null);
  const save = async () => {
    try {
      await vaultSaveConfirm();
      close();
    } catch (e) {
      // e.g. "vault is locked" (auto-lock fired while the bar was up) or a failed
      // write. Closing would read as saved; Rust kept the capture, so keep the
      // bar and say why, and Save works again once the vault is unlocked.
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  const notNow = () => {
    void vaultSaveDismiss();
    close();
  };
  const never = () => {
    void vaultNeverSave();
    close();
  };

  return (
    <Show when={p()}>
      {(prompt) => (
        <Show
          when={!prompt().warning}
          fallback={
            // Credential-entry firewall (ADR 0013, Pillar 2): the password went
            // into a site impersonating a brand you value. No save offered —
            // just the warning and what to do about it.
            <div class="perm-bar danger" role="alertdialog" aria-live="assertive">
              <span class="perm-ico">⚠</span>
              <span class="perm-text">
                You just entered a password on <b>{prompt().host}</b>, which looks like{" "}
                <b>{prompt().warning?.resembles}</b>. If that wasn't intentional, change your{" "}
                {prompt().warning?.resembles} password now.
              </span>
              <button class="perm-btn dismiss" onClick={close}>
                Dismiss
              </button>
            </div>
          }
        >
          <div class="perm-bar" role="alertdialog" aria-live="assertive">
            <span class="perm-ico">🔑</span>
            <span class="perm-text">
              {prompt().update ? "Update the saved password for " : "Save your password for "}
              <b>{prompt().host}</b>
              <Show when={prompt().username}> · {prompt().username}</Show>?
              <Show when={err()}> Not saved: {err()}.</Show>
            </span>
            <button class="perm-btn allow" onClick={() => void save()}>
              {prompt().update ? "Update" : "Save"}
            </button>
            <button class="perm-btn deny" onClick={notNow}>
              Not now
            </button>
            <button class="perm-btn dismiss" title="Never save for this site" onClick={never}>
              Never
            </button>
          </div>
        </Show>
      )}
    </Show>
  );
};

export default SavePasswordBar;
