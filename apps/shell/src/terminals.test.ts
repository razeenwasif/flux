import { beforeEach, describe, expect, it } from "vitest";

import {
  activeTerminalText,
  clipBlock,
  registerTerminal,
  setActiveTerminal,
  unregisterTerminal,
} from "./terminals";

/** Enough of xterm for the registry: a buffer of lines it can read back. */
function fakeTerm(lines: string[]) {
  return {
    buffer: {
      active: {
        length: lines.length,
        baseY: 0,
        cursorY: 0,
        getLine: (i: number) => ({ translateToString: () => lines[i] ?? "" }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// The registry is module state, so each test starts from a known set.
const SHELL = 1;
const EDITOR = 0xd000_0000;

beforeEach(() => {
  unregisterTerminal(SHELL);
  unregisterTerminal(EDITOR);
});

describe("terminal registry", () => {
  it("does not let an unfocused pane steal the agent's read target", () => {
    // The shell is what the user is working in.
    registerTerminal(SHELL, fakeTerm(["$ cargo test", "error[E0308]: mismatched types"]), true);
    expect(activeTerminalText()?.session).toBe(SHELL);

    // The editor column mounts on its own — at startup, and again on every `:q`.
    // Before #178 this claimed the slot, so "read the terminal" silently
    // returned nvim's screen instead of the failing build the user was staring at.
    registerTerminal(EDITOR, fakeTerm(["  1 fn main() {", "~", "demo.rs [+]"]), false);
    expect(activeTerminalText()?.session).toBe(SHELL);
    expect(activeTerminalText()?.text).toContain("E0308");
  });

  it("still follows focus, so an editor you click into becomes readable", () => {
    registerTerminal(SHELL, fakeTerm(["$ ls"]), true);
    registerTerminal(EDITOR, fakeTerm(["  1 fn main() {"]), false);

    setActiveTerminal(EDITOR);
    expect(activeTerminalText()?.session).toBe(EDITOR);
    // …and back again.
    setActiveTerminal(SHELL);
    expect(activeTerminalText()?.session).toBe(SHELL);
  });

  it("a terminal the user opened still claims it", () => {
    // The default is unchanged: opening a terminal tab makes it the target.
    registerTerminal(EDITOR, fakeTerm(["editor"]), false);
    registerTerminal(SHELL, fakeTerm(["shell"]), true);
    expect(activeTerminalText()?.session).toBe(SHELL);
  });

  it("falls back to a registered terminal when nothing claimed one", () => {
    // Only the editor exists: reading *it* beats reporting nothing at all.
    registerTerminal(EDITOR, fakeTerm(["  1 fn main() {"]), false);
    expect(activeTerminalText()?.session).toBe(EDITOR);
  });

  it("closing the read target hands off rather than going silent", () => {
    registerTerminal(EDITOR, fakeTerm(["editor"]), false);
    registerTerminal(SHELL, fakeTerm(["shell"]), true);
    unregisterTerminal(SHELL);
    expect(activeTerminalText()?.session).toBe(EDITOR);
  });
});

describe("a failed command's block, for Explain/Fix", () => {
  it("is passed whole when it fits", () => {
    expect(clipBlock(["$ ls nope", "ls: nope: No such file or directory"])).toBe(
      "$ ls nope\nls: nope: No such file or directory",
    );
  });

  it("keeps the command and the error that ends a long run", () => {
    // A two-line prompt (starship's default) puts the command on the 3rd row:
    // the OSC 133 A mark lands on the blank row before it.
    const lines = [
      "",
      "~/proj on main",
      "❯ cargo build",
      ...Array.from({ length: 120 }, (_, i) => `warning: unused variable \`x${i}\` --> src/lib.rs:${i}:9`),
      "error[E0308]: mismatched types",
    ];
    const out = clipBlock(lines);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain("❯ cargo build");
    expect(out.endsWith("error[E0308]: mismatched types")).toBe(true);
  });
});
