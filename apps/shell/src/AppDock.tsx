/**
 * App dock (#131) — a vertical launcher pinned to Flux's bottom-right corner for
 * the user's own web apps (Nexus / Prism / Vector / Oracle). Each shows the app's
 * favicon; clicking opens it as a floating pane (AppPane) — or, for sites that
 * block cross-origin framing, in the native-webview side panel (#48). Same fixed
 * right-edge safe zone as the music bubble.
 *
 * Collapsible since #177. Five 44px buttons is a permanent 250px stripe down the
 * right edge for something used a few times a day, so the rail folds into a
 * single handle. Two consequences worth naming:
 *
 *   * **The handle has to carry the open-app state.** Expanded, a running app is
 *     shown by the button's `.on` ring. Collapsed, that disappears — so the
 *     handle shows the count instead. A control that hides live state is worse
 *     than the stripe it saved.
 *   * **Collapsing frees screen, not layout.** The dock is `position: fixed`, so
 *     nothing re-tiles: unlike the bookmark bar or the editor column, there is
 *     no card to grow into the space.
 */
import { For, Show, createSignal, type Component } from "solid-js";

import { FLUX_APPS, type FluxApp } from "./apps";
import {
  appDockOpen,
  openAppIds,
  openSitePanel,
  openTimetable,
  setAppDockOpen,
  setOpenAppIds,
  setFocusedAppId,
} from "./store";

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
    // Sites that refuse cross-origin framing can't live in the pane's iframe.
    // The web panel (#48) is a real OS webview, so they load there — and it
    // keeps them glanceable beside a tab rather than taking one over.
    if (app.noFrame) {
      void openSitePanel({ url: app.url, host: app.host, title: app.name }).catch(() => {});
      return;
    }
    setOpenAppIds((ids) => (ids.includes(app.id) ? ids : [...ids, app.id]));
    setFocusedAppId(app.id);
  };
  /** Apps currently open, so the collapsed handle can still report them. */
  const openCount = () => openAppIds().length;

  return (
    <div class="appdock" classList={{ collapsed: !appDockOpen() }}>
      {/* The items are always rendered — collapsing is a CSS transition, not an
          unmount, so an open app's `.on` ring is intact the moment you reopen
          and nothing has to be re-measured. `inert` keeps the hidden buttons out
          of tab order and off the accessibility tree, which `visibility` alone
          would not do. */}
      <div class="appdock-items" inert={!appDockOpen() || undefined}>
        {/* Timetable — Flux's own week view, pinned where Google Calendar used to
            be. A subscribed uni .ics renders here natively instead of loading
            Google in a panel. */}
        <button class="appdock-btn" title="Timetable — your week at a glance" onClick={() => openTimetable()}>
          <span class="appdock-glyph">🗓</span>
        </button>
        <For each={FLUX_APPS}>
          {(app) => (
            <button
              class="appdock-btn"
              classList={{ on: openAppIds().includes(app.id) }}
              title={
                app.noFrame
                  ? `${app.name} — ${app.tagline} (opens in the side panel: this site blocks embedding)`
                  : `${app.name} — ${app.tagline}`
              }
              onClick={() => open(app)}
            >
              <AppIcon app={app} />
            </button>
          )}
        </For>
      </div>
      <button
        class="appdock-btn appdock-toggle"
        aria-expanded={appDockOpen()}
        aria-label={appDockOpen() ? "Collapse app dock" : "Expand app dock"}
        title={
          appDockOpen()
            ? "Collapse the app dock"
            : openCount() > 0
              ? `Your apps — ${openCount()} open`
              : "Your apps"
        }
        onClick={() => setAppDockOpen(!appDockOpen())}
      >
        <span class="appdock-glyph">{appDockOpen() ? "›" : "⌘"}</span>
        {/* Only while collapsed: expanded, each button shows its own state. */}
        <Show when={!appDockOpen() && openCount() > 0}>
          <span class="appdock-count">{openCount()}</span>
        </Show>
      </button>
    </div>
  );
};

export default AppDock;
