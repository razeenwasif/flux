import { onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/** Open modals, bottom → top. Only the topmost contains focus: two document
 *  focusin traps that each pull focus back into their own dialog recurse until
 *  the stack overflows. */
const stack: HTMLElement[] = [];
/** #root's inert state from before the first modal opened. */
let baseInert = false;

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
    if (stack.length === 0) baseInert = root?.inert ?? false;
    stack.push(dialog);
    if (root) root.inert = true;
    const focusFirst = () =>
      (
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        dialog.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ??
        dialog
      ).focus();
    const frame = requestAnimationFrame(focusFirst);
    const containFocus = (event: FocusEvent) => {
      if (stack.at(-1) !== dialog) return; // a modal above this one owns focus
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("focusin", containFocus);
    onCleanup(() => {
      const wasTop = stack.at(-1) === dialog;
      const i = stack.lastIndexOf(dialog);
      if (i >= 0) stack.splice(i, 1);
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", containFocus);
      // Modals can close out of order: #root stays inert until the last one goes.
      if (root && stack.length === 0) root.inert = baseInert;
      // Restoring focus from under a modal that's still open would pull it out.
      if (wasTop && previous instanceof HTMLElement && previous.isConnected) previous.focus();
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
