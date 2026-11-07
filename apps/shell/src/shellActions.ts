/**
 * A bridge from pages to the shell's actions.
 *
 * App.tsx owns the layout toggles (terminal, agent, editor, Files, Notebook) and
 * runs them through one `dispatch`. Liquid Silk's home dock (StartPage) needs a
 * few of them, three components deep; threading callbacks through ContentArea
 * and InternalPage for one dock would be more wiring than feature. App registers
 * its dispatcher here once and the dock calls it by name, the same names the
 * keyboard shortcuts use.
 *
 * The open/closed state the dock shows is registered alongside, for the same
 * reason (terminal and agent live in App, not the store).
 */
export type ShellAction = "toggle-terminal" | "toggle-agent" | "toggle-editor" | "toggle-files" | "toggle-notebook";

type ShellBridge = {
  run: (action: ShellAction) => boolean;
  isOpen: (action: ShellAction) => boolean;
};

let bridge: ShellBridge | null = null;

export const registerShellActions = (b: ShellBridge): void => {
  bridge = b;
};

/** Run a shell action; false when nothing is registered (tests, the HUD). */
export const runShellAction = (action: ShellAction): boolean => bridge?.run(action) ?? false;

/** Whether that action's panel is open. Reactive when the registered reader is. */
export const shellActionOpen = (action: ShellAction): boolean => bridge?.isOpen(action) ?? false;
