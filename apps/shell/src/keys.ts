/**
 * Flux's commands and their keys, from the one registry in keys.rs: the menu
 * bar, the launcher's hints, Settings → Keyboard and every page's forwarder
 * (assets/shortcuts.js) read the same list. This half matches a keypress in
 * the chrome against it; App runs what it names. On the boot path, so it stays
 * small: labels are keyLabel.ts, the recorder KeyboardSettings.tsx.
 *
 * A chord reads `Ctrl+Alt+Shift+Cmd+K`, modifiers in that order. chordOf MUST
 * read keys the way shortcuts.js does.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";

import type { KeysInfo } from "./bindings.gen";

const [info, setInfo] = createSignal<KeysInfo | null>(null);
let byChord: Record<string, string> = {};

/** The registry, once Rust has answered. */
export const keysInfo = info;

export const applyKeys = (k: KeysInfo): void => {
  const map: Record<string, string> = {};
  for (const c of k.commands) for (const chord of c.keys) map[chord] ??= c.id;
  byChord = map;
  setInfo(k);
};

const keysList = () => invoke<KeysInfo>("keys_list");

/** Load the keys and follow rebinds (from Settings, here or in a page). */
export const loadKeys = (): void => {
  void keysList()
    .then(applyKeys)
    .catch(() => {});
  void listen<KeysInfo>("flux://keys", (e) => applyKeys(e.payload)).catch(() => {});
};

/** True while Settings is recording a shortcut: no command runs. */
export const [keyRecording, setKeyRecording] = createSignal(false);

/** Punctuation by key position: Shift and Option change what e.key says. */
const CODES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  NumpadAdd: "=",
  NumpadSubtract: "-",
};
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "Dead"]);

/** "Shift+Cmd+K" for a keydown, or null for a lone modifier. */
export function chordOf(e: KeyboardEvent): string | null {
  const c = e.code || "";
  let k = e.key || "";
  if (/^Key[A-Z]$/.test(c) && !/^[a-z]$/i.test(k)) k = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) k = c.slice(5);
  else if (CODES[c]) k = CODES[c]!;
  else if (k.length === 1) k = k.toUpperCase();
  if (!k || MODIFIERS.has(k)) return null;
  return (
    (e.ctrlKey ? "Ctrl+" : "") +
    (e.altKey ? "Alt+" : "") +
    (e.shiftKey ? "Shift+" : "") +
    (e.metaKey ? "Cmd+" : "") +
    k
  );
}

/** A key that types or moves the caret belongs to the text field, unless ⌘ or
 *  Ctrl is down; Back and Forward leave text fields alone too. */
export function typing(e: KeyboardEvent, action: string): boolean {
  const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
  const field = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
  if (!field) return false;
  if (action === "back" || action === "forward") return true;
  return !e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key || "");
}

/** The command this keydown runs, if any. */
export function actionFor(e: KeyboardEvent): string | null {
  if (e.isComposing) return null;
  const chord = chordOf(e);
  const a = chord ? byChord[chord] : undefined;
  return a && !typing(e, a) ? a : null;
}
