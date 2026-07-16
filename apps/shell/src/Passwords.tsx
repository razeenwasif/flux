/**
 * Password vault — the footer 🔑 popover (BACKLOG #61). Deliberately lean: it's
 * the *contextual* surface (like the Proton Pass extension popup) — logins that
 * match the current site with a one-click Fill, plus unlock/lock and a link to
 * the full-page manager (flux://passwords) for browsing/editing everything.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  VAULT_URL,
  onVaultLocked,
  onVaultReady,
  vaultFill,
  vaultForHost,
  vaultLock,
  vaultStatus,
  vaultUnlock,
  type CredentialMeta,
  type VaultStatus,
} from "./ipc";
import { activeId, activeTab, openTab } from "./store";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const Passwords: Component<{ initialOpen?: boolean }> = (props) => {
  const [open, setOpen] = createSignal(!!props.initialOpen);
  const [status, setStatus] = createSignal<VaultStatus | null>(null);
  const [matches, setMatches] = createSignal<CredentialMeta[]>([]);
  const [unlockPw, setUnlockPw] = createSignal("");
  const [msg, setMsg] = createSignal<string | null>(null);

  const locked = () => !!status()?.locked;
  const host = () => {
    const t = activeTab();
    return t && t.kind === "browser" ? hostOf(t.url) : null;
  };

  const refresh = () => {
    void vaultStatus()
      .then(setStatus)
      .catch(() => {});
    const h = host();
    if (h && !locked())
      void vaultForHost(h)
        .then(setMatches)
        .catch(() => setMatches([]));
    else setMatches([]);
  };
  onMount(async () => {
    const unLocked = await onVaultLocked(() => refresh());
    const unReady = await onVaultReady(() => refresh());
    onCleanup(() => {
      unLocked();
      unReady();
    });
  });
  // Poll for host matches only while the popover is open (was an always-on 2.5s
  // timer). The locked-state badge stays fresh via the onVaultLocked event.
  createEffect(() => {
    if (!open()) return;
    visibleInterval(refresh, 2500);
  });

  const fill = (c: CredentialMeta) => {
    const id = activeId();
    if (id != null)
      void vaultFill(id, c.id)
        .then(() => setOpen(false))
        .catch((e) => setMsg(String(e)));
  };
  const unlock = async () => {
    if (!unlockPw()) return;
    try {
      await vaultUnlock(unlockPw());
      setUnlockPw("");
      setMsg(null);
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };
  const openManager = () => {
    setOpen(false);
    void openTab("browser", VAULT_URL);
  };

  return (
    <div style={{ display: "contents" }}>
      <button
        classList={{ "icon-btn": true, active: open() }}
        title={locked() ? "Passwords (locked)" : "Passwords"}
        onClick={() => {
          setOpen((v) => !v);
          if (!open()) refresh();
        }}
      >
        {locked() ? "🔒" : "🔑"}
      </button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover footer-pop">
          <div class="shields-row">
            <span class="shields-label">Passwords</span>
            <span class="ext-ver">{locked() ? "locked" : `${status()?.count ?? 0}`}</span>
          </div>

          <Show when={locked()}>
            <div class="start-empty" style={{ padding: "2px 8px 6px" }}>
              Enter your master password to unlock.
            </div>
            <div class="ext-install">
              <input
                class="ext-path"
                type="password"
                placeholder="Master password"
                value={unlockPw()}
                autofocus
                onInput={(e) => setUnlockPw(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlock()}
              />
              <button class="shields-update" disabled={!unlockPw()} onClick={() => void unlock()}>
                Unlock
              </button>
            </div>
          </Show>

          <Show when={!locked()}>
            <Show when={status() && !status()!.available}>
              <div class="ext-error">No keychain or key file — vault unavailable.</div>
            </Show>

            <Show when={host()}>
              <div class="sidebar-section" style={{ padding: "4px 8px 2px" }}>
                For {host()}
              </div>
              <Show
                when={matches().length > 0}
                fallback={
                  <div class="start-empty" style={{ padding: "2px 8px 6px" }}>
                    No saved logins for this site.
                  </div>
                }
              >
                <For each={matches()}>
                  {(c) => (
                    <div class="ext-row">
                      <div class="ext-head">
                        <span class="ext-name" title={c.urls[0] ?? ""}>
                          {c.name || c.urls[0]} <span class="ext-ver">{c.username}</span>
                        </span>
                        <button class="vault-fill" title="Fill this page" onClick={() => fill(c)}>
                          Fill
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </Show>

            <div class="shields-sep" />
            <button class="shields-update" onClick={openManager}>
              ⤢ Open Passwords manager
            </button>
            <Show when={status()?.protection === "password"}>
              <button class="shields-update" onClick={() => void vaultLock().then(refresh)}>
                🔒 Lock now
              </button>
            </Show>
          </Show>

          <Show when={msg()}>
            <div class="ext-error" style={{ color: "var(--flux-text-dim)" }}>
              {msg()}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Passwords;
