/**
 * Shields — the content-blocker control (BACKLOG #57). A footer icon with a
 * live blocked-count badge; clicking opens the popover (lazy — the toggle UI
 * loads on first open, keeping it out of the boot bundle per ADR 0001).
 */
import { Show, createEffect, createSignal, lazy, type Component } from "solid-js";

import { shieldsStatus, type ShieldsStatus } from "./ipc";
import Icon from "./Icon";
import { activeTab } from "./store";

const ShieldsPop = lazy(() => import("./ShieldsPop"));

const Shields: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [status, setStatus] = createSignal<ShieldsStatus | null>(null);
  const [open, setOpen] = createSignal(false);
  // Just the blocked-count for the icon badge (cheap, refreshed on navigation —
  // the popover polls the full status set itself while open).
  const pollBadge = () =>
    void shieldsStatus()
      .then(setStatus)
      .catch(() => {});
  createEffect(() => {
    activeTab()?.url;
    pollBadge();
  });

  return (
    // No positioning context here: the popover anchors to .sidebar-footer so it
    // spans the sidebar width (never wider — it would fall behind the webview).
    <div style={{ display: "contents" }}>
      <button
        classList={{ "icon-btn": true, active: open() }}
        title="Shields — content blocker"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="shields" />
        <Show when={(status()?.blocked ?? 0) > 0}>
          <span class="shield-badge">{status()!.blocked > 999 ? "999+" : status()!.blocked}</span>
        </Show>
      </button>
      <Show when={open()}>
        <ShieldsPop onNavigate={props.onNavigate} onClose={() => setOpen(false)} />
      </Show>
    </div>
  );
};

export default Shields;
