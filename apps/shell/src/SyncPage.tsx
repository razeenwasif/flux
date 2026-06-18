/**
 * flux://sync — E2E-encrypted sync (BACKLOG #62). Account-optional, local-first:
 * point Flux at a folder your devices already sync (Dropbox / Syncthing / iCloud
 * / a USB stick) and it writes ONE end-to-end-encrypted file there. Bookmarks +
 * sessions merge across devices; the passphrase never leaves your machine, and
 * whatever syncs the folder only ever sees ciphertext.
 */
import { Show, createSignal, onMount, type Component } from "solid-js";
import { syncLock, syncNow, syncSetFolder, syncStatus, syncUnlock, type SyncStatus } from "./ipc";
import { activeId, updateTabTitle } from "./store";

const SyncPage: Component = () => {
  const [status, setStatus] = createSignal<SyncStatus | null>(null);
  const [folder, setFolder] = createSignal("");
  const [pass, setPass] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const refresh = () =>
    void syncStatus().then((s) => { setStatus(s); setFolder(s.folder ?? ""); }).catch(() => {});
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Sync");
    refresh();
  });

  const saveFolder = async () => { await syncSetFolder(folder().trim()); setErr(null); setMsg(null); refresh(); };
  const unlock = async () => {
    setErr(null); setMsg(null);
    try { await syncUnlock(pass()); setPass(""); refresh(); }
    catch (e) { setErr(String(e)); }
  };
  const lock = async () => { await syncLock(); refresh(); };
  const sync = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await syncNow();
      setMsg(`Synced — merged ${r.bookmarks_added} bookmark${r.bookmarks_added === 1 ? "" : "s"} and ${r.sessions_added} session${r.sessions_added === 1 ? "" : "s"}.`);
      refresh();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const lastSync = () => {
    const ms = status()?.last_ms ?? 0;
    return ms ? new Date(ms).toLocaleString() : "never";
  };

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🔄 Sync</div>
        <span class="res-mem">last sync: {lastSync()}</span>
      </header>

      <div class="hist-body sync-body">
        <p class="sync-intro">
          End-to-end encrypted, no account. Point Flux at a folder your devices already
          sync (Dropbox, Syncthing, iCloud Drive, a USB stick…). Flux writes one encrypted
          file there; your passphrase never leaves this device, and the sync service only
          ever sees ciphertext. <b>Bookmarks and saved sessions</b> merge across devices.
        </p>

        <label class="sync-label">Sync folder</label>
        <div class="sync-row">
          <input class="sync-input" placeholder="/path/to/Dropbox/Flux  (or a Windows path)" value={folder()} onInput={(e) => setFolder(e.currentTarget.value)} />
          <button class="sync-btn" onClick={() => void saveFolder()}>Set</button>
        </div>

        <label class="sync-label">Passphrase</label>
        <Show
          when={status()?.unlocked}
          fallback={
            <div class="sync-row">
              <input class="sync-input" type="password" placeholder="Shared passphrase (same on every device)" value={pass()}
                onInput={(e) => setPass(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />
              <button class="sync-btn" disabled={!status()?.folder} onClick={() => void unlock()}>Unlock</button>
            </div>
          }
        >
          <div class="sync-row">
            <span class="sync-unlocked">🔓 Unlocked on this device</span>
            <button class="sync-btn" onClick={() => void lock()}>Lock</button>
          </div>
        </Show>

        <button class="sync-now" disabled={!status()?.unlocked || busy()} onClick={() => void sync()}>
          {busy() ? "Syncing…" : "🔄 Sync now"}
        </button>

        <Show when={msg()}><div class="sync-msg">{msg()}</div></Show>
        <Show when={err()}><div class="sync-err">{err()}</div></Show>

        <p class="sync-note">
          Same passphrase + same folder on each device = your data follows you. Lose the
          passphrase and the data can't be recovered (that's the point — it's end-to-end
          encrypted). Merge is additive in v1: new items sync, deletions don't propagate.
        </p>
      </div>
    </div>
  );
};

export default SyncPage;
