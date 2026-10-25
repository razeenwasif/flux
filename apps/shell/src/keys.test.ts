/**
 * One registry (keys.rs), read in three places that must agree.
 *
 * The chrome matches keys with keys.ts; a focused page matches them with the
 * injected shortcuts.js, across a language boundary; App runs what either
 * names. When the two readers disagreed (as the old hand-copied chord lists
 * did, twice), a shortcut worked on Flux's own pages and silently did nothing
 * on every real website. And a registry command nothing runs is a menu item
 * and a Settings row that do nothing.
 */
import { describe, expect, it } from "vitest";

import injected from "../../../crates/flux-core/assets/shortcuts.js?raw";
import app from "./App.tsx?raw";
import { actionFor, applyKeys, chordOf, typing } from "./keys";
import registry from "./mock/keys.gen.json?raw";
import palette from "./paletteActions.ts?raw";
import type { KeysInfo } from "./bindings.gen";

const info = JSON.parse(registry) as KeysInfo;

type Fake = Omit<Partial<KeyboardEvent>, "target"> & { target?: unknown };
const key = (
  code: string,
  k: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
  target?: unknown,
): Fake => ({
  code,
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  isComposing: false,
  target: target ?? { tagName: "BODY" },
  composedPath: () => [target ?? { tagName: "BODY" }] as unknown as EventTarget[],
  preventDefault() {},
  stopPropagation() {},
});

/** Keydowns as a Mac sends them, and the chord each one is. */
const TABLE: [Fake, string | null][] = [
  [key("KeyT", "t", { meta: true }), "Cmd+T"],
  [key("KeyK", "k", { meta: true, shift: true }), "Shift+Cmd+K"],
  // Option turns letters and digits into symbols; the key's place says what it is.
  [key("Digit1", "¡", { alt: true }), "Alt+1"],
  [key("KeyI", "ˆ", { meta: true, alt: true }), "Alt+Cmd+I"],
  // A Cyrillic layout still has ⌘T where T is.
  [key("KeyT", "е", { meta: true }), "Cmd+T"],
  [key("Equal", "+", { meta: true, shift: true }), "Shift+Cmd+="],
  [key("Backslash", "|", { meta: true, shift: true }), "Shift+Cmd+\\"],
  [key("BracketLeft", "[", { meta: true }), "Cmd+["],
  [key("Backquote", "`", { meta: true }), "Cmd+`"],
  [key("Tab", "Tab", { ctrl: true, shift: true }), "Ctrl+Shift+Tab"],
  [key("ArrowLeft", "ArrowLeft", { alt: true }), "Alt+ArrowLeft"],
  [key("F5", "F5"), "F5"],
  [key("Comma", ",", { meta: true }), "Cmd+,"],
  [key("MetaLeft", "Meta", { meta: true }), null],
];

/** Run shortcuts.js against a fake page; what it forwards for each keydown. */
function pageForwards(map: Record<string, string>, events: Fake[]): (string | null)[] {
  let listener: ((e: Fake) => void) | null = null;
  const sent: string[] = [];
  const win = {
    __FLUX_KEYS__: map,
    __TAURI_INTERNALS__: { invoke: (_cmd: string, args: { action: string }) => sent.push(args.action) },
    addEventListener: (_t: string, fn: (e: Fake) => void) => (listener = fn),
  } as Record<string, unknown>;
  new Function("window", injected)(win);
  return events.map((e) => {
    const before = sent.length;
    listener!(e);
    return sent.length > before ? sent.at(-1)! : null;
  });
}

describe("one reading of a keypress", () => {
  it("reads each keydown as the chord keys.rs writes", () => {
    for (const [e, chord] of TABLE) expect(chordOf(e as KeyboardEvent), JSON.stringify(e)).toBe(chord);
  });

  it("the page reads them the same way", () => {
    const map: Record<string, string> = {};
    TABLE.forEach(([, chord], i) => chord && (map[chord] ??= `cmd-${i}`));
    const got = pageForwards(
      map,
      TABLE.map(([e]) => e),
    );
    expect(got).toEqual(TABLE.map(([, chord]) => (chord ? map[chord] : null)));
  });

  it("leaves typing keys to a text field, in the chrome and in pages", () => {
    const field = { tagName: "TEXTAREA" };
    const optLeft = key("ArrowLeft", "ArrowLeft", { alt: true }, field); // a word back
    const optOne = key("Digit1", "¡", { alt: true }, field); // types ¡
    const cmdBracket = key("BracketLeft", "[", { meta: true }, field); // outdent
    const cmdT = key("KeyT", "t", { meta: true }, field);
    expect(typing(optLeft as KeyboardEvent, "back")).toBe(true);
    expect(typing(optOne as KeyboardEvent, "mode-tabs")).toBe(true);
    expect(typing(cmdBracket as KeyboardEvent, "back")).toBe(true);
    expect(typing(cmdT as KeyboardEvent, "new-tab")).toBe(false);
    const map = { "Alt+ArrowLeft": "back", "Alt+1": "mode-tabs", "Cmd+[": "back", "Cmd+T": "new-tab" };
    expect(pageForwards(map, [optLeft, optOne, cmdBracket, cmdT])).toEqual([null, null, null, "new-tab"]);
  });

  it("matches the registry's defaults in the chrome", () => {
    applyKeys(info);
    expect(actionFor(key("KeyK", "k", { meta: true }) as KeyboardEvent)).toBe("palette");
    expect(actionFor(key("Digit2", "™", { alt: true }) as KeyboardEvent)).toBe("mode-calendar");
    expect(actionFor(key("KeyJ", "j", { meta: true }) as KeyboardEvent)).toBe(null);
  });
});

describe("every command runs", () => {
  /** The cases App's dispatch handles itself. */
  const dispatched = (() => {
    const start = app.indexOf("const dispatch = (action: string): boolean => {");
    const body = app.slice(start, app.indexOf("\n  };\n", start));
    return new Set([...body.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]!));
  })();
  /** The launcher's commands, by id; generated ones (translations, layouts) aside. */
  const launcher = new Set([...palette.matchAll(/\bid: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
  const GENERATED = new Set(["import-zen", "indexer-orb", "layout-restore"]);

  it("runs every command in the registry", () => {
    const dead = info.commands
      .map((c) => c.id)
      .filter((id) => !dispatched.has(id) && !launcher.has(id) && !/^tab-[1-9]$/.test(id));
    expect(dead, "commands with a key, a menu item and a Settings row that do nothing").toEqual([]);
  });

  it("lists every launcher command in the registry", () => {
    const ids = new Set(info.commands.map((c) => c.id));
    const missing = [...launcher].filter((id) => !ids.has(id) && !GENERATED.has(id));
    expect(missing, "launcher commands keys.rs doesn't know, so they can't have a key").toEqual([]);
  });
});
