/**
 * The welcome (Welcome.tsx): which step is showing, or null. Here, small, so
 * the launcher, Settings and the first-launch check can open it without
 * loading it.
 */
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

const [welcomeStep, setWelcomeStep] = createSignal<number | null>(null);
export { welcomeStep };

/** Open at `step`: 0 is the start, 1 the import. */
export const openWelcome = (step = 0): void => {
  setWelcomeStep(step);
};
export const closeWelcome = (): void => {
  setWelcomeStep(null);
  localStorage.setItem("flux.welcome.done", "1");
};

/** A first launch (nothing visited, nothing bookmarked) opens the welcome,
 *  once; a profile that has history never sees it on its own. */
export function welcomeIfFirstLaunch(): void {
  if (localStorage.getItem("flux.welcome.done")) return;
  void invoke<boolean>("import_fresh")
    .then((fresh) => (fresh ? openWelcome(0) : localStorage.setItem("flux.welcome.done", "1")))
    .catch(() => {});
}
