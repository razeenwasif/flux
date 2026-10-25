/**
 * The agent panel's cited-answer and restyle calls (cite.rs, boosts.rs), with
 * the panel rather than in the chrome's entry chunk. Its cards' own calls are
 * in citeCardIpc.ts: shared with the panel, they'd pull the cards' chunks into
 * the panel's.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

import type { BoostDraft, PageAnswerEvent } from "./ipc";

/** Answer from the active page, citing its passages: tokens as they come, then
 *  the answer worked out (which passages it cites, its table's checked claims). */
export const agentPageAnswer = (prompt: string, onEvent: (e: PageAnswerEvent) => void): Promise<void> => {
  const ch = new Channel<PageAnswerEvent>();
  ch.onmessage = onEvent;
  return invoke<void>("agent_page_answer", { prompt, onEvent: ch });
};
/** A restyle of the active page from a sentence: checked against the page and
 *  previewed there, not saved (boostSave saves it, boostPreviewClear drops it). */
export const boostDraft = (instruction: string) => invoke<BoostDraft>("boost_draft", { instruction });
