/**
 * Shields popover body (#57) — split from Shields.tsx so the toggles/status UI
 * loads on first open instead of riding in the boot bundle (ADR 0001). The
 * eager side keeps only the footer icon + blocked-count badge.
 */
import { Show, createSignal, createEffect, on, onMount, type Component } from "solid-js";

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
import { settingsWriter } from "./settingsWriter";
import { protectionStatus, protectionMetrics, requestControlsHint } from "./protectionStatus";
import { activeId, activeTab } from "./store";

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname || null : null;
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

  const writer = settingsWriter();
  const [loadError, setLoadError] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  let version = 0;
  const poll = () => {
    if (writer.pending()) return;
    const request = ++version;
    const tabId = activeId();
    void Promise.all([
      shieldsStatus(tabId),
      httpsStatus(),
      trackingStatus(),
      cookiesStatus(),
      permissionsStatus(),
      leanStatus(),
    ])
      .then(([shields, https, tracking, cookies, permissions, lean]) => {
        if (request !== version || tabId !== activeId() || writer.pending()) return;
        setStatus(shields);
        setHttps(https);
        setTracking(tracking);
        setCookies(cookies);
        setBlockPerms(permissions);
        setLean(lean);
        setLoadError(false);
      })
      .catch(() => {
        if (request === version) {
          setStatus(null);
          setLoadError(true);
        }
      });
  };
  onMount(() => visibleInterval(poll, 2000));
  createEffect(
    on(activeId, () => {
      setStatus(null);
      poll();
    }),
  );
  const save = async (label: string, action: () => Promise<unknown>) => {
    version++;
    await writer.run(label, action);
    poll();
  };
  const requestControls = () => status()?.request_controls === true;
  const togglePerms = () => {
    const value = !blockPerms();
    void save("site permissions", () => permissionsSetBlock(value));
  };

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
    if (s) void save("Shields", () => shieldsSetEnabled(!s.enabled));
  };
  const toggleSite = () => {
    const h = host();
    const value = !siteOn();
    if (h) void save("site protection", () => shieldsSetSite(h, value));
  };
  const httpsOn = () => !!https()?.enabled;
  const siteAllowsHttp = () => {
    const h = host();
    const s = https();
    return !!(h && s && s.sites_allow_http.includes(h));
  };
  const toggleHttps = () => {
    const value = !httpsOn();
    void save("HTTPS-only", () => httpsSetEnabled(value));
  };
  const toggleSiteHttp = () => {
    const h = host();
    const value = !siteAllowsHttp();
    if (h) void save("HTTP exception", () => httpsAllowSite(h, value));
  };
  const leanOn = () => {
    const h = host();
    const l = lean();
    return !!(h && l && l.sites_on.includes(h));
  };
  const toggleLean = () => {
    const h = host();
    const value = !leanOn();
    if (h) void save("Lean mode", () => leanSetSite(h, value));
  };
  const clearOnClose = () => {
    const h = host();
    const c = cookies();
    return !!(h && c && c.clear_on_close.includes(h));
  };
  const toggleClearOnClose = () => {
    const h = host();
    const value = !clearOnClose();
    if (h) void save("cookie preference", () => cookiesSetClearOnClose(h, value));
  };

  return (
    <>
      <div class="shield-backdrop" onClick={() => props.onClose()} />
      <div class="glass popover shields-pop footer-pop">
        <div class="shields-stat" role="status">
          {protectionStatus(status(), host() != null, host())}
        </div>
        <Show when={loadError()}>
          <div role="alert" class="settings-feedback">
            Could not load protection settings.<button onClick={poll}>Retry loading</button>
          </div>
        </Show>
        <Show when={writer.error()}>
          <div role="alert" class="settings-feedback">
            {writer.error()}
            <button onClick={() => void Promise.resolve(writer.retry()).then(poll)}>Retry save</button>
          </div>
        </Show>
        <Show when={writer.pending()}>
          <div role="status" class="shields-stat">
            Saving…
          </div>
        </Show>
        <fieldset
          class="shields-fields"
          disabled={writer.pending() || !status()}
          aria-label="Protection controls"
        >
          <div class="shields-row">
            <span class="shields-label">Shields</span>
            <Show
              when={requestControls()}
              fallback={
                <span class="shields-stat">
                  {status()?.backend === "webkit" ? "Native rules" : "Unavailable"}
                </span>
              }
            >
              <button
                role="switch"
                aria-label="Shields"
                aria-checked={!!status()?.enabled}
                classList={{ "shields-toggle": true, on: !!status()?.enabled }}
                onClick={toggleGlobal}
              >
                {status()?.enabled ? "On" : "Off"}
              </button>
            </Show>
          </div>
          <Show when={host() && requestControls()}>
            <div class="shields-row">
              <span class="shields-host" title={host()!}>
                {host()}
              </span>
              <button
                role="switch"
                aria-label="Shields for this site"
                aria-checked={siteOn()}
                classList={{ "shields-toggle": true, on: siteOn() }}
                onClick={toggleSite}
              >
                {siteOn() ? "On" : "Off"}
              </button>
            </div>
          </Show>
          <Show when={status() && !requestControls()}>
            <div class="shields-stat">{requestControlsHint(status())}</div>
          </Show>
          <div class="shields-sep" />
          <div class="shields-row">
            <span class="shields-label">Trackers</span>
            <select
              class="shields-select"
              aria-label="Tracking prevention"
              disabled={!requestControls()}
              title={
                requestControls()
                  ? "Tracking prevention"
                  : "Tracking-prevention levels are available on Windows only"
              }
              value={String(tracking())}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                void save("tracking prevention", () => trackingSetLevel(v));
                e.currentTarget.value = String(tracking());
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
            <button
              role="switch"
              aria-label="HTTPS-only"
              aria-checked={httpsOn()}
              disabled={!requestControls()}
              classList={{ "shields-toggle": true, on: httpsOn() }}
              onClick={toggleHttps}
            >
              {httpsOn() ? "On" : "Off"}
            </button>
          </div>
          <Show when={requestControls() && httpsOn() && host()}>
            <div class="shields-row">
              <span class="shields-host">Allow HTTP here</span>
              <button
                role="switch"
                aria-label="Allow HTTP on this site"
                aria-checked={siteAllowsHttp()}
                classList={{ "shields-toggle": true, on: siteAllowsHttp() }}
                onClick={toggleSiteHttp}
              >
                {siteAllowsHttp() ? "Yes" : "No"}
              </button>
            </div>
          </Show>
          <div class="shields-row">
            <span class="shields-label">Block camera/mic/geo</span>
            <button
              role="switch"
              aria-label="Block camera, microphone and location"
              aria-checked={blockPerms()}
              classList={{ "shields-toggle": true, on: blockPerms() }}
              onClick={togglePerms}
            >
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
              <button
                disabled={!requestControls()}
                role="switch"
                aria-label="Lean mode for this site"
                aria-checked={leanOn()}
                classList={{ "shields-toggle": true, on: leanOn() }}
                onClick={toggleLean}
              >
                {leanOn() ? "On" : "Off"}
              </button>
            </div>
          </Show>
          <div class="shields-stat">{protectionMetrics(status())}</div>
          <button
            class="shields-update"
            onClick={() =>
              void save("filter update", async () => {
                await shieldsRefresh();
                setNotice(
                  status()?.backend === "webkit"
                    ? "Update requested. Restart Flux to apply refreshed native rules."
                    : "Filter update requested.",
                );
              })
            }
          >
            Update filter lists
          </button>
          <Show when={notice()}>
            <div class="shields-stat" role="status">
              {notice()}
            </div>
          </Show>
          <div class="shields-sep" />
          <Show when={host()}>
            <div class="shields-row">
              <span class="shields-host">Clear cookies on close</span>
              <button
                role="switch"
                aria-label="Clear cookies on close"
                aria-checked={clearOnClose()}
                classList={{ "shields-toggle": true, on: clearOnClose() }}
                onClick={toggleClearOnClose}
              >
                {clearOnClose() ? "Yes" : "No"}
              </button>
            </div>
            <button
              class="shields-update"
              onClick={() => {
                const h = host();
                if (h) void save("site cookie cleanup", () => cookiesClearSite(h));
              }}
            >
              Clear cookies for this site
            </button>
          </Show>
          <button class="shields-update" onClick={() => void save("cookie cleanup", cookiesClearAll)}>
            Clear all cookies
          </button>
        </fieldset>
      </div>
    </>
  );
};

export default ShieldsPop;
