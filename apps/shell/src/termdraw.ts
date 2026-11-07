/**
 * What the terminal draws beyond plain cells: ligatures and inline images.
 *
 * Ligatures: the bundled font (Cascadia Code) has them, but a terminal draws cell
 * by cell, so they never form. Telling xterm to draw a run of symbols as one lets
 * the font shape it. The font forms hundreds of them, in context ("=>", "<!--",
 * "|>"), so it's whole runs that are joined rather than a list of sequences. Its
 * few with a bracket ("[|", "#{") stay apart, to keep this small.
 * (`@xterm/addon-ligatures` finds them by reading font files from disk, which a
 * webview can't do.)
 *
 * Images: the addon stays off first paint and out of the default boot, until a
 * program first sends something that might be one, or asks whether the terminal
 * can show them (it answers yes only once the addon is in).
 */

/** Long enough for any ligature in the font. Past it, a run is a ruler or a
 *  divider ("--------"), and drawing it as one would fill the glyph atlas. */
const MAX_RUN = 8;
const RUN = /[-!#$%&*+./:;<=>?@\\^_|~]{2,}/g;
/** The ranges of `text` to draw as one, for `registerCharacterJoiner`. */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(RUN)) {
    if (m[0].length <= MAX_RUN) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

const ESC = 0x1b;
const P = 0x50; // ESC P opens a device control string, as Sixel does
const CSI = 0x5b; // "["
const ITERM_IMAGE = [0x5d, 0x31, 0x33, 0x33, 0x37, 0x3b]; // "]1337;" (iTerm's image protocol)

/** "ESC [ c" or "ESC [ 0 c" (which terminal is this?), or "ESC [ ? … S" (how many
 *  colours and pixels can it do?): how a program finds out about Sixel. */
function asksAboutImages(bytes: Uint8Array, at: number): boolean {
  const c = (n: number) => String.fromCharCode(bytes[at + n] ?? 0);
  if (c(0) === "c" || (c(0) === "0" && c(1) === "c")) return true;
  if (c(0) !== "?") return false;
  for (let n = 1; n < 24; n++) {
    if (c(n) === "S") return true;
    if (!/[0-9;]/.test(c(n))) return false;
  }
  return false;
}

/** Whether program output may hold an inline image or ask about them. A false
 *  positive only loads the addon early. */
export function mayHoldImage(bytes: Uint8Array): boolean {
  for (let i = bytes.indexOf(ESC); i !== -1; i = bytes.indexOf(ESC, i + 1)) {
    if (bytes[i + 1] === P) return true;
    if (ITERM_IMAGE.every((b, n) => bytes[i + 1 + n] === b)) return true;
    if (bytes[i + 1] === CSI && asksAboutImages(bytes, i + 2)) return true;
  }
  return false;
}
