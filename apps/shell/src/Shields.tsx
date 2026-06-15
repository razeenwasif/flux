/**
 * Shields — the content-blocker control (BACKLOG #57). A footer icon with a
 * live blocked-count badge; clicking opens a popover to toggle blocking globally
 * or for the current site, and to refresh the filter lists.
 */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  cookiesClearAll,
  cookiesClearSite,
  cookiesSetClearOnClose,
  cookiesStatus,
  httpsAllowSite,
  httpsSetEnabled,
  httpsStatus,
  permissionsSetBlock,
  permissionsStatus,
  shieldsRefresh,
  shieldsSetEnabled,
  shieldsSetSite,
  shieldsStatus,
  trackingSetLevel,
  trackingStatus,
  type CookieStatus,
  type HttpsStatus,
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
  const [https, setHttps] = createSignal<HttpsStatus | null>(null);
  const [tracking, setTracking] = createSignal(2);
  const [cookies, setCookies] = createSignal<CookieStatus | null>(null);
  const [blockPerms, setBlockPerms] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let timer: number | undefined;

  const poll = () => {
    void shieldsStatus().then(setStatus).catch(() => {});
    void httpsStatus().then(setHttps).catch(() => {});
    void trackingStatus().then(setTracking).catch(() => {});
    void cookiesStatus().then(setCookies).catch(() => {});
    void permissionsStatus().then(setBlockPerms).catch(() => {});
  };

  const togglePerms = () => void permissionsSetBlock(!blockPerms()).then(poll);
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

  const httpsOn = () => !!https()?.enabled;
  // Whether this site is allowlisted to stay on HTTP.
  const siteAllowsHttp = () => {
    const h = host();
    const s = https();
    return !!(h && s && s.sites_allow_http.includes(h));
  };
  const toggleHttps = () => void httpsSetEnabled(!httpsOn()).then(poll);
  const toggleSiteHttp = () => {
    const h = host();
    if (h) void httpsAllowSite(h, !siteAllowsHttp()).then(poll);
  };

  const clearOnClose = () => {
    const h = host();
    const c = cookies();
    return !!(h && c && c.clear_on_close.includes(h));
  };
  const toggleClearOnClose = () => {
    const h = host();
    if (h) void cookiesSetClearOnClose(h, !clearOnClose()).then(poll);
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
          <div class="shields-sep" />
          <div class="shields-row">
            <span class="shields-label">Trackers</span>
            <select
              class="shields-select"
              value={String(tracking())}
              onChange={(e) => { const v = Number(e.currentTarget.value); setTracking(v); void trackingSetLevel(v); }}
            >
              <option value="0">Off</option>
              <option value="1">Basic</option>
              <option value="2">Balanced</option>
              <option value="3">Strict</option>
            </select>
          </div>
          <div class="shields-row">
            <span class="shields-label">HTTPS-only</span>
            <button classList={{ "shields-toggle": true, on: httpsOn() }} onClick={toggleHttps}>
              {httpsOn() ? "On" : "Off"}
            </button>
          </div>
          <Show when={httpsOn() && host()}>
            <div class="shields-row">
              <span class="shields-host">Allow HTTP here</span>
              <button classList={{ "shields-toggle": true, on: siteAllowsHttp() }} onClick={toggleSiteHttp}>
                {siteAllowsHttp() ? "Yes" : "No"}
              </button>
            </div>
          </Show>
          <div class="shields-row">
            <span class="shields-label">Block camera/mic/geo</span>
            <button classList={{ "shields-toggle": true, on: blockPerms() }} onClick={togglePerms}>
              {blockPerms() ? "On" : "Off"}
            </button>
          </div>
          <div class="shields-stat">{status()?.blocked ?? 0} blocked this session</div>
          <button class="shields-update" onClick={() => void shieldsRefresh()}>Update filter lists</button>
          <div class="shields-sep" />
          <Show when={host()}>
            <div class="shields-row">
              <span class="shields-host">Clear cookies on close</span>
              <button classList={{ "shields-toggle": true, on: clearOnClose() }} onClick={toggleClearOnClose}>
                {clearOnClose() ? "Yes" : "No"}
              </button>
            </div>
            <button class="shields-update" onClick={() => { const h = host(); if (h) void cookiesClearSite(h); }}>
              Clear cookies for this site
            </button>
          </Show>
          <button class="shields-update" onClick={() => void cookiesClearAll()}>Clear all cookies</button>
        </div>
      </Show>
    </div>
  );
};

export default Shields;
