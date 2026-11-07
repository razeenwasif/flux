import { describe, expect, it } from "vitest";

import { canRunWasm } from "./termimages";
import { ligatureRanges, mayHoldImage } from "./termdraw";

const joined = (text: string) => ligatureRanges(text).map(([a, b]) => text.slice(a, b));
const bytes = (s: string) => new TextEncoder().encode(s);

describe("ligatureRanges", () => {
  it("joins runs of symbols, in order", () => {
    expect(joined("if a != b => c |> d")).toEqual(["!=", "=>", "|>"]);
    expect(ligatureRanges("a => b")).toEqual([[2, 4]]);
    expect(joined("<!-- x --> <=> ===")).toEqual(["<!--", "-->", "<=>", "==="]);
  });

  it("leaves words and lone symbols alone", () => {
    expect(ligatureRanges("hello world = 1 - 2")).toEqual([]);
    expect(ligatureRanges("")).toEqual([]);
  });

  it("doesn't join a ruler, which would fill the glyph atlas", () => {
    expect(ligatureRanges("-".repeat(9))).toEqual([]);
    expect(joined("-".repeat(8))).toEqual(["-".repeat(8)]);
    expect(joined(`${"=".repeat(40)} a -> b`)).toEqual(["->"]);
  });

  it("leaves brackets out of a run", () => {
    expect(joined("[| a |] x ||] y")).toEqual(["||"]);
  });
});

describe("mayHoldImage", () => {
  it("sees Sixel and iTerm's image protocol", () => {
    expect(mayHoldImage(bytes("before \x1bPq#0;2;0;0;0~-\x1b\\"))).toBe(true);
    expect(mayHoldImage(bytes("\x1b[0m\x1b]1337;File=inline=1:AAAA\x07"))).toBe(true);
  });

  it("sees a program asking whether the terminal can show them", () => {
    expect(mayHoldImage(bytes("\x1b[c"))).toBe(true);
    expect(mayHoldImage(bytes("\x1b[0c"))).toBe(true);
    expect(mayHoldImage(bytes("\x1b[?2;1;0S"))).toBe(true);
  });

  it("isn't set off by ordinary output", () => {
    expect(mayHoldImage(bytes("plain text, P ]1337;"))).toBe(false);
    expect(mayHoldImage(bytes("\x1b[31mred\x1b[0m \x1b]0;a title\x07 \x1b]133;A\x07"))).toBe(false);
    expect(mayHoldImage(bytes("\x1b[?25h\x1b[?2004l\x1b[2J\x1b[H\x1b[1c"))).toBe(false);
    expect(mayHoldImage(bytes("ends on ESC \x1b"))).toBe(false);
    expect(mayHoldImage(new Uint8Array())).toBe(false);
  });
});

describe("canRunWasm", () => {
  it("is true where WebAssembly runs, and false where it's refused", () => {
    expect(canRunWasm()).toBe(true);
    const real = WebAssembly.Module;
    WebAssembly.Module = function () {
      throw new WebAssembly.CompileError("refused by policy");
    } as unknown as typeof WebAssembly.Module;
    try {
      expect(canRunWasm()).toBe(false);
    } finally {
      WebAssembly.Module = real;
    }
  });
});
