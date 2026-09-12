import { onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/** Shell overlays share focus containment and restoration. Native pages are hidden by App. */
const Modal: Component<{
  label: string;
  backdropClass: string;
  class: string;
  onClose: () => void;
  children: JSX.Element;
}> = (props) => {
  let dialog!: HTMLDivElement;
  onMount(() => {
    const previous = document.activeElement;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const focusFirst = () =>
      (
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        dialog.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ??
        dialog
      ).focus();
    const frame = requestAnimationFrame(focusFirst);
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("focusin", containFocus);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", containFocus);
      if (root) root.inert = wasInert;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  });

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "Tab") {
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
      const first = controls[0] ?? dialog;
      const last = controls.at(-1) ?? dialog;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <Portal>
      <div
        class={props.backdropClass}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div
          ref={dialog}
          class={props.class}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          tabIndex={-1}
          onKeyDown={onKey}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  );
};

export default Modal;
