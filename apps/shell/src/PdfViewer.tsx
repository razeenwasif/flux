/**
 * flux://pdf — built-in PDF viewer + editor (BACKLOG #35 viewer, #112 editor).
 * Renders with PDF.js (lazy-loaded) inside a Flux internal page so PDFs view
 * consistently on both engines. Bytes come from the Rust core (`pdf_fetch`,
 * CORS-free). Source is `flux://pdf?src=<encoded url-or-path>`.
 *
 * The editor adds, on top of the viewer:
 *  • Edit mode — markup (highlight, pen/ink, text, rectangle, arrow), eraser,
 *    undo, colour + stroke. Annotations are stored in **PDF-point space** so they
 *    survive zoom and map cleanly onto the page.
 *  • Pages panel — reorder (drag), rotate, delete, extract a page, merge another
 *    PDF.
 *  • Save — `pdf-lib` burns the annotations into the page bytes and the Rust core
 *    writes the result to Downloads (`pdf_save`). Page-ops always burn the
 *    current annotations first, so annotation→page indices never drift.
 */
import { For, Match, Show, Switch, createEffect, createSignal, onMount, type Component } from "solid-js";
import { ocrAvailable, ocrImage, pdfFetch, pdfPublishText, pdfSave } from "./ipc";
import { tabs, updateTabTitle } from "./store";

// ─── Annotation model (all geometry in PDF points, origin top-left, y-down) ──
type Tool = "pan" | "highlight" | "pen" | "text" | "rect" | "arrow" | "erase";
interface Base {
  id: number;
  page: number;
  color: string;
}
interface RectAnnot extends Base {
  kind: "highlight" | "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}
interface InkAnnot extends Base {
  kind: "pen";
  pts: [number, number][];
  width: number;
}
interface LineAnnot extends Base {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}
interface TextAnnot extends Base {
  kind: "text";
  x: number;
  y: number;
  text: string;
  size: number;
}
type Annot = RectAnnot | InkAnnot | LineAnnot | TextAnnot;

interface Dims {
  w: number;
  h: number;
} // PDF points

// ─── AcroForm fields (BACKLOG #113) ──────────────────────────────────────────
type FieldType = "text" | "checkbox" | "radio" | "dropdown";
interface FormField {
  name: string;
  type: FieldType;
  options?: string[];
}
type FieldValue = string | boolean;
/** A form widget's on-page box (PDF.js geometry), for in-place editing. */
interface WidgetBox {
  id: number;
  page: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  exportValue?: string;
}

const PALETTE = ["#ffd60a", "#ff453a", "#32d74b", "#0a84ff", "#bf5af2", "#1c1c1e"];
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "pan", icon: "✋", label: "Pan / select" },
  { id: "highlight", icon: "🖍️", label: "Highlight" },
  { id: "pen", icon: "✏️", label: "Pen" },
  { id: "text", icon: "T", label: "Text" },
  { id: "rect", icon: "▭", label: "Rectangle" },
  { id: "arrow", icon: "↗", label: "Arrow" },
  { id: "erase", icon: "⌫", label: "Erase (click an annotation)" },
];

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** One viewer instance per PDF tab. `tabId` is what makes that true: the source,
 *  the loaded document and every edit are scoped to THIS tab, never to whichever
 *  tab happens to be active. ContentArea keys the instance on the id (see
 *  FilesView for the same pattern), so switching between two PDF tabs gives each
 *  its own document instead of one shared viewer showing the last-loaded file. */
