// Registry of live xterm instances by session, so the agent can read the active
// terminal's scrollback ("read the terminal" → into Gemma's context). TerminalView
// registers/unregisters its term and flags itself active.

import type { Terminal as XTerm } from "@xterm/xterm";

const registry = new Map<number, XTerm>();
let activeSession: number | null = null;

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

/** Recent scrollback of the active terminal (trailing blank lines trimmed). */
export function activeTerminalText(maxLines = 400): { session: number; text: string } | null {
  const session = activeSession ?? (registry.size ? [...registry.keys()].pop()! : null);
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

export function hasTerminal(): boolean {
  return registry.size > 0;
}
