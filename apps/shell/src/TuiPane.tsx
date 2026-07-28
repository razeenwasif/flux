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
import { createSignal, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import TerminalView from "./TerminalView";
import {
  closeTuiPane,
  focusedTuiPane,
  openTerminalApp,
  setFocusedTuiPane,
  type TuiPane as TuiPaneRec,
} from "./store";

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
      setSize({ w: Math.max(360, s0.w + me.clientX - sx), h: Math.max(240, s0.h + me.clientY - sy) });
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
        <div class="apppane-head" onPointerDown={startDrag}>
          <span class="tuipane-icon">{props.pane.icon}</span>
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
          <TerminalView session={props.pane.session} active={isFocused()} background={false} />
        </div>
        <div class="apppane-resize" onPointerDown={startResize} title="Resize" />
      </div>
    </Portal>
  );
};

export default TuiPane;
