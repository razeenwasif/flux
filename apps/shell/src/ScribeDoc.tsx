/**
 * Scribe's page — a **document**, not a canvas (ADR 0014, second pass).
 *
 * The first design put text boxes on a drawing surface: every line was placed by
 * clicking, and editing meant reopening a block. That fought the actual job,
 * which is writing. So the page is now an ordinary rich-text editor — a real
 * caret, selection, backspace across lines, headings and lists — and **ink is an
 * object you insert**: the pen opens a drawing pane, and what you draw lands on
 * the page as an image you can drag and resize.
 *
 * Storage stays inside the page's opaque `strokes` string (Rust never parses
 * it), so this needed no schema change:
 *
 *   { v: 2, html: "<p>…</p>", objects: [{ id, src, x, y, w, h }] }
 *
 * A page written under the old model is a bare `Stroke[]`; `parseDoc()` upgrades
 * it on open — typed blocks become paragraphs, and all the ink is flattened into
 * one positioned image, so nothing is lost.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";

import InkCanvas, { renderStrokesScaled, type InkApi, type Stroke } from "./InkCanvas";

export type InkObject = { id: string; src: string; x: number; y: number; w: number; h: number };
export type DocModel = { v: 2; html: string; objects: InkObject[] };

/** A4 at ~150dpi, matching what the page publishes at. */
export const DOC_W = 1240;
export const DOC_H = 1754;
/** Size of the drawing pane's canvas, in page units. */
const PAD_W = 900;
const PAD_H = 620;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render a legacy stroke array to a PNG data URL, so old ink survives as an
 *  object rather than being dropped when the page becomes a document. */
const strokesToPng = (ss: Stroke[]): string | null => {
  const ink = ss.filter((s) => s.t !== "text");
  if (!ink.length) return null;
  const c = document.createElement("canvas");
  c.width = DOC_W;
  c.height = DOC_H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  renderStrokesScaled(ctx, ink, { w: DOC_W, h: DOC_H }, DOC_W, DOC_H);
  return c.toDataURL("image/png");
};

