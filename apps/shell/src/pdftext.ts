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
import { ocrImage, pdfFetch } from "./ipc";

/** Enough for a summary; a whole textbook would blow the model's context long
 *  before it ran out of value. Mirrors the viewer's own cap. */
const MAX_CHARS = 60_000;

/** How many pages the agent will OCR unprompted.
 *
 *  OCR is a subprocess per page — roughly a second each — so a 300-page scan is
 *  five minutes of a task loop that looks hung. Forty covers a lecture deck or a
 *  paper, and anything longer is a deliberate act the user should start from the
 *  viewer, where the progress is visible and interruptible. */
const OCR_PAGE_CAP = 40;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjs: any = null;
const ensurePdfjs = async () => {
  if (pdfjs) return pdfjs;
  pdfjs = await import("pdfjs-dist");
  const PdfWorker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  return pdfjs;
};

/**
 * Render one page to a base64 PNG for OCR.
 *
 * **2x**: OCR accuracy falls off sharply below ~200dpi and screen scale is well
 * under that. The canvas is freed before returning — a 2x A4 bitmap is ~30 MB,
 * and holding one per page turns a long scan into a hundreds-of-MB spike.
 *
 * Shared by the viewer's "Read with OCR" button and the agent's automatic pass:
 * both need exactly this, and the two numbers above are the kind that drift
 * apart silently when copied.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function renderPageToPngB64(doc: any, pageNo: number): Promise<string> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement("canvas");
  c.width = vp.width;
  c.height = vp.height;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const b64 = c.toDataURL("image/png").split(",")[1] ?? "";
  c.width = 0;
  c.height = 0;
  return b64;
}

/**
 * OCR a whole document, page by page. Returns the pages that yielded anything.
 *
 * `onPage` reports progress — this is slow (a subprocess per page), and a
 * silent minute is indistinguishable from a hang. A page that fails is skipped
 * rather than aborting: one unreadable page shouldn't lose the other forty.
 */
export async function ocrDocument(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  onPage?: (page: number, total: number) => void,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<{ text: string; pagesRead: number; total: number; truncated: boolean }> {
  const total: number = doc.numPages;
  const limit = Math.min(total, maxPages);
  const parts: string[] = [];
  for (let i = 1; i <= limit; i++) {
    onPage?.(i, limit);
    const b64 = await renderPageToPngB64(doc, i);
    if (!b64) break;
    const text = await ocrImage(b64).catch((e) => {
      console.warn("[flux ocr] page", i, e);
      return "";
    });
    if (text.trim()) parts.push(`[page ${i}] ${text.trim()}`);
  }
  return {
    text: parts.join("\n\n"),
    pagesRead: parts.length,
    total,
    truncated: limit < total,
  };
}

export interface PdfText {
  text: string;
  pages: number;
  /** Pages that yielded any text at all. Far below `pages` means a scan. */
  pagesWithText: number;
  truncated: boolean;
  /** True when the text came from OCR rather than the document's text layer —
   *  a machine read it off an image, so it may not say quite what the page says. */
  ocr: boolean;
}

export async function readPdfText(
  path: string,
  /** Called when the document has no text layer and OCR is about to run, then
   *  once per page. Returning false from the first call skips OCR. */
  onOcr?: (page: number, total: number) => void,
  /** Whether OCR is worth attempting — the caller checks for a tesseract binary. */
  canOcr = false,
): Promise<PdfText> {
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
  // A scan has no text layer, and telling the user to go and click "Read with
  // OCR" themselves is asking them to do by hand the one thing the agent was
  // asked to do. The machinery is right here; run it.
  if (!parts.length && canOcr) {
    const { text, pagesRead, total, truncated } = await ocrDocument(doc, onOcr, OCR_PAGE_CAP);
    return { text, pages: total, pagesWithText: pagesRead, truncated, ocr: true };
  }

  return {
    text: parts.join("\n\n"),
    pages: doc.numPages,
    pagesWithText,
    truncated: chars >= MAX_CHARS,
    ocr: false,
  };
}
