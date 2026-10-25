/**
 * What the boot path needs of a focus session: whether a tab is covered, and
 * the clock card's line. focusStore.ts answers once it has loaded (just after
 * the first paint); until then nothing is covered, as no session has been
 * read yet.
 */
import { createSignal } from "solid-js";

import type { TabMeta } from "./ipc";

export interface Cover {
  site: string;
  /** Where the tab is, or was going. */
  url: string;
  /** A navigation was stopped (the page under it is elsewhere, or blank). */
  stopped: boolean;
}

interface Gate {
  cover: (tab: TabMeta | null | undefined) => Cover | null;
  /** "Focus · 18:02 left", or "" when no session runs. */
  line: () => string;
}

const [gate, setGate] = createSignal<Gate | null>(null);

export const focusCover = (tab: TabMeta | null | undefined): Cover | null => gate()?.cover(tab) ?? null;
export const focusLine = (): string => gate()?.line() ?? "";
export const installFocusGate = (g: Gate): void => {
  setGate(() => g);
};
