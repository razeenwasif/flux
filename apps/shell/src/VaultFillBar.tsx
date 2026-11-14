// "Fill password?" bar: the confirm step for a page-initiated autofill. The
// in-page chip shares one JS world with every script on the page, so its click
// proves nothing. This bar lives in the trusted chrome, and only its "Fill"
// injects the password (vault_fill re-checks the origin, the credential-entry
// firewall and the host match). Docked above the content card like
// SavePasswordBar; reuses the .perm-* styles.
//
// It names the site each login was SAVED for (audit S25), since the page's own
// host says nothing about whose login is about to be typed into it. A login
// saved for a related site, a sub- or parent domain or another port, takes a
// second step that shows both names: `evil.tumblr.com` is not `tumblr.com`.
import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFillRequest } from "./ipc";
import { activeId, fillRequest, setFillRequest } from "./store";

/** "Fill" stays inert this long after the bar appears or changes what it asks,
 *  so a page can't raise it just as the user clicks where the button lands. */
const ARM_MS = 600;

type Choice = VaultFillRequest["choices"][number];
const who = (c: Choice) => c.username || c.name || "saved login";
/** In the picker, a login from another site says so. */
const option = (c: Choice) => (c.exact ? who(c) : `${who(c)} (saved for ${c.saved_host})`);

const VaultFillBar: Component = () => {
  // Only the tab that asked, and only while it's in front.
  const req = () => {
    const r = fillRequest();
    return r && r.tab === activeId() ? r : null;
  };
  const [choice, setChoice] = createSignal("");
  /** The second step for a related login: both names are on screen. */
  const [confirming, setConfirming] = createSignal(false);
  const [armed, setArmed] = createSignal(false);
  const picked = () => req()?.choices.find((c) => c.id === choice()) ?? null;
  createEffect(() => {
    const r = req();
    setConfirming(false);
    if (r) setChoice(r.choices[0]?.id ?? "");
  });
  // Re-arm whenever what a click would do changes: a new request, another
  // login picked, or the step from "Fill" to "Use it here".
  createEffect(() => {
    req();
    choice();
    confirming();
    setArmed(false);
    const t = setTimeout(() => setArmed(true), ARM_MS);
    onCleanup(() => clearTimeout(t));
  });
  const close = () => setFillRequest(null);
  const fill = (r: VaultFillRequest) => {
    const c = picked();
    if (!c) return close();
    if (!c.exact && !confirming()) {
      setConfirming(true);
      return;
    }
    close();
    // `expectedHost` is the page this bar named. Rust fills only if the tab is
    // still on it, so an answer given about one page never lands on another.
    void invoke<void>("vault_fill", {
      tabId: r.tab,
      id: c.id,
      confirmRelated: !c.exact,
      expectedHost: r.host,
    }).catch(() => {});
  };

  return (
    <Show when={req()}>
      {(r) => (
        <div class="perm-bar" role="alertdialog" aria-live="assertive">
          <span class="perm-ico">🔑</span>
          <Show
            when={confirming() && picked()}
            fallback={
              <span class="perm-text">
                Fill your saved password for <b>{picked()?.saved_host ?? r().host}</b>
                <Show when={r().choices.length === 1 && r().choices[0]}>{(c) => <> · {who(c())}</>}</Show>?
              </span>
            }
          >
            {(c) => (
              <span class="perm-text">
                This login was saved for <b>{c().saved_host}</b>. This page is <b>{r().host}</b>, which may
                belong to someone else. Use it here?
              </span>
            )}
          </Show>
          <Show when={r().choices.length > 1 && !confirming()}>
            <select
              class="perm-select"
              aria-label="Saved login"
              value={choice()}
              onChange={(e) => setChoice(e.currentTarget.value)}
            >
              <For each={r().choices}>{(c) => <option value={c.id}>{option(c)}</option>}</For>
            </select>
          </Show>
          <button class="perm-btn allow" disabled={!armed()} onClick={() => fill(r())}>
            {confirming() ? "Use it here" : "Fill"}
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
