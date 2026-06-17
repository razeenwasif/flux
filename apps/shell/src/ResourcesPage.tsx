/**
 * flux://resources — resource monitor (BACKLOG #70). Overall process/free RAM
 * plus a per-tab payload + state view, with one-click reclaim ("sleep background
 * tabs"). NB: browser engines share processes across tabs, so true per-tab CPU
 * isn't cleanly attributable — this shows captured-DOM weight + live/sleeping
 * state, which is what's actionable here. Polls only while open.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { memStatus, tabDomSizes, type MemInfo } from "./ipc";
import { activeId, activeWorkspace, isHibernated, tabs, updateTabTitle } from "./store";

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; }
}
const mb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const ResourcesPage: Component<{ onNavigate: (url: string) => void; onSleepBackground: () => void }> = (props) => {
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  const [sizes, setSizes] = createSignal<Record<number, number>>({});

  const refresh = () => {
    void memStatus().then(setMem).catch(() => {});
    void tabDomSizes().then((s) => setSizes(Object.fromEntries(s))).catch(() => {});
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Resources");
    refresh();
    const t = window.setInterval(refresh, 2500);
    onCleanup(() => clearInterval(t));
  });

  // Browser tabs in the active workspace, heaviest first.
  const rows = createMemo(() =>
    tabs()
      .filter((t) => t.kind === "browser" && t.workspace === activeWorkspace() && !t.url.startsWith("flux://"))
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
              Flux {Math.round(m().process_mb)} MB · {Math.round(m().available_mb)} MB free ({m().available_pct}%)
            </span>
          )}
        </Show>
        <button class="hist-clear" onClick={() => props.onSleepBackground()}>💤 Sleep background tabs</button>
      </header>

      <div class="hist-body">
        <div class="res-note">
          {rows().length} tab{rows().length === 1 ? "" : "s"} in this space · {liveCount()} live.
          Per-tab CPU isn't separable (shared engine processes) — weight below is the captured page payload.
        </div>
        <Show when={rows().length > 0} fallback={<div class="hist-empty">No web tabs in this workspace.</div>}>
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
