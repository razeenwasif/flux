/**
 * flux://sessions — named sessions (BACKLOG #47). Save the current tabs as a
 * named bundle, then restore them later (opens every tab). DOM-rendered in the
 * content card like flux://history. Distinct from the always-on session restore.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  sessionDelete,
  sessionSave,
  sessionsList,
  snapshotsList,
  type DaySnapshot,
  type SavedSession,
} from "./ipc";
import { activeId, restoreSession, restoreSnapshot, updateTabTitle } from "./store";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// A friendly label for an auto-snapshot day relative to today.
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const SessionsPage: Component<{ onNavigate: (url: string) => void }> = () => {
  const [sessions, setSessions] = createSignal<SavedSession[]>([]);
  const [snaps, setSnaps] = createSignal<DaySnapshot[]>([]);
  const [name, setName] = createSignal("");
  const [note, setNote] = createSignal("");

  const load = () => {
    void sessionsList()
      .then(setSessions)
      .catch(() => setSessions([]));
    void snapshotsList()
      .then(setSnaps)
      .catch(() => setSnaps([]));
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Sessions");
    load();
  });

  const save = async () => {
    const s = await sessionSave(name().trim() || "Untitled").catch(() => null);
    setName("");
    if (s) setNote(`Saved “${s.name}” · ${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`);
    load();
  };
  const restore = async (s: SavedSession) => {
    const n = await restoreSession(s.id);
    setNote(`Reopened ${n} tab${n === 1 ? "" : "s"} from “${s.name}”`);
  };
  const remove = (s: SavedSession) => void sessionDelete(s.id).then(load);
  const reopenDay = async (snap: DaySnapshot) => {
    const n = await restoreSnapshot(snap.day);
    setNote(`Reopened ${n} tab${n === 1 ? "" : "s"} from ${dayLabel(snap.captured_ms)}`);
  };

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🗃 Sessions</div>
        <input
          class="hist-search"
          placeholder="Name this session…"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button class="hist-clear" onClick={() => void save()}>
          ＋ Save current tabs
        </button>
      </header>

      <Show when={note()}>{(n) => <div class="bm-flash">{n()}</div>}</Show>

      <div class="hist-body">
        <Show when={snaps().length > 0}>
          <div class="hist-group">
            <div class="hist-day">Recent days · auto-saved, reopen where you left off</div>
            <For each={snaps()}>
              {(snap) => (
                <div class="bm-folder">
                  <span class="bm-folder-name">🕒 {dayLabel(snap.captured_ms)}</span>
                  <span class="hist-day" style={{ "margin-left": "auto" }}>
                    {snap.tabs.length} tab{snap.tabs.length === 1 ? "" : "s"} · {when(snap.captured_ms)}
                  </span>
                  <button
                    class="bm-open-group"
                    disabled={snap.tabs.length === 0}
                    onClick={() => void reopenDay(snap)}
                  >
                    ↺ Reopen
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show
          when={sessions().length > 0}
          fallback={
            <div class="hist-empty">No saved sessions yet — name your current set of tabs and save it.</div>
          }
        >
          <For each={sessions()}>
            {(s) => (
              <div class="hist-group">
                <div class="bm-folder">
                  <span class="bm-folder-name">🗃 {s.name}</span>
                  <span class="hist-day" style={{ "margin-left": "auto" }}>
                    {s.tabs.length} · {when(s.created_ms)}
                  </span>
                  <button class="bm-open-group" onClick={() => void restore(s)}>
                    ↺ Reopen
                  </button>
                  <button
                    class="hist-forget"
                    title="Delete session"
                    style={{ opacity: 1 }}
                    onClick={() => remove(s)}
                  >
                    ✕
                  </button>
                </div>
                <For each={s.tabs.slice(0, 8)}>
                  {(t) => (
                    <div class="hist-row" style={{ "padding-left": "10px" }}>
                      <span class="hist-text">
                        <span class="hist-name">{t.title || t.url}</span>
                        <span class="hist-url">{t.url}</span>
                      </span>
                    </div>
                  )}
                </For>
                <Show when={s.tabs.length > 8}>
                  <div class="hist-url" style={{ "padding-left": "10px" }}>
                    +{s.tabs.length - 8} more
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default SessionsPage;
