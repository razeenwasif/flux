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
  vaultReveal,
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

  /** Copy a credential's password to the clipboard. The fallback for pages the
   *  injector can't fill — a custom widget, a cross-origin frame, or a two-step
   *  sign-in whose password screen hasn't appeared yet. */
  const copyPw = async (c: CredentialMeta): Promise<boolean> => {
    let pw: string | null = null;
    try {
      pw = await vaultReveal(c.id);
    } catch {
      return false; // vault locked / entry gone
    }
    if (!pw) return false;
    try {
      await navigator.clipboard.writeText(pw);
      return true;
    } catch {
      // Some embedded webviews refuse the async Clipboard API (no permission,
      // not treated as a secure context). Fall back to the legacy path, which
      // is still honoured there.
      try {
        const ta = document.createElement("textarea");
        ta.value = pw;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  };

  const fill = async (c: CredentialMeta) => {
    const id = activeId();
    if (id == null) return;
    let filled = true;
    let why = "";
    try {
      await vaultFill(id, c.id);
    } catch (e) {
      filled = false;
      why = String(e).replace(/^Error:\s*/, "");
    }
    // Copy REGARDLESS of whether the injection succeeded. An earlier version
    // bailed on failure, which skipped the fallback at the exact moment it was
    // needed — a blocked or impossible fill is precisely when you want the
    // password on the clipboard. The injected script's own result can't come
    // back either (eval is fire-and-forget), so this is the only path that
    // always leaves you something usable.
    const copied = await copyPw(c);
    if (filled) {
      setMsg(copied ? "Filled · password copied" : "Filled");
      window.setTimeout(() => setOpen(false), 1100);
    } else {
      // Say what went wrong AND that there's still a way forward.
      setMsg(copied ? `${why} — password copied instead` : why || "Couldn't fill or copy");
    }
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
                        <button
                          class="vault-fill"
                          title="Fill this page (also copies the password)"
                          onClick={() => void fill(c)}
                        >
                          Fill
                        </button>
                        <button
                          class="vault-copy"
                          title="Copy password to clipboard"
                          onClick={() => {
                            void copyPw(c).then((ok) =>
                              setMsg(ok ? "Password copied" : "Couldn't copy"),
                            );
                          }}
                        >
                          Copy
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
