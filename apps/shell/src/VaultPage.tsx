/**
 * flux://passwords — the full-page password vault manager (BACKLOG #61).
 *
 * Rendered in the content card (no native webview, so it has the whole area —
 * unlike the cramped sidebar popover, which stays for contextual autofill). A
 * Proton-Pass-style two-pane: a searchable list on the left, a detail/edit pane
 * on the right, plus import + security. Passwords are fetched on demand
 * (`vault_reveal`), never listed in bulk to the chrome.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  vaultAdd,
  vaultDisableMasterPassword,
  vaultImportProton,
  vaultList,
  vaultLock,
  vaultRemove,
  vaultReveal,
  vaultSetAutolock,
  vaultSetMasterPassword,
  vaultStatus,
  vaultUnlock,
  onVaultLocked,
  onVaultReady,
  type CredentialMeta,
  type VaultStatus,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

type Pane = "detail" | "add" | "import" | "security";

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 42%)`;
}
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const VaultPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [status, setStatus] = createSignal<VaultStatus | null>(null);
  const [list, setList] = createSignal<CredentialMeta[]>([]);
  const [query, setQuery] = createSignal("");
  const [selId, setSelId] = createSignal<string | null>(null);
  const [pane, setPane] = createSignal<Pane>("detail");
  const [pw, setPw] = createSignal<string | null>(null); // revealed password of selection
  const [showPw, setShowPw] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  // forms
  const [unlockPw, setUnlockPw] = createSignal("");
  const [form, setForm] = createSignal({ name: "", url: "", username: "", password: "" });
  const [impPath, setImpPath] = createSignal("");
  const [impPass, setImpPass] = createSignal("");
  const [mpw, setMpw] = createSignal("");
  const [mpw2, setMpw2] = createSignal("");

  const locked = () => !!status()?.locked;
  const protection = () => status()?.protection ?? "keychain";

  const refresh = () => {
    void vaultStatus()
      .then(setStatus)
      .catch(() => {});
    void vaultList()
      .then(setList)
      .catch(() => setList([]));
  };
  onMount(async () => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Passwords");
    visibleInterval(refresh, 4000);
    const unLocked = await onVaultLocked(() => {
      setPw(null);
      refresh();
    });
    const unReady = await onVaultReady(() => refresh());
    onCleanup(() => {
      unLocked();
      unReady();
    });
  });

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const items = [...list()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return items;
    return items.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q) ||
        c.urls.some((u) => u.toLowerCase().includes(q)),
    );
  });
  const selected = () => list().find((c) => c.id === selId()) ?? null;

  const select = async (c: CredentialMeta) => {
    setSelId(c.id);
    setPane("detail");
    setShowPw(false);
    setPw(null);
    setPw(await vaultReveal(c.id).catch(() => null));
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
  const copy = async (text: string | null, label: string) => {
    if (text == null) return;
    await navigator.clipboard.writeText(text).catch(() => {});
    setMsg(`Copied ${label}`);
    setTimeout(() => setMsg(null), 1400);
  };
  const remove = async (c: CredentialMeta) => {
    await vaultRemove(c.id).catch((e) => setMsg(String(e)));
    setSelId(null);
    refresh();
  };
  const submitAdd = async () => {
    const f = form();
    if (!f.name.trim() && !f.url.trim()) return;
    try {
      await vaultAdd(f.name || f.url, f.url, f.username, f.password);
      setForm({ name: "", url: "", username: "", password: "" });
      setPane("detail");
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };
  const isPgp = () => /\.(pgp|gpg)$/i.test(impPath().trim());
  const runImport = async () => {
    if (!impPath().trim()) return;
    try {
      const n = await vaultImportProton(impPath().trim(), isPgp() ? impPass() : undefined);
      setImpPath("");
      setImpPass("");
      setMsg(`Imported ${n} login${n === 1 ? "" : "s"}`);
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };
  const setMaster = async () => {
    if (!mpw() || (protection() !== "password" && mpw() !== mpw2())) {
      setMsg("passwords don't match");
      return;
    }
    try {
      await vaultSetMasterPassword(mpw());
      setMpw("");
      setMpw2("");
      setMsg("Master password saved");
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };
  const disableMaster = async () => {
    if (!mpw()) {
      setMsg("enter your master password");
      return;
    }
    try {
      await vaultDisableMasterPassword(mpw());
      setMpw("");
      setMpw2("");
      setMsg("Master password removed");
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div class="vault-page">
      {/* ── Locked ── */}
      <Show when={locked()}>
        <div class="vault-lock">
          <div class="vault-lock-card glass">
            <div class="vault-lock-icon">🔒</div>
            <h2>Vault locked</h2>
            <p>Enter your master password to unlock.</p>
            <input
              class="vault-input"
              type="password"
              placeholder="Master password"
              value={unlockPw()}
              autofocus
              onInput={(e) => setUnlockPw(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void unlock()}
            />
            <button class="vault-btn primary" disabled={!unlockPw()} onClick={() => void unlock()}>
              Unlock
            </button>
            <Show when={msg()}>
              <div class="vault-msg err">{msg()}</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* ── Unlocked ── */}
      <Show when={!locked()}>
        <header class="vault-head">
          <div class="vault-title">
            🔑 Passwords <span class="vault-count">{status()?.count ?? 0}</span>
          </div>
          <input
            class="vault-search"
            placeholder="Search logins…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <div class="vault-head-actions">
            <button
              class="vault-btn"
              classList={{ on: pane() === "add" }}
              onClick={() => {
                setPane("add");
                setSelId(null);
              }}
            >
              + New
            </button>
            <button
              class="vault-btn"
              classList={{ on: pane() === "import" }}
              onClick={() => {
                setPane("import");
                setSelId(null);
              }}
            >
              Import
            </button>
            <button
              class="vault-btn"
              classList={{ on: pane() === "security" }}
              onClick={() => {
                setPane("security");
                setSelId(null);
              }}
            >
              Security
            </button>
            <Show when={protection() === "password"}>
              <button class="vault-btn" onClick={() => void vaultLock().then(refresh)}>
                🔒 Lock
              </button>
            </Show>
          </div>
        </header>

        <div class="vault-body">
          {/* List */}
          <div class="vault-list">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="vault-empty">
                  {list().length === 0
                    ? "No logins yet — add one or import from Proton Pass, Chrome, or Bitwarden."
                    : "No matches."}
                </div>
              }
            >
              <For each={filtered()}>
                {(c) => (
                  <button
                    classList={{ "vault-item": true, sel: selId() === c.id }}
                    onClick={() => void select(c)}
                  >
                    <span
                      class="vault-avatar"
                      style={{ background: avatarColor(c.name || c.urls[0] || "?") }}
                    >
                      {(c.name || c.urls[0] || "?").charAt(0).toUpperCase()}
                    </span>
                    <span class="vault-item-text">
                      <span class="vault-item-name">{c.name || hostLabel(c.urls[0] ?? "")}</span>
                      <span class="vault-item-sub">{c.username || hostLabel(c.urls[0] ?? "")}</span>
                    </span>
                    <Show when={c.has_totp}>
                      <span class="vault-totp" title="Has TOTP">
                        ⏱
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>

          {/* Right pane */}
          <div class="vault-detail">
            <Show when={pane() === "add"}>
              <h3>New login</h3>
              <label class="vault-field">
                <span>Name</span>
                <input
                  class="vault-input"
                  value={form().name}
                  onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))}
                />
              </label>
              <label class="vault-field">
                <span>Website</span>
                <input
                  class="vault-input"
                  placeholder="https://site.com"
                  value={form().url}
                  onInput={(e) => setForm((f) => ({ ...f, url: e.currentTarget.value }))}
                />
              </label>
              <label class="vault-field">
                <span>Username / email</span>
                <input
                  class="vault-input"
                  value={form().username}
                  onInput={(e) => setForm((f) => ({ ...f, username: e.currentTarget.value }))}
                />
              </label>
              <label class="vault-field">
                <span>Password</span>
                <input
                  class="vault-input"
                  type="password"
                  value={form().password}
                  onInput={(e) => setForm((f) => ({ ...f, password: e.currentTarget.value }))}
                />
              </label>
              <div class="vault-row">
                <button class="vault-btn primary" onClick={() => void submitAdd()}>
                  Save
                </button>
                <button class="vault-btn" onClick={() => setPane("detail")}>
                  Cancel
                </button>
              </div>
            </Show>

            <Show when={pane() === "import"}>
              <h3>Import passwords</h3>
              <p class="vault-hint">
                Export from <b>Proton Pass</b> (CSV, ZIP, PGP, JSON), <b>Chrome</b> (Settings → Passwords →
                Export, CSV), or <b>Bitwarden</b> (unencrypted CSV/JSON) and give the file path. The format is
                detected automatically. No live sync — re-import to refresh.
              </p>
              <label class="vault-field">
                <span>File path</span>
                <input
                  class="vault-input"
                  placeholder="/path/to/export.csv (.zip / .pgp / .json)"
                  value={impPath()}
                  onInput={(e) => setImpPath(e.currentTarget.value)}
                />
              </label>
              <Show when={isPgp()}>
                <label class="vault-field">
                  <span>PGP passphrase</span>
                  <input
                    class="vault-input"
                    type="password"
                    value={impPass()}
                    onInput={(e) => setImpPass(e.currentTarget.value)}
                  />
                </label>
              </Show>
              <div class="vault-row">
                <button
                  class="vault-btn primary"
                  disabled={!impPath().trim()}
                  onClick={() => void runImport()}
                >
                  Import
                </button>
              </div>
            </Show>

            <Show when={pane() === "security"}>
              <h3>Security</h3>
              <p class="vault-hint">
                Protection: <strong>{protection() === "password" ? "Master password" : "OS keychain"}</strong>
                . A master password (Argon2id) seals the vault even from your logged-in account and removes
                the key from the keychain.
              </p>
              <Show when={protection() === "password"}>
                <label class="vault-field">
                  <span>Auto-lock when idle</span>
                  <select
                    class="vault-input"
                    value={String(status()?.autolock_minutes ?? 0)}
                    onChange={(e) => void vaultSetAutolock(Number(e.currentTarget.value)).then(refresh)}
                  >
                    <option value="0">Never</option>
                    <option value="1">1 min</option>
                    <option value="5">5 min</option>
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                  </select>
                </label>
              </Show>
              <label class="vault-field">
                <span>
                  {protection() === "password" ? "New / current master password" : "Master password"}
                </span>
                <input
                  class="vault-input"
                  type="password"
                  value={mpw()}
                  onInput={(e) => setMpw(e.currentTarget.value)}
                />
              </label>
              <Show when={protection() !== "password"}>
                <label class="vault-field">
                  <span>Confirm</span>
                  <input
                    class="vault-input"
                    type="password"
                    value={mpw2()}
                    onInput={(e) => setMpw2(e.currentTarget.value)}
                  />
                </label>
              </Show>
              <div class="vault-row">
                <button class="vault-btn primary" onClick={() => void setMaster()}>
                  {protection() === "password" ? "Change password" : "Set master password"}
                </button>
                <Show when={protection() === "password"}>
                  <button class="vault-btn danger" onClick={() => void disableMaster()}>
                    Remove
                  </button>
                </Show>
              </div>
            </Show>

            <Show when={pane() === "detail"}>
              <Show
                when={selected()}
                fallback={<div class="vault-empty big">Select a login to view its details.</div>}
              >
                {(c) => (
                  <>
                    <div class="vault-detail-head">
                      <span class="vault-avatar lg" style={{ background: avatarColor(c().name || "?") }}>
                        {(c().name || "?").charAt(0).toUpperCase()}
                      </span>
                      <h3>{c().name || hostLabel(c().urls[0] ?? "")}</h3>
                    </div>
                    <div class="vault-field">
                      <span>Username</span>
                      <div class="vault-value">
                        <code>{c().username || "—"}</code>
                        <button
                          class="vault-mini"
                          title="Copy"
                          onClick={() => void copy(c().username, "username")}
                        >
                          ⧉
                        </button>
                      </div>
                    </div>
                    <div class="vault-field">
                      <span>Password</span>
                      <div class="vault-value">
                        <code>{showPw() ? (pw() ?? "…") : "••••••••••"}</code>
                        <button class="vault-mini" title="Reveal" onClick={() => setShowPw((v) => !v)}>
                          👁
                        </button>
                        <button class="vault-mini" title="Copy" onClick={() => void copy(pw(), "password")}>
                          ⧉
                        </button>
                      </div>
                    </div>
                    <Show when={c().urls.length > 0}>
                      <div class="vault-field">
                        <span>Websites</span>
                        <div class="vault-urls">
                          <For each={c().urls}>
                            {(u) => (
                              <button class="vault-url" onClick={() => props.onNavigate(u)}>
                                {hostLabel(u)} ↗
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                    <Show when={c().has_totp}>
                      <div class="vault-field">
                        <span>TOTP</span>
                        <div class="vault-value">
                          <code>stored ⏱</code>
                        </div>
                      </div>
                    </Show>
                    <div class="vault-row" style={{ "margin-top": "16px" }}>
                      <button class="vault-btn danger" onClick={() => void remove(c())}>
                        Delete login
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </Show>
          </div>
        </div>

        <Show when={msg()}>
          <div class="vault-toast glass">{msg()}</div>
        </Show>
      </Show>
    </div>
  );
};

export default VaultPage;
