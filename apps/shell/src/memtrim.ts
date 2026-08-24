/**
 * Which background tabs to trim, and when to forget that we did.
 *
 * WebView2 can GC a tab and drop its decoded image/font caches without unloading
 * it (`webview_memory_low`). That's cheap enough to do on a short fuse, but only
 * *once* per background stint — re-issuing it every sweep would mean a forced GC
 * a minute, forever, on every idle tab.
 *
 * So the caller keeps a note of what it has trimmed, and this decides what to add
 * to that note and what to drop from it. Pure, because both failure modes are
 * silent: forget too eagerly and you re-trim on a loop; forget too late and a tab
 * that came back stays marked and is never trimmed again.
 */

/** How long a tab must sit in the background before it's worth trimming.
 *  One full sweep of the 60 s hibernation timer — long enough that flicking
 *  between two tabs never triggers it, short enough to matter in a long session. */
export const TRIM_IDLE_MS = 60_000;

export interface BackgroundTab {
  id: number;
  /** Milliseconds since this tab was last the active one. */
  idleMs: number;
}

export interface TrimPlan {
  /** Tabs to ask the engine to trim now. */
  trim: number[];
  /** Ids to drop from the trimmed set — they're no longer backgrounded. */
  forget: number[];
}

/**
 * @param background live tabs that are currently off-screen
 * @param trimmed    ids the caller has already trimmed
 */
export function planTrim(background: readonly BackgroundTab[], trimmed: ReadonlySet<number>): TrimPlan {
  const live = new Set(background.map((t) => t.id));
  return {
    // A tab that's no longer in the background is either visible again or gone.
    // Either way the note is stale: `webview_show` restores the normal budget in
    // Rust, and a closed/hibernated tab has no webview left to restore.
    forget: [...trimmed].filter((id) => !live.has(id)),
    trim: background.filter((t) => !trimmed.has(t.id) && t.idleMs >= TRIM_IDLE_MS).map((t) => t.id),
  };
}
