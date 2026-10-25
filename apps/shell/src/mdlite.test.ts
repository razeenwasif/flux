import { describe, expect, it } from "vitest";

import { parseBlocks, parseInline, toggleTask } from "./mdlite";

describe("notes markdown", () => {
  it("reads headings, paragraphs, lists, quotes, rules and code", () => {
    const blocks = parseBlocks(
      "# Lab 6\n\nSome *quiet* words\nthat wrap.\n\n- one\n  - nested\n1. first\n> said\n---\n```\nlet x = 1;\n```\n",
    );
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "li", "li", "li", "quote", "hr", "code"]);
    expect(blocks[1]).toEqual({
      t: "p",
      inl: [
        { t: "text", v: "Some " },
        { t: "i", v: "quiet" },
        { t: "text", v: " words that wrap." },
      ],
    });
    expect(blocks[3]).toMatchObject({ t: "li", depth: 1, marker: "•" });
    expect(blocks[4]).toMatchObject({ t: "li", marker: "1." });
    expect(blocks[7]).toEqual({ t: "code", text: "let x = 1;" });
  });

  it("keeps a task's source line, past frontmatter", () => {
    const src = "---\ntags: [uni]\n---\n# To do\n- [ ] read the spec\n- [x] set up the repo\n";
    const tasks = parseBlocks(src).filter((b) => b.t === "task");
    expect(tasks).toMatchObject([
      { done: false, line: 4 },
      { done: true, line: 5 },
    ]);
  });

  it("ticks exactly the task it's asked to, and nothing else", () => {
    const src = "- [ ] a\n- [x] b\nplain [ ] text";
    expect(toggleTask(src, 0)).toBe("- [x] a\n- [x] b\nplain [ ] text");
    expect(toggleTask(src, 1)).toBe("- [ ] a\n- [ ] b\nplain [ ] text");
    expect(toggleTask(src, 2)).toBe(src);
    expect(toggleTask(src, 9)).toBe(src);
  });

  it("only makes http(s) links", () => {
    expect(parseInline("see [docs](https://tauri.app) and **this** `code`")).toEqual([
      { t: "text", v: "see " },
      { t: "link", v: "docs", href: "https://tauri.app" },
      { t: "text", v: " and " },
      { t: "b", v: "this" },
      { t: "text", v: " " },
      { t: "code", v: "code" },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "[x](javascript:alert(1))" }]);
  });
});
