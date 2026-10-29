// The Indexer orb's commands (indexer.rs). A module of its own rather than
// ipc.ts: only the lazily loaded orb uses them, and ipc.ts is in the entry chunk.
import { invoke } from "@tauri-apps/api/core";
import type { IndexerPick, IndexerResults, IndexerStatus } from "./bindings.gen";

export type { IndexerMatch, IndexerPick, IndexerResults, IndexerShelf, IndexerStatus } from "./bindings.gen";

/** State of the index; the first call of a session starts an incremental build. */
export const indexerStatus = () => invoke<IndexerStatus>("indexer_status");
/** Re-read changed notes in the background. */
export const indexerReindex = () => invoke<IndexerStatus>("indexer_reindex");
/** Read the PDFs in another folder too (lecture slides, say); starts reading. */
export const indexerAddFolder = (path: string) => invoke<IndexerStatus>("indexer_add_folder", { path });
/** Stop reading a folder added with `indexerAddFolder`. */
export const indexerRemoveFolder = (path: string) => invoke<IndexerStatus>("indexer_remove_folder", { path });
/** Which cards a search looks at. */
export type IndexerScope = "all" | "notes" | "books";
export const indexerSearch = (query: string, k?: number, scope?: IndexerScope) =>
  invoke<IndexerResults>("indexer_search", { query, k, scope });
/** The System 1 tie-break: which option (a match's `label`) answers `question`. */
export const indexerDecide = (question: string, options: string[]) =>
  invoke<IndexerPick>("indexer_decide", { question, options });
/** Load the System 1 model ahead of a question. Fire and forget. */
export const indexerWarm = () => invoke<void>("indexer_warm");
/** Open a note in the default text editor, not the app macOS registers for
 *  `.md` (often Xcode). */
export const openNote = (path: string) => invoke<void>("fs_open_text", { path });
