import { createSignal } from "solid-js";
import { tuiAppsList, type TuiApp } from "./ipc";
import { FAVORITES_KEY, readFavorites } from "./launcherPreferences";
export const [favorites, setFavorites] = createSignal(readFavorites(localStorage.getItem(FAVORITES_KEY)));
export function toggleFavorite(id: string): void {
  const next = favorites().includes(id)
    ? favorites().filter((value) => value !== id)
    : [...favorites(), id].slice(0, 6);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  setFavorites(next);
}
const [terminalApps, setTerminalAppsRaw] = createSignal<TuiApp[]>([]);
export { terminalApps };
export function setTerminalApps(apps: TuiApp[]): void {
  setTerminalAppsRaw(apps);
  const ids = new Set(apps.map((app) => `terminal:${app.id}`));
  const next = favorites().filter((id) => !id.startsWith("terminal:") || ids.has(id));
  if (next.length !== favorites().length) {
    setFavorites(next);
    // The app list is already authoritative. A storage failure must not turn a
    // successful backend save into an apparent failure or hide the loaded apps.
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    } catch {
      /* retry on next app load */
    }
  }
}
export const [appsError, setAppsError] = createSignal("");
export const [appsLoading, setAppsLoading] = createSignal(false);
let loaded = false;
export async function loadTerminalApps(): Promise<void> {
  if (loaded || appsLoading()) return;
  setAppsLoading(true);
  setAppsError("");
  try {
    setTerminalApps(await tuiAppsList());
    loaded = true;
  } catch (error) {
    setAppsError(`Could not load terminal apps: ${String(error)}`);
  } finally {
    setAppsLoading(false);
  }
}
