/**
 * Per-document reading state for the PDF viewer (#155): where you were, how far
 * you'd zoomed, your bookmarks and your comments.
 *
 * **Why this exists at all:** a PDF tab's viewer unmounts when you switch away
 * from it — ContentArea renders only the active tab's internal page — so coming
 * back re-fetched the bytes and re-rendered from scratch, landing you on page 1
 * of a 300-page paper every single time. Keeping every PDF mounted (the
 * terminal keep-alive trick) would cost a decoded document per tab; recording
 * where you were costs a few hundred bytes.
 *
 * **Bookmarks and comments are sidecar, not burned into the PDF.** The editor's
 * annotations become part of the file on Save, which is right for markup you
 * want other readers to see. These are reading state — the whole point is that
 * they don't modify the document, so a bookmark can't dirty a file you only
 * meant to read. The trade is that they live on this machine only and are keyed
 * to the source path: move the file and they don't follow it.
 *
 * Keyed by source rather than by tab id, so the state follows the *document*
 * across tabs, closes and restarts.
 */

export interface PdfBookmark {
  id: number;
  page: number;
  label: string;
  ms: number;
}

export interface PdfComment {
  id: number;
  page: number;
  text: string;
  ms: number;
}

export interface PdfDocState {
  /** 1-based page you were last looking at. */
  page: number;
  scale: number;
  bookmarks: PdfBookmark[];
  comments: PdfComment[];
}

/** Matches the viewer's initial zoom. */
export const DEFAULT_SCALE = 1.2;

export const emptyState = (): PdfDocState => ({
  page: 1,
  scale: DEFAULT_SCALE,
  bookmarks: [],
  comments: [],
});

/** FNV-1a over the source string. A full path can be long and contains
 *  characters that make for miserable storage keys; a hash is fixed-width and
 *  opaque. Collisions would swap two documents' bookmarks, which at 32 bits and
 *  a personal library's worth of PDFs is not a risk worth more code. */
export function keyFor(src: string): string {
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `flux.pdf.${(h >>> 0).toString(36)}`;
}

/** Coerce whatever is in storage into a valid state. Anything unparseable,
 *  truncated or hand-edited yields defaults rather than throwing — a corrupt
 *  entry must never stop a document from opening. */
export function parseState(raw: string | null): PdfDocState {
  if (!raw) return emptyState();
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!o || typeof o !== "object") return emptyState();
  const r = o as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  const list = <T>(v: unknown, pick: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v)
      ? v.flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const got = pick(x as Record<string, unknown>);
          return got ? [got] : [];
        })
      : [];

  return {
    page: Math.max(1, Math.round(num(r.page, 1))),
    // Clamped to the viewer's own zoom range, so a bad value can't render a
    // page at 400x and hang on a canvas allocation.
    scale: Math.min(4, Math.max(0.4, num(r.scale, DEFAULT_SCALE))),
    bookmarks: list<PdfBookmark>(r.bookmarks, (x) =>
      typeof x.label === "string"
        ? {
            id: num(x.id, 0),
            page: Math.max(1, Math.round(num(x.page, 1))),
            label: x.label,
            ms: num(x.ms, 0),
          }
        : null,
    ),
    comments: list<PdfComment>(r.comments, (x) =>
      typeof x.text === "string"
        ? {
            id: num(x.id, 0),
            page: Math.max(1, Math.round(num(x.page, 1))),
            text: x.text,
            ms: num(x.ms, 0),
          }
        : null,
    ),
  };
}

export function loadDocState(src: string): PdfDocState {
  if (!src) return emptyState();
  try {
    return parseState(localStorage.getItem(keyFor(src)));
  } catch {
    return emptyState();
  }
}

/** Persist, or drop the entry entirely when there's nothing worth keeping —
 *  otherwise every PDF ever opened leaves a row behind forever. */
export function saveDocState(src: string, s: PdfDocState): void {
  if (!src) return;
  const worthless =
    s.page <= 1 && s.scale === DEFAULT_SCALE && s.bookmarks.length === 0 && s.comments.length === 0;
  try {
    if (worthless) localStorage.removeItem(keyFor(src));
    else localStorage.setItem(keyFor(src), JSON.stringify(s));
  } catch {
    /* quota or a locked-down storage partition — reading state isn't worth a throw */
  }
}
