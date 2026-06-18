/**
 * flux://apps — installed site-apps / PWAs (BACKLOG #42). Each opens in its own
 * chrome-less OS window (just the page). Install from ⌘K "Install this site as
 * app"; relaunch or remove them here.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { pwaLaunch, pwaList, pwaRemove, type PwaApp } from "./ipc";
import { activeId, updateTabTitle } from "./store";

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function letter(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

const AppsPage: Component = () => {
  const [apps, setApps] = createSignal<PwaApp[]>([]);
  const refresh = () => void pwaList().then((a) => setApps(a ?? [])).catch(() => {});
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Apps");
    refresh();
  });
  const remove = (id: number) => void pwaRemove(id).then(refresh);

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🧩 Installed apps</div>
        <span class="res-mem">{apps().length} app{apps().length === 1 ? "" : "s"}</span>
      </header>
      <div class="hist-body">
        <div class="res-note">
          Sites installed as apps open in their own window (no tabs/chrome). Install one
          with ⌘K → <b>Install this site as app</b> while on a site.
        </div>
        <Show when={apps().length > 0} fallback={<div class="hist-empty">No installed apps yet.</div>}>
          <div class="apps-grid">
            <For each={apps()}>
              {(a) => (
                <div class="app-tile" onClick={() => void pwaLaunch(a.id)} title={a.url}>
                  <span class="app-ico">{letter(a.name)}</span>
                  <span class="app-name">{a.name || hostOf(a.url)}</span>
                  <span class="app-host">{hostOf(a.url)}</span>
                  <button class="app-del" title="Remove app" onClick={(e) => { e.stopPropagation(); remove(a.id); }}>✕</button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default AppsPage;
