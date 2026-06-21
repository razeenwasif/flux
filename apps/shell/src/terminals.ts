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

export function registerTerminal(session: number, term: XTerm): void {
  registry.set(session, term);
  activeSession = session;
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

/** Absolute scrollback line count — a baseline to read only a command's new output. */
export function activeTerminalLineCount(): number {
  const s = targetSession();
  const term = s != null ? registry.get(s) : null;
  return term ? term.buffer.active.length : 0;
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

export function hasTerminal(): boolean {
  return registry.size > 0;
}
