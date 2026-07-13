// Window chrome (extracted from App.tsx during the decomposition): the draggable
// title bar, macOS-style traffic lights, and the invisible native-resize grips
// for the borderless window.
import { type Component } from "solid-js";
import { win, type ResizeDir } from "./ipc";
import { activeTab } from "./store";

/** macOS-style traffic lights. Glyphs appear on hover (group-hover). */
export const TrafficLights: Component = () => (
  <div class="traffic">
    <button class="tl tl-close" onClick={() => win.close()} aria-label="Close">✕</button>
    <button class="tl tl-min" onClick={() => win.minimize()} aria-label="Minimize">−</button>
    <button class="tl tl-max" onClick={() => win.toggleMaximize()} aria-label="Zoom">+</button>
  </div>
);

/** Full-width draggable title bar. It lives in its own grid row so no tab
 *  webview can ever cover it — the fix for "nowhere to grab the window". */
export const TitleBar: Component = () => (
  <header class="titlebar" data-tauri-drag-region="deep">
    <TrafficLights />
    <span class="titlebar-title">{activeTab()?.title || "Flux"}</span>
  </header>
);

/** Invisible edge/corner grips that drive native resize on the borderless
 *  window via Tauri's startResizeDragging. */
export const ResizeHandles: Component = () => {
  const grip = (dir: ResizeDir, cls: string) => (
    <div
      class={`resize-h ${cls}`}
      onMouseDown={(e) => {
        e.preventDefault();
        win.startResize(dir);
      }}
    />
  );
  return (
    <>
      {grip("North", "rh-n")}
      {grip("South", "rh-s")}
      {grip("West", "rh-w")}
      {grip("East", "rh-e")}
      {grip("NorthWest", "rh-nw")}
      {grip("NorthEast", "rh-ne")}
      {grip("SouthWest", "rh-sw")}
      {grip("SouthEast", "rh-se")}
    </>
  );
};
