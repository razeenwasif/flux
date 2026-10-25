/**
 * Shields — the content-blocker control (BACKLOG #57). An icon with the active
 * page's blocked count, live as requests are blocked; clicking opens the
 * popover (lazy — the toggle UI loads on first open, keeping it out of the
 * boot bundle per ADR 0001).
 */
import { Show, createEffect, createMemo, createSignal, lazy, on, onCleanup, type Component } from "solid-js";

import { onShieldsPage, shieldsStatus, type ShieldsStatus } from "./ipc";
import Icon from "./Icon";
import { activeId, activeTab, isLoading } from "./store";

const ShieldsPop = lazy(() => import("./ShieldsPop"));

const Shields: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [status, setStatus] = createSignal<ShieldsStatus | null>(null);
  const [blocked, setBlocked] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  // Just the page's blocked count for the badge (cheap, refreshed on navigation
  // and pushed as blocks happen — the popover polls the full status itself).
  const pollBadge = () => {
    const tab = activeId();
    void shieldsStatus(tab)
      .then((s) => {
        if (tab !== activeId()) return;
        setStatus(s);
        setBlocked(s.page_blocked);
      })
      .catch(() => {});
  };
  const live = onShieldsPage((tab, n) => tab === activeId() && setBlocked(n));
  onCleanup(() => void live.then((off) => off()));
  // Re-polled when the active page navigates and when it finishes loading, which
  // is when most of its requests have been blocked. Keyed on a memo: reading
  // activeTab() directly re-polled on every title tick too, since each one
  // hands the active tab a new object.
  const navState = createMemo(() => `${activeTab()?.url ?? ""} ${isLoading()}`);
  createEffect(on(navState, pollBadge));

  return (
    // No positioning context here: the popover anchors to .sidebar-footer so it
    // spans the sidebar width (never wider — it would fall behind the webview).
    <div style={{ display: "contents" }}>
      <button
        classList={{ "icon-btn": true, active: open() }}
        title={blocked() ? `Shields — ${blocked()} blocked on this page` : "Shields — content blocker"}
        aria-label="Shields — content blocker"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="shields" />
        <Show when={status()?.request_metrics && blocked() > 0}>
          <span class="shield-badge">{blocked() > 999 ? "999+" : blocked()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <ShieldsPop onNavigate={props.onNavigate} onClose={() => setOpen(false)} />
      </Show>
    </div>
  );
};

export default Shields;
