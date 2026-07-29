// Web-panel column (#48), extracted from App.tsx. A slim right-side pane holding
// one or two pinned-site native webviews; this DOM is just the toolbars +
// placeholders the OS webviews are positioned over, plus the drag handles.
import { type Component, Show, lazy } from "solid-js";
import { panelNavigate, type WebPanel } from "./ipc";
import {
  activePanel,
  calendarDocked,
  activePanelB,
  closePanel,
  closePanelB,
  panelSplitRatio,
  panelWidth,
  setPanelDragging,
  setPanelSplitRatio,
  setPanelWidth,
} from "./store";

const CalendarPop = lazy(() => import("./CalendarPop"));

const WebPanelPane: Component = () => {
  const both = () => activePanel() != null && activePanelB() != null;
  // Drag the horizontal divider to re-balance the top/bottom split. Webviews hide
  // during the drag (panelDragging) so the DOM divider can track the pointer freely.
  const startSplitDrag = (e: PointerEvent) => {
    e.preventDefault();
    const pane = (e.currentTarget as HTMLElement).parentElement;
    if (!pane) return;
    setPanelDragging(true);
    const move = (ev: PointerEvent) => {
      const r = pane.getBoundingClientRect();
      if (r.height > 0) setPanelSplitRatio((ev.clientY - r.top) / r.height);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanelDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Resize the panel's width by dragging the toolbar grip. The edge divider sits
  // in a reserved gutter that the native webview covers on the WebView2 build
  // (so it's invisible/ungrabbable there); the toolbar is the one HTML strip the
  // webview is provably inset from, so a grip here is always hittable. Hiding the
  // webview on drag-start (panelDragging) lets the pointer track freely after.
  const startWidthDrag = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add("resizing");
    setPanelDragging(true);
    const startX = e.clientX;
    const startW = panelWidth();
    const move = (ev: PointerEvent) => setPanelWidth(startW - (ev.clientX - startX));
    const up = () => {
      setPanelDragging(false);
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const slot = (id: string, p: WebPanel, onClose: () => void, grow: () => number) => (
    <div class="webpanel-surface" id={id} style={{ "flex-grow": String(grow()) }}>
      <div class="panel-toolbar">
        <span class="panel-title" title={p.url}>
          {p.title || p.url}
        </span>
        <button class="panel-btn" title="Reload panel" onClick={() => void panelNavigate(p.id, p.url)}>
          ⟳
        </button>
        <button class="panel-btn" title="Close panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="panel-placeholder" />
    </div>
  );
  return (
    <aside class="webpanel-pane">
      {/* Resize handle anchored to the pane's own left edge — always at the panel
          boundary regardless of which other columns are open, and it sits in the
          reserved gutter the native webview is inset from, so it's grabbable. */}
      <div class="panel-edge-resize" title="Drag to resize the panel" onPointerDown={startWidthDrag} />
      {/* Docked calendar: plain DOM in this column. The native panel webviews
          are positioned from their placeholders' rects each layout pass, so
          they simply shrink and reposition around it rather than conflicting. */}
      <Show when={calendarDocked()}>
        <CalendarPop docked />
      </Show>
      <Show when={activePanel()}>
        {(p) =>
          slot(
            "flux-panel-area",
            p(),
            () => closePanel(),
            () => (both() ? panelSplitRatio() : 1),
          )
        }
      </Show>
      <Show when={both()}>
        <div class="webpanel-vdiv" onPointerDown={startSplitDrag} title="Drag to resize split" />
      </Show>
      <Show when={activePanelB()}>
        {(p) =>
          slot(
            "flux-panel-area-b",
            p(),
            () => closePanelB(),
            () => (both() ? 1 - panelSplitRatio() : 1),
          )
        }
      </Show>
    </aside>
  );
};

export default WebPanelPane;
