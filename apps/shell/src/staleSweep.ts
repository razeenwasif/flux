/**
 * Auto-archive sweep (#46, branch-aware) — dynamically imported from App's
 * hibernation timer so none of this rides in the eager boot bundle.
 *
 * Stale tabs that form a Trail-connected "rabbit hole" archive together as ONE
 * branch — closed as a set, recorded as a named unit (Gemma writes the name
 * asynchronously), restorable as a set. Loners fall back to the flat per-tab
 * archived list. Gentle: at most one branch + a few singles per sweep.
 */
import { agentChat, traceBranches } from "./ipc";
import {
  archiveBranchRecord,
  archiveTabRecord,
  closeTab,
  staleTabIds,
  tabs,
  updateBranchSummary,
} from "./store";

export async function runStaleSweep(now: number): Promise<void> {
  const stale = staleTabIds(now);
  if (stale.length === 0) return;
  const refs = stale
    .map((id) => tabs().find((x) => x.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({ id: t.id, url: t.url }));
  let branches: number[][] = refs.map((r) => [r.id]); // fallback: all singles
  try {
    branches = await traceBranches(refs);
  } catch {
    /* backend unavailable → per-tab behavior */
  }
  let didBranch = false;
  let singles = 0;
  for (const branch of branches) {
    const members = branch
      .map((id) => tabs().find((x) => x.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t);
    if (members.length >= 2 && !didBranch) {
      didBranch = true; // one branch per sweep keeps it gentle
      const bid = archiveBranchRecord(members.map((t) => ({ url: t.url, title: t.title })));
      for (const t of members) void closeTab(t.id);
      // Name the rabbit hole (best-effort, local Gemma; placeholder until then).
      const titles = members.map((t) => `- ${t.title || t.url}`).join("\n");
      void agentChat(
        `These pages were one research thread that is now archived. In at most 10 words, name the thread — output ONLY the name, no quotes, no period:\n${titles}`,
      )
        .then((r) => {
          const s =
            r
              .trim()
              .split("\n")[0]
              ?.replace(/^["'\s]+|["'\s.]+$/g, "") ?? "";
          if (s && s.length <= 90) updateBranchSummary(bid, s);
        })
        .catch(() => {});
    } else if (members.length === 1 && singles < 5) {
      singles++;
      const t = members[0]!;
      archiveTabRecord(t.url, t.title);
      void closeTab(t.id);
    }
  }
}
