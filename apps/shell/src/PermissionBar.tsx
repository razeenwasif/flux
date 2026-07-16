// Flux-styled permission prompt (#38, the Ask case). The engine's permission
// request is deferred in Rust; this bar answers it. Docked ABOVE the content
// card as a sibling — the card (and its native webview, via the ResizeObserver)
// shrinks to make room, so nothing has to fight the OS webview layer.
import { Component, Show } from "solid-js";
import { permissionAnswer, type PermAsk, type PermKind } from "./ipc";
import { permAsks, removePermAsk } from "./store";
import { createSignal } from "solid-js";

const KIND_META: Record<PermKind, { icon: string; label: string }> = {
  camera: { icon: "🎥", label: "use your camera" },
  microphone: { icon: "🎤", label: "use your microphone" },
  geolocation: { icon: "📍", label: "know your location" },
  notifications: { icon: "🔔", label: "send you notifications" },
  clipboard_read: { icon: "📋", label: "read your clipboard" },
  other: { icon: "🔐", label: "use a device permission" },
};

const PermissionBar: Component = () => {
  const current = (): PermAsk | undefined => permAsks()[0];
  const [remember, setRemember] = createSignal(false);
  const answer = (allow: boolean) => {
    const a = current();
    if (!a) return;
    void permissionAnswer(a.id, a.host, a.kind, allow, remember());
    removePermAsk(a.id);
    setRemember(false);
  };
  return (
    <Show when={current()}>
      {(ask) => (
        <div class="perm-bar" role="alertdialog" aria-live="assertive">
          <span class="perm-ico">{KIND_META[ask().kind].icon}</span>
          <span class="perm-text">
            <b>{ask().host || "This page"}</b> wants to {KIND_META[ask().kind].label}
          </span>
          <Show when={permAsks().length > 1}>
            <span class="perm-more">+{permAsks().length - 1} more</span>
          </Show>
          <label class="perm-remember">
            <input
              type="checkbox"
              checked={remember()}
              onInput={(e) => setRemember(e.currentTarget.checked)}
            />
            Remember for this site
          </label>
          <button class="perm-btn allow" onClick={() => answer(true)}>
            Allow
          </button>
          <button class="perm-btn deny" onClick={() => answer(false)}>
            Block
          </button>
          {/* ✕ = deny once, never remembered — same as ignoring a native prompt. */}
          <button
            class="perm-btn dismiss"
            title="Dismiss (deny this once)"
            onClick={() => {
              setRemember(false);
              answer(false);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </Show>
  );
};

export default PermissionBar;
