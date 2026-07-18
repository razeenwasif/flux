/**
 * Shields popover body (#57) — split from Shields.tsx so the toggles/status UI
 * loads on first open instead of riding in the boot bundle (ADR 0001). The
 * eager side keeps only the footer icon + blocked-count badge.
 */
import { Show, createSignal, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  cookiesClearAll,
  cookiesClearSite,
  cookiesSetClearOnClose,
  cookiesStatus,
  httpsAllowSite,
  httpsSetEnabled,
  httpsStatus,
  leanSetSite,
  leanStatus,
  PERMISSIONS_URL,
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
  type LeanStatus,
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

const ShieldsPop: Component<{ onNavigate: (url: string) => void; onClose: () => void }> = (props) => {
  const [status, setStatus] = createSignal<ShieldsStatus | null>(null);
  const [https, setHttps] = createSignal<HttpsStatus | null>(null);
  const [tracking, setTracking] = createSignal(2);
  const [cookies, setCookies] = createSignal<CookieStatus | null>(null);
  const [blockPerms, setBlockPerms] = createSignal(false);
  const [lean, setLean] = createSignal<LeanStatus | null>(null);

  const poll = () => {
    void shieldsStatus()
      .then(setStatus)
      .catch(() => {});
    void httpsStatus()
      .then(setHttps)
      .catch(() => {});
    void trackingStatus()
      .then(setTracking)
      .catch(() => {});
    void cookiesStatus()
      .then(setCookies)
      .catch(() => {});
    void permissionsStatus()
      .then(setBlockPerms)
      .catch(() => {});
    void leanStatus()
      .then(setLean)
      .catch(() => {});
  };
  onMount(() => visibleInterval(poll, 2000));

  const togglePerms = () => void permissionsSetBlock(!blockPerms()).then(poll);

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
  const leanOn = () => {
    const h = host();
    const l = lean();
    return !!(h && l && l.sites_on.includes(h));
  };
  const toggleLean = () => {
    const h = host();
    if (h) void leanSetSite(h, !leanOn()).then(poll);
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
    <>
      <div class="shield-backdrop" onClick={() => props.onClose()} />
      <div class="glass popover shields-pop footer-pop">
        <div class="shields-row">
          <span class="shields-label">Shields</span>
          <button classList={{ "shields-toggle": true, on: !!status()?.enabled }} onClick={toggleGlobal}>
            {status()?.enabled ? "On" : "Off"}
          </button>
        </div>
        <Show when={host()}>
          <div class="shields-row">
            <span class="shields-host" title={host()!}>
              {host()}
            </span>
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
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setTracking(v);
              void trackingSetLevel(v);
            }}
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
        <button
          class="shields-update"
          onClick={() => {
            props.onClose();
            props.onNavigate(PERMISSIONS_URL);
          }}
        >
          Manage site permissions…
        </button>
        <Show when={host()}>
          <div class="shields-row">
            <span
              class="shields-host"
              title="Block heavy third-party scripts (analytics, A/B, chat widgets) on this site. May break live chat / logins."
            >
              Lean mode here
            </span>
            <button classList={{ "shields-toggle": true, on: leanOn() }} onClick={toggleLean}>
              {leanOn() ? "On" : "Off"}
            </button>
          </div>
        </Show>
        <div class="shields-stat">
          {status()?.blocked ?? 0} blocked this session
          <Show when={status()}>
            {" · "}
            {status()!.rules_fired} rules active · {status()!.cache_hit_pct}% cache hits
          </Show>
        </div>
        <button class="shields-update" onClick={() => void shieldsRefresh()}>
          Update filter lists
        </button>
        <div class="shields-sep" />
        <Show when={host()}>
          <div class="shields-row">
            <span class="shields-host">Clear cookies on close</span>
            <button classList={{ "shields-toggle": true, on: clearOnClose() }} onClick={toggleClearOnClose}>
              {clearOnClose() ? "Yes" : "No"}
            </button>
          </div>
          <button
            class="shields-update"
            onClick={() => {
              const h = host();
              if (h) void cookiesClearSite(h);
            }}
          >
            Clear cookies for this site
          </button>
        </Show>
        <button class="shields-update" onClick={() => void cookiesClearAll()}>
          Clear all cookies
        </button>
      </div>
    </>
  );
};

export default ShieldsPop;
