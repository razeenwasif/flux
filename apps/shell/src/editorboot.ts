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
 * The editor's RPC socket for a PTY session.
 *
 * Computed here rather than fetched, because the boot command is queued the
 * moment the column mounts and an `await` would race that — losing the race
 * means booting a plain `nvim` the agent can't read, silently and most of the
 * time.
 *
 * Mirrors `flux_core::nvim::socket_path`. Two languages, one format: both sides
 * pin the literal in a test, so changing either without the other fails rather
 * than quietly breaking RPC. `/tmp` because on the Windows build these two sides
 * are different operating systems and it needs no environment lookup to agree.
 */
export function socketPath(session: number): string {
  return `/tmp/flux-nvim-${session}.sock`;
}

/**
 * Boot the editor with an RPC socket so the agent can read the live buffer
 * (#179) — unsaved edits included, which reading the file from disk can't give.
 *
 * `rm -f` first because the socket outlives a crash: nvim refuses to listen on a
 * path that already exists, so a hard exit would leave the column permanently
 * unable to start. Removing it runs in the same shell the socket lives in, which
 * is what makes this correct on the Windows build too — there the shell is WSL,
 * and so is the socket.
 *
 * The path is quoted but also `/tmp/flux-nvim-<n>.sock` by construction — digits
 * and dashes, nothing a shell would look at twice.
 */
export function bootCommand(socket: string): string {
  return `rm -f '${socket}' && ${BOOT_CMD} --listen '${socket}'`;
}

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
 * The editor session that is live right now, or `null` when the column is
 * closed — so the agent can tell "your editor says X" from "you don't have one
 * open", which are different answers to the same question.
 *
 * Plain module state rather than a signal: the only reader checks it on demand
 * inside an agent turn, so nothing needs to re-render when it changes. The
 * column sets it as generations come and go, and clears it on unmount.
 */
let liveSession: number | null = null;
export function setEditorSession(session: number | null): void {
  liveSession = session;
}
export function editorSession(): number | null {
  return liveSession;
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
