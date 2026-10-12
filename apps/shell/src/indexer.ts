// The Indexer orb's commands (indexer.rs). A module of its own rather than
// ipc.ts: only the lazily loaded orb uses them, and ipc.ts is in the entry chunk.
import { invoke } from "@tauri-apps/api/core";
import type { IndexerPick, IndexerResults, IndexerStatus } from "./bindings.gen";

export type { IndexerMatch, IndexerPick, IndexerResults, IndexerStatus } from "./bindings.gen";

/** State of the index; the first call of a session starts an incremental build. */
export const indexerStatus = () => invoke<IndexerStatus>("indexer_status");
/** Re-read changed notes in the background. */
export const indexerReindex = () => invoke<IndexerStatus>("indexer_reindex");
export const indexerSearch = (query: string, k?: number) =>
  invoke<IndexerResults>("indexer_search", { query, k });
/** The System 1 tie-break: which option (a match's `label`) answers `question`. */
export const indexerDecide = (question: string, options: string[]) =>
  invoke<IndexerPick>("indexer_decide", { question, options });
/** Load the System 1 model ahead of a question. Fire and forget. */
export const indexerWarm = () => invoke<void>("indexer_warm");
