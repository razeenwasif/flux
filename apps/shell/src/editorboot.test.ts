import { describe, expect, it } from "vitest";

import {
  BOOT_CMD,
  EDITOR_SESSION_BASE,
  MAX_QUICK_EXITS,
  MIN_HEALTHY_MS,
  QUICK_EXIT_MS,
  bootCommand,
  exitAction,
  sessionFor,
  socketPath,
  socketPathFor,
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

  it("refuses a run of quick exits, which a slow shell rc hides", () => {
    // With the editor missing, a shell whose rc takes 3 s still exits after 3 s:
    // past the instant-exit check, so on its own it would relaunch forever.
    const slow = MIN_HEALTHY_MS + 1_000;
    expect(exitAction(slow, 0)).toBe("relaunch");
    expect(exitAction(slow, MAX_QUICK_EXITS - 2)).toBe("relaunch");
    expect(exitAction(slow, MAX_QUICK_EXITS - 1)).toBe("fail");
    // A session that was actually used isn't part of a run.
    expect(exitAction(QUICK_EXIT_MS, 10)).toBe("relaunch");
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
    expect(socketPathFor(7, false)).toBe("/tmp/flux-nvim-7.sock");
    expect(socketPathFor(EDITOR_SESSION_BASE, false)).toBe(
      `/tmp/flux-nvim-${EDITOR_SESSION_BASE}.sock`,
    );
    // Windows: a named pipe, since nvim there won't listen on a file path at
    // all. Forward slashes — the name travels through an MSYS2 bash, which
    // would eat the backslashes of the `\\.\pipe\…` spelling.
    expect(socketPathFor(7, true)).toBe("//./pipe/flux-nvim-7");
    expect(socketPathFor(7, true)).not.toContain("\\");
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

  it("ends the shell with the editor", () => {
    // It's typed into an interactive shell: without the exit, `:q` (or a missing
    // editor) leaves a prompt behind, the PTY never ends, and the column neither
    // relaunches nor reports anything.
    expect(bootCommand("/tmp/flux-nvim-9.sock").endsWith("; exit")).toBe(true);
    expect(bootCommand("//./pipe/flux-nvim-9").endsWith("; exit")).toBe(true);
  });

  it("doesn't try to rm a named pipe", () => {
    // A pipe isn't a file: `rm -f` can't clear it, and nothing needs clearing —
    // Windows drops the name when the last handle closes. Sweeping anyway would
    // fail the `&&` and stop the editor from booting at all.
    const cmd = bootCommand("//./pipe/flux-nvim-9");
    expect(cmd).toBe(`${BOOT_CMD} --listen '//./pipe/flux-nvim-9'; exit`);
    expect(cmd).not.toContain("rm -f");
  });

  it("boots the editor without a redundant cd", () => {
    // The PTY already starts in $HOME for a non-tab session; a `cd ~` here would
    // be a second source of truth for the same thing.
    expect(BOOT_CMD).toBe("nvim");
    expect(BOOT_CMD).not.toMatch(/\bcd\b/);
  });
});
