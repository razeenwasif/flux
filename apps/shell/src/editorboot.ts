/**
 * Boot policy for the nvim column (#174).
 *
 * The column relaunches its editor whenever the process exits, which is the
 * behaviour that makes it feel permanent — and also the one that turns a
 * misconfigured editor into an infinite respawn loop. That decision, and the
 * session-id arithmetic it depends on, live here as plain functions so both can
 * be tested without standing up a PTY.
 */

/** Reserved PTY-session range for the editor column. Tab ids start at 1 and
 *  climb slowly; TUI panes own 0xe0000000+ and TerminalColumn's splits
 *  0xf0000000+ — a distinct base keeps the four allocators from ever colliding. */
export const EDITOR_SESSION_BASE = 0xd000_0000;

/** What the column boots. No `cd ~` on purpose: a non-tab PTY already starts in
 *  the user's home (`terminal.rs` falls back to `home_dir()`), so adding one
 *  would be a second source of truth for the same thing. */
export const BOOT_CMD = "nvim";

/**
 * A session that exits sooner than this never really started — the editor isn't
 * on PATH, or it died on a config error. Relaunching *that* spins forever, so it
 * is reported instead.
 */
export const MIN_HEALTHY_MS = 2_000;

/** The PTY session id for a given relaunch generation. */
export function sessionFor(generation: number): number {
  return EDITOR_SESSION_BASE + generation;
}

/**
 * What to do when the editor process exits, given how long it had been up.
 *
 * A long-lived session ending means the user quit, and they should get a fresh
 * editor back. A session that dies immediately means it never worked, and
 * relaunching would loop — so that surfaces as a failure the user can act on.
 */
export function exitAction(uptimeMs: number): "relaunch" | "fail" {
  return uptimeMs >= MIN_HEALTHY_MS ? "relaunch" : "fail";
}
