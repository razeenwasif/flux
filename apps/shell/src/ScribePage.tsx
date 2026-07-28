/**
 * flux://scribe — handwritten, per-course notebooks (ADR 0014). A GoodNotes-style
 * shelf of course notebooks, each an ordered list of fixed-size pages you flip
 * through. The ink is the shared `InkCanvas` engine on its bounded (paged) path;
 * pages persist to disk in Rust (`scribe.rs`) and publish one-way to the Onyx
 * vault as Markdown + an embedded PNG.
 *
 * Whiteboard is the freeform infinite scratch surface; Scribe is the structured,
 * durable course-notes surface. Same engine, different shell.
 */
import { For, Show, createSignal, on, onCleanup, onMount, createEffect, type Component } from "solid-js";

import InkCanvas, { type InkApi, type InkTemplate, type Stroke } from "./InkCanvas";
import {
  scribeCreate,
  scribeDelete,
  scribeList,
  scribeLoad,
  scribePublishPage,
  scribeSave,
  type Notebook,
  type NotebookMeta,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

// A4 portrait at ~150dpi — a familiar page shape with room for long derivations.
const PAGE_W = 1240;
const PAGE_H = 1754;

const TEMPLATES: { id: InkTemplate; label: string }[] = [
  { id: "grid", label: "Grid" },
  { id: "lined", label: "Lined" },
  { id: "squared", label: "Squared" },
  { id: "plain", label: "Plain" },
];

const parseStrokes = (json: string): Stroke[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const blobToB64 = (b: Blob): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      res(s.slice(s.indexOf(",") + 1)); // strip the data: prefix
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

const ScribePage: Component = () => {
  const [shelf, setShelf] = createSignal<NotebookMeta[]>([]);
  const [notebook, setNotebook] = createSignal<Notebook | null>(null);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [pageStrokes, setPageStrokes] = createSignal<Stroke[]>([]);
  const [shelfErr, setShelfErr] = createSignal("");
  const [saveErr, setSaveErr] = createSignal("");

  // New-notebook inline form.
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newCourse, setNewCourse] = createSignal("");

  // Publish panel.
  const [pubOpen, setPubOpen] = createSignal(false);
  const [pubTitle, setPubTitle] = createSignal("");
  const [pubBody, setPubBody] = createSignal("");
  const [pubTags, setPubTags] = createSignal("");
  const [pubMsg, setPubMsg] = createSignal("");
  const [pubBusy, setPubBusy] = createSignal(false);

  let inkApi: InkApi | null = null;
  let saveTimer = 0;

  const pages = () => notebook()?.pages ?? [];
  const curPage = () => pages()[pageIndex()];

  const refreshShelf = async () => {
    try {
      setShelf(await scribeList());
      setShelfErr("");
    } catch (e) {
      setShelfErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Scribe");
    void refreshShelf();
    onCleanup(() => window.clearTimeout(saveTimer));
  });

  // Reload strokes only when the *page identity* changes (open a notebook, flip
  // a page) — not on every autosave, which mutates notebook() too and would
  // needlessly re-parse the page JSON on each stroke.
  createEffect(
    on(
      () => `${notebook()?.id ?? ""}:${pageIndex()}`,
      () => {
        const p = curPage();
        setPageStrokes(p ? parseStrokes(p.strokes) : []);
      },
    ),
  );

  const persist = (nb: Notebook) => {
    setNotebook(nb);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      scribeSave(nb)
        .then(() => setSaveErr(""))
        .catch((e) => setSaveErr(String(e).replace(/^Error:\s*/, "")));
    }, 500);
  };

  const onStrokes = (next: Stroke[]) => {
    setPageStrokes(next);
    const cur = notebook();
    if (!cur) return;
    const idx = pageIndex();
    const pages2 = cur.pages.map((p, i) =>
      i === idx ? { ...p, strokes: JSON.stringify(next), ts: Date.now() } : p,
    );
    persist({ ...cur, pages: pages2 });
  };

  const openNotebook = async (id: string) => {
    try {
      const nb = await scribeLoad(id);
      setNotebook(nb);
      setPageIndex(0);
      const at = activeId();
      if (at != null) updateTabTitle(at, `Scribe · ${nb.name}`);
    } catch (e) {
      setShelfErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const createNotebook = async () => {
    const name = newName().trim();
    if (!name) return;
    try {
      const nb = await scribeCreate(name, newCourse().trim() || undefined);
      setCreating(false);
      setNewName("");
      setNewCourse("");
      await refreshShelf();
      setNotebook(nb);
      setPageIndex(0);
    } catch (e) {
      setShelfErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const removeNotebook = async (id: string, name: string) => {
    if (!window.confirm(`Delete notebook “${name}” and all its pages?`)) return;
    try {
      await scribeDelete(id);
      await refreshShelf();
    } catch (e) {
      setShelfErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const closeToShelf = () => {
    setNotebook(null);
    void refreshShelf();
    const at = activeId();
    if (at != null) updateTabTitle(at, "Scribe");
  };

  const addPage = (template: InkTemplate) => {
    const cur = notebook();
    if (!cur) return;
    const p = {
      id: `pg-${Date.now().toString(36)}`,
      template,
      strokes: "[]",
      ts: Date.now(),
    };
    const pages2 = [...cur.pages, p];
    persist({ ...cur, pages: pages2 });
    setPageIndex(pages2.length - 1);
  };

  const deletePage = () => {
    const cur = notebook();
    if (!cur) return;
    if (cur.pages.length <= 1) {
      onStrokes([]); // last page: clear rather than leave an empty notebook
      return;
    }
    if (!window.confirm("Delete this page?")) return;
    const idx = pageIndex();
    const pages2 = cur.pages.filter((_, i) => i !== idx);
    setPageIndex(Math.min(idx, pages2.length - 1));
    persist({ ...cur, pages: pages2 });
  };

  const renameNotebook = () => {
    const cur = notebook();
    if (!cur) return;
    const name = window.prompt("Notebook name", cur.name)?.trim();
    if (name) {
      persist({ ...cur, name });
      const at = activeId();
      if (at != null) updateTabTitle(at, `Scribe · ${name}`);
    }
  };

  /** The course IS the vault folder this notebook publishes into, so it's
   *  editable after creation (you rarely know the exact folder name up front). */
  const editCourse = () => {
    const cur = notebook();
    if (!cur) return;
    const course = window.prompt(
      "Course — the folder inside your Onyx vault that pages publish into.\n" +
        "Use the folder's exact name (e.g. “06 - Mathematics”). Blank = “Flux Scribe”.",
      cur.course ?? "",
    );
    if (course == null) return; // cancelled
    persist({ ...cur, course: course.trim() || null });
  };

  const openPublish = () => {
    const cur = notebook();
    setPubTitle(`${cur?.name ?? "Note"} — p${pageIndex() + 1}`);
    setPubBody("");
    // Tags persist between publishes — consecutive pages of one lecture usually
    // share them, and clearing every time made tagging tedious enough to skip.
    setPubMsg("");
    setPubOpen(true);
  };

  const doPublish = async () => {
    const cur = notebook();
    if (!cur || !inkApi) return;
    setPubBusy(true);
    setPubMsg("");
    try {
      const blob = await inkApi.pageToBlob();
      if (!blob) {
        setPubMsg("Nothing to publish on this page yet.");
        setPubBusy(false);
        return;
      }
      const b64 = await blobToB64(blob);
      const path = await scribePublishPage(
        cur.id,
        pageIndex(),
        { title: pubTitle().trim() || cur.name, body: pubBody(), tags: pubTags() || null },
        b64,
      );
      setPubMsg(`✓ Published to Onyx:\n${path}`);
    } catch (e) {
      setPubMsg(String(e).replace(/^Error:\s*/, ""));
    }
    setPubBusy(false);
  };

  return (
    <div class="scribe">
      <Show
        when={notebook()}
        fallback={
          // ── Shelf ──
          <div class="scribe-shelf-wrap">
            <div class="scribe-shelf-head">
              <h2>Scribe</h2>
              <span class="scribe-sub">Handwritten notebooks, one per course · publish pages to Onyx</span>
              <span style={{ flex: 1 }} />
              <button class="wb-btn" onClick={() => setCreating((v) => !v)}>
                ＋ New notebook
              </button>
            </div>
            <Show when={creating()}>
              <div class="scribe-create">
                <input
                  class="scribe-input"
                  placeholder="Notebook name (e.g. Calculus)"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void createNotebook()}
                  autofocus
                />
                <input
                  class="scribe-input"
                  placeholder="Course (optional — Onyx folder, e.g. MATH1013)"
                  value={newCourse()}
                  onInput={(e) => setNewCourse(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void createNotebook()}
                />
                <button class="wb-btn" onClick={() => void createNotebook()}>
                  Create
                </button>
              </div>
            </Show>
            <Show when={shelfErr()}>
              <div class="scribe-err">{shelfErr()}</div>
            </Show>
            <div class="scribe-grid">
              <For
                each={shelf()}
                fallback={<div class="scribe-empty">No notebooks yet. Create one for each course.</div>}
              >
                {(nb) => (
                  <div class="scribe-card" onClick={() => void openNotebook(nb.id)}>
                    <div class="scribe-card-spine" style={{ background: nb.tint ?? "#7b61ff" }} />
                    <div class="scribe-card-body">
                      <div class="scribe-card-name">{nb.name}</div>
                      <Show when={nb.course}>
                        <div class="scribe-card-course">{nb.course}</div>
                      </Show>
                      <div class="scribe-card-meta">
                        {nb.page_count} {nb.page_count === 1 ? "page" : "pages"}
                      </div>
                    </div>
                    <button
                      class="scribe-card-del"
                      title="Delete notebook"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeNotebook(nb.id, nb.name);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        }
      >
        {/* ── Open notebook ── */}
        <div class="scribe-topbar">
          <button class="wb-btn" title="Back to shelf" onClick={closeToShelf}>
            ‹ Shelf
          </button>
          <button class="scribe-title" title="Rename notebook" onClick={renameNotebook}>
            {notebook()!.name}
          </button>
          <button
            class="scribe-course-btn"
            classList={{ unset: !notebook()!.course }}
            title={
              notebook()!.course
                ? `Publishes into “${notebook()!.course}” in your Onyx vault — click to change`
                : "No course set — pages publish into “Flux Scribe”. Click to point this notebook at a vault folder."
            }
            onClick={editCourse}
          >
            {notebook()!.course ?? "set course"}
          </button>
          <span style={{ flex: 1 }} />
          <div class="scribe-pagenav">
            <button
              class="wb-btn"
              title="Previous page"
              disabled={pageIndex() === 0}
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            >
              ‹
            </button>
            <span class="scribe-pageno">
              {pageIndex() + 1} / {pages().length}
            </span>
            <button
              class="wb-btn"
              title="Next page"
              disabled={pageIndex() >= pages().length - 1}
              onClick={() => setPageIndex((i) => Math.min(pages().length - 1, i + 1))}
            >
              ›
            </button>
          </div>
          <div class="scribe-addpage">
            <For each={TEMPLATES}>
              {(t) => (
                <button
                  class="scribe-addbtn"
                  title={`Add ${t.label.toLowerCase()} page`}
                  onClick={() => addPage(t.id)}
                >
                  ＋{t.label}
                </button>
              )}
            </For>
          </div>
          <button class="wb-btn danger" title="Delete this page" onClick={deletePage}>
            🗑 Page
          </button>
          <button class="wb-btn" title="Publish this page to Onyx" onClick={openPublish}>
            ⇪ Onyx
          </button>
        </div>
        <Show when={saveErr()}>
          <div class="scribe-err">Autosave failed: {saveErr()}</div>
        </Show>
        {/* Keyed on notebook+page so flipping remounts the engine (fresh camera
            + undo history) and loads that page's strokes. */}
        <Show when={`${notebook()!.id}:${pageIndex()}`} keyed>
          <InkCanvas
            strokes={pageStrokes()}
            onChange={onStrokes}
            bounds={{ w: PAGE_W, h: PAGE_H }}
            template={(curPage()?.template as InkTemplate) ?? "grid"}
            exportName={() => `${notebook()!.name}-p${pageIndex() + 1}`}
            api={(a) => (inkApi = a)}
          />
        </Show>

        <Show when={pubOpen()}>
          <div class="scribe-pub-scrim" onClick={() => !pubBusy() && setPubOpen(false)}>
            <div class="scribe-pub" onClick={(e) => e.stopPropagation()}>
              <div class="scribe-pub-head">Publish page to Onyx</div>
              <input
                class="scribe-input"
                placeholder="Note title"
                value={pubTitle()}
                onInput={(e) => setPubTitle(e.currentTarget.value)}
              />
              <textarea
                class="scribe-pub-body"
                placeholder="Notes / transcription (optional) — this becomes the searchable text in Onyx"
                value={pubBody()}
                onInput={(e) => setPubBody(e.currentTarget.value)}
              />
              <input
                class="scribe-input"
                placeholder="Tags — e.g. kkt, duality, convexity (commas or spaces; # optional)"
                value={pubTags()}
                onInput={(e) => setPubTags(e.currentTarget.value)}
              />
              <div class="scribe-pub-hint">
                Writes a Markdown note with the handwriting embedded as a PNG into{" "}
                <b>{notebook()!.course || "Flux Scribe"}</b> in your vault. One-way — Scribe keeps the ink.
              </div>
              <Show when={pubMsg()}>
                <div class="scribe-pub-msg">{pubMsg()}</div>
              </Show>
              <div class="scribe-pub-actions">
                <button class="wb-btn" disabled={pubBusy()} onClick={() => setPubOpen(false)}>
                  Close
                </button>
                <button class="wb-btn" disabled={pubBusy()} onClick={() => void doPublish()}>
                  {pubBusy() ? "Publishing…" : "Publish"}
                </button>
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default ScribePage;
