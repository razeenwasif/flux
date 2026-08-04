/**
 * Extract a PDF's text so the agent can actually read one (#158).
 *
 * "read <path>" used `read_text_file`, which on a PDF returns the raw container
 * — `%PDF-1.7`, object headers, compressed streams. The model would dutifully
 * take that as the document's contents and summarise the binary. So a request to
 * go through a folder of lecture slides could not work even once the loop
 * reached the files.
 *
 * The bytes come from Rust (`pdf_fetch`, the same CORS-free path the viewer
 * uses) and the text comes from PDF.js here, rather than a second extractor in
 * Rust: PDF.js is already a dependency, already lazy-loaded, and already the
 * thing whose output the KB indexes — so a PDF reads the same way whether the
 * agent or the viewer opened it. A Rust implementation would be a second answer
 * to the same question, free to disagree.
 */
import { pdfFetch } from "./ipc";

/** Enough for a summary; a whole textbook would blow the model's context long
 *  before it ran out of value. Mirrors the viewer's own cap. */
const MAX_CHARS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjs: any = null;
const ensurePdfjs = async () => {
  if (pdfjs) return pdfjs;
  pdfjs = await import("pdfjs-dist");
  const PdfWorker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  return pdfjs;
};

export interface PdfText {
  text: string;
  pages: number;
  /** Pages that yielded any text at all. Far below `pages` means a scan. */
  pagesWithText: number;
  truncated: boolean;
}

export async function readPdfText(path: string): Promise<PdfText> {
  const buf = await pdfFetch(path);
  if (!buf || buf.byteLength === 0) throw new Error(`Couldn't read ${path}`);
  const lib = await ensurePdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const parts: string[] = [];
  let chars = 0;
  let pagesWithText = 0;
  for (let i = 1; i <= doc.numPages && chars < MAX_CHARS; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    // PDF.js gives positioned runs, not lines. Joining on spaces is what a
    // reader wants anyway — it reads prose, not layout.
    const page = content.items
      .map((it: { str?: string }) => it.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (page) {
      // Page-numbered, because a summary that can cite "slide 12" is worth far
      // more than one that can't, and the model has no other way to know.
      parts.push(`[page ${i}] ${page}`);
      chars += page.length;
      pagesWithText++;
    }
  }
  return {
    text: parts.join("\n\n"),
    pages: doc.numPages,
    pagesWithText,
    truncated: chars >= MAX_CHARS,
  };
}
