import { describe, expect, it } from "vitest";
import { DEFAULT_FAVORITES, matchesLauncher, readFavorites } from "./launcherPreferences";
import { FOCUSED_HIDDEN, WIDGETS, readHidden, readOrder } from "./startPreferences";
import { shortcutLabel } from "./platform";
describe("launcher preferences", () => {
  it("preserves deliberately empty favorites and recovers malformed storage", () => {
    expect(readFavorites("[]")).toEqual([]);
    for (const raw of [null, "null", "{}", "broken"]) expect(readFavorites(raw)).toEqual(DEFAULT_FAVORITES);
  });
  it("deduplicates valid identifiers and caps the rail at six", () => {
    expect(
      readFavorites(
        JSON.stringify([
          null,
          5,
          "garbage",
          "page:flux://history",
          "page:flux://history",
          ...Array.from({ length: 8 }, (_, i) => `terminal:${i}`),
        ]),
      ),
    ).toEqual(["page:flux://history", "terminal:0", "terminal:1", "terminal:2", "terminal:3", "terminal:4"]);
  });
  it("matches all query terms across names and commands without case sensitivity", () => {
    expect(matchesLauncher("  GIT term ", "LazyGit", "Terminal", "lazygit")).toBe(true);
    expect(matchesLauncher("git notebook", "LazyGit", "Terminal")).toBe(false);
    expect(matchesLauncher("", "Notebook")).toBe(true);
  });
});
describe("home preferences", () => {
  it("defaults to focused home while preserving an explicit show-all choice", () => {
    expect(readHidden(null)).toEqual(FOCUSED_HIDDEN);
    expect(readHidden("[]")).toEqual([]);
    expect(readHidden('["headlines","headlines","removed",42]')).toEqual(["headlines"]);
  });
  it("repairs invalid data and appends new widgets without duplicating saved order", () => {
    const keys = WIDGETS.map((w) => w.key);
    for (const raw of [null, "null", "{}", "broken"]) expect(readOrder(raw)).toEqual(keys);
    const order = readOrder('["calc","calc","recent","removed"]');
    expect(order.slice(0, 2)).toEqual(["calc", "recent"]);
    expect(new Set(order).size).toBe(keys.length);
    expect(readHidden("{}")).toEqual(FOCUSED_HIDDEN);
  });
});
it("formats platform shortcuts without changing the action", () => {
  expect(shortcutLabel("Toggle editor (Ctrl+Shift+E)", true)).toBe("Toggle editor (⌘⇧E)");
  expect(shortcutLabel("Ctrl+Shift+E", false)).toBe("Ctrl+Shift+E");
});
