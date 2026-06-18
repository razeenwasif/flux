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
import { For, Show, createEffect, createSignal, onMount, type Component } from "solid-js";
import { pdfFetch, pdfSave } from "./ipc";
import { activeId, activeTab, updateTabTitle } from "./store";

// ─── Annotation model (all geometry in PDF points, origin top-left, y-down) ──
type Tool = "pan" | "highlight" | "pen" | "text" | "rect" | "arrow" | "erase";
interface Base { id: number; page: number; color: string }
interface RectAnnot extends Base { kind: "highlight" | "rect"; x: number; y: number; w: number; h: number }
interface InkAnnot extends Base { kind: "pen"; pts: [number, number][]; width: number }
interface LineAnnot extends Base { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; width: number }
interface TextAnnot extends Base { kind: "text"; x: number; y: number; text: string; size: number }
type Annot = RectAnnot | InkAnnot | LineAnnot | TextAnnot;

interface Dims { w: number; h: number } // PDF points

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
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
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

const PdfViewer: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [scale, setScale] = createSignal(1.2);
  const [numPages, setNumPages] = createSignal(0);
  const [pages, setPages] = createSignal<number[]>([]);
  const [dims, setDims] = createSignal<Dims[]>([]);
  const [src, setSrc] = createSignal("");
  const [docVersion, setDocVersion] = createSignal(0); // bump → re-render pages

  const [mode, setMode] = createSignal<"view" | "edit" | "pages">("view");
  const [tool, setTool] = createSignal<Tool>("pan");
  const [color, setColor] = createSignal(PALETTE[0]!);
  const [annots, setAnnots] = createSignal<Annot[]>([]);
  const [draft, setDraft] = createSignal<Annot | null>(null);
  const [textDraft, setTextDraft] = createSignal<{ page: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [toast, setToast] = createSignal("");

  let working: Uint8Array = new Uint8Array();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfDoc: any = null;
  const canvases: (HTMLCanvasElement | undefined)[] = [];
  let renderToken = 0;
  let annotId = 1;
  // Drag context for the in-progress annotation.
  let drag: { page: number; rect: DOMRect; w: number; h: number } | null = null;

  const parseSrc = () => {
    const url = activeTab()?.url ?? "";
    const q = url.split("?")[1] ?? "";
    const s = new URLSearchParams(q).get("src");
    try { return s ? decodeURIComponent(s) : ""; } catch { return s ?? ""; }
  };
  const filename = () => {
    const tail = (src().split(/[?#]/)[0] ?? "").split("/").pop() || "PDF";
    try { return decodeURIComponent(tail); } catch { return tail; }
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
    const id = activeId();
    if (id != null) updateTabTitle(id, "PDF");
    if (!s) { setError("No PDF source."); setLoading(false); return; }
    try {
      const b64 = await pdfFetch(s);
      if (!b64) { setError("Couldn't load this PDF."); setLoading(false); return; }
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await loadBytes(bytes);
      const id2 = activeId();
      if (id2 != null) updateTabTitle(id2, filename());
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
    docVersion(); scale(); pages();
    const token = ++renderToken;
    void (async () => {
      for (const p of pages()) {
        if (token !== renderToken) return;
        await renderPage(p, token);
      }
    })();
  });

  const zoom = (d: number) => setScale((v) => Math.min(4, Math.max(0.4, +(v + d).toFixed(2))));
  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(""), 3200); };

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
    else if (t === "arrow") setDraft({ id: 0, page: pageNo, color: c, kind: "arrow", x1: x, y1: y, x2: x, y2: y, width: 2 });
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
    if ((cur.kind === "highlight" || cur.kind === "rect")) {
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

  const undo = () => { setAnnots((prev) => prev.slice(0, -1)); setDirty(true); };
  const clearAll = () => { setAnnots([]); setDirty(true); };

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
        pg.drawRectangle({ x: a.x, y: H - (a.y + a.h), width: a.w, height: a.h, borderColor: col, borderWidth: 1.5, opacity: 0 });
      } else if (a.kind === "pen") {
        for (let i = 1; i < a.pts.length; i++) {
          const p0 = a.pts[i - 1]!; const p1 = a.pts[i]!;
          pg.drawLine({ start: { x: p0[0], y: H - p0[1] }, end: { x: p1[0], y: H - p1[1] }, thickness: a.width, color: col });
        }
      } else if (a.kind === "arrow") {
        const s = { x: a.x1, y: H - a.y1 }; const en = { x: a.x2, y: H - a.y2 };
        pg.drawLine({ start: s, end: en, thickness: a.width, color: col });
        const ang = Math.atan2(en.y - s.y, en.x - s.x);
        const head = 8;
        for (const off of [Math.PI - 0.4, Math.PI + 0.4]) {
          pg.drawLine({ start: en, end: { x: en.x + head * Math.cos(ang + off), y: en.y + head * Math.sin(ang + off) }, thickness: a.width, color: col });
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

  const rotatePage = (i: number) => applyPageOp(async (bytes) => {
    const { PDFDocument, degrees } = await import("pdf-lib");
    const d = await PDFDocument.load(bytes);
    const p = d.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + 90) % 360));
    return new Uint8Array(await d.save());
  });

  const deletePage = (i: number) => {
    if (numPages() <= 1) { flash("Can't delete the only page."); return; }
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

  const save = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      const bytes = await burnAnnots(working);
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
        <span class="pdf-title" title={src()}>{filename()}{dirty() ? " •" : ""}</span>
        <Show when={numPages() > 0}><span class="pdf-pages">{numPages()} page{numPages() === 1 ? "" : "s"}</span></Show>
        <span style={{ flex: 1 }} />
        <div class="pdf-modes">
          <button classList={{ "pdf-mode": true, active: mode() === "view" }} onClick={() => setMode("view")} disabled={!ready()}>View</button>
          <button classList={{ "pdf-mode": true, active: mode() === "edit" }} onClick={() => setMode("edit")} disabled={!ready()}>✎ Edit</button>
          <button classList={{ "pdf-mode": true, active: mode() === "pages" }} onClick={() => setMode("pages")} disabled={!ready()}>▦ Pages</button>
        </div>
        <button class="pdf-btn" onClick={() => zoom(-0.2)} title="Zoom out" disabled={!ready()}>−</button>
        <span class="pdf-zoom">{Math.round(scale() * 100)}%</span>
        <button class="pdf-btn" onClick={() => zoom(0.2)} title="Zoom in" disabled={!ready()}>+</button>
        <button class="pdf-btn pdf-save" onClick={() => void save()} title="Save edited copy to Downloads" disabled={!ready() || saving()}>
          {saving() ? "…" : "Save"}
        </button>
        <a class="pdf-btn" href={src()} download={filename()} title="Download original">↓</a>
      </div>

      {/* Edit toolbar */}
      <Show when={mode() === "edit"}>
        <div class="pdf-edit-bar">
          <For each={TOOLS}>
            {(t) => (
              <button classList={{ "pdf-tool": true, active: tool() === t.id }} title={t.label} onClick={() => setTool(t.id)}>{t.icon}</button>
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
          <button class="pdf-btn" onClick={undo} title="Undo last" disabled={annots().length === 0}>↶ Undo</button>
          <button class="pdf-btn" onClick={clearAll} title="Clear all annotations" disabled={annots().length === 0}>Clear</button>
          <span class="pdf-edit-hint">{annots().length} annotation{annots().length === 1 ? "" : "s"}</span>
        </div>
      </Show>

      <Show when={error()}><div class="pdf-msg">{error()}</div></Show>
      <Show when={loading() && !error()}><div class="pdf-msg">Loading PDF…</div></Show>

      {/* Pages panel */}
      <Show when={mode() === "pages" && ready()}>
        <div class="pdf-pages-panel">
          <div class="pdf-pages-actions">
            <button class="pdf-btn" onClick={() => mergeInput?.click()}>＋ Merge PDF…</button>
            <input ref={mergeInput} type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={(e) => void onMergeFile(e)} />
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
                  onDrop={(e) => { e.preventDefault(); const from = dragIdx(); if (from !== null) reorder(from, i()); setDragIdx(null); }}
                >
                  <PageThumb pageNo={p} getDoc={() => pdfDoc} version={docVersion()} />
                  <div class="pdf-thumb-bar">
                    <span class="pdf-thumb-no">{i() + 1}</span>
                    <button class="pdf-thumb-btn" title="Rotate 90°" onClick={() => void rotatePage(i())}>⟳</button>
                    <button class="pdf-thumb-btn" title="Extract page" onClick={() => void extractPage(i())}>⤓</button>
                    <button class="pdf-thumb-btn danger" title="Delete page" onClick={() => deletePage(i())}>✕</button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Page render + annotation overlay */}
      <div class="pdf-pages-wrap" classList={{ "mode-edit": mode() === "edit", hidden: mode() === "pages" }}>
        <For each={pages()}>
          {(p) => {
            const d = () => dims()[p - 1] ?? { w: 600, h: 800 };
            const cssW = () => d().w * scale();
            const cssH = () => d().h * scale();
            return (
              <div class="pdf-page-wrap" style={{ width: `${cssW()}px`, height: `${cssH()}px` }}>
                <canvas class="pdf-page" ref={(el) => (canvases[p - 1] = el)} />
                <Show when={mode() === "edit"}>
                  <svg
                    class="pdf-annot-layer"
                    viewBox={`0 0 ${d().w} ${d().h}`}
                    preserveAspectRatio="none"
                    style={{ "pointer-events": interactiveSvg() ? "auto" : "none", cursor: interactiveSvg() ? "crosshair" : "default" }}
                    onPointerDown={(e) => onPointerDown(e, p)}
                  >
                    <For each={shapesFor(p)}>
                      {(a) => {
                        const pe = () => (interactiveShape() ? "auto" : "none");
                        if (a.kind === "highlight" || a.kind === "rect") {
                          const r = normRect(a);
                          return (
                            <rect
                              x={r.x} y={r.y} width={r.w} height={r.h}
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
                              points={polyPoints(a.pts)} fill="none" stroke={a.color}
                              stroke-width={a.width} stroke-linecap="round" stroke-linejoin="round"
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
                            <g style={{ "pointer-events": pe(), cursor: "pointer" }} onClick={(e) => eraseAnnot(a.id, e)}>
                              <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={a.color} stroke-width={a.width} stroke-linecap="round" />
                              <line x1={a.x2} y1={a.y2} x2={hx(0.4)} y2={hy(0.4)} stroke={a.color} stroke-width={a.width} stroke-linecap="round" />
                              <line x1={a.x2} y1={a.y2} x2={hx(-0.4)} y2={hy(-0.4)} stroke={a.color} stroke-width={a.width} stroke-linecap="round" />
                            </g>
                          );
                        }
                        if (a.kind !== "text") return null;
                        return (
                          <text
                            x={a.x} y={a.y + a.size * 0.8} font-size={`${a.size}`} fill={a.color}
                            style={{ "pointer-events": pe(), cursor: "pointer", "font-family": "sans-serif" }}
                            onClick={(e) => eraseAnnot(a.id, e)}
                          >{a.text}</text>
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
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setTextDraft(null); } }}
                  />
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={toast()}><div class="pdf-toast">{toast()}</div></Show>
    </div>
  );
};

/** A small rendered thumbnail for the Pages panel. */
const PageThumb: Component<{ pageNo: number; getDoc: () => unknown; version: number }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    props.version; // re-render after a page-op
    const doc = props.getDoc() as { getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } }> } | null;
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
