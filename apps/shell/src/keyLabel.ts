/**
 * Chords as people read them (keys.ts writes them `Shift+Cmd+K`): "⇧⌘K" on a
 * Mac, "Ctrl+Shift+K" elsewhere. Off the boot entry: tooltips, the launcher
 * and Settings use it.
 */
import { invoke } from "@tauri-apps/api/core";

import type { KeysInfo } from "./bindings.gen";
import { keysInfo } from "./keys";
import { isMac } from "./platform";

const SYM: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Tab: "⇥",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
};
/** A chord's key caps: ["⇧", "⌘", "K"] on a Mac, ["Ctrl", "Shift", "K"] elsewhere. */
export const keyParts = (chord: string): string[] =>
  chord.split("+").map((p) => (isMac ? (SYM[p] ?? p) : p === "Cmd" ? "Win" : p));
/** "⇧⌘K" on a Mac, "Ctrl+Shift+K" elsewhere. */
export const keyLabel = (chord: string): string => keyParts(chord).join(isMac ? "" : "+");
/** A command's first key as a label, or "" when it has none. */
export function keyOf(id: string): string {
  const chord = keysInfo()?.commands.find((c) => c.id === id)?.keys[0];
  return chord ? keyLabel(chord) : "";
}
/** "Toggle sidebar (⌘B)", or the label alone when the command has no key. */
export function withKey(label: string, id: string): string {
  const k = keyOf(id);
  return k ? `${label} (${k})` : label;
}

/** Bind `id` to `chord` alone (null unbinds); the chord leaves whoever had it. */
export const keysSet = (id: string, chord: string | null) => invoke<KeysInfo>("keys_set", { id, chord });
/** Back to the defaults: one command, or every one (null). */
export const keysReset = (id: string | null) => invoke<KeysInfo>("keys_reset", { id });
