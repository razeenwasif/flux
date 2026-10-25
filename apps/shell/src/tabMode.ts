/**
 * The tabs pane's modes (Velvet Paper): Tabs, Calendar, Mail, Notes and
 * Context (your notes that relate to the page, the machine, the Trail).
 *
 * The pane keeps its width in every mode, so the page beside it never moves.
 * The other modes fold the tab list into a rail of favicons and put their
 * panel beside it (`TabModePanel`, lazy: its chunk loads on the first switch).
 * Not persisted: a launch always opens on the tabs.
 */
import { createSignal } from "solid-js";

export type TabMode = "tabs" | "calendar" | "mail" | "notes" | "context";
export const TAB_MODES: TabMode[] = ["tabs", "calendar", "mail", "notes", "context"];

const [tabMode, setTabModeSig] = createSignal<TabMode>("tabs");
export { tabMode };

/** Runs a mode change. The pane installs one that animates the morph; until
 *  it has, a change just sets the mode. */
let changer: (to: TabMode) => void = (to) => setTabModeSig(to);
export const setTabModeChanger = (fn: ((to: TabMode) => void) | null): void => {
  changer = fn ?? ((to) => setTabModeSig(to));
};
/** Commit a mode without ceremony (the morph calls this mid-flight). */
export const commitTabMode = (to: TabMode): void => {
  setTabModeSig(to);
};
export const setTabMode = (to: TabMode): void => {
  if (to !== tabMode()) changer(to);
};

/** The inbox's unread count as last fetched by anything that reads mail (the
 *  Mail mode, the new tab's Mailbox card), for the Mail segment's badge. */
const [mailUnread, setMailUnread] = createSignal<number | null>(null);
export { mailUnread, setMailUnread };
