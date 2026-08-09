import { describe, expect, it } from "vitest";

import {
  BOOT_CMD,
  EDITOR_SESSION_BASE,
  MIN_HEALTHY_MS,
  bootCommand,
  exitAction,
  sessionFor,
  socketPath,
} from "./editorboot";

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

  it("pins the socket format that Rust also derives", () => {
    // The two sides never exchange this path — each computes it. Pinning the
    // literal here and in `flux_core::nvim`'s tests means changing one without
    // the other fails a test instead of silently breaking RPC.
    expect(socketPath(7)).toBe("/tmp/flux-nvim-7.sock");
    expect(socketPath(EDITOR_SESSION_BASE)).toBe(`/tmp/flux-nvim-${EDITOR_SESSION_BASE}.sock`);
    // Distinct per session, or two columns would fight over one socket.
    expect(socketPath(7)).not.toBe(socketPath(8));
  });

  it("boots with an RPC socket, clearing a stale one first", () => {
    // nvim refuses to listen on a path that exists, so a crash would otherwise
    // leave the column permanently unable to start.
    const cmd = bootCommand("/tmp/flux-nvim-9.sock");
    expect(cmd).toContain("--listen");
    expect(cmd).toContain("/tmp/flux-nvim-9.sock");
    expect(cmd.indexOf("rm -f")).toBeLessThan(cmd.indexOf("--listen"));
    // …and only starts the editor if the removal succeeded.
    expect(cmd).toContain("&&");
  });

  it("boots the editor without a redundant cd", () => {
    // The PTY already starts in $HOME for a non-tab session; a `cd ~` here would
    // be a second source of truth for the same thing.
    expect(BOOT_CMD).toBe("nvim");
    expect(BOOT_CMD).not.toMatch(/\bcd\b/);
  });
});
