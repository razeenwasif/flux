import { describe, expect, it } from "vitest";

import {
  ago,
  calculate,
  highlight,
  keepSelection,
  layout,
  looksLikeAddress,
  matchScore,
  parseQuery,
  type SectionKind,
} from "./launcherModel";

const rows = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const all = (counts: Partial<Record<SectionKind, number>>) => ({
  search: rows(counts.search ?? 0, "s"),
  tabs: rows(counts.tabs ?? 0, "t"),
  history: rows(counts.history ?? 0, "h"),
  notes: rows(counts.notes ?? 0, "n"),
  commands: rows(counts.commands ?? 0, "c"),
});

describe("parseQuery", () => {
  it("reads the scopes", () => {
    expect(parseQuery("attention")).toEqual({ scope: "all", q: "attention" });
    expect(parseQuery("@tabs attention")).toEqual({ scope: "tabs", q: "attention" });
    expect(parseQuery("@HISTORY  rust book")).toEqual({ scope: "history", q: "rust book" });
    expect(parseQuery("@notes")).toEqual({ scope: "notes", q: "" });
    expect(parseQuery("> split")).toEqual({ scope: "commands", q: "split" });
    expect(parseQuery(">")).toEqual({ scope: "commands", q: "" });
  });

  it("doesn't take an address for a scope", () => {
    expect(parseQuery("@tabsome")).toEqual({ scope: "all", q: "@tabsome" });
  });
});

describe("layout", () => {
  it("keeps the order and caps 3, 4, 2, 2, with commands taking the rest of 14", () => {
    const out = layout(all({ search: 3, tabs: 9, history: 23, notes: 5, commands: 20 }), "all");
    expect(out.map((s) => [s.kind, s.rows.length, s.total])).toEqual([
      ["search", 3, 3],
      ["tabs", 4, 9],
      ["history", 2, 23],
      ["notes", 2, 5],
      ["commands", 3, 20],
    ]);
  });

  it("gives commands the room an empty section leaves", () => {
    const out = layout(all({ search: 1, commands: 20 }), "all");
    expect(out.map((s) => [s.kind, s.rows.length])).toEqual([
      ["search", 1],
      ["commands", 13],
    ]);
  });

  it("gives a scoped section all 14 rows", () => {
    const out = layout(all({ search: 2, history: 30, commands: 5 }), "history");
    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toHaveLength(14);
    expect(out[0]!.total).toBe(30);
  });
});

describe("keepSelection", () => {
  it("stays on the same row when late results land above it", () => {
    expect(keepSelection("c1", ["s0", "c0", "c1"], 2)).toBe(2);
    expect(keepSelection("c1", ["s0", "t0", "t1", "c0", "c1"], 2)).toBe(4);
  });

  it("falls back to the same place, clamped", () => {
    expect(keepSelection("gone", ["a", "b"], 5)).toBe(1);
    expect(keepSelection(null, [], 3)).toBe(0);
  });
});

describe("matching", () => {
  it("needs every word, and ranks a start above a middle", () => {
    expect(matchScore("split view", "Split view (tile up to four tabs)")).toBeGreaterThan(0);
    expect(matchScore("split zebra", "Split view")).toBe(0);
    expect(matchScore("att", "Attention")).toBeGreaterThan(matchScore("att", "Self-attention"));
    expect(matchScore("att", "Self-attention")).toBeGreaterThan(matchScore("tent", "Self-attention"));
  });

  it("marks every match", () => {
    expect(highlight("Self-attention: attention", "attention")).toEqual([
      { text: "Self-", hit: false },
      { text: "attention", hit: true },
      { text: ": ", hit: false },
      { text: "attention", hit: true },
    ]);
    expect(highlight("Hacker News", "")).toEqual([{ text: "Hacker News", hit: false }]);
  });
});

describe("looksLikeAddress", () => {
  it("tells an address from words", () => {
    for (const a of [
      "arxiv.org",
      "news.ycombinator.com/item?id=1",
      "localhost:5173",
      "https://x.y/z",
      "10.0.0.2",
    ])
      expect(looksLikeAddress(a), a).toBe(true);
    for (const w of ["attention", "rust book", "e.g", "3.14"]) expect(looksLikeAddress(w), w).toBe(false);
  });
});

describe("calculate", () => {
  it("does sums, including the percent forms", () => {
    expect(calculate("80 + 15%")).toBe(92);
    expect(calculate("200 - 10%")).toBe(180);
    expect(calculate("15% * 80")).toBe(12);
    expect(calculate("2 ^ 10")).toBe(1024);
    expect(calculate("(1 + 2) × 3")).toBe(9);
    expect(calculate("1,000 / 8")).toBe(125);
    expect(calculate("-3 + 5")).toBe(2);
    expect(calculate("7 / 2")).toBe(3.5);
  });

  it("isn't a sum without an operator, or with words", () => {
    for (const s of ["2024", "-4", "rust 2024", "80 +", "1 / 0", "(2 + 3", ""])
      expect(calculate(s), s).toBeNull();
  });
});

describe("ago", () => {
  const now = Date.UTC(2026, 9, 25, 12);
  it("reads like the history column", () => {
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h");
    expect(ago(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 d");
    expect(ago(now - 9 * 86_400_000, now)).toBe("last week");
  });
});
