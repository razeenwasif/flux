/**
 * What the PDF editor's text notes can be burned in with.
 *
 * pdf-lib draws them in Helvetica, a WinAnsi font, and `drawText()` throws on any
 * character outside that set (CJK, Cyrillic, Greek, ✓, →, emoji). One such note
 * failed Save and every page-op until it was erased. Drawing the full text would
 * need an embedded TTF and @pdf-lib/fontkit; until then the characters the font
 * can't draw are written as "?", and the caller tells the user so.
 */

/** `text` with every code point outside `glyphs` (a font's `getCharacterSet()`) as "?". */
export function drawableText(text: string, glyphs: ReadonlySet<number>): { text: string; replaced: boolean } {
  let replaced = false;
  // Array.from walks code points, so an emoji's surrogate pair is one "?".
  const out = Array.from(text, (ch) => {
    if (glyphs.has(ch.codePointAt(0)!)) return ch;
    replaced = true;
    return "?";
  }).join("");
  return { text: out, replaced };
}
