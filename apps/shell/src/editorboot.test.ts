import { describe, expect, it } from "vitest";

import { BOOT_CMD, EDITOR_SESSION_BASE, MIN_HEALTHY_MS, exitAction, sessionFor } from "./editorboot";

describe("editor column boot policy", () => {
  it("relaunches a session the user actually used", () => {
    expect(exitAction(MIN_HEALTHY_MS)).toBe("relaunch");
    expect(exitAction(30_000)).toBe("relaunch");
  });

  it("refuses to relaunch one that died on startup", () => {
    // The whole point of the guard: `nvim` missing from PATH exits instantly, and
    // relaunching that is an infinite loop, not a feature.
    expect(exitAction(0)).toBe("fail");
    expect(exitAction(MIN_HEALTHY_MS - 1)).toBe("fail");
  });

  it("allocates session ids that can't collide with the other PTY owners", () => {
    // Tab ids start at 1 and climb slowly; TUI panes and the terminal column's
    // split panes have their own bases. A collision would cross-wire two live
    // PTYs, so the ranges must stay disjoint.
    const TUI_PANE_BASE = 0xe000_0000;
    const COL_PANE_BASE = 0xf000_0000;
    expect(EDITOR_SESSION_BASE).toBeLessThan(TUI_PANE_BASE);
    expect(EDITOR_SESSION_BASE).toBeLessThan(COL_PANE_BASE);

    // Even after a great many relaunches it stays inside its own range.
    expect(sessionFor(0)).toBe(EDITOR_SESSION_BASE);
    expect(sessionFor(1)).toBe(EDITOR_SESSION_BASE + 1);
    expect(sessionFor(1_000_000)).toBeLessThan(TUI_PANE_BASE);
    // …and never collides with a plausible tab id.
    expect(sessionFor(0)).toBeGreaterThan(100_000);
  });

  it("boots the editor without a redundant cd", () => {
    // The PTY already starts in $HOME for a non-tab session; a `cd ~` here would
    // be a second source of truth for the same thing.
    expect(BOOT_CMD).toBe("nvim");
    expect(BOOT_CMD).not.toMatch(/\bcd\b/);
  });
});
