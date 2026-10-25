/**
 * The cited-answer and restyle cards' calls (cite.rs, boosts.rs), loaded with
 * the cards (CitedAnswer.tsx, RestyleCard.tsx).
 */
import { invoke } from "@tauri-apps/api/core";

/** Scroll `tab` to a cited passage and highlight it: "shown", "not_found",
 *  "moved" (the tab left `url`) or "unavailable". */
export const agentCiteShow = (tab: number, url: string, text: string, n: number) =>
  invoke<string>("agent_cite_show", { tab, url, text, n });
export const agentCiteClear = (tab: number) => invoke<void>("agent_cite_clear", { tab });
/** An answer as up to six to-do lines (none when there's nothing to do). */
export const agentTasksFrom = (text: string) => invoke<string[]>("agent_tasks_from", { text });
export const boostPreviewClear = (tab: number) => invoke<void>("boost_preview_clear", { tab });
