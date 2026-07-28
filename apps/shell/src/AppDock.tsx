/**
 * App dock (#131) — a vertical launcher pinned to Flux's bottom-right corner for
 * the user's own web apps (Nexus / Prism / Vector / Oracle). Each shows the app's
 * favicon; clicking opens it as a floating pane (AppPane) — or, for sites that
 * block cross-origin framing, as a tab. Same fixed right-edge safe zone as the
 * music bubble.
 */
import { For, Show, createSignal, type Component } from "solid-js";

import { FLUX_APPS, type FluxApp } from "./apps";
import { openAppIds, openTab, setOpenAppIds, setFocusedAppId } from "./store";

/** Favicon with a tinted-monogram fallback (shared with the pane title bar). */
export const AppIcon: Component<{ app: FluxApp; size?: number }> = (props) => {
  const [failed, setFailed] = createSignal(false);
  const px = `${props.size ?? 22}px`;
  // Prefer a bundled icon (the user's own app art); else the live favicon; else a monogram.
  const src = () => props.app.iconAsset ?? `https://${props.app.host}/favicon.ico`;
  return (
    <Show
      when={!failed()}
      fallback={
        <span class="appdock-mono" style={{ background: props.app.tint, width: px, height: px }}>
          {props.app.name[0]}
        </span>
      }
    >
      <img
        class="appdock-fav"
        style={{ width: px, height: px }}
        src={src()}
        alt=""
        onError={() => setFailed(true)}
      />
    </Show>
  );
};

const AppDock: Component = () => {
  const open = (app: FluxApp) => {
    // Sites that refuse cross-origin framing can't live in the pane's iframe —
    // send them to a tab (a native webview), where they load normally.
    if (app.noFrame) {
      void openTab("browser", app.url).catch(() => {});
      return;
    }
    setOpenAppIds((ids) => (ids.includes(app.id) ? ids : [...ids, app.id]));
    setFocusedAppId(app.id);
  };
  return (
    <div class="appdock">
      <For each={FLUX_APPS}>
        {(app) => (
          <button
            class="appdock-btn"
            classList={{ on: openAppIds().includes(app.id) }}
            title={
              app.noFrame
                ? `${app.name} — ${app.tagline} (opens in a tab: this site blocks embedding)`
                : `${app.name} — ${app.tagline}`
            }
            onClick={() => open(app)}
          >
            <AppIcon app={app} />
          </button>
        )}
      </For>
    </div>
  );
};

export default AppDock;
