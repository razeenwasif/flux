// "Fill password?" bar: the confirm step for a page-initiated autofill. The
// in-page chip shares one JS world with every script on the page, so its click
// proves nothing. This bar lives in the trusted chrome, and only its "Fill"
// injects the password (vault_fill re-checks the origin, the credential-entry
// firewall and the host match). Docked above the content card like
// SavePasswordBar; reuses the .perm-* styles.
import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { vaultFill, type VaultFillRequest } from "./ipc";
import { activeId, fillRequest, setFillRequest } from "./store";

/** "Fill" stays inert this long after the bar appears, so a page can't raise it
 *  just as the user clicks where the button lands. */
const ARM_MS = 600;

const label = (c: VaultFillRequest["choices"][number]) => c.username || c.name || "saved login";

const VaultFillBar: Component = () => {
  // Only the tab that asked, and only while it's in front.
  const req = () => {
    const r = fillRequest();
    return r && r.tab === activeId() ? r : null;
  };
  const [choice, setChoice] = createSignal("");
  const [armed, setArmed] = createSignal(false);
  createEffect(() => {
    const r = req();
    setArmed(false);
    if (!r) return;
    setChoice(r.choices[0]?.id ?? "");
    const t = setTimeout(() => setArmed(true), ARM_MS);
    onCleanup(() => clearTimeout(t));
  });
  const close = () => setFillRequest(null);
  const fill = (tab: number) => {
    const id = choice();
    close();
    if (id) void vaultFill(tab, id).catch(() => {});
  };

  return (
    <Show when={req()}>
      {(r) => (
        <div class="perm-bar" role="alertdialog" aria-live="assertive">
          <span class="perm-ico">🔑</span>
          <span class="perm-text">
            Fill your saved password for <b>{r().host}</b>
            <Show when={r().choices.length === 1 && r().choices[0]}>{(c) => <> · {label(c())}</>}</Show>?
          </span>
          <Show when={r().choices.length > 1}>
            <select
              class="perm-select"
              aria-label="Saved login"
              value={choice()}
              onChange={(e) => setChoice(e.currentTarget.value)}
            >
              <For each={r().choices}>{(c) => <option value={c.id}>{label(c)}</option>}</For>
            </select>
          </Show>
          <button class="perm-btn allow" disabled={!armed()} onClick={() => fill(r().tab)}>
            Fill
          </button>
          <button class="perm-btn deny" onClick={close}>
            Not now
          </button>
        </div>
      )}
    </Show>
  );
};

export default VaultFillBar;