const PdfViewer: Component<{ tabId: number }> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [scale, setScale] = createSignal(1.2);
  const [numPages, setNumPages] = createSignal(0);
  const [pages, setPages] = createSignal<number[]>([]);
  const [dims, setDims] = createSignal<Dims[]>([]);
  const [src, setSrc] = createSignal("");
  const [docVersion, setDocVersion] = createSignal(0); // bump → re-render pages

  const [mode, setMode] = createSignal<"view" | "edit" | "pages" | "forms">("view");
  const [tool, setTool] = createSignal<Tool>("pan");
  const [color, setColor] = createSignal(PALETTE[0]!);
  const [annots, setAnnots] = createSignal<Annot[]>([]);
  const [draft, setDraft] = createSignal<Annot | null>(null);
  const [textDraft, setTextDraft] = createSignal<{
    page: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [toast, setToast] = createSignal("");

  const [formFields, setFormFields] = createSignal<FormField[]>([]);
  const [formValues, setFormValues] = createSignal<Record<string, FieldValue>>({});
  const [formMsg, setFormMsg] = createSignal("");
  const [flattenOnSave, setFlattenOnSave] = createSignal(false);
  const [widgets, setWidgets] = createSignal<WidgetBox[]>([]);

  let working: Uint8Array = new Uint8Array();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfDoc: any = null;
  const canvases: (HTMLCanvasElement | undefined)[] = [];
  let renderToken = 0;
  let annotId = 1;
  // Drag context for the in-progress annotation.
  let drag: { page: number; rect: DOMRect; w: number; h: number } | null = null;

  const parseSrc = () => {
    // THIS tab's url — not the active tab's. Reading activeTab() here is what
    // made every PDF tab render whichever file was opened last.
    const url = tabs().find((t) => t.id === props.tabId)?.url ?? "";
    const q = url.split("?")[1] ?? "";
    const s = new URLSearchParams(q).get("src");
    try {
      return s ? decodeURIComponent(s) : "";
    } catch {
      return s ?? "";
    }
  };
  const filename = () => {
    const tail = (src().split(/[?#]/)[0] ?? "").split("/").pop() || "PDF";
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  };
  const saveName = () => {
    const f = filename();
    const stem = f.toLowerCase().endsWith(".pdf") ? f.slice(0, -4) : f;
    return `${stem} (edited).pdf`;
  };

  // ── PDF.js load + render ───────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfjs: any = null;
  const ensurePdfjs = async () => {
    if (pdfjs) return pdfjs;
    pdfjs = await import("pdfjs-dist");
    const PdfWorker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
    return pdfjs;
  };

  /** Matches the Rust-side cap; stopping here avoids extracting pages whose text
   *  would only be truncated on arrival. */
  const MAX_TEXT = 400_000;

  /** (Re)load the viewer from a byte buffer (initial load + after a page-op). */
  const loadBytes = async (bytes: Uint8Array) => {
    working = bytes;
    const lib = await ensurePdfjs();
    pdfDoc = await lib.getDocument({ data: bytes.slice() }).promise;
    const n = pdfDoc.numPages;
    const ds: Dims[] = [];
    for (let i = 1; i <= n; i++) {
      const vp = (await pdfDoc.getPage(i)).getViewport({ scale: 1 });
      ds.push({ w: vp.width, h: vp.height });
    }
    setDims(ds);
    setNumPages(n);
    setPages(Array.from({ length: n }, (_, i) => i + 1));
    setReady(true);
    setDocVersion((v) => v + 1);
    void publishText();
  };

  /** Hand the document's text to Flux once it's open.
   *
   *  Without this a PDF is invisible to the agent: the viewer is Flux's own DOM
   *  inside the chrome, so `capture.js` never runs and no snapshot exists. The
   *  text is taken from PDF.js's own text layer — already parsed for search and
   *  selection — rather than parsing the file a second time in Rust.
   *
   *  Best-effort and non-blocking: a scanned PDF has no text layer, and a failure
   *  here must never stop the document rendering. */
  /** True when the document yielded no selectable text at all — a scan. */
  const [scanned, setScanned] = createSignal(false);
  const [canOcr, setCanOcr] = createSignal(false);
  const [ocrPage, setOcrPage] = createSignal(0); // 0 = not running
  const [ocrErr, setOcrErr] = createSignal("");

  /**
   * Read a scanned document with OCR, one page at a time.
   *
   * Pages are rendered here rather than in Rust because the viewer already has
   * them decoded — shipping the PDF to the backend to re-render would duplicate
   * PDF.js in another language. Rendered at 2x: OCR accuracy falls off sharply
   * below ~200dpi, and screen scale is well under that.
   *
   * Published to its own `pdf-ocr` source, never merged into `pdf`, so every
   * citation carries that a machine read this off an image and may be wrong.
   */
  const runOcr = async () => {
    if (!pdfDoc || ocrPage()) return;
    setOcrErr("");
    const parts: string[] = [];
    try {
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        setOcrPage(i);
        const page = await pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement("canvas");
        c.width = vp.width;
        c.height = vp.height;
        const ctx = c.getContext("2d");
        if (!ctx) break;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const b64 = c.toDataURL("image/png").split(",")[1] ?? "";
        // Free the bitmap before the next page: a 2x A4 canvas is ~30MB and
        // holding one per page would be a hundreds-of-MB spike on a long scan.
        c.width = 0;
        c.height = 0;
        const text = await ocrImage(b64).catch((e) => {
          // One unreadable page shouldn't lose the other forty.
          console.warn("[flux ocr] page", i, e);
          return "";
        });
        if (text.trim()) parts.push(text.trim());
      }
      const joined = parts.join("\n\n");
      if (!joined.trim()) {
        setOcrErr("Nothing legible was found on these pages.");
        return;
      }
      await pdfPublishText(
        props.tabId,
        src() || filename(),
        filename(),
        joined,
        pdfDoc.numPages,
        parts.length,
        true, // machine-read: lands in `pdf-ocr`, not `pdf`
      );
      setScanned(false); // it has text now
    } catch (e) {
      setOcrErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setOcrPage(0);
    }
  };

  const publishText = async () => {
    if (!pdfDoc) return;
    try {
      const parts: string[] = [];
      let chars = 0;
      for (let i = 1; i <= pdfDoc.numPages && chars < MAX_TEXT; i++) {
        const content = await (await pdfDoc.getPage(i)).getTextContent();
        // PDF.js gives positioned runs, not lines; joining on spaces is what the
        // embedder wants anyway (it reads prose, not layout).
        const page = content.items
          .map((it: { str?: string }) => it.str ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (page) {
          parts.push(page);
          chars += page.length;
        }
      }
      const text = parts.join("\n\n");
      // Report what was found per page, not just the total: a deck whose later
      // slides are images extracts fine for the first few and then silently
      // yields nothing, which looks identical to a truncation bug.
      const withText = parts.length;
      if (!text.trim()) {
        void pdfPublishText(props.tabId, src() || filename(), filename(), "", pdfDoc.numPages, 0);
        // Nothing selects in this document — it's page images, i.e. a scan. That
        // is precisely the case OCR exists for, so offer it (only if a binary is
        // actually installed; see `ocrAvailable`).
        setScanned(true);
        void ocrAvailable().then(setCanOcr);
        return; // no text layer at all
      }
      await pdfPublishText(props.tabId, src() || filename(), filename(), text, pdfDoc.numPages, withText);
    } catch {
      /* never let text extraction break the viewer */
    }
  };

  const renderPage = async (pageNo: number, token: number) => {
    const canvas = canvases[pageNo - 1];
    if (!pdfDoc || !canvas) return;
    const page = await pdfDoc.getPage(pageNo);
    if (token !== renderToken) return;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale() * dpr });
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d");
    if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
  };

  const load = async () => {
    const s = parseSrc();
    setSrc(s);
    updateTabTitle(props.tabId, "PDF");
    if (!s) {
      setError("No PDF source.");
      setLoading(false);
      return;
    }
    try {
      const buf = await pdfFetch(s);
      if (!buf || buf.byteLength === 0) {
        setError("Couldn't load this PDF.");
        setLoading(false);
        return;
      }
      // Raw ArrayBuffer straight from Rust — no atob, no intermediate binary
      // string, one copy. This is what makes large PDFs affordable.
      const bytes = new Uint8Array(buf);
      await loadBytes(bytes);
      updateTabTitle(props.tabId, filename());
      setLoading(false);
    } catch (e) {
      setError(`Couldn't render this PDF: ${String(e)}`);
      setLoading(false);
    }
  };

  onMount(load);
  // Re-render every page when the doc reloads or the zoom changes.
  createEffect(() => {
    if (!ready()) return;
    docVersion();
    scale();
    pages();
    const token = ++renderToken;
    void (async () => {
      for (const p of pages()) {
        if (token !== renderToken) return;
        await renderPage(p, token);
      }
    })();
  });

  const zoom = (d: number) => setScale((v) => Math.min(4, Math.max(0.4, +(v + d).toFixed(2))));
  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3200);
  };

  // ── Annotation drawing ───────────────────────────────────────────────────
  const pt = (e: PointerEvent): [number, number] => {
    if (!drag) return [0, 0];
    const x = ((e.clientX - drag.rect.left) / drag.rect.width) * drag.w;
    const y = ((e.clientY - drag.rect.top) / drag.rect.height) * drag.h;
    return [Math.max(0, Math.min(drag.w, x)), Math.max(0, Math.min(drag.h, y))];
  };

  const onPointerDown = (e: PointerEvent, pageNo: number) => {
    const t = tool();
    if (mode() !== "edit" || t === "pan" || t === "erase") return;
    e.preventDefault();
    const svg = e.currentTarget as SVGSVGElement;
    const d = dims()[pageNo - 1];
    if (!d) return;
    drag = { page: pageNo, rect: svg.getBoundingClientRect(), w: d.w, h: d.h };
    const [x, y] = pt(e);
    if (t === "text") {
      setTextDraft({ page: pageNo, x, y, left: e.clientX - drag.rect.left, top: e.clientY - drag.rect.top });
      drag = null;
      return;
    }
    const c = color();
    if (t === "pen") setDraft({ id: 0, page: pageNo, color: c, kind: "pen", pts: [[x, y]], width: 2 });
    else if (t === "arrow")
      setDraft({ id: 0, page: pageNo, color: c, kind: "arrow", x1: x, y1: y, x2: x, y2: y, width: 2 });
    else setDraft({ id: 0, page: pageNo, color: c, kind: t, x, y, w: 0, h: 0 });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const onPointerMove = (e: PointerEvent) => {
    const cur = draft();
    if (!cur || !drag) return;
    const [x, y] = pt(e);
    if (cur.kind === "pen") setDraft({ ...cur, pts: [...cur.pts, [x, y]] });
    else if (cur.kind === "arrow") setDraft({ ...cur, x2: x, y2: y });
    else setDraft({ ...cur, w: x - cur.x, h: y - cur.y });
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    const cur = draft();
    drag = null;
    setDraft(null);
    if (!cur) return;
    // Discard degenerate marks.
    if (cur.kind === "pen" && cur.pts.length < 2) return;
    if (cur.kind === "highlight" || cur.kind === "rect") {
      const r = normRect(cur);
      if (r.w < 3 || r.h < 3) return;
      commit({ ...r, id: 0 });
      return;
    }
    if (cur.kind === "arrow" && Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) < 4) return;
    commit(cur);
  };

  const normRect = (r: RectAnnot): RectAnnot => ({
    ...r,
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  });

  const commit = (a: Annot) => {
    setAnnots((prev) => [...prev, { ...a, id: annotId++ }]);
    setDirty(true);
  };

  const commitText = (value: string) => {
    const td = textDraft();
    setTextDraft(null);
    const v = value.trim();
    if (!td || !v) return;
    commit({ id: 0, page: td.page, color: color(), kind: "text", x: td.x, y: td.y, text: v, size: 16 });
  };

  const eraseAnnot = (id: number, e: MouseEvent) => {
    if (tool() !== "erase") return;
    e.stopPropagation();
    setAnnots((prev) => prev.filter((a) => a.id !== id));
    setDirty(true);
  };

  const undo = () => {
    setAnnots((prev) => prev.slice(0, -1));
    setDirty(true);
  };
  const clearAll = () => {
    setAnnots([]);
    setDirty(true);
  };

  // ── pdf-lib: burn annotations + page operations ────────────────────────────
  const burnAnnots = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const list = annots();
    if (list.length === 0) return bytes;
    const { PDFDocument, rgb } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes.slice());
    const pgs = doc.getPages();
    for (const a of list) {
      const pg = pgs[a.page - 1];
      if (!pg) continue;
      const H = pg.getHeight();
      const [r, g, b] = hexToRgb01(a.color);
      const col = rgb(r, g, b);
      if (a.kind === "highlight") {
        pg.drawRectangle({ x: a.x, y: H - (a.y + a.h), width: a.w, height: a.h, color: col, opacity: 0.35 });
      } else if (a.kind === "rect") {
        pg.drawRectangle({
          x: a.x,
          y: H - (a.y + a.h),
          width: a.w,
          height: a.h,
          borderColor: col,
          borderWidth: 1.5,
          opacity: 0,
        });
      } else if (a.kind === "pen") {
        for (let i = 1; i < a.pts.length; i++) {
          const p0 = a.pts[i - 1]!;
          const p1 = a.pts[i]!;
          pg.drawLine({
            start: { x: p0[0], y: H - p0[1] },
            end: { x: p1[0], y: H - p1[1] },
            thickness: a.width,
            color: col,
          });
        }
      } else if (a.kind === "arrow") {
        const s = { x: a.x1, y: H - a.y1 };
        const en = { x: a.x2, y: H - a.y2 };
        pg.drawLine({ start: s, end: en, thickness: a.width, color: col });
        const ang = Math.atan2(en.y - s.y, en.x - s.x);
        const head = 8;
        for (const off of [Math.PI - 0.4, Math.PI + 0.4]) {
          pg.drawLine({
            start: en,
            end: { x: en.x + head * Math.cos(ang + off), y: en.y + head * Math.sin(ang + off) },
            thickness: a.width,
            color: col,
          });
        }
      } else if (a.kind === "text") {
        pg.drawText(a.text, { x: a.x, y: H - a.y - a.size, size: a.size, color: col });
      }
    }
    return new Uint8Array(await doc.save());
  };

  /** Burn current annotations, run a byte→byte transform, reload the viewer. */
  const applyPageOp = async (op: (bytes: Uint8Array) => Promise<Uint8Array>) => {
    try {
      const burned = await burnAnnots(working);
      const next = await op(burned);
      setAnnots([]);
      await loadBytes(next);
      setDirty(true);
    } catch (e) {
      flash(`Page operation failed: ${String(e)}`);
    }
  };

  const rotatePage = (i: number) =>
    applyPageOp(async (bytes) => {
      const { PDFDocument, degrees } = await import("pdf-lib");
      const d = await PDFDocument.load(bytes);
      const p = d.getPage(i);
      p.setRotation(degrees((p.getRotation().angle + 90) % 360));
      return new Uint8Array(await d.save());
    });

  const deletePage = (i: number) => {
    if (numPages() <= 1) {
      flash("Can't delete the only page.");
      return;
    }
    void applyPageOp(async (bytes) => {
      const { PDFDocument } = await import("pdf-lib");
      const src = await PDFDocument.load(bytes);
      const out = await PDFDocument.create();
      const keep = src.getPageIndices().filter((idx) => idx !== i);
      const copied = await out.copyPages(src, keep);
      copied.forEach((p) => out.addPage(p));
      return new Uint8Array(await out.save());
    });
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    void applyPageOp(async (bytes) => {
      const { PDFDocument } = await import("pdf-lib");
      const src = await PDFDocument.load(bytes);
      const order = src.getPageIndices();
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved!);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, order);
      copied.forEach((p) => out.addPage(p));
      return new Uint8Array(await out.save());
    });
  };

  const extractPage = async (i: number) => {
    try {
      const { PDFDocument } = await import("pdf-lib");
      const burned = await burnAnnots(working);
      const src = await PDFDocument.load(burned);
      const out = await PDFDocument.create();
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p!);
      const bytes = new Uint8Array(await out.save());
      const path = await pdfSave(bytesToB64(bytes), saveName().replace(/\.pdf$/i, ` p${i + 1}.pdf`));
      flash(`Saved page ${i + 1} → ${path}`);
    } catch (e) {
      flash(`Extract failed: ${String(e)}`);
    }
  };

  let mergeInput: HTMLInputElement | undefined;
  const onMergeFile = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = "";
    if (!file) return;
    const other = new Uint8Array(await file.arrayBuffer());
    void applyPageOp(async (bytes) => {
      const { PDFDocument } = await import("pdf-lib");
      const base = await PDFDocument.load(bytes);
      const add = await PDFDocument.load(other);
      const copied = await base.copyPages(add, add.getPageIndices());
      copied.forEach((p) => base.addPage(p));
      return new Uint8Array(await base.save());
    });
  };

  // ── AcroForm form fill (#113) ──────────────────────────────────────────────
  /** Enumerate the PDF's fillable fields + current values (uses `instanceof`,
   *  which survives minification — `constructor.name` would not). */
  const loadFields = async () => {
    setFormMsg("");
    try {
      const lib = await import("pdf-lib");
      const doc = await lib.PDFDocument.load(working.slice());
      const fields = doc.getForm().getFields();
      const out: FormField[] = [];
      const vals: Record<string, FieldValue> = {};
      for (const f of fields) {
        const name = f.getName();
        if (f instanceof lib.PDFTextField) {
          out.push({ name, type: "text" });
          vals[name] = f.getText() ?? "";
        } else if (f instanceof lib.PDFCheckBox) {
          out.push({ name, type: "checkbox" });
          vals[name] = f.isChecked();
        } else if (f instanceof lib.PDFRadioGroup) {
          out.push({ name, type: "radio", options: f.getOptions() });
          vals[name] = f.getSelected() ?? "";
        } else if (f instanceof lib.PDFDropdown) {
          out.push({ name, type: "dropdown", options: f.getOptions() });
          vals[name] = f.getSelected()?.[0] ?? "";
        } else if (f instanceof lib.PDFOptionList) {
          out.push({ name, type: "dropdown", options: f.getOptions() });
          vals[name] = f.getSelected()?.[0] ?? "";
        }
        // Buttons + signature fields aren't fillable here — skipped.
      }
      setFormFields(out);
      setFormValues(vals);
      if (out.length === 0) setFormMsg("This PDF has no fillable form fields.");
    } catch (e) {
      setFormFields([]);
      setFormMsg(`Couldn't read the form: ${String(e)}`);
    }
  };

  /** Write the current panel values into a byte buffer (optionally flatten). */
  const writeForm = async (bytes: Uint8Array, flatten: boolean): Promise<Uint8Array> => {
    if (formFields().length === 0) return bytes;
    const lib = await import("pdf-lib");
    const doc = await lib.PDFDocument.load(bytes.slice());
    const form = doc.getForm();
    const vals = formValues();
    for (const ff of formFields()) {
      try {
        if (ff.type === "text") form.getTextField(ff.name).setText(String(vals[ff.name] ?? ""));
        else if (ff.type === "checkbox") {
          const cb = form.getCheckBox(ff.name);
          vals[ff.name] ? cb.check() : cb.uncheck();
        } else if (ff.type === "radio") {
          const v = String(vals[ff.name] ?? "");
          if (v) form.getRadioGroup(ff.name).select(v);
        } else if (ff.type === "dropdown") {
          const v = String(vals[ff.name] ?? "");
          if (v) form.getDropdown(ff.name).select(v);
        }
      } catch {
        /* a field that won't take the value is skipped, not fatal */
      }
    }
    if (flatten) form.flatten();
    return new Uint8Array(await doc.save());
  };

  /** Collect every form widget's on-page box (PDF.js) for in-place editing.
   *  PDF.js gives us per-widget geometry (incl. rotation) + the radio export
   *  value; the field *type* comes from the pdf-lib pass (`formFields`). */
  const gatherWidgets = async () => {
    if (!pdfDoc) {
      setWidgets([]);
      return;
    }
    const out: WidgetBox[] = [];
    try {
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anns: any[] = await page.getAnnotations({ intent: "display" });
        for (const a of anns) {
          if (a.subtype !== "Widget" || !a.fieldName || a.fieldType === "Sig" || a.pushButton) continue;
          const r = vp1.convertToViewportRectangle(a.rect) as number[];
          const x = Math.min(r[0]!, r[2]!),
            y = Math.min(r[1]!, r[3]!);
          out.push({
            id: out.length,
            page: i,
            name: a.fieldName,
            x,
            y,
            w: Math.abs(r[2]! - r[0]!),
            h: Math.abs(r[3]! - r[1]!),
            exportValue: a.buttonValue ?? undefined,
          });
        }
      }
    } catch {
      /* leave whatever we gathered */
    }
    setWidgets(out);
  };

  const widgetsForPage = (pageNo: number) => widgets().filter((w) => w.page === pageNo);
  const fieldType = (name: string): FieldType | undefined => formFields().find((f) => f.name === name)?.type;

  /** Render one in-place form widget, positioned over its page box. */
  const fieldWidget = (wd: WidgetBox) => {
    const s = () => scale();
    const pos = () => ({
      left: `${wd.x * s()}px`,
      top: `${wd.y * s()}px`,
      width: `${wd.w * s()}px`,
      height: `${wd.h * s()}px`,
    });
    const t = fieldType(wd.name);
    const font = () => `${Math.max(8, Math.min(16, wd.h * s() * 0.62))}px`;
    if (t === "checkbox") {
      return (
        <input
          type="checkbox"
          class="pdf-fw"
          style={pos()}
          checked={Boolean(formValues()[wd.name])}
          onChange={(e) => setFieldValue(wd.name, e.currentTarget.checked)}
        />
      );
    }
    if (t === "radio") {
      return (
        <input
          type="radio"
          class="pdf-fw"
          style={pos()}
          checked={String(formValues()[wd.name] ?? "") === wd.exportValue}
          onChange={() => setFieldValue(wd.name, wd.exportValue ?? "")}
        />
      );
    }
    if (t === "dropdown") {
      const ff = formFields().find((f) => f.name === wd.name);
      return (
        <select
          class="pdf-fw pdf-fw-text"
          style={{ ...pos(), "font-size": font() }}
          value={String(formValues()[wd.name] ?? "")}
          onChange={(e) => setFieldValue(wd.name, e.currentTarget.value)}
        >
          <option value="">—</option>
          <For each={ff?.options ?? []}>{(o) => <option value={o}>{o}</option>}</For>
        </select>
      );
    }
    // default: text
    return (
      <input
        type="text"
        class="pdf-fw pdf-fw-text"
        style={{ ...pos(), "font-size": font() }}
        value={String(formValues()[wd.name] ?? "")}
        onInput={(e) => setFieldValue(wd.name, e.currentTarget.value)}
      />
    );
  };

  const setFieldValue = (name: string, v: FieldValue) => {
    setFormValues((prev) => ({ ...prev, [name]: v }));
    setDirty(true);
  };

  /** Burn the filled values into the working doc so they show on the page. */
  const applyForm = async () => {
    try {
      const next = await writeForm(working, false);
      await loadBytes(next);
      setDirty(true);
      flash("Form values applied to the document.");
    } catch (e) {
      flash(`Apply failed: ${String(e)}`);
    }
  };

  // (Re)read fields + widget boxes when entering Forms mode or after a change.
  createEffect(() => {
    if (mode() === "forms" && ready()) {
      docVersion();
      void (async () => {
        await loadFields();
        await gatherWidgets();
      })();
    }
  });

  const save = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      // Form values + drawn annotations both burned into the saved copy.
      const withForm = await writeForm(working, flattenOnSave());
      const bytes = await burnAnnots(withForm);
      const path = await pdfSave(bytesToB64(bytes), saveName());
      setDirty(false);
      flash(`Saved → ${path}`);
    } catch (e) {
      flash(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // ── Reorder drag state (Pages panel) ───────────────────────────────────────
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);

  // ── SVG annotation rendering helpers ───────────────────────────────────────
  const interactiveSvg = () => mode() === "edit" && tool() !== "pan" && tool() !== "erase";
  const interactiveShape = () => mode() === "edit" && tool() === "erase";

  const shapesFor = (pageNo: number): Annot[] => {
    const base = annots().filter((a) => a.page === pageNo);
    const d = draft();
    return d && d.page === pageNo ? [...base, { ...d, id: -1 }] : base;
  };
  const polyPoints = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <div class="pdf-view">
      <div class="pdf-toolbar">
        <span class="pdf-title" title={src()}>
          {filename()}
          {dirty() ? " •" : ""}
        </span>
        <Show when={numPages() > 0}>
          <span class="pdf-pages">
            {numPages()} page{numPages() === 1 ? "" : "s"}
          </span>
        </Show>
        <span style={{ flex: 1 }} />
        <div class="pdf-modes">
          <button
            classList={{ "pdf-mode": true, active: mode() === "view" }}
            onClick={() => setMode("view")}
            disabled={!ready()}
          >
            View
          </button>
          <button
            classList={{ "pdf-mode": true, active: mode() === "edit" }}
            onClick={() => setMode("edit")}
            disabled={!ready()}
          >
            ✎ Edit
          </button>
          <button
            classList={{ "pdf-mode": true, active: mode() === "pages" }}
            onClick={() => setMode("pages")}
            disabled={!ready()}
          >
            ▦ Pages
          </button>
          <button
            classList={{ "pdf-mode": true, active: mode() === "forms" }}
            onClick={() => setMode("forms")}
            disabled={!ready()}
          >
            🖊 Forms
          </button>
        </div>
        <button class="pdf-btn" onClick={() => zoom(-0.2)} title="Zoom out" disabled={!ready()}>
          −
        </button>
        <span class="pdf-zoom">{Math.round(scale() * 100)}%</span>
        <button class="pdf-btn" onClick={() => zoom(0.2)} title="Zoom in" disabled={!ready()}>
          +
        </button>
        <button
          class="pdf-btn pdf-save"
          onClick={() => void save()}
          title="Save edited copy to Downloads"
          disabled={!ready() || saving()}
        >
          {saving() ? "…" : "Save"}
        </button>
        <a class="pdf-btn" href={src()} download={filename()} title="Download original">
          ↓
        </a>
      </div>

      {/* Edit toolbar */}
      <Show when={mode() === "edit"}>
        <div class="pdf-edit-bar">
          <For each={TOOLS}>
            {(t) => (
              <button
                classList={{ "pdf-tool": true, active: tool() === t.id }}
                title={t.label}
                onClick={() => setTool(t.id)}
              >
                {t.icon}
              </button>
            )}
          </For>
          <span class="pdf-sep" />
          <For each={PALETTE}>
            {(c) => (
              <button
                classList={{ "pdf-swatch": true, active: color() === c }}
                style={{ background: c }}
                title={c}
                onClick={() => setColor(c)}
              />
            )}
          </For>
          <span class="pdf-sep" />
          <button class="pdf-btn" onClick={undo} title="Undo last" disabled={annots().length === 0}>
            ↶ Undo
          </button>
          <button
            class="pdf-btn"
            onClick={clearAll}
            title="Clear all annotations"
            disabled={annots().length === 0}
          >
            Clear
          </button>
          <span class="pdf-edit-hint">
            {annots().length} annotation{annots().length === 1 ? "" : "s"}
          </span>
        </div>
      </Show>

      {/* A scanned document: nothing selects, so Gemma and the KB see an empty
          page. Say so plainly and offer the one thing that helps, rather than
          leaving the user to wonder why asking about this PDF returns nothing. */}
      <Show when={scanned()}>
        <div class="pdf-ocr-bar">
          <span class="pdf-ocr-msg">
            No selectable text — this looks like a scan, so Gemma can't read it yet.
          </span>
          <Show
            when={canOcr()}
            fallback={
              <span class="pdf-ocr-hint" title="Flux runs the tesseract binary if it's installed">
                Install <code>tesseract</code> to read it
              </span>
            }
          >
            <button class="pdf-ocr-btn" disabled={ocrPage() > 0} onClick={() => void runOcr()}>
              {ocrPage() > 0 ? `Reading page ${ocrPage()}…` : "Read with OCR"}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={ocrErr()}>
        <div class="pdf-msg">{ocrErr()}</div>
      </Show>

      <Show when={error()}>
        <div class="pdf-msg">{error()}</div>
      </Show>
      <Show when={loading() && !error()}>
        <div class="pdf-msg">Loading PDF…</div>
      </Show>

      {/* Pages panel */}
      <Show when={mode() === "pages" && ready()}>
        <div class="pdf-pages-panel">
          <div class="pdf-pages-actions">
            <button class="pdf-btn" onClick={() => mergeInput?.click()}>
              ＋ Merge PDF…
            </button>
            <input
              ref={mergeInput}
              type="file"
              accept="application/pdf,.pdf"
              style={{ display: "none" }}
              onChange={(e) => void onMergeFile(e)}
            />
            <span class="pdf-edit-hint">Drag to reorder · rotate / delete / extract per page</span>
          </div>
          <div class="pdf-thumbs">
            <For each={pages()}>
              {(p, i) => (
                <div
                  classList={{ "pdf-thumb": true, dragover: dragIdx() !== null }}
                  draggable={true}
                  onDragStart={() => setDragIdx(i())}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragIdx();
                    if (from !== null) reorder(from, i());
                    setDragIdx(null);
                  }}
                >
                  <PageThumb pageNo={p} getDoc={() => pdfDoc} version={docVersion()} />
                  <div class="pdf-thumb-bar">
                    <span class="pdf-thumb-no">{i() + 1}</span>
                    <button class="pdf-thumb-btn" title="Rotate 90°" onClick={() => void rotatePage(i())}>
                      ⟳
                    </button>
                    <button class="pdf-thumb-btn" title="Extract page" onClick={() => void extractPage(i())}>
                      ⤓
                    </button>
                    <button class="pdf-thumb-btn danger" title="Delete page" onClick={() => deletePage(i())}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Page render + annotation overlay (+ Forms side panel) */}
      <div class="pdf-body" classList={{ hidden: mode() === "pages" }}>
        <div class="pdf-pages-wrap" classList={{ "mode-edit": mode() === "edit" }}>
          <For each={pages()}>
            {(p) => {
              const d = () => dims()[p - 1] ?? { w: 600, h: 800 };
              const cssW = () => d().w * scale();
              const cssH = () => d().h * scale();
              return (
                <div class="pdf-page-wrap" style={{ width: `${cssW()}px`, height: `${cssH()}px` }}>
                  <canvas class="pdf-page" ref={(el) => (canvases[p - 1] = el)} />
                  <Show when={mode() === "forms"}>
                    <For each={widgetsForPage(p)}>{(wd) => fieldWidget(wd)}</For>
                  </Show>
                  <Show when={mode() === "edit"}>
                    <svg
                      class="pdf-annot-layer"
                      viewBox={`0 0 ${d().w} ${d().h}`}
                      preserveAspectRatio="none"
                      style={{
                        "pointer-events": interactiveSvg() ? "auto" : "none",
                        cursor: interactiveSvg() ? "crosshair" : "default",
                      }}
                      onPointerDown={(e) => onPointerDown(e, p)}
                    >
                      <For each={shapesFor(p)}>
                        {(a) => {
                          const pe = () => (interactiveShape() ? "auto" : "none");
                          if (a.kind === "highlight" || a.kind === "rect") {
                            const r = normRect(a);
                            return (
                              <rect
                                x={r.x}
                                y={r.y}
                                width={r.w}
                                height={r.h}
                                fill={a.kind === "highlight" ? a.color : "none"}
                                fill-opacity={a.kind === "highlight" ? 0.35 : 0}
                                stroke={a.kind === "rect" ? a.color : "none"}
                                stroke-width={a.kind === "rect" ? 1.5 : 0}
                                style={{ "pointer-events": pe(), cursor: "pointer" }}
                                onClick={(e) => eraseAnnot(a.id, e)}
                              />
                            );
                          }
                          if (a.kind === "pen") {
                            return (
                              <polyline
                                points={polyPoints(a.pts)}
                                fill="none"
                                stroke={a.color}
                                stroke-width={a.width}
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                style={{ "pointer-events": pe(), cursor: "pointer" }}
                                onClick={(e) => eraseAnnot(a.id, e)}
                              />
                            );
                          }
                          if (a.kind === "arrow") {
                            const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
                            const head = 8;
                            const hx = (o: number) => a.x2 + head * Math.cos(ang + Math.PI + o);
                            const hy = (o: number) => a.y2 + head * Math.sin(ang + Math.PI + o);
                            return (
                              <g
                                style={{ "pointer-events": pe(), cursor: "pointer" }}
                                onClick={(e) => eraseAnnot(a.id, e)}
                              >
                                <line
                                  x1={a.x1}
                                  y1={a.y1}
                                  x2={a.x2}
                                  y2={a.y2}
                                  stroke={a.color}
                                  stroke-width={a.width}
                                  stroke-linecap="round"
                                />
                                <line
                                  x1={a.x2}
                                  y1={a.y2}
                                  x2={hx(0.4)}
                                  y2={hy(0.4)}
                                  stroke={a.color}
                                  stroke-width={a.width}
                                  stroke-linecap="round"
                                />
                                <line
                                  x1={a.x2}
                                  y1={a.y2}
                                  x2={hx(-0.4)}
                                  y2={hy(-0.4)}
                                  stroke={a.color}
                                  stroke-width={a.width}
                                  stroke-linecap="round"
                                />
                              </g>
                            );
                          }
                          if (a.kind !== "text") return null;
                          return (
                            <text
                              x={a.x}
                              y={a.y + a.size * 0.8}
                              font-size={`${a.size}`}
                              fill={a.color}
                              style={{
                                "pointer-events": pe(),
                                cursor: "pointer",
                                "font-family": "sans-serif",
                              }}
                              onClick={(e) => eraseAnnot(a.id, e)}
                            >
                              {a.text}
                            </text>
                          );
                        }}
                      </For>
                    </svg>
                  </Show>
                  {/* Inline text entry */}
                  <Show when={textDraft()?.page === p}>
                    <input
                      class="pdf-text-input"
                      autofocus
                      style={{ left: `${textDraft()!.left}px`, top: `${textDraft()!.top}px`, color: color() }}
                      onBlur={(e) => commitText(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          setTextDraft(null);
                        }
                      }}
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        {/* Forms panel */}
        <Show when={mode() === "forms"}>
          <div class="pdf-forms-panel">
            <div class="pdf-forms-head">
              <span class="pdf-forms-title">Form fields</span>
              <label class="pdf-forms-flatten">
                <input
                  type="checkbox"
                  checked={flattenOnSave()}
                  onChange={(e) => setFlattenOnSave(e.currentTarget.checked)}
                />
                Flatten on save
              </label>
            </div>
            <Show when={formMsg()}>
              <div class="pdf-edit-hint">{formMsg()}</div>
            </Show>
            <div class="pdf-fields">
              <For each={formFields()}>
                {(ff) => (
                  <label class="pdf-field">
                    <span class="pdf-field-name" title={ff.name}>
                      {ff.name}
                    </span>
                    <Switch>
                      <Match when={ff.type === "checkbox"}>
                        <input
                          type="checkbox"
                          checked={Boolean(formValues()[ff.name])}
                          onChange={(e) => setFieldValue(ff.name, e.currentTarget.checked)}
                        />
                      </Match>
                      <Match when={ff.type === "radio" || ff.type === "dropdown"}>
                        <select
                          class="pdf-field-input"
                          value={String(formValues()[ff.name] ?? "")}
                          onChange={(e) => setFieldValue(ff.name, e.currentTarget.value)}
                        >
                          <option value="">—</option>
                          <For each={ff.options ?? []}>{(o) => <option value={o}>{o}</option>}</For>
                        </select>
                      </Match>
                      <Match when={ff.type === "text"}>
                        <input
                          class="pdf-field-input"
                          type="text"
                          value={String(formValues()[ff.name] ?? "")}
                          onInput={(e) => setFieldValue(ff.name, e.currentTarget.value)}
                        />
                      </Match>
                    </Switch>
                  </label>
                )}
              </For>
            </div>
            <Show when={formFields().length > 0}>
              <button class="pdf-btn pdf-forms-apply" onClick={() => void applyForm()}>
                Apply to document
              </button>
              <span class="pdf-edit-hint">
                Apply fills the values into the page. Save writes a copy to Downloads (Flatten = no longer
                editable).
              </span>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={toast()}>
        <div class="pdf-toast">{toast()}</div>
      </Show>
    </div>
  );
};

/** A small rendered thumbnail for the Pages panel. */
const PageThumb: Component<{ pageNo: number; getDoc: () => unknown; version: number }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    props.version; // re-render after a page-op
    const doc = props.getDoc() as {
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: unknown) => { promise: Promise<void> };
      }>;
    } | null;
    if (!doc || !canvas) return;
    void (async () => {
      const page = await doc.getPage(props.pageNo);
      const vp = page.getViewport({ scale: 0.28 });
      if (!canvas) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
    })();
  });
  return <canvas class="pdf-thumb-canvas" ref={(el) => (canvas = el)} />;
};

export default PdfViewer;
