/**
 * A site's own icon on the new tab's tiles (Shortcuts, Top sites): the biggest
 * one it offers, from Rust's `site_icon` — a tab's 16 px favicon would blur at
 * tile size. The tile's letters show while it loads, or for a site without one.
 */
import { invoke } from "@tauri-apps/api/core";
import { type Component, type JSX, Show, createEffect } from "solid-js";
import { createStore } from "solid-js/store";

// Per host, so a tile only re-renders when its own icon lands.
const [icons, setIcons] = createStore<Record<string, string | null>>({});
const inflight = new Set<string>();

function ensure(host: string | null): void {
  if (!host || host in icons || inflight.has(host)) return;
  inflight.add(host);
  invoke<string | null>("site_icon", { host })
    .then((d) => setIcons(host, d ?? null))
    .catch(() => setIcons(host, null))
    .finally(() => inflight.delete(host));
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") || null : null;
  } catch {
    return null;
  }
};

const SiteIcon: Component<{ url: string; fallback: JSX.Element }> = (props) => {
  const host = () => hostOf(props.url);
  createEffect(() => ensure(host()));
  const src = () => {
    const h = host();
    return h ? icons[h] : undefined;
  };
  return (
    <Show when={src()} fallback={props.fallback}>
      {(s) => (
        <img
          class="start-tile-icon"
          src={s()}
          alt=""
          draggable={false}
          // An image the engine can't draw falls back to the letters.
          onError={() => {
            const h = host();
            if (h) setIcons(h, null);
          }}
        />
      )}
    </Show>
  );
};

export default SiteIcon;
