/**
 * An app's favicon with a tinted-monogram fallback — the app dock's, the pane
 * title bar's and Liquid Silk's home dock's. Its own module so the home dock
 * (a lazy chunk) doesn't pull AppDock out of its startup chunk.
 */
import { Show, createSignal, type Component } from "solid-js";

import type { FluxApp } from "./apps";

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
