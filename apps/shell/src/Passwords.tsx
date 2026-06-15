/**
 * Password vault UI (BACKLOG #61, ADR 0009). A footer 🔑 popover: lists stored
 * logins, fills the active page's login form (same-origin, user-initiated),
 * imports a Proton Pass JSON export, and adds/reveals/removes entries. Passwords
 * never load eagerly — reveal/copy fetches one on demand; fill injects straight
 * into the page from Rust.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  vaultAdd,
  vaultFill,
  vaultImportProton,
  vaultList,
  vaultRemove,
  vaultReveal,
  vaultStatus,
  type CredentialMeta,
  type VaultStatus,
} from "./ipc";
import { activeId, activeTab } from "./store";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const Passwords: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [status, setStatus] = createSignal<VaultStatus | null>(null);
  const [list, setList] = createSignal<CredentialMeta[]>([]);
  const [revealed, setRevealed] = createSignal<Record<string, string>>({});
  const [path, setPath] = createSignal("");
  const [pgpPass, setPgpPass] = createSignal("");
  const [msg, setMsg] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", url: "", username: "", password: "" });

  const refresh = () => {
    void vaultStatus().then(setStatus).catch(() => {});
    void vaultList().then(setList).catch(() => {});
  };
  let timer: number | undefined;
  onMount(() => {
    refresh();
    timer = window.setInterval(() => open() && refresh(), 2500);
    onCleanup(() => clearInterval(timer));
  });

  const curHost = (): string | null => {
    const t = activeTab();
    return t && t.kind === "browser" ? hostOf(t.url) : null;
  };
  const matches = (e: CredentialMeta): boolean => {
    const h = curHost();
    if (!h) return false;
    return e.urls.some((u) => {
      const ph = hostOf(u);
      return !!ph && (ph === h || h.endsWith(`.${ph}`) || ph.endsWith(`.${h}`));
    });
  };

  const fill = (e: CredentialMeta) => {
    const id = activeId();
    if (id != null) void vaultFill(id, e.id).then(() => setOpen(false)).catch((err) => setMsg(String(err)));
  };
  const copy = async (e: CredentialMeta) => {
    const pw = await vaultReveal(e.id).catch(() => null);
    if (pw != null) {
      await navigator.clipboard.writeText(pw).catch(() => {});
      setMsg(`Copied ${e.name} password`);
      setTimeout(() => setMsg(null), 1500);
    }
  };
  const toggleReveal = async (e: CredentialMeta) => {
    if (revealed()[e.id] != null) {
      setRevealed((r) => { const n = { ...r }; delete n[e.id]; return n; });
      return;
    }
    const pw = await vaultReveal(e.id).catch(() => null);
    if (pw != null) setRevealed((r) => ({ ...r, [e.id]: pw }));
  };
  const remove = (e: CredentialMeta) => void vaultRemove(e.id).then(refresh).catch((err) => setMsg(String(err)));

  const isPgp = () => /\.(pgp|gpg)$/i.test(path().trim());
  const importProton = async () => {
    const p = path().trim();
    if (!p) return;
    setMsg(null);
    try {
      const n = await vaultImportProton(p, isPgp() ? pgpPass() : undefined);
      setPath("");
      setPgpPass("");
      setMsg(`Imported ${n} login${n === 1 ? "" : "s"}`);
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const submitAdd = async () => {
    const f = form();
    if (!f.name.trim() && !f.url.trim()) return;
    try {
      await vaultAdd(f.name || f.url, f.url, f.username, f.password);
      setForm({ name: "", url: "", username: "", password: "" });
      setAdding(false);
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const sorted = () => {
    const m = (e: CredentialMeta) => (matches(e) ? 0 : 1);
    return [...list()].sort((a, b) => m(a) - m(b) || a.name.localeCompare(b.name));
  };

  return (
    <div style={{ display: "contents" }}>
      <button classList={{ "icon-btn": true, active: open() }} title="Passwords" onClick={() => { setOpen((v) => !v); if (!open()) refresh(); }}>
        🔑
      </button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover footer-pop">
          <div class="shields-row">
            <span class="shields-label">Passwords</span>
            <span class="ext-ver">{status()?.count ?? 0} · {status()?.source ?? "…"}</span>
          </div>
          <Show when={status() && !status()!.available}>
            <div class="ext-error">No keychain or key file — vault unavailable.</div>
          </Show>

          <Show
            when={list().length > 0}
            fallback={<div class="start-empty" style={{ padding: "4px 8px 8px" }}>No logins yet. Import a Proton Pass export or add one below.</div>}
          >
            <For each={sorted()}>
              {(e) => (
                <div class="ext-row">
                  <div class="ext-head">
                    <span class="ext-name" title={e.urls[0] ?? ""}>
                      {e.name || e.urls[0]} <span class="ext-ver">{e.username}</span>
                    </span>
                    <span style={{ display: "flex", gap: "4px" }}>
                      <Show when={matches(e)}>
                        <button class="vault-fill" title="Fill this page" onClick={() => fill(e)}>Fill</button>
                      </Show>
                      <button class="find-nav" title="Copy password" onClick={() => void copy(e)}>⧉</button>
                      <button class="find-nav" title="Reveal" onClick={() => void toggleReveal(e)}>👁</button>
                      <button class="ext-remove" title="Delete" onClick={() => remove(e)}>✕</button>
                    </span>
                  </div>
                  <Show when={revealed()[e.id] != null}>
                    <div class="vault-pw">{revealed()[e.id]}</div>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <div class="shields-sep" />
          <div class="ext-install">
            <input class="ext-path" placeholder="Proton Pass export (.csv / .zip / .pgp / .json)" value={path()} onInput={(e) => setPath(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && !isPgp() && void importProton()} />
            <button class="shields-update" disabled={!path().trim()} onClick={() => void importProton()}>Import</button>
          </div>
          <Show when={isPgp()}>
            <input class="ext-path" type="password" style={{ margin: "5px 8px 0" }} placeholder="PGP passphrase" value={pgpPass()} onInput={(e) => setPgpPass(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void importProton()} />
          </Show>

          <Show
            when={adding()}
            fallback={<button class="shields-update" onClick={() => setAdding(true)}>+ Add a login</button>}
          >
            <div class="vault-add">
              <input class="ext-path" placeholder="Name" value={form().name} onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))} />
              <input class="ext-path" placeholder="https://site.com" value={form().url} onInput={(e) => setForm((f) => ({ ...f, url: e.currentTarget.value }))} />
              <input class="ext-path" placeholder="Username / email" value={form().username} onInput={(e) => setForm((f) => ({ ...f, username: e.currentTarget.value }))} />
              <input class="ext-path" type="password" placeholder="Password" value={form().password} onInput={(e) => setForm((f) => ({ ...f, password: e.currentTarget.value }))} />
              <div style={{ display: "flex", gap: "6px" }}>
                <button class="vault-fill" onClick={() => void submitAdd()}>Save</button>
                <button class="shields-update" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          </Show>

          <Show when={msg()}>
            <div class="ext-error" style={{ color: "var(--flux-text-dim)" }}>{msg()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Passwords;
