import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { drawableText } from "./pdffont";

describe("drawableText", () => {
  it("lets pdf-lib draw a note it used to throw on", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const glyphs = new Set(font.getCharacterSet());
    const page = doc.addPage();

    // What failed Save and every page-op while such a note existed.
    expect(() => page.drawText("✓ approved", { font, size: 12 })).toThrow();
    const t = drawableText("✓ approved", glyphs);
    expect(t).toEqual({ text: "? approved", replaced: true });
    expect(() => page.drawText(t.text, { font, size: 12 })).not.toThrow();

    expect(drawableText("日本語 · Привет", glyphs).text).toBe("??? · ??????");
    expect(drawableText("ok 😀", glyphs).text).toBe("ok ?"); // one code point, one "?"
  });

  it("keeps everything WinAnsi can encode, and says nothing was replaced", async () => {
    const doc = await PDFDocument.create();
    const glyphs = new Set((await doc.embedFont(StandardFonts.Helvetica)).getCharacterSet());
    expect(drawableText("café – “q” €5", glyphs)).toEqual({ text: "café – “q” €5", replaced: false });
  });
});
