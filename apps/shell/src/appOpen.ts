/**
 * Opening one of the user's own web apps (apps.ts) from Liquid Silk's home dock
 * (start/SilkDock). AppDock keeps an identical inline copy, because it is on the
 * startup path and importing this would add a chunk there (`npm run perf`).
 */
import type { FluxApp } from "./apps";
import { openSitePanel, setFocusedAppId, setOpenAppIds } from "./store";

export const openFluxApp = (app: FluxApp): void => {
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
