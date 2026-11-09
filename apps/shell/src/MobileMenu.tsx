/**
 * The phone's ⋯ menu (ADR 0012): a bottom sheet in place of the desktop
 * sidebar. A row of actions on the current page (forward, share, new tab, the
 * agent), then every Flux destination in a grid. Opened from the bar's ⋯;
 * a tap outside, a drag down, or picking something closes it.
 */
import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, type Component } from "solid-js";

import {
  APPS_URL,
  ARCHIVE_URL,
  BOOKMARKS_URL,
  FEEDS_URL,
  HISTORY_URL,
  NOTEBOOK_URL,
  OMNI_URL,
  RESOURCES_URL,
  SESSIONS_URL,
  SETTINGS_URL,
  SPEEDTEST_URL,
  SYNC_URL,
  TASKS_URL,
  TRAIL_URL,
  VAULT_URL,
  isStartUrl,
  shieldsSetEnabled,
  shieldsSetSite,
  shieldsStatus,
  webviewForward,
  webviewReload,
  type ShieldsStatus,
} from "./ipc";
import { Icon, type IconName } from "./mobileicons";
import { activeTab, openTab } from "./store";
import "./MobileMenu.css";

const DESTINATIONS: { icon: IconName; label: string; url: string }[] = [
  { icon: "book", label: "Notebook", url: NOTEBOOK_URL },
  { icon: "compass", label: "Trail", url: TRAIL_URL },
  { icon: "clock", label: "History", url: HISTORY_URL },
  { icon: "star", label: "Bookmarks", url: BOOKMARKS_URL },
  { icon: "archive", label: "Saved", url: ARCHIVE_URL },
  { icon: "rss", label: "Feeds", url: FEEDS_URL },
  { icon: "layers", label: "Sessions", url: SESSIONS_URL },
  { icon: "check", label: "Tasks", url: TASKS_URL },
  { icon: "sparkle", label: "Omni", url: OMNI_URL },
  { icon: "grid", label: "Apps", url: APPS_URL },
  { icon: "key", label: "Passwords", url: VAULT_URL },
  { icon: "sync", label: "Sync", url: SYNC_URL },
  { icon: "gauge", label: "Resources", url: RESOURCES_URL },
  { icon: "bolt", label: "Speed test", url: SPEEDTEST_URL },
  { icon: "gear", label: "Settings", url: SETTINGS_URL },
];

