/**
 * The /task loop (#A, Flux Next "agent steps"): plan one step from the live
 * page, run it, look again. What kind of step it is comes from the page, not
 * the model (steps.rs): reads and drafts run on their own, a commit (sends,
 * buys, posts, deletes) asks once with a preview and runs only if its target is
 * still the one you said yes to. A step counts as done only when a fresh look
 * at the page shows it; a sign-in or CAPTCHA is handed to you.
 * Its own chunk, loaded on the first /task: nothing here is needed to paint the
 * window.
 */
import {
  agentPageFacts,
  agentRunAction,
  agentStepGuard,
  agentTaskStep,
  agentVerifyStep,
  type AgentAction,
  type StepGuard,
  type StepVerdict,
} from "./ipc";

export const MAX_TASK_STEPS = 8;
/** How long a click or typing gets to show on the page before Flux looks. */
const SETTLE_MS = 1200;
/** "Keep waiting": look every 3 seconds, for up to 90. */
const POLL_MS = 3000;
const POLLS = 30;

export type Blocker = "sign-in" | "captcha";
export type HandoffChoice = "done" | "skip" | "wait" | "stop";

export interface TaskDeps {
  say: (role: "task" | "assistant" | "action" | "error", text: string) => void;
  busy: (on: boolean) => void;
  activeTab: () => number | undefined;
  tabUrl: (tab?: number) => string | undefined;
  /** Ready for the page's report on the action about to run. */
  expectReport: (tab: number | undefined, action: AgentAction) => void;
  /** The page's report, when it says the action didn't run (not found, blocked). */
  failure: (tab?: number) => string | undefined;
  /** A commit's card; resolves on Do it / Skip / Stop. */
  decide: (action: AgentAction, n: number, guard: StepGuard) => Promise<"approve" | "skip" | "stop">;
  /** Show (or clear) the hand-off card. */
  showHandoff: (h: { what: Blocker; waiting: boolean } | null) => void;
  /** The next button pressed on the hand-off card. */
  nextChoice: () => Promise<HandoffChoice>;
  wait: (ms: number) => Promise<void>;
  /** You pressed Stop while it worked on its own. */
  stopped: () => boolean;
}

const KIND_LABEL: Record<StepGuard["kind"], string> = { read: "Read", draft: "Draft", commit: "Commit" };

/** A step as it's proposed, before anything says whether it happened. */
export function stepWhat(a: AgentAction): string {
  switch (a.action) {
    case "click":
      return `click ${a.selector} (${a.reason})`;
    case "extract_table":
      return `extract ${a.selector} → ${a.format}`;
    case "type":
      return `type into ${a.selector}`;
    case "reveal":
      return `reveal ${a.selector}`;
    case "refuse":
      return a.reason;
    case "finish":
      return a.summary;
  }
}

/** A sign-in or CAPTCHA is yours to do. Resolves when you say you're done,
 *  skip the page or stop; "Keep waiting" watches the page and carries on by
 *  itself once it no longer needs you. */
async function handOff(d: TaskDeps, what: Blocker, tab?: number): Promise<"done" | "skip" | "stop"> {
  let choice = d.nextChoice();
  d.showHandoff({ what, waiting: false });
  try {
    for (;;) {
      const c = await choice;
      if (c !== "wait") return c;
      choice = d.nextChoice();
      d.showHandoff({ what, waiting: true });
      for (let n = 0; n < POLLS; n++) {
        const pressed = await Promise.race([choice.then(() => true), d.wait(POLL_MS).then(() => false)]);
        if (pressed) break;
        const page = await agentPageFacts(tab).catch(() => null);
        if (page?.checked && !page.sign_in && !page.captcha) return "done";
      }
      d.showHandoff({ what, waiting: false });
    }
  } finally {
    d.showHandoff(null);
  }
}

