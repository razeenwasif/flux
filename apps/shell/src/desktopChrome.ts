import { lazy } from "solid-js";

// Every component in this registry is explicitly preloaded on desktop.
// The performance gate reads these literal imports as additional startup roots.
const desktopChrome = {
  Sidebar: lazy(() => import("./Sidebar")),
  AppDock: lazy(() => import("./AppDock")),
  WebPanelPane: lazy(() => import("./WebPanelPane")),
  TerminalColumn: lazy(() => import("./TerminalColumn")),
};
export const { Sidebar, AppDock, WebPanelPane, TerminalColumn } = desktopChrome;
export function preloadDesktopChrome() {
  for (const component of Object.values(desktopChrome)) void component.preload();
}