/** Parse a page's stored content, upgrading the pre-document format. */
export const parseDoc = (raw: string): DocModel => {
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    return { v: 2, html: "", objects: [] };
  }
  if (v && typeof v === "object" && (v as DocModel).v === 2) {
    const d = v as DocModel;
    return { v: 2, html: d.html ?? "", objects: d.objects ?? [] };
  }
  // Legacy: a bare Stroke[]. Typed blocks become paragraphs (in reading order),
  // and the ink is flattened into a single full-page object.
  if (Array.isArray(v)) {
    const ss = v as Stroke[];
    const text = ss
      .filter((s): s is Extract<Stroke, { t: "text" }> => s.t === "text")
      .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)
      .map((s) => `<p>${escapeHtml(s.text).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const png = strokesToPng(ss);
    return {
      v: 2,
      html: text,
      objects: png ? [{ id: "legacy", src: png, x: 0, y: 0, w: DOC_W, h: DOC_H }] : [],
    };
  }
  return { v: 2, html: "", objects: [] };
};

type Props = {
  /** The page's stored content (opaque JSON). */
  content: string;
  onChange: (json: string) => void;
  template?: string;
  /** Explicit page scale, or **null to fit the page to its viewport** — which is
   *  what keeps it readable in a split pane or a narrow window. */
  zoom: number | null;
  /** The scale actually in use, so the host can show a percentage. */
  onScale?: (n: number) => void;
  api?: (a: { pageToBlob: () => Promise<Blob | null>; text: () => string }) => void;
};

const ScribeDoc: Component<Props> = (props) => {
  const initial = parseDoc(props.content);
  const [objects, setObjects] = createSignal<InkObject[]>(initial.objects);
  const [drawing, setDrawing] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null);
  let body!: HTMLDivElement;
  // Width available to the page. Measured, because the pane it lives in resizes
  // for reasons this component can't see: a split-view seam, the sidebar, the
  // agent/terminal column, the window itself.
  const [avail, setAvail] = createSignal(0);
  const PAGE_PAD = 32; // the scroll box's padding, both sides
  const scale = () => {
    const explicit = props.zoom;
    if (explicit != null) return explicit;
    const w = avail() - PAGE_PAD;
    if (w <= 0) return 1;
    return Math.max(0.2, Math.min(1, w / DOC_W));
  };
  let ro: ResizeObserver | undefined;
  const measure = (el: HTMLDivElement) => {
    ro?.disconnect();
    ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
  };
  onCleanup(() => ro?.disconnect());
  createEffect(() => props.onScale?.(scale()));

  let inkApi: InkApi | null = null;
  let padStrokes: Stroke[] = [];

  /** Serialize the current page. The editor owns its own DOM, so the HTML is
   *  read out of it rather than mirrored in a signal — mirroring would fight the
   *  caret on every keystroke. */
  const emit = () => {
    const model: DocModel = { v: 2, html: body?.innerHTML ?? "", objects: objects() };
    props.onChange(JSON.stringify(model));
  };

  onMount(() => {
    body.innerHTML = initial.html;
    props.api?.({
      pageToBlob: async () => {
        // The ink objects are already PNGs; publish the first as the page image.
        const first = objects()[0];
        if (!first) return null;
        const res = await fetch(first.src);
        return await res.blob();
      },
      text: () => body?.innerText ?? "",
    });
  });

  // ── formatting ──
  // execCommand is deprecated but universally implemented, and it gives a real
  // editor's behaviour (selection-aware bold, lists, block types) for a fraction
  // of the code a custom model would need.
  const cmd = (name: string, arg?: string) => {
    body.focus();
    document.execCommand(name, false, arg);
    emit();
  };

  // ── ink objects ──
  const insertDrawing = async () => {
    if (!inkApi) return;
    const blob = await inkApi.pageToBlob();
    setDrawing(false);
    if (!blob) return;
    const src = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(blob);
    });
    // Land it near the top-left of the page's writing area, sized to fit.
    const w = Math.min(560, DOC_W - 96);
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => {});
    const h = img.height && img.width ? Math.round((w * img.height) / img.width) : 320;
    setObjects((o) => [
      ...o,
      { id: `ink-${Date.now().toString(36)}`, src, x: 48, y: 64 + o.length * 24, w, h },
    ]);
    emit();
  };

  const startObjDrag = (e: PointerEvent, id: string, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    const start = objects().find((o) => o.id === id);
    if (!start) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const z = scale() || 1;
    const move = (me: PointerEvent) => {
      const dx = (me.clientX - sx) / z;
      const dy = (me.clientY - sy) / z;
      setObjects((all) =>
        all.map((o) => {
          if (o.id !== id) return o;
          if (mode === "move") return { ...o, x: start.x + dx, y: start.y + dy };
          // Resize keeps the aspect ratio: a squashed diagram is never wanted.
          const w = Math.max(80, start.w + dx);
          return { ...o, w, h: Math.round((w * start.h) / start.w) };
        }),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      emit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const removeObj = (id: string) => {
    setObjects((o) => o.filter((x) => x.id !== id));
    setSelected(null);
    emit();
  };

  return (
    <div class="sdoc">
      <div class="sdoc-bar">
        <button title="Bold (Ctrl+B)" onClick={() => cmd("bold")}>
          <b>B</b>
        </button>
        <button title="Italic (Ctrl+I)" onClick={() => cmd("italic")}>
          <i>I</i>
        </button>
        <button title="Underline (Ctrl+U)" onClick={() => cmd("underline")}>
          <u>U</u>
        </button>
        <span class="sdoc-sep" />
        <button title="Heading 1" onClick={() => cmd("formatBlock", "h1")}>
          H1
        </button>
        <button title="Heading 2" onClick={() => cmd("formatBlock", "h2")}>
          H2
        </button>
        <button title="Body text" onClick={() => cmd("formatBlock", "p")}>
          ¶
        </button>
        <span class="sdoc-sep" />
        <button title="Bulleted list" onClick={() => cmd("insertUnorderedList")}>
          • List
        </button>
        <button title="Numbered list" onClick={() => cmd("insertOrderedList")}>
          1. List
        </button>
        <span style={{ flex: 1 }} />
        <button
          class="sdoc-draw"
          title="Draw an equation or diagram to insert"
          onClick={() => setDrawing(true)}
        >
          ✏️ Draw
        </button>
      </div>

      <div class="sdoc-scroll" ref={measure}>
        <div class="sdoc-sizer" style={{ width: `${DOC_W * scale()}px`, height: `${DOC_H * scale()}px` }}>
          <div
            class="sdoc-page"
            classList={{ [`tpl-${props.template ?? "plain"}`]: true }}
            style={{
              width: `${DOC_W}px`,
              "min-height": `${DOC_H}px`,
              transform: `scale(${scale()})`,
            }}
            onPointerDown={() => setSelected(null)}
          >
            {/* The document itself: an ordinary editor, so typing behaves the way
              typing is expected to. */}
            <div
              ref={body}
              class="sdoc-body"
              contentEditable
              spellcheck={true}
              onInput={emit}
              onBlur={emit}
            />
            {/* Ink sits above the text as free-floating objects. */}
            <For each={objects()}>
              {(o) => (
                <div
                  class="sdoc-obj"
                  classList={{ on: selected() === o.id }}
                  style={{ left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px` }}
                  onPointerDown={(e) => startObjDrag(e, o.id, "move")}
                >
                  <img src={o.src} alt="" draggable={false} />
                  <Show when={selected() === o.id}>
                    <button class="sdoc-obj-del" title="Delete drawing" onClick={() => removeObj(o.id)}>
                      ✕
                    </button>
                    <div
                      class="sdoc-obj-resize"
                      title="Resize"
                      onPointerDown={(e) => startObjDrag(e, o.id, "resize")}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* The drawing pane: the full ink engine, but scoped to producing one
          object rather than painting the page. */}
      <Show when={drawing()}>
        <div class="sdoc-pad-scrim" onClick={() => setDrawing(false)}>
          <div class="sdoc-pad" onClick={(e) => e.stopPropagation()}>
            <div class="sdoc-pad-head">
              <span>Draw — it'll be inserted as an image you can move</span>
              <span style={{ flex: 1 }} />
              <button class="wb-btn" onClick={() => setDrawing(false)}>
                Cancel
              </button>
              <button class="wb-btn" onClick={() => void insertDrawing()}>
                Insert
              </button>
            </div>
            <InkCanvas
              strokes={padStrokes}
              onChange={(s) => (padStrokes = s)}
              bounds={{ w: PAD_W, h: PAD_H }}
              template="grid"
              api={(a) => (inkApi = a)}
            />
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ScribeDoc;
