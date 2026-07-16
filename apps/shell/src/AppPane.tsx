/**
 * App pane (#131) — a movable, resizable floating window that embeds one of the
 * user's pinned web apps in an iframe. Multiple can be open (they cascade); the
 * focused one sits on top and is the app Gemma assists with. Rendered while open;
 * App hides the tab webview so the (HTML) pane is visible above it.
 */
import { createSignal, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import type { FluxApp } from "./apps";
import { AppIcon } from "./AppDock";
import { focusedAppId, setFocusedAppId, setOpenAppIds, openTab } from "./store";

const AppPane: Component<{ app: FluxApp; index: number }> = (props) => {
  const [pos, setPos] = createSignal({ x: 120, y: 90 });
  const [size, setSize] = createSignal({ w: 920, h: 640 });
  const [dragging, setDragging] = createSignal(false); // disables iframe pointer-events mid-gesture

  onMount(() => {
    const w = Math.min(920, window.innerWidth - 120);
    const h = Math.min(640, window.innerHeight - 140);
    setSize({ w, h });
    const cx = Math.max(60, (window.innerWidth - w) / 2);
    setPos({ x: cx + props.index * 34, y: 70 + props.index * 34 });
  });

  const focus = () => setFocusedAppId(props.app.id);
  const close = () => {
    setOpenAppIds((ids) => ids.filter((i) => i !== props.app.id));
  };
  const z = () => (focusedAppId() === props.app.id ? 86 : 84);

  // Pointer-drag the title bar to move; drag the corner handle to resize.
  const startDrag = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".apppane-btn")) return; // let buttons click
    focus();
    e.preventDefault();
    setDragging(true);
    const sx = e.clientX,
      sy = e.clientY,
      p0 = pos();
    const move = (me: PointerEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 80, p0.x + me.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, p0.y + me.clientY - sy));
      setPos({ x, y });
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startResize = (e: PointerEvent) => {
    focus();
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
    const sx = e.clientX,
      sy = e.clientY,
      s0 = size();
    const move = (me: PointerEvent) => {
      setSize({ w: Math.max(360, s0.w + me.clientX - sx), h: Math.max(260, s0.h + me.clientY - sy) });
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <Portal>
      <div
        class="apppane glass"
        classList={{ focused: focusedAppId() === props.app.id }}
        style={{
          left: `${pos().x}px`,
          top: `${pos().y}px`,
          width: `${size().w}px`,
          height: `${size().h}px`,
          "z-index": z(),
        }}
        onPointerDown={focus}
      >
        <div class="apppane-head" onPointerDown={startDrag}>
          <AppIcon app={props.app} size={16} />
          <span class="apppane-name">{props.app.name}</span>
          <span class="apppane-host">{props.app.host}</span>
          <span class="apppane-sp" />
          <button
            class="apppane-btn"
            title="Open in a tab"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              close();
              void openTab("browser", props.app.url);
            }}
          >
            ↗
          </button>
          <button
            class="apppane-btn"
            title="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={close}
          >
            ✕
          </button>
        </div>
        <iframe
          class="apppane-frame"
          classList={{ noevents: dragging() }}
          src={props.app.url}
          title={props.app.name}
          allow="clipboard-read; clipboard-write; camera; microphone; geolocation"
        />
        <div class="apppane-resize" onPointerDown={startResize} title="Resize" />
      </div>
    </Portal>
  );
};

export default AppPane;
