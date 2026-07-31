/**
 * flux://resources — resource monitor (BACKLOG #70). Overall process/free RAM
 * plus a per-tab payload + state view, with one-click reclaim ("sleep background
 * tabs"). NB: browser engines share processes across tabs, so true per-tab CPU
 * isn't cleanly attributable — this shows captured-DOM weight + live/sleeping
 * state, which is what's actionable here. Polls only while open.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";
import { SETTINGS_URL, memStatus, storageUsage, tabDomSizes, type MemInfo, type StorageReport } from "./ipc";
import { visibleInterval } from "./poll";
import { activeId, activeWorkspace, isHibernated, tabs, updateTabTitle } from "./store";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
const mb = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const ResourcesPage: Component<{ onNavigate: (url: string) => void; onSleepBackground: () => void }> = (
  props,
) => {
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  const [sizes, setSizes] = createSignal<Record<number, number>>({});
  // On-disk profile size. RAM is only half the resource story, and the half that
  // grows silently is the one that eventually breaks a site (see storage.rs).
  // Measured once per visit, not on the 2.5s poll — it walks the tree.
  const [store, setStore] = createSignal<StorageReport | null>(null);

  const refresh = () => {
    void memStatus()
      .then(setMem)
      .catch(() => {});
    void tabDomSizes()
      .then((s) => setSizes(Object.fromEntries(s)))
      .catch(() => {});
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Resources");
    visibleInterval(refresh, 2500);
    void storageUsage()
      .then(setStore)
      .catch(() => {});
  });

  // Browser tabs in the active workspace, heaviest first.
  const rows = createMemo(() =>
    tabs()
      .filter(
        (t) => t.kind === "browser" && t.workspace === activeWorkspace() && !t.url.startsWith("flux://"),
      )
      .map((t) => ({ tab: t, size: sizes()[t.id] ?? 0 }))
      .sort((a, b) => b.size - a.size),
  );
  const liveCount = () => rows().filter((r) => !isHibernated(r.tab.id)).length;

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">📊 Resources</div>
        <Show when={mem()}>
          {(m) => (
            <span class="res-mem">
              Flux {Math.round(m().process_mb)} MB · {Math.round(m().available_mb)} MB free (
              {m().available_pct}%)
            </span>
          )}
        </Show>
        <Show when={store()}>
          {(st) => (
            <span classList={{ "res-store": true, warn: st().warn }} title={`Browsing data at ${st().root}`}>
              {st().total_bytes >= 1024 ** 3
                ? `${(st().total_bytes / 1024 ** 3).toFixed(1)} GB on disk`
                : `${Math.round(st().total_bytes / 1048576)} MB on disk`}
            </span>
          )}
        </Show>
        <button class="hist-clear" onClick={() => props.onSleepBackground()}>
          💤 Sleep background tabs
        </button>
      </header>
      {/* Storage that has grown pathological is worth saying out loud: it breaks
          one site at a time, in a way that looks like a bug in that site. */}
      <Show when={store()?.warn}>
        <div class="res-store-warn">
          ⚠ Browsing data on disk has grown unusually large
          {store()!.entries.find((e) => e.warn)
            ? ` (${store()!.entries.find((e) => e.warn)!.label}: ${Math.round(store()!.entries.find((e) => e.warn)!.bytes / 1048576)} MB)`
            : ""}
          . This can crash a single site in every Flux window while private tabs and other browsers load it
          fine.{" "}
          <button class="res-store-link" onClick={() => props.onNavigate(SETTINGS_URL)}>
            Clear browsing data
          </button>
        </div>
      </Show>

      <div class="hist-body">
        <div class="res-note">
          {rows().length} tab{rows().length === 1 ? "" : "s"} in this space · {liveCount()} live. Per-tab CPU
          isn't separable (shared engine processes) — weight below is the captured page payload.
        </div>
        <Show
          when={rows().length > 0}
          fallback={<div class="hist-empty">No web tabs in this workspace.</div>}
        >
          <For each={rows()}>
            {(r) => (
              <div class="hist-row" onClick={() => props.onNavigate(r.tab.url)}>
                <span classList={{ "res-badge": true, sleeping: isHibernated(r.tab.id) }}>
                  {isHibernated(r.tab.id) ? "💤" : "●"}
                </span>
                <span class="hist-text">
                  <span class="hist-name">{r.tab.title || hostOf(r.tab.url) || r.tab.url}</span>
                  <span class="hist-url">{hostOf(r.tab.url) || r.tab.url}</span>
                </span>
                <span class="res-size">{r.size ? mb(r.size) : "—"}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default ResourcesPage;
