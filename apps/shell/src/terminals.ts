// Registry of live xterm instances by session, so the agent can read the active
// terminal's scrollback ("read the terminal" → into Gemma's context). TerminalView
// registers/unregisters its term and flags itself active.

import type { Terminal as XTerm } from "@xterm/xterm";

import { terminalWrite } from "./ipc";

const registry = new Map<number, XTerm>();
let activeSession: number | null = null;

// App registers how to open/show the terminal column, so the agent can bring a
// terminal up before running a command in it (without AgentPanel importing App).
let openTerminalFn: (() => void) | null = null;
export function setTerminalOpener(fn: () => void): void {
  openTerminalFn = fn;
}

// A command to auto-run once a freshly-opened terminal's PTY is spawned (TUI app
// launcher). Set before the tab mounts; TerminalView consumes it after spawn so
// there's no race against the PTY being ready.
const pendingCommand = new Map<number, string>();
export function setPendingCommand(session: number, cmd: string): void {
  pendingCommand.set(session, cmd);
}
export function takePendingCommand(session: number): string | null {
  const cmd = pendingCommand.get(session) ?? null;
  pendingCommand.delete(session);
  return cmd;
}

/**
 * Add a terminal to the registry.
 *
 * `claimActive` decides whether mounting also makes this the agent's "read the
 * terminal" target. It used to be unconditional, which quietly broke once a
 * terminal could mount without the user opening it: the editor column (#174)
 * boots with the window and remounts on every `:q`, so each relaunch stole the
 * read target from whatever shell the user was actually debugging in. Focus
 * still switches it — see `setActiveTerminal` — so an editor you click into
 * becomes readable, which is the part that should depend on you.
 */
export function registerTerminal(session: number, term: XTerm, claimActive = true): void {
  registry.set(session, term);
  if (claimActive) activeSession = session;
}
export function unregisterTerminal(session: number): void {
  registry.delete(session);
  if (activeSession === session) activeSession = registry.size ? [...registry.keys()].pop()! : null;
}
export function setActiveTerminal(session: number): void {
  if (registry.has(session)) activeSession = session;
}

function targetSession(): number | null {
  return activeSession ?? (registry.size ? [...registry.keys()].pop()! : null);
}

/** Recent scrollback of the active terminal (trailing blank lines trimmed). */
export function activeTerminalText(maxLines = 400): { session: number; text: string } | null {
  const session = targetSession();
  if (session == null) return null;
  const term = registry.get(session);
  if (!term) return null;
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - maxLines);
  const lines: string[] = [];
  for (let i = start; i < total; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return { session, text: lines.join("\n") };
}

/** Absolute buffer row of the cursor (where the prompt sits) — the baseline to read
 *  only a command's new output. NOT buffer length: on a fresh terminal the prompt is
 *  near the top with empty rows below, so length-1 points below the output. */
export function activeTerminalCursorLine(): number {
  const s = targetSession();
  const term = s != null ? registry.get(s) : null;
  if (!term) return 0;
  const buf = term.buffer.active;
  return buf.baseY + buf.cursorY;
}

/** Active terminal's lines from `startLine` to the end (capped, trailing blanks trimmed). */
export function activeTerminalLinesFrom(startLine: number, maxLines = 200): string {
  const s = targetSession();
  const term = s != null ? registry.get(s) : null;
  if (!term) return "";
  const buf = term.buffer.active;
  const total = buf.length;
  const from = Math.max(0, Math.max(startLine, total - maxLines));
  const lines: string[] = [];
  for (let i = from; i < total; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}

/** Type a command into the active terminal and run it (Enter = `\r`). Opens a
 *  terminal first if none is live. Returns the session it ran in, or null if no
 *  terminal could be brought up. */
export async function runInActiveTerminal(cmd: string): Promise<number | null> {
  const wasOpen = hasTerminal();
  if (!wasOpen) openTerminalFn?.();
  // The terminal mounts, then spawns its PTY asynchronously (registerTerminal runs
  // before terminalSpawn resolves), so wait for a live term, then let the backend
  // PTY settle before the first write if we had to open it.
  for (let i = 0; i < 30 && !hasTerminal(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!hasTerminal()) return null;
  if (!wasOpen) await new Promise((r) => setTimeout(r, 500));
  const s = targetSession();
  if (s == null) return null;
  await terminalWrite(s, new TextEncoder().encode(cmd + "\r"));
  return s;
}

/** Insert a command at the active terminal's prompt WITHOUT running it (no `\r`),
 *  so the user can review/edit before pressing Enter. Opens a terminal if none is
 *  live. Returns the session, or null if no terminal could be brought up. */
export async function insertInActiveTerminal(cmd: string): Promise<number | null> {
  const wasOpen = hasTerminal();
  if (!wasOpen) openTerminalFn?.();
  for (let i = 0; i < 30 && !hasTerminal(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!hasTerminal()) return null;
  if (!wasOpen) await new Promise((r) => setTimeout(r, 500));
  const s = targetSession();
  if (s == null) return null;
  await terminalWrite(s, new TextEncoder().encode(cmd));
  return s;
}

export function hasTerminal(): boolean {
  return registry.size > 0;
}
