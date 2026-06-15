/**
 * Shields — the content-blocker control (BACKLOG #57). A footer icon with a
 * live blocked-count badge; clicking opens a popover to toggle blocking globally
 * or for the current site, and to refresh the filter lists.
 */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  shieldsRefresh,
  shieldsSetEnabled,
  shieldsSetSite,
  shieldsStatus,
  type ShieldsStatus,
} from "./ipc";
import { activeTab } from "./store";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const Shields: Component = () => {
  const [status, setStatus] = createSignal<ShieldsStatus | null>(null);
  const [open, setOpen] = createSignal(false);
  let timer: number | undefined;

  const poll = () => void shieldsStatus().then(setStatus).catch(() => {});
  onMount(() => {
    poll();
    timer = window.setInterval(poll, 2000);
    onCleanup(() => clearInterval(timer));
  });

  // The active browser tab's host drives the per-site toggle.
  const host = () => {
    const t = activeTab();
    return t && t.kind === "browser" ? hostOf(t.url) : null;
  };
  const siteOn = () => {
    const h = host();
    const s = status();
    return h && s ? !s.sites_off.includes(h) : true;
  };

  const toggleGlobal = () => {
    const s = status();
    if (s) void shieldsSetEnabled(!s.enabled).then(poll);
  };
  const toggleSite = () => {
    const h = host();
    if (h) void shieldsSetSite(h, !siteOn()).then(poll);
  };

  return (
    <div style={{ position: "relative" }}>
      <button classList={{ "icon-btn": true, active: open() }} title="Shields — content blocker" onClick={() => setOpen((v) => !v)}>
        🛡
        <Show when={(status()?.blocked ?? 0) > 0}>
          <span class="shield-badge">{status()!.blocked > 999 ? "999+" : status()!.blocked}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover shields-pop" style={{ bottom: "calc(100% + 8px)", left: "6px" }}>
          <div class="shields-row">
            <span class="shields-label">Shields</span>
            <button classList={{ "shields-toggle": true, on: !!status()?.enabled }} onClick={toggleGlobal}>
              {status()?.enabled ? "On" : "Off"}
            </button>
          </div>
          <Show when={host()}>
            <div class="shields-row">
              <span class="shields-host" title={host()!}>{host()}</span>
              <button classList={{ "shields-toggle": true, on: siteOn() }} onClick={toggleSite}>
                {siteOn() ? "On" : "Off"}
              </button>
            </div>
          </Show>
          <div class="shields-stat">{status()?.blocked ?? 0} blocked this session</div>
          <button class="shields-update" onClick={() => void shieldsRefresh()}>Update filter lists</button>
        </div>
      </Show>
    </div>
  );
};

export default Shields;
