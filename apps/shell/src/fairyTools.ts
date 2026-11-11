/**
 * Flux's browser tools, as Fairy uses them (fairy.rs `tools`, Lyra's
 * desktop/flux-tools.mjs). Fairy's model decides what to do; every step runs
 * here through the same checks as /task (taskLoop.ts): the step guard
 * (steps.rs) refuses sensitive sites and controls that order, pay or delete,
 * a commit waits for your answer on the task bar's card and runs only if its
 * target is still the one you said yes to, and a fresh look says whether it
 * happened. Private and Tor tabs are never listed, read or acted on.
 * Loaded with Fairy's first ask: nothing here is needed to paint.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  agentRunAction,
  agentStepGuard,
  agentVerifyStep,
  type AgentAction,
  type StepGuard,
  type StepVerdict,
} from "./ipc";
import { stepWhat } from "./taskLoop";

/** How long a click gets to show on the page before Flux looks; typing shows at once. */
const SETTLE_MS = 1200;
const SETTLE_TYPING_MS = 200;
const KIND_LABEL: Record<StepGuard["kind"], string> = { read: "Read", draft: "Draft", commit: "Commit" };

export type ToolTab = { id: number; title: string; url: string; private?: boolean; tor?: boolean };

export interface FairyToolDeps {
  say: (role: "task" | "assistant" | "action" | "error", text: string) => void;
  /** Browser tabs in the workspace you're in. */
  tabs: () => ToolTab[];
  activeTab: () => number | undefined;
  /** Open `url` in a new tab you then see; resolves with its id. */
  open: (url: string) => Promise<number>;
  expectReport: (tab: number | undefined, action: AgentAction) => void;
  failure: (tab: number | undefined) => string | undefined;
  /** The commit card. */
  decide: (action: AgentAction, n: number, guard: StepGuard) => Promise<"approve" | "skip" | "stop">;
  wait: (ms: number) => Promise<void>;
  /** You pressed Stop on the task bar. */
  stopped: () => boolean;
  /** Fairy has started acting: show the task bar. */
  working: () => void;
}

type Call = { call: number; tool: string; args: Record<string, unknown> };

/** Start answering Fairy's tool calls. Resolves with a function that stops. */
export function serveFairyTools(d: FairyToolDeps): Promise<() => void> {
  let asked = 0;
  // The tabs Fairy may use: browser tabs here, never private or Tor.
  const usable = () => d.tabs().filter((t) => !t.private && !t.tor && /^https?:\/\//i.test(t.url));
  const tabFor = (raw: unknown): number => {
    const id = typeof raw === "number" ? raw : d.activeTab();
    const tab = usable().find((t) => t.id === id);
    if (!tab)
      throw new Error(
        raw == null
          ? "The tab the user is on isn't a web page Fairy can use (private, Tor, or a Flux page). Use flux_tabs or flux_open."
          : "There's no such tab, or it's private or Tor.",
      );
    return tab.id;
  };
  const str = (v: unknown, name: string, max: number): string => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is missing.`);
    if (v.length > max) throw new Error(`${name} is too long.`);
    return v;
  };

  const step = async (action: AgentAction, tab: number) => {
    if (d.stopped()) throw new Error("The user stopped the task.");
    let check = await agentStepGuard(action, tab).catch(() => null);
    if (!check) throw new Error("Flux couldn't look at the page.");
    const what = stepWhat(action, check.before.target?.label);
    if (check.before.target && !check.before.target.found)
      throw new Error("That isn't on the page now. Read the page again.");
    const { guard } = check;
    if (guard.blocked) {
      d.say("assistant", `✕ Not done: ${what} (${guard.blocked})`);
      throw new Error(`Flux refused: ${guard.blocked}.`);
    }
    if (guard.kind === "commit") {
      d.working();
      const c = await d.decide(action, ++asked, guard);
      if (c === "stop") throw new Error("The user stopped the task.");
      if (c === "skip") {
        d.say("task", `↷ Skipped: ${what}`);
        throw new Error("The user said no to this step. Don't try it again.");
      }
      const again = await agentStepGuard(action, tab).catch(() => null);
      if (!again || again.guard.blocked || again.guard.fingerprint !== guard.fingerprint) {
        d.say("assistant", `✕ Not done: the page changed before “${what}” ran.`);
        throw new Error("The page changed before the step ran. Read it again.");
      }
      check = again;
    }
    if (d.stopped()) throw new Error("The user stopped the task.");
    d.working();
    d.expectReport(tab, action);
    await agentRunAction(action, tab, d.tabs().find((t) => t.id === tab)?.url);
    await d.wait(action.action === "type" ? SETTLE_TYPING_MS : SETTLE_MS);
    const failed = d.failure(tab);
    if (failed) throw new Error(`Not done: ${failed.replace(/_/g, " ")}.`);
    const verdict: StepVerdict = await agentVerifyStep(action, check.before, tab).catch(() => ({
      verified: false,
      how: "Flux couldn't look at the page afterwards",
    }));
    const kind = KIND_LABEL[guard.kind];
    d.say(
      "action",
      verdict.verified
        ? `${kind} · ${what} — ✓ ${verdict.how}`
        : `${kind} · ${what} — applied, unverified: ${verdict.how}`,
    );
    return { kind: guard.kind, verified: verdict.verified, how: verdict.how };
  };

  const run = async (tool: string, a: Record<string, unknown>): Promise<unknown> => {
    switch (tool) {
      case "tabs": {
        const active = d.activeTab();
        return usable().map((t) => ({ tab: t.id, title: t.title, url: t.url, active: t.id === active }));
      }
      case "read":
        return invoke("agent_page_view", { tab: tabFor(a.tab) });
      case "open": {
        const url = str(a.url, "The address", 4000).trim();
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https addresses open.");
        const tab = await d.open(url);
        d.say("action", `Opened ${url}`);
        return { tab };
      }
      case "click":
        return step(
          { action: "click", selector: str(a.ref, "ref", 64), reason: str(a.reason, "reason", 300) },
          tabFor(a.tab),
        );
      case "type":
        return step(
          {
            action: "type",
            selector: str(a.ref, "ref", 64),
            text: typeof a.text === "string" ? a.text.slice(0, 5000) : "",
          },
          tabFor(a.tab),
        );
      default:
        throw new Error(`Flux has no tool called ${tool}.`);
    }
  };

  return listen<Call>("flux://fairy-tool", (e) => {
    const { call, tool, args } = e.payload;
    void run(tool, args ?? {}).then(
      (result) => invoke("fairy_tool_result", { call, result: result ?? null, error: null }),
      (err: unknown) =>
        invoke("fairy_tool_result", {
          call,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  });
}
