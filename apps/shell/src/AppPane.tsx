/**
 * App pane (#131) — a movable, resizable floating window that embeds one of the
 * user's pinned web apps in an iframe. Multiple can be open (they cascade); the
 * focused one sits on top and is the app Gemma assists with. Rendered while open;
 * App hides the tab webview so the (HTML) pane is visible above it.
 */
import { For, createSignal, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import type { FluxApp } from "./apps";
import { AppIcon } from "./AppDock";
import { RESIZE_HANDLES, startPaneDrag, startPaneResize } from "./paneGeometry";
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

  // Move by the title bar; resize from any edge or corner (shared geometry).
  const ctl = { pos, setPos, size, setSize, setDragging, onFocus: focus };

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
        <div class="apppane-head" onPointerDown={(e) => startPaneDrag(ctl, e)}>
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
        <For each={RESIZE_HANDLES}>
          {(h) => (
            <div
              class={`pane-grip pane-grip-${h.dir}`}
              style={{ cursor: h.cursor }}
              onPointerDown={(e) => startPaneResize(ctl, e, h.dir)}
            />
          )}
        </For>
      </div>
    </Portal>
  );
};

export default AppPane;
