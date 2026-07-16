// Shared tab-visual bits used by both the Sidebar and the ContentArea (extracted
// from App.tsx during the decomposition). Favicons are fetched cookielessly +
// cached by Rust per host; the letter glyph shows while loading or when none
// exists.
import { type Component, Show, createEffect } from "solid-js";
import { isStartUrl, type TabMeta } from "./ipc";
import { ensureFavicon, faviconFor } from "./store";

/** Favicon for a bare URL — the app-rail web-panel icons. */
export const PanelIcon: Component<{ url: string }> = (props) => {
  const host = (): string | null => {
    try {
      return new URL(props.url).hostname.replace(/^www\./, "") || null;
    } catch {
      return null;
    }
  };
  createEffect(() => ensureFavicon(host()));
  const data = () => faviconFor(host());
  return (
    <Show
      when={typeof data() === "string"}
      fallback={<span class="fav-letter">{(host() ?? "?").charAt(0).toUpperCase()}</span>}
    >
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

/** Tab/pin icon: the site's real favicon (#21) once fetched, else a letter glyph
 *  (or ⌨/📁 for terminal/files). */
export const Favicon: Component<{ tab: TabMeta }> = (props) => {
  const host = (): string | null => {
    const t = props.tab;
    if (t.kind !== "browser" || isStartUrl(t.url)) return null;
    try {
      return new URL(t.url).hostname.replace(/^www\./, "") || null;
    } catch {
      return t.url.split("/")[2]?.replace(/^www\./, "") ?? null;
    }
  };
  createEffect(() => ensureFavicon(host()));
  const data = () => faviconFor(host());
  const letter = () => {
    const t = props.tab;
    if (t.kind === "terminal") return "⌨";
    if (t.kind === "files") return "📁";
    const h = host() ?? t.url.split("/")[2] ?? t.url;
    return (h.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  };
  return (
    <Show when={typeof data() === "string"} fallback={<span class="fav-letter">{letter()}</span>}>
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

/** Last path segment of a filesystem path (Windows or Unix), for the tab title. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** The tab's semantic-cluster tint (#14), or transparent when unclustered. */
export function clusterColor(tab: TabMeta): string {
  return tab.cluster ? `#${tab.cluster.color.toString(16).padStart(6, "0")}` : "transparent";
}
