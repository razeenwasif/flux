/**
 * App dock (#131) — a vertical launcher pinned to Flux's bottom-right corner for
 * the user's own web apps (Nexus / Prism / Vector / Oracle). Each shows the app's
 * favicon; clicking opens it as a floating pane (AppPane). Same fixed right-edge
 * safe zone as the music bubble.
 */
import { For, Show, createSignal, type Component } from "solid-js";

import { FLUX_APPS, type FluxApp } from "./apps";
import { openAppIds, setOpenAppIds, setFocusedAppId } from "./store";

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
  const open = (id: string) => {
    setOpenAppIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setFocusedAppId(id);
  };
  return (
    <div class="appdock">
      <For each={FLUX_APPS}>
        {(app) => (
          <button
            class="appdock-btn"
            classList={{ on: openAppIds().includes(app.id) }}
            title={`${app.name} — ${app.tagline}`}
            onClick={() => open(app.id)}
          >
            <AppIcon app={app} />
          </button>
        )}
      </For>
    </div>
  );
};

export default AppDock;