const MobileMenu: Component<{
  open: boolean;
  onNavigate: (url: string) => void;
  onClose: () => void;
  onAgent: () => void;
  onFiles: () => void;
}> = (props) => {
  const pageUrl = () => {
    const t = activeTab();
    return t?.kind === "browser" && !isStartUrl(t.url) ? t.url : "";
  };
  const [copied, setCopied] = createSignal(false);

  // Shields for this page: what it blocked, and the site's switch. Read each
  // time the sheet opens; a change reloads the page so it takes effect.
  const [shields, setShields] = createSignal<ShieldsStatus | null>(null);
  const loadShields = () => {
    const t = activeTab();
    void shieldsStatus(t?.kind === "browser" ? t.id : null)
      .then(setShields)
      .catch(() => setShields(null));
  };
  createEffect(() => {
    if (props.open) loadShields();
  });
  const host = () => {
    try {
      return new URL(pageUrl()).hostname;
    } catch {
      return "";
    }
  };
  const shieldsUp = () => {
    const s = shields();
    return !!s && s.enabled && !s.sites_off.includes(host());
  };
  const toggleShields = async () => {
    const s = shields();
    const h = host();
    if (!s || !h) return;
    if (!s.enabled) await shieldsSetEnabled(true).catch(() => {});
    else await shieldsSetSite(h, !shieldsUp()).catch(() => {});
    loadShields();
    const t = activeTab();
    if (t?.kind === "browser") void webviewReload(t.id).catch(() => {});
  };

  const go = (url: string) => {
    props.onNavigate(url);
    props.onClose();
  };
  /** The system share sheet, presented natively by the tab plugin: WebKit's
   *  navigator.share showed a cut-off popover inside the app. Copies the link
   *  if the plugin can't. */
  const share = async () => {
    const url = pageUrl();
    if (!url) return;
    props.onClose();
    try {
      await invoke("plugin:flux-webview|share", { url, title: activeTab()?.title || null });
    } catch {
      await navigator.clipboard?.writeText(url).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  // Drag the sheet down by its grabber or header to dismiss it.
  let y0 = 0;
  const [dy, setDy] = createSignal(0);

  const actions = (): { icon: IconName; label: string; run: () => void; off?: boolean }[] => [
    {
      icon: "forward",
      label: "Forward",
      off: !pageUrl(),
      run: () => {
        const t = activeTab();
        if (t?.kind === "browser") void webviewForward(t.id).catch(() => {});
        props.onClose();
      },
    },
    {
      icon: copied() ? "link" : "share",
      label: copied() ? "Copied" : "Share",
      off: !pageUrl(),
      run: () => void share(),
    },
    {
      icon: "plus",
      label: "New tab",
      run: () => {
        void openTab("browser");
        props.onClose();
      },
    },
    {
      icon: "sparkle",
      label: "Agent",
      run: () => {
        props.onClose();
        props.onAgent();
      },
    },
  ];

  return (
    <>
      <Show when={props.open}>
        <div class="mm-backdrop" onClick={() => props.onClose()} />
      </Show>
      <nav
        class="mobile-menu"
        classList={{ open: props.open }}
        style={dy() ? { transform: `translateY(${dy()}px)`, transition: "none" } : undefined}
        aria-hidden={!props.open}
      >
        <div
          class="mm-handle"
          onTouchStart={(e) => (y0 = e.touches[0]!.clientY)}
          onTouchMove={(e) => setDy(Math.max(0, e.touches[0]!.clientY - y0))}
          onTouchEnd={() => {
            if (dy() > 80) props.onClose();
            setDy(0);
          }}
        >
          <span class="mm-grabber" />
          <Show when={pageUrl()}>
            <div class="mm-page">
              <span class="mm-page-title">{activeTab()?.title || pageUrl()}</span>
              <span class="mm-page-url">{pageUrl()}</span>
            </div>
          </Show>
        </div>
        <Show when={pageUrl() ? shields() : null}>
          {(s) => (
            <button class="mm-shield" classList={{ off: !shieldsUp() }} onClick={() => void toggleShields()}>
              <span class="mm-shield-ico">
                <Icon name="shield" size={20} />
              </span>
              <span class="mm-shield-main">
                <span class="mm-shield-title">
                  {!s().enabled
                    ? "Shields are off everywhere"
                    : shieldsUp()
                      ? "Shields up"
                      : `Shields down for ${host()}`}
                </span>
                <span class="mm-shield-sub">
                  {shieldsUp()
                    ? `${s().page_blocked} ad${s().page_blocked === 1 ? "" : "s"} and trackers blocked on this page`
                    : "Ads and trackers load here"}
                </span>
              </span>
              <span class="mm-switch" classList={{ on: shieldsUp() }} aria-hidden="true" />
            </button>
          )}
        </Show>
        <div class="mm-actions">
          <For each={actions()}>
            {(a) => (
              <button class="mm-action" disabled={a.off} onClick={a.run}>
                <Icon name={a.icon} size={22} />
                <span>{a.label}</span>
              </button>
            )}
          </For>
        </div>
        <div class="mm-grid">
          <button
            class="mm-dest"
            onClick={() => {
              props.onClose();
              props.onFiles();
            }}
          >
            <span class="mm-dest-ico">
              <Icon name="folder" size={21} />
            </span>
            <span class="mm-dest-label">Files</span>
          </button>
          <For each={DESTINATIONS}>
            {(d) => (
              <button class="mm-dest" onClick={() => go(d.url)}>
                <span class="mm-dest-ico">
                  <Icon name={d.icon} size={21} />
                </span>
                <span class="mm-dest-label">{d.label}</span>
              </button>
            )}
          </For>
        </div>
      </nav>
    </>
  );
};

export default MobileMenu;
