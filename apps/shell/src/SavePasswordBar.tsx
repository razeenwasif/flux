// "Save password?" bar (BACKLOG #61 follow-up). The page sentinel captured a
// manually-typed login on submit; Rust holds the password and raised this
// prompt. Docked ABOVE the content card as a sibling (like PermissionBar) — the
// card + its native webview shrink to make room, so nothing fights the OS
// webview layer. Reuses the .perm-* styles.
import { Component, Show } from "solid-js";
import { onVaultSaved, vaultNeverSave, vaultSaveConfirm, vaultSaveDismiss } from "./ipc";
import { savePrompt, setSavePrompt } from "./store";

const SavePasswordBar: Component = () => {
  const p = () => savePrompt();
  const close = () => setSavePrompt(null);
  const save = () => {
    void vaultSaveConfirm();
    close();
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
        <div class="perm-bar" role="alertdialog" aria-live="assertive">
          <span class="perm-ico">🔑</span>
          <span class="perm-text">
            {prompt().update ? "Update the saved password for " : "Save your password for "}
            <b>{prompt().host}</b>
            <Show when={prompt().username}> · {prompt().username}</Show>?
          </span>
          <button class="perm-btn allow" onClick={save}>
            {prompt().update ? "Update" : "Save"}
          </button>
          <button class="perm-btn deny" onClick={notNow}>
            Not now
          </button>
          <button class="perm-btn dismiss" title="Never save for this site" onClick={never}>
            Never
          </button>
        </div>
      )}
    </Show>
  );
};

export default SavePasswordBar;
