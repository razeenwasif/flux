/**
 * flux://whiteboard — a built-in whiteboard / paint surface. DOM-rendered in
 * the content card (no webview), velvet/glass chrome, lazy chunk.
 *
 * The drawing itself is the shared `InkCanvas` engine (vector strokes, camera
 * pan/zoom, object eraser, undo/redo, PNG export) on its infinite-canvas path
 * (`bounds=null`). This page owns only the whiteboard-specific shell: multiple
 * named boards persisted to localStorage as compact stroke JSON. (Scribe reuses
 * the same engine for paged, disk-backed course notebooks — `ScribePage`.)
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

import InkCanvas, { type Stroke } from "./InkCanvas";
import { activeId, updateTabTitle } from "./store";

type Board = { id: string; name: string; ts: number; strokes: Stroke[] };

const BOARDS_KEY = "flux.whiteboard.boards";
const loadBoards = (): Board[] => {
  try {
    const v = JSON.parse(localStorage.getItem(BOARDS_KEY) || "[]");
    return Array.isArray(v) && v.length ? v : [{ id: "b1", name: "Board 1", ts: Date.now(), strokes: [] }];
  } catch {
    return [{ id: "b1", name: "Board 1", ts: Date.now(), strokes: [] }];
  }
};

const WhiteboardPage: Component = () => {
  const [boards, setBoards] = createSignal<Board[]>(loadBoards());
  const [boardId, setBoardId] = createSignal(boards()[0]!.id);
  const board = () => boards().find((b) => b.id === boardId()) ?? boards()[0]!;

  let saveTimer = 0;
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(BOARDS_KEY, JSON.stringify(boards()));
      } catch {
        /* full/private — drawing still lives in memory */
      }
    }, 500);
  };

  // Undo/redo/export/clear all live inside InkCanvas now; this only persists.
  const setStrokes = (next: Stroke[]) => {
    setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, strokes: next, ts: Date.now() } : b)));
    scheduleSave();
  };

  // ── boards ──
  const addBoard = () => {
    const id = `b${Date.now().toString(36)}`;
    const b: Board = { id, name: `Board ${boards().length + 1}`, ts: Date.now(), strokes: [] };
    setBoards((bs) => [...bs, b]);
    setBoardId(id);
    scheduleSave();
  };
  const renameBoard = () => {
    const name = window.prompt("Board name", board().name)?.trim();
    if (name) {
      setBoards((bs) => bs.map((b) => (b.id === boardId() ? { ...b, name } : b)));
      scheduleSave();
    }
  };
  const deleteBoard = () => {
    if (boards().length <= 1) {
      // Last board: clear it rather than leaving the page empty.
      setStrokes([]);
      return;
    }
    if (!window.confirm(`Delete “${board().name}”?`)) return;
    const gone = boardId();
    setBoards((bs) => bs.filter((b) => b.id !== gone));
    setBoardId(boards()[0]!.id);
    scheduleSave();
  };

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Whiteboard");
    onCleanup(() => {
      window.clearTimeout(saveTimer);
      try {
        localStorage.setItem(BOARDS_KEY, JSON.stringify(boards()));
      } catch {
        /* ignore */
      }
    });
  });

  return (
    <div class="wb">
      {/* Keyed on boardId so switching boards remounts the engine — resetting
          its camera + undo history, exactly as before. */}
      <Show when={boardId()} keyed>
        <InkCanvas strokes={board().strokes} onChange={setStrokes} exportName={() => board().name} />
      </Show>
      <div class="wb-boards">
        <For each={boards()}>
          {(b) => (
            <button
              classList={{ "wb-board": true, on: b.id === boardId() }}
              title={new Date(b.ts).toLocaleString()}
              onClick={() => setBoardId(b.id)}
              onDblClick={renameBoard}
            >
              {b.name}
            </button>
          )}
        </For>
        <button class="wb-board wb-board-add" title="New board" onClick={addBoard}>
          ＋
        </button>
        <span style={{ flex: 1 }} />
        <button class="wb-board" title="Rename board" onClick={renameBoard}>
          ✎
        </button>
        <button class="wb-board" title="Delete board" onClick={deleteBoard}>
          ✕
        </button>
      </div>
    </div>
  );
};

export default WhiteboardPage;
