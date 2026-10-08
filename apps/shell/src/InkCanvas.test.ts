import { describe, expect, it, vi } from "vitest";

import {
  fontSizeOf,
  inkBox,
  lineHeightOf,
  textBox,
  typingInto,
  wrapText,
  type TextStroke,
} from "./InkCanvas";

// Text layout measures glyphs on a canvas, and importing a Solid component
// registers its delegated events on `window.document`; Node has neither. Stand
// in just enough of both before the import runs, with a monospace font: every
// character is half the font size wide.
vi.hoisted(() => {
  const ctx = {
    font: "",
    measureText(text: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
      return { width: text.length * px * 0.5 };
    },
  };
  const document = { createElement: () => ({ getContext: () => ctx }), addEventListener: () => {} };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document });
});

/** A block as the Scribe pad writes it: 12 pt on a 150 dpi page, wrapping at
 *  the pad's right margin. */
const padText = (text: string, extra: Partial<TextStroke> = {}): TextStroke => ({
  t: "text",
  color: "#2ff3ff",
  size: 25,
  at: { x: 48, y: 342.5 },
  text,
  w: 804,
  ...extra,
});

describe("what a text block paints (eraser target, PNG crop)", () => {
  it("covers every line, not just the first baseline", () => {
    // Shift+Enter keeps the newline: the second line sits a full line below `at`,
    // which the old crop (first baseline + 24) cut out of the inserted drawing.
    const s = padText("caption\nsecond line");
    const b = inkBox(s);
    expect(b.y1).toBeGreaterThanOrEqual(s.at.y + lineHeightOf(s));
    expect(b.y0).toBeLessThanOrEqual(s.at.y - fontSizeOf(s));
  });

  it("covers a paragraph that wrapped", () => {
    const s = padText(Array(60).fill("word").join(" "));
    const lines = wrapText(s);
    expect(lines.length).toBeGreaterThan(1);
    const b = inkBox(s);
    expect(b.y1).toBeGreaterThanOrEqual(s.at.y + (lines.length - 1) * lineHeightOf(s));
    expect(b.x1 - b.x0).toBeLessThanOrEqual(s.w!);
  });

  it("is only as wide as the widest line, not the wrap width", () => {
    // `textBox` spans the wrap width so a click anywhere along the line edits
    // it — far too wide for the eraser or the crop of a short label.
    const s = padText("caption\nsecond line");
    expect(textBox(s).x1).toBe(s.at.x + s.w!);
    expect(inkBox(s).x1).toBe(s.at.x + "second line".length * fontSizeOf(s) * 0.5);
  });

  it("reaches the top of a heading", () => {
    // H1 renders at about twice the stored size.
    const s = padText("Limits", { style: "h1" });
    expect(inkBox(s).y0).toBeLessThanOrEqual(s.at.y - s.size * 2);
  });
});

describe("canvas shortcuts", () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as never;

  it("leave other people's typing alone", () => {
    // A Scribe page is a contenteditable DIV: with a whiteboard panel open in
    // the same document, its "t" opened the board's text box and took the caret.
    expect(typingInto(el("DIV", true))).toBe(true);
    expect(typingInto(el("P", true))).toBe(true); // a paragraph inside the page
    expect(typingInto(el("INPUT"))).toBe(true);
    expect(typingInto(el("TEXTAREA"))).toBe(true);
    expect(typingInto(el("SELECT"))).toBe(true); // the pt-size picker
  });

  it("still fire from the canvas, its buttons and the page background", () => {
    expect(typingInto(el("CANVAS"))).toBe(false);
    expect(typingInto(el("BUTTON"))).toBe(false);
    expect(typingInto(el("BODY"))).toBe(false);
    expect(typingInto(null)).toBe(false);
  });
});
