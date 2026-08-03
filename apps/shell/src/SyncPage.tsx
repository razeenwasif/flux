/**
 * flux://sync — E2E-encrypted sync (BACKLOG #62). Account-optional, local-first:
 * point Flux at a folder your devices already sync (Dropbox / Syncthing / iCloud
 * / a USB stick) and it writes ONE end-to-end-encrypted file there. Bookmarks,
 * sessions, and browsing history merge across devices, deletions propagate via
 * tombstones, and an optional timer keeps it hands-off; the passphrase never
 * leaves your machine, and whatever syncs the folder only ever sees ciphertext.
 */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  onSyncDone,
  onSyncError,
  syncLock,
  syncNow,
  syncSetAuto,
  syncSetFolder,
  syncStatus,
  syncUnlock,
  type SyncReport,
  type SyncStatus,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

/**
 * What actually happened, in words that distinguish the three outcomes.
 *
 * This used to say "merged 0 bookmarks, 0 sessions, 0 history entries" whenever
 * nothing came *in* — which is the correct and expected result on the first
 * device, and on any device that's already up to date. It read as failure in
 * both cases. The report counts the pull; the push always happens, so say so.
 */
const summary = (r: SyncReport) => {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const sent = `${plural(r.sent_bookmarks, "bookmark")}, ${plural(r.sent_sessions, "session")} and ${plural(r.sent_history, "history entry").replace("entrys", "entries")}`;
  const got = r.bookmarks_added + r.sessions_added + r.history_added;
  if (!r.had_remote) {
    // First device into an empty folder: nothing to receive, everything to give.
    return `no data from other devices yet — published ${sent}. Set the same folder and passphrase on your other device.`;
  }
  if (got === 0) return `already up to date — published ${sent}.`;
  return `received ${plural(r.bookmarks_added, "bookmark")}, ${plural(r.sessions_added, "session")} and ${plural(r.history_added, "history entry").replace("entrys", "entries")}; published ${sent}.`;
};

const SyncPage: Component = () => {
  const [status, setStatus] = createSignal<SyncStatus | null>(null);
  const [folder, setFolder] = createSignal("");
  const [pass, setPass] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const refresh = () =>
    void syncStatus()
      .then((s) => {
        setStatus(s);
        setFolder(s.folder ?? "");
      })
      .catch(() => {});
  onMount(async () => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Sync");
    refresh();
    // Reflect background (auto) syncs live.
    const offDone = await onSyncDone((r) => {
      setErr(null);
      setMsg(`Auto-synced — ${summary(r)}`);
      refresh();
    });
    const offErr = await onSyncError((e) => setErr(`Auto-sync: ${e}`));
    onCleanup(() => {
      offDone();
      offErr();
    });
  });

  const saveFolder = async () => {
    await syncSetFolder(folder().trim());
    setErr(null);
    setMsg(null);
    refresh();
  };
  const unlock = async () => {
    setErr(null);
    setMsg(null);
    try {
      await syncUnlock(pass());
      setPass("");
      refresh();
    } catch (e) {
      setErr(String(e));
    }
  };
  const lock = async () => {
    await syncLock();
    refresh();
  };
  const sync = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await syncNow();
      setMsg(`Synced — ${summary(r)}`);
      refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleAuto = async () => {
    const next = !status()?.auto;
    await syncSetAuto(next).catch(() => {});
    refresh();
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
          End-to-end encrypted, no account. Point Flux at a folder your devices already sync (Dropbox,
          Syncthing, iCloud Drive, a USB stick…). Flux writes one encrypted file there; your passphrase never
          leaves this device, and the sync service only ever sees ciphertext.{" "}
          <b>Bookmarks, saved sessions, and browsing history</b> merge across devices, and deletions
          propagate.
        </p>

        <label class="sync-label">Sync folder</label>
        <div class="sync-row">
          <input
            class="sync-input"
            placeholder="/path/to/Dropbox/Flux  (or a Windows path)"
            value={folder()}
            onInput={(e) => setFolder(e.currentTarget.value)}
          />
          <button class="sync-btn" onClick={() => void saveFolder()}>
            Set
          </button>
        </div>

        <label class="sync-label">Passphrase</label>
        <Show
          when={status()?.unlocked}
          fallback={
            <div class="sync-row">
              <input
                class="sync-input"
                type="password"
                placeholder="Shared passphrase (same on every device)"
                value={pass()}
                onInput={(e) => setPass(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void unlock();
                }}
              />
              <button class="sync-btn" disabled={!status()?.folder} onClick={() => void unlock()}>
                Unlock
              </button>
            </div>
          }
        >
          <div class="sync-row">
            <span class="sync-unlocked">🔓 Unlocked on this device</span>
            <button class="sync-btn" onClick={() => void lock()}>
              Lock
            </button>
          </div>
        </Show>

        <button class="sync-now" disabled={!status()?.unlocked || busy()} onClick={() => void sync()}>
          {busy() ? "Syncing…" : "🔄 Sync now"}
        </button>

        <Show when={status()?.unlocked}>
          <div class="sync-row sync-auto">
            <span class="sync-auto-label">
              Auto-sync
              <span class="sync-auto-hint">re-sync every few minutes while unlocked</span>
            </span>
            <button
              classList={{ "shields-toggle": true, on: !!status()?.auto }}
              onClick={() => void toggleAuto()}
            >
              {status()?.auto ? "On" : "Off"}
            </button>
          </div>
        </Show>

        <Show when={msg()}>
          <div class="sync-msg">{msg()}</div>
        </Show>
        <Show when={err()}>
          <div class="sync-err">{err()}</div>
        </Show>

        <p class="sync-note">
          Same passphrase + same folder on each device = your data follows you. Lose the passphrase and the
          data can't be recovered (that's the point — it's end-to-end encrypted). Deletions propagate via
          tombstones; history syncs your most-frequent pages (capped so the encrypted file stays small).
        </p>
      </div>
    </div>
  );
};

export default SyncPage;
