// Flux's own dialogs (ask.tsx) that are open right now. The page views are
// native layers above this DOM, so `pageOverlayActive` hides them while one is
// up; otherwise a dialog opened over a web page sat behind it. A module of its
// own, like launcherOpen.ts, so ask.tsx doesn't load the whole store.
import { createSignal } from "solid-js";

const [dialogsOpen, setDialogsOpen] = createSignal(0);
export { dialogsOpen };

/** Hide the page views while a dialog is up. Call the returned function once it closes. */
export function holdDialog(): () => void {
  setDialogsOpen((n) => n + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    setDialogsOpen((n) => n - 1);
  };
}
