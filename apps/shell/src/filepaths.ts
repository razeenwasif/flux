/**
 * Path helpers for the Files view, kept out of the component so they can be
 * tested: quiet string logic whose mistakes only show on unusual names.
 */

/** Turn a local OS path into a file:// URL (handles Windows drive paths + backslashes). */
export function toFileUrl(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s; // C:/Users/… → /C:/Users/…
  // encodeURI leaves `#` and `?` alone (they're URL delimiters), so "C# notes.md"
  // opened …/C and "#1 report.pdf" opened its folder instead of the PDF viewer.
  return "file://" + encodeURI(s).replace(/[#?]/g, (c) => encodeURIComponent(c));
}
