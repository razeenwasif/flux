/**
 * TUI pane (#117 follow-up) — a movable, resizable floating window running one
 * of the user's terminal apps (onyx / scroll / council …) in a real PTY.
 *
 * The sibling of `AppPane` (which floats a *web* app in an iframe): same window
 * chrome, but the body is `TerminalView`. That works because Flux's terminal is
 * xterm.js — plain DOM — so it renders anywhere, unlike a tab's page (a native
 * webview layer above the card). Panes register in `pageOverlayActive`, so the
 * shared show/hide effect lifts the native page out of the way while one is open.
 *
 * The PTY dies with the pane: TerminalView's own onCleanup kills the session on
 * unmount, so closing the window is the whole teardown.
 */
import { For, createSignal, onMount, type Component, lazy, Suspense } from "solid-js";
import { Portal } from "solid-js/web";

import { RESIZE_HANDLES, startPaneDrag, startPaneResize } from "./paneGeometry";
import { IconOrGlyph } from "./Icon";
import {
  closeTuiPane,
  focusedTuiPane,
  openTerminalApp,
  setFocusedTuiPane,
  type TuiPane as TuiPaneRec,
} from "./store";

const TerminalView = lazy(() => import("./TerminalView"));

const TuiPane: Component<{ pane: TuiPaneRec; index: number }> = (props) => {
  const [pos, setPos] = createSignal({ x: 140, y: 100 });
  const [size, setSize] = createSignal({ w: 860, h: 560 });
  // Terminals swallow pointer events; suspend that mid-drag so a fast gesture
  // can't get "stuck" inside the xterm surface.
  const [dragging, setDragging] = createSignal(false);

  onMount(() => {
    const w = Math.min(860, window.innerWidth - 120);
    const h = Math.min(560, window.innerHeight - 140);
    setSize({ w, h });
    const cx = Math.max(60, (window.innerWidth - w) / 2);
    setPos({ x: cx + props.index * 34, y: 70 + props.index * 34 });
  });

  const focus = () => setFocusedTuiPane(props.pane.session);
  const close = () => closeTuiPane(props.pane.session);
  const isFocused = () => focusedTuiPane() === props.pane.session;
  const z = () => (isFocused() ? 86 : 84);

  // Move by the title bar; resize from any edge or corner (shared geometry).
  const ctl = { pos, setPos, size, setSize, setDragging, onFocus: focus };

  return (
    <Portal>
      <div
        class="apppane tuipane glass"
        classList={{ focused: isFocused() }}
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
          <IconOrGlyph icon={props.pane.icon} size={15} class="tuipane-icon" />
          <span class="apppane-name">{props.pane.name}</span>
          <span class="apppane-host">{props.pane.cmd}</span>
          <span class="apppane-sp" />
          <button
            class="apppane-btn"
            title="Move to a terminal tab"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              // Re-launch in a tab (a PTY can't migrate between panes) and drop
              // this window — the pane's own shell exits with it.
              close();
              void openTerminalApp(props.pane.cmd, props.pane.cwd).catch(() => {});
            }}
          >
            ↗
          </button>
          <button
            class="apppane-btn"
            title="Close (ends this shell)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={close}
          >
            ✕
          </button>
        </div>
        <div class="tuipane-body" classList={{ noevents: dragging() }}>
          {/* background=false: a floating pane must not hold its own WebGL2
              context for the liquid backdrop (the terminal-splits rule). */}
          <Suspense>
            <TerminalView session={props.pane.session} active={isFocused()} background={false} />
          </Suspense>
        </div>
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

export default TuiPane;
