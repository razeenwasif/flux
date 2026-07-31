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
import { scribeProofread, type TextFix } from "./ipc";

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
  // A signal, not a plain `let`. InkCanvas is *controlled*: it rebuilds from
  // `props.strokes` on every commit, so the parent has to hand back an updated
  // array. Solid compiles `strokes={padStrokes()}` into a reactive getter, while a
  // bare `strokes={padStrokes}` is read once at creation and frozen — which left
  // every stroke appending to the original empty array, so each new stroke
  // replaced the previous one.
  const [padStrokes, setPadStrokes] = createSignal<Stroke[]>([]);

  // Gemma's proofreading suggestions. `null` means "not asked yet", which is a
  // different thing from an empty list ("asked, nothing wrong") — and the panel
  // says which, so a clean page never looks like a failed check.
  const [fixes, setFixes] = createSignal<TextFix[] | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [fixErr, setFixErr] = createSignal("");

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

  // ── Tab to indent ──
  // A contenteditable does nothing useful with Tab: the browser moves focus out
  // of the document entirely, which is why pressing it appeared to do nothing.
  const INDENT_STEP = 40; // one Docs-sized stop
  const MAX_INDENT = 360;
  const BLOCK_SEL = "p,h1,h2,h3,h4,li,blockquote,pre,div";

  /** The blocks the selection touches, innermost only — so a paragraph inside a
   *  list item isn't indented twice for one keypress. */
  const selectedBlocks = (): HTMLElement[] => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !sel.focusNode || !body.contains(sel.focusNode)) return [];
    const range = sel.getRangeAt(0);
    const hit = Array.from(body.querySelectorAll<HTMLElement>(BLOCK_SEL)).filter((el) =>
      range.intersectsNode(el),
    );
    return hit.filter((el) => !hit.some((other) => other !== el && el.contains(other)));
  };

  const indent = (outward: boolean) => {
    let blocks = selectedBlocks();
    // A page that's only ever been typed into holds its text directly in the
    // editor, with no block to move — so give it one first.
    if (!blocks.length) {
      document.execCommand("formatBlock", false, "p");
      blocks = selectedBlocks();
      if (!blocks.length) return;
    }
    if (blocks.some((el) => el.tagName === "LI")) {
      // Lists nest through the native command, which produces the right markup.
      document.execCommand(outward ? "outdent" : "indent");
    } else {
      for (const el of blocks) {
        const cur = parseFloat(el.style.marginLeft) || 0;
        const next = Math.min(MAX_INDENT, Math.max(0, cur + (outward ? -INDENT_STEP : INDENT_STEP)));
        el.style.marginLeft = next ? `${next}px` : "";
      }
    }
    emit();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    indent(e.shiftKey);
  };

  // ── proofreading ──
  const proofread = async () => {
    const text = body.innerText.trim();
    setFixErr("");
    if (!text) {
      setFixes([]);
      return;
    }
    setChecking(true);
    try {
      setFixes(await scribeProofread(text));
    } catch (e) {
      // Say what went wrong. An empty panel here would read as "no mistakes".
      setFixes(null);
      setFixErr(String(e));
    } finally {
      setChecking(false);
    }
  };

  /** Apply one suggestion by editing the text node that holds it, so the
   *  formatting around it survives — correcting a bold word leaves it bold.
   *  (Writing a text node does collapse the caret to the start of that node, but
   *  focus is on this button when it happens, so nothing visible moves.)
   *
   *  It can miss: the page may have been edited since the check, or the span may
   *  straddle two nodes (half of it bold). That's reported rather than swallowed
   *  — a button that silently does nothing is worse than no button. */
  const applyFix = (f: TextFix): boolean => {
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const v = n.nodeValue ?? "";
      const i = v.indexOf(f.before);
      if (i < 0) continue;
      n.nodeValue = v.slice(0, i) + f.after + v.slice(i + f.before.length);
      setFixes((all) => all?.filter((x) => x !== f) ?? null);
      emit();
      return true;
    }
    setFixErr(`Couldn't find “${f.before}” — the text changed, or it spans formatting.`);
    return false;
  };

  const applyAll = () => {
    setFixErr("");
    const missed = (fixes() ?? []).filter((f) => !applyFix(f)).length;
    if (missed) setFixErr(`${missed} suggestion${missed > 1 ? "s" : ""} no longer match the text.`);
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
          class="sdoc-check"
          title="Check spelling and grammar with Gemma (local)"
          disabled={checking()}
          onClick={() => void proofread()}
        >
          {checking() ? "Checking…" : "✓ Proofread"}
        </button>
        <button
          class="sdoc-draw"
          title="Draw an equation or diagram to insert"
          onClick={() => {
            setPadStrokes([]); // each drawing starts blank, not on top of the last
            setDrawing(true);
          }}
        >
          ✏️ Draw
        </button>
      </div>

      {/* Suggestions live beside the page, never inside it: nothing is changed
          until you accept it. */}
      <Show when={checking() || fixErr() || fixes()}>
        <div class="sdoc-fixes">
          <div class="sdoc-fixes-head">
            <span>Gemma — spelling &amp; grammar</span>
            <span style={{ flex: 1 }} />
            <Show when={(fixes()?.length ?? 0) > 1}>
              <button onClick={applyAll}>Apply all</button>
            </Show>
            <button
              title="Dismiss"
              onClick={() => {
                setFixes(null);
                setFixErr("");
              }}
            >
              ✕
            </button>
          </div>
          <Show when={fixErr()}>
            <p class="sdoc-fixes-err">{fixErr()}</p>
          </Show>
          <Show when={!checking() && fixes()?.length === 0}>
            <p class="sdoc-fixes-note">Nothing to fix — spelling and grammar look right.</p>
          </Show>
          <For each={fixes() ?? []}>
            {(f) => (
              <div class="sdoc-fix">
                <span class="sdoc-fix-before">{f.before}</span>
                <span class="sdoc-fix-arrow">→</span>
                <span class="sdoc-fix-after">{f.after}</span>
                <span class="sdoc-fix-why">{f.why}</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => applyFix(f)}>Apply</button>
                <button title="Ignore" onClick={() => setFixes((all) => all?.filter((x) => x !== f) ?? null)}>
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

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
              onKeyDown={onKeyDown}
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
              strokes={padStrokes()}
              onChange={(s) => setPadStrokes(s)}
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
