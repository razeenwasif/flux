// "Save password?" bar (BACKLOG #61 follow-up). The page sentinel captured a
// manually-typed login on submit; Rust holds the password and raised this
// prompt. Docked ABOVE the content card as a sibling (like PermissionBar) — the
// card + its native webview shrink to make room, so nothing fights the OS
// webview layer. Reuses the .perm-* styles.
//
// The prompt is its tab's own (audit S26): `savePrompt()` is the one for the tab
// in front, and Save, Not now and Never all name that tab, so a page in another
// tab can neither replace what this bar is about to save nor answer for it.
import { Component, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clearSavePrompt, savePrompt } from "./store";

/** Commit `tab`'s pending save (the bar's "Save"/"Update"): the capture staged
 *  at `staged`, the one this bar showed, and not one that replaced it since. */
const vaultSaveConfirm = (tab: number, staged: number) => invoke<void>("vault_save_confirm", { tab, staged });
/** What Rust answers when that capture is gone (vault.rs `SAVE_GONE`). */
const GONE = "no longer waiting";
/** Drop `tab`'s pending save ("Not now"). */
const vaultSaveDismiss = (tab: number) => invoke<void>("vault_save_dismiss", { tab });
/** Drop `tab`'s pending save and never offer for its host again. */
const vaultNeverSave = (tab: number) => invoke<void>("vault_never_save", { tab });

/** Save stays inert this long after the bar appears or its text changes, so a
 *  page can't raise or swap it just as a click lands where the button is. */
const ARM_MS = 600;

const SavePasswordBar: Component = () => {
  // A memo, so the effect below runs when THIS tab's prompt changes, not on
  // every other tab's prompt coming or going (which would disarm Save each time).
  const p = createMemo(savePrompt);
  // Rust took a capture back (the login turned out to be stored already, say):
  // its prompt goes too, rather than staying up to be clicked.
  const cleared = listen<number>("flux://vault-save-clear", (e) => clearSavePrompt(e.payload));
  onCleanup(() => void cleared.then((off) => off()).catch(() => {}));
  /** Why the last Save/Update failed; a new prompt starts clean. */
  const [err, setErr] = createSignal<string | null>(null);
  const [armed, setArmed] = createSignal(false);
  createEffect(
    on(p, (prompt) => {
      setErr(null);
      setArmed(false);
      if (!prompt) return;
      const t = setTimeout(() => setArmed(true), ARM_MS);
      onCleanup(() => clearTimeout(t));
    }),
  );
  const save = async (tab: number, staged: number) => {
    try {
      await vaultSaveConfirm(tab, staged);
      clearSavePrompt(tab);
    } catch (e) {
      // The capture this bar showed is gone or was replaced: nothing to retry.
      if (String(e).includes(GONE)) return clearSavePrompt(tab);
      // e.g. "vault is locked" (auto-lock fired while the bar was up) or a failed
      // write. Closing would read as saved; Rust kept the capture, so keep the
      // bar and say why, and Save works again once the vault is unlocked.
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };
  const notNow = (tab: number) => {
    void vaultSaveDismiss(tab);
    clearSavePrompt(tab);
  };
  const never = (tab: number) => {
    void vaultNeverSave(tab);
    clearSavePrompt(tab);
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
              <button class="perm-btn dismiss" onClick={() => clearSavePrompt(prompt().tab)}>
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
            <button
              class="perm-btn allow"
              disabled={!armed()}
              onClick={() => void save(prompt().tab, prompt().staged)}
            >
              {prompt().update ? "Update" : "Save"}
            </button>
            <button class="perm-btn deny" onClick={() => notNow(prompt().tab)}>
              Not now
            </button>
            <button
              class="perm-btn dismiss"
              title="Never save for this site"
              onClick={() => never(prompt().tab)}
            >
              Never
            </button>
          </div>
        </Show>
      )}
    </Show>
  );
};

export default SavePasswordBar;
