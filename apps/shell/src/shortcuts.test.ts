/**
 * The chord set is written twice, and the copies drift.
 *
 * A native tab webview captures the keyboard when focused, so the chrome's own
 * `keydown` listener never sees a shortcut pressed while you're on a real
 * website. `crates/flux-core/assets/shortcuts.js` is injected into every page to
 * detect Flux's chords and forward them — which means it has to mirror
 * `shortcuts.ts` by hand, across a language boundary, with nothing enforcing it.
 *
 * It had already drifted twice by the time this test was written: `spotlight`
 * and `shell-history` both worked on Flux's own pages and silently did nothing
 * everywhere else. That's the worst shape a bug can take — it works when you
 * test it, because you test it on a Flux page.
 */
import { describe, expect, it } from "vitest";

import injected from "../../../crates/flux-core/assets/shortcuts.js?raw";
import ts from "./shortcuts.ts?raw";

/** Every action string a source file can return. `tab-N` is excluded: both
 *  files build it by concatenation, so the literal prefix isn't an action. */
const actionsIn = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/return "([a-z-]+)"/g)) {
    if (m[1] !== "tab-") out.add(m[1]!);
  }
  return out;
};

describe("page-forwarded shortcuts", () => {
  it("forwards every chord the chrome handles", () => {
    const chrome = actionsIn(ts);
    const page = actionsIn(injected);
    expect(chrome.size).toBeGreaterThan(15);

    // `tab-N` is built by concatenation in both files, not returned as a
    // literal, so neither set contains it.
    const missing = [...chrome].filter((a) => !page.has(a));
    expect(missing, "chords that do nothing on a real website").toEqual([]);
  });

  it("doesn't forward chords the chrome would ignore", () => {
    // The reverse drift: a page swallowing a key (it calls preventDefault)
    // and handing the chrome an action it has no case for, so the key is dead
    // rather than doing what the *site* wanted with it.
    const chrome = actionsIn(ts);
    const page = actionsIn(injected);
    const unknown = [...page].filter((a) => !chrome.has(a));
    expect(unknown, "forwarded to the chrome, which has no such action").toEqual([]);
  });

  it("agrees on the modifier each chord uses", () => {
    // `Ctrl+K` and `Ctrl+Shift+K` are different actions; a chord landing in the
    // wrong branch of one file opens the wrong thing on websites only.
    const shiftBranch = (src: string): Set<string> => {
      // `&& e.shiftKey` — not plain "e.shiftKey", which first appears in the
      // *unshifted* branch's `!e.shiftKey` guard and would swallow both.
      const start = src.indexOf("&& e.shiftKey");
      const end = src.indexOf("altKey && !mod", start);
      return actionsIn(src.slice(start, end > 0 ? end : undefined));
    };
    expect([...shiftBranch(injected)].sort()).toEqual([...shiftBranch(ts)].sort());
  });
});