export async function runTaskLoop(goal: string, d: TaskDeps): Promise<void> {
  const history: string[] = [];
  // Each commit is asked about once: what became of it, by its target.
  const decided = new Map<string, "done" | "declined" | "failed">();
  // Pages whose sign-in or CAPTCHA was handed off: not offered again.
  const handedOff = new Set<string>();
  // What keeps a finish from counting as confirmed.
  let unverified = 0;
  let undone = 0;
  let lastOk = true;
  let refused = 0;
  const run = async <T>(p: Promise<T>) => {
    d.busy(true);
    try {
      return await p;
    } finally {
      d.busy(false);
    }
  };

  for (let i = 0; i < MAX_TASK_STEPS; i++) {
    if (d.stopped()) return d.say("task", "⏹ Task stopped.");
    const tab = d.activeTab();
    const page = await agentPageFacts(tab).catch(() => null);
    if (page && (page.sign_in || page.captcha) && !handedOff.has(page.url)) {
      handedOff.add(page.url);
      const c = await handOff(d, page.captcha ? "captcha" : "sign-in", tab);
      if (c === "stop") return d.say("task", "⏹ Task stopped.");
      if (c === "skip")
        history.push(
          "(skipped a page that needs the user to sign in or prove they're human; find another way)",
        );
    }

    // Plan the next step from the live page and what's been done.
    const action = await run(agentTaskStep(goal, history));
    if (action.action === "finish") {
      // Done only counts when the page showed every step that got it there.
      const why = [
        unverified && `${unverified} step${unverified === 1 ? "" : "s"} applied without the page showing it`,
        undone && `${undone} commit${undone === 1 ? "" : "s"} didn't go through`,
        !lastOk && "the last step didn't work",
      ].filter(Boolean);
      return d.say(
        "task",
        why.length
          ? `Finished, but not confirmed: ${action.summary} (${why.join("; ")})`
          : `✓ ${action.summary}`,
      );
    }
    if (action.action === "refuse") return d.say("assistant", `✕ ${action.reason}`);

    const what = stepWhat(action);
    let check = await agentStepGuard(action, tab).catch(() => null);
    if (!check) return d.say("error", "Flux couldn't look at the page. Task stopped.");
    const { guard } = check;
    if (guard.blocked) {
      d.say("assistant", `✕ Not done: ${what} (${guard.blocked})`);
      history.push(`✕ NOT ALLOWED (${guard.blocked}): ${what}`);
      undone++;
      lastOk = false;
      if (++refused >= 2) return d.say("task", "Task stopped: the next steps aren't ones Flux will take.");
      continue;
    }
    if (guard.kind === "commit") {
      const before = decided.get(guard.fingerprint);
      if (before) {
        history.push(
          before === "done"
            ? `✕ NOT REPEATED (already done once): ${what}`
            : before === "declined"
              ? `✕ NOT REPEATED (the user said no to it): ${what}`
              : `✕ NOT REPEATED (it didn't work once): ${what}`,
        );
        d.say("task", `↷ Not asked again: ${what}`);
        lastOk = before === "done";
        continue;
      }
      // Only commits ask, with what they'll do.
      const c = await d.decide(action, i + 1, guard);
      if (c === "stop") return d.say("task", "⏹ Task stopped.");
      if (c === "skip") {
        decided.set(guard.fingerprint, "declined");
        history.push(`✕ SKIPPED BY THE USER: ${what}`);
        undone++;
        lastOk = false;
        continue;
      }
      // It runs only if its target is still the one you said yes to.
      const again = await agentStepGuard(action, tab).catch(() => null);
      if (!again || again.guard.blocked || again.guard.fingerprint !== guard.fingerprint) {
        d.say("assistant", `✕ Not done: the page changed before “${what}” ran.`);
        history.push(`✕ NOT DONE (the page changed before it ran): ${what}`);
        undone++;
        lastOk = false;
        continue;
      }
      check = again;
      decided.set(guard.fingerprint, "done");
    }

    // Run it, let the page settle, then look again.
    if (d.stopped()) return d.say("task", "⏹ Task stopped.");
    d.expectReport(tab, action);
    await run(agentRunAction(action, tab, d.tabUrl(tab)));
    await d.wait(SETTLE_MS);
    const failed = d.failure(tab);
    if (failed) {
      // The page's own report already says so in the feed.
      const why = failed.replace(/_/g, " ");
      history.push(`✕ NOT DONE (${why}): ${what}`);
      if (guard.kind === "commit") {
        decided.set(guard.fingerprint, "failed");
        undone++;
      }
      lastOk = false;
      continue;
    }
    const verdict: StepVerdict = await agentVerifyStep(action, check.before, tab).catch(() => ({
      verified: false,
      how: "Flux couldn't look at the page afterwards",
    }));
    const kind = KIND_LABEL[guard.kind];
    lastOk = verdict.verified;
    if (verdict.verified) {
      d.say("action", `${kind} · ${what} — ✓ ${verdict.how}`);
      history.push(`✓ [${guard.kind}] ${what} (${verdict.how})`);
    } else {
      unverified++;
      d.say("action", `${kind} · ${what} — applied, unverified: ${verdict.how}`);
      history.push(`UNVERIFIED [${guard.kind}] ${what} (${verdict.how})`);
    }
  }
  d.say("task", `Reached the ${MAX_TASK_STEPS}-step limit — stopping.`);
}
