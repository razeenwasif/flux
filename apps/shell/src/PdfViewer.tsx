/**
 * flux://pdf — built-in PDF viewer (BACKLOG #35). Renders with PDF.js (lazy-
 * loaded so it never weighs down the chrome bundle) inside a Flux internal page,
 * so PDFs view consistently on both engines (WebKitGTK has no native viewer).
 * The bytes come from the Rust core (`pdf_fetch`) which fetches server-side to
 * sidestep cross-origin CORS. Continuous page scroll + zoom + download.
 *
 * Source is passed as `flux://pdf?src=<encoded url-or-path>`.
 */
import { Show, createEffect, createSignal, onMount, type Component } from "solid-js";
import { pdfFetch } from "./ipc";
import { activeId, activeTab, updateTabTitle } from "./store";

const PdfViewer: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [scale, setScale] = createSignal(1.2);
  const [numPages, setNumPages] = createSignal(0);
  const [src, setSrc] = createSignal("");
  let container: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfDoc: any = null;
  let renderToken = 0;

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

  const renderAll = async () => {
    if (!pdfDoc || !container) return;
    const token = ++renderToken;
    const dpr = window.devicePixelRatio || 1;
    const s = scale();
    container.innerHTML = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== renderToken) return; // a newer render superseded this one
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: s * dpr });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      container.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
    }
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
      const pdfjs = await import("pdfjs-dist");
      // Vite's `?worker` import bundles the worker correctly (a bare specifier
      // in `new URL(..., import.meta.url)` doesn't resolve to node_modules).
      const PdfWorker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      pdfDoc = await pdfjs.getDocument({ data: bytes }).promise;
      setNumPages(pdfDoc.numPages);
      const id2 = activeId();
      if (id2 != null) updateTabTitle(id2, filename());
      setLoading(false);
      setReady(true);
    } catch (e) {
      setError(`Couldn't render this PDF: ${String(e)}`);
      setLoading(false);
    }
  };

  onMount(load);
  // (Re)render whenever the doc is ready or the zoom changes.
  createEffect(() => {
    if (ready()) {
      scale();
      void renderAll();
    }
  });

  const zoom = (d: number) => setScale((v) => Math.min(4, Math.max(0.4, +(v + d).toFixed(2))));

  return (
    <div class="pdf-view">
      <div class="pdf-toolbar">
        <span class="pdf-title" title={src()}>{filename()}</span>
        <Show when={numPages() > 0}><span class="pdf-pages">{numPages()} page{numPages() === 1 ? "" : "s"}</span></Show>
        <span style={{ flex: 1 }} />
        <button class="pdf-btn" onClick={() => zoom(-0.2)} title="Zoom out" disabled={!ready()}>−</button>
        <span class="pdf-zoom">{Math.round(scale() * 100)}%</span>
        <button class="pdf-btn" onClick={() => zoom(0.2)} title="Zoom in" disabled={!ready()}>+</button>
        <a class="pdf-btn" href={src()} download={filename()} title="Download">↓</a>
      </div>
      <Show when={error()}><div class="pdf-msg">{error()}</div></Show>
      <Show when={loading() && !error()}><div class="pdf-msg">Loading PDF…</div></Show>
      <div class="pdf-pages-wrap" ref={container} />
    </div>
  );
};

export default PdfViewer;
