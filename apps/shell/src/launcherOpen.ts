import { createSignal } from "solid-js";

/** The launcher is up (Launcher.tsx). */
export const [launcherOpen, setLauncherShown] = createSignal(false);
/** What its field starts with: ">" lists the commands. */
export const [launcherInitial, setLauncherInitial] = createSignal("");

let opener: (() => Promise<void>) | null = null;
/** How App opens it: a still of each page on screen goes into its card first,
 *  so the launcher floats over the page rather than an empty card. */
export const setLauncherOpener = (fn: () => Promise<void>): void => {
  opener = fn;
};

export function setLauncherOpen(on: boolean, initial = ""): void {
  if (!on) {
    setLauncherShown(false);
    return;
  }
  if (launcherOpen()) return;
  setLauncherInitial(initial);
  if (opener) void opener();
  else setLauncherShown(true);
}
