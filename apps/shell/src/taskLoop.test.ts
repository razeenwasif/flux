/**
 * The /task loop's promises (Flux Next "agent steps"): a task is done only when
 * the page showed it (no false successes), and each commit is asked about once
 * and runs at most once. Steps' kinds and verdicts come from the engine
 * (steps.rs, tested there); here they're scripted, like a page would answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAction, PageFacts, StepCheck, StepGuard, StepVerdict } from "./ipc";

const ipc = vi.hoisted(() => ({
  agentPageFacts: vi.fn(),
  agentTaskStep: vi.fn(),
  agentStepGuard: vi.fn(),
  agentRunAction: vi.fn(),
  agentVerifyStep: vi.fn(),
}));
vi.mock("./ipc", () => ipc);

import { runTaskLoop, type HandoffChoice, type TaskDeps } from "./taskLoop";

const page = (over: Partial<PageFacts> = {}): PageFacts => ({
  checked: true,
  url: "https://shop.example/cart",
  sign_in: false,
  captcha: false,
  text_len: 100,
  text_hash: "1",
  target: null,
  ...over,
});
const check = (kind: StepGuard["kind"], fingerprint: string, blocked: string | null = null): StepCheck => ({
  guard: { kind, why: "", effect: "", blocked, preview: `Click “${fingerprint}”`, fingerprint },
  before: page(),
});
const click = (selector: string): AgentAction => ({ action: "click", selector, reason: "next" });
const type = (selector: string): AgentAction => ({ action: "type", selector, text: "hi" });
const finish: AgentAction = { action: "finish", summary: "Order placed" };

/** The planner's steps in order; each call also records the history it saw. */
let plan: AgentAction[];
let seen: string[][];
/** Each step's kind and target, by selector (as the engine would classify it). */
let guards: Record<string, StepCheck | StepCheck[]>;
let verdicts: Record<string, StepVerdict>;
let lines: string[];
let decisions: ("approve" | "skip" | "stop")[];
let choices: HandoffChoice[];
let failures: Record<string, string>;
let deps: TaskDeps;
let ran: string[];

beforeEach(() => {
  vi.clearAllMocks();
  plan = [];
  seen = [];
  guards = {};
  verdicts = {};
  lines = [];
  decisions = [];
  choices = [];
  failures = {};
  ran = [];
  ipc.agentPageFacts.mockResolvedValue(page());
  ipc.agentTaskStep.mockImplementation(async (_goal: string, history: string[]) => {
    seen.push([...history]);
    return plan.shift() ?? finish;
  });
  ipc.agentStepGuard.mockImplementation(async (a: AgentAction) => {
    const sel = "selector" in a ? a.selector : "";
    const g = guards[sel] ?? check("read", sel);
    return Array.isArray(g) ? g.shift()! : g;
  });
  let last = "";
  ipc.agentRunAction.mockImplementation(async (a: AgentAction) => {
    last = "selector" in a ? a.selector : "";
    ran.push(last);
  });
  ipc.agentVerifyStep.mockImplementation(async (a: AgentAction) => {
    const sel = "selector" in a ? a.selector : "";
    return verdicts[sel] ?? { verified: true, how: "the page changed" };
  });
  deps = {
    say: (_role, text) => lines.push(text),
    busy: () => {},
    activeTab: () => 7,
    tabUrl: () => "https://shop.example/cart",
    expectReport: () => {},
    failure: () => failures[last],
    decide: vi.fn(async () => decisions.shift() ?? "approve"),
    showHandoff: vi.fn(),
    nextChoice: vi.fn(() => {
      const c = choices.shift();
      return c ? Promise.resolve(c) : new Promise<HandoffChoice>(() => {});
    }),
    wait: () => Promise.resolve(),
    stopped: () => false,
  };
});

const last = () => lines[lines.length - 1];

describe("only commits ask", () => {
  it("runs reads and drafts on its own and asks once for the commit", async () => {
    plan = [type("#qty"), click("a.next"), click("#place")];
    guards = { "#qty": check("draft", "qty"), "#place": check("commit", "place") };
    await runTaskLoop("buy it", deps);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["#qty", "a.next", "#place"]);
    expect(last()).toBe("✓ Order placed");
  });

  it("never asks about or runs the same commit twice", async () => {
    plan = [click("#place"), click("#place")];
    guards = { "#place": check("commit", "place") };
    await runTaskLoop("buy it", deps);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["#place"]);
    expect(seen[2]).toContain("✕ NOT REPEATED (already done once): click #place (next)");
  });

  it("doesn't ask again about a commit you skipped, and won't call the task done", async () => {
    plan = [click("#place"), click("#place")];
    guards = { "#place": check("commit", "place") };
    decisions = ["skip"];
    await runTaskLoop("buy it", deps);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);
    expect(last()).toMatch(/^Finished, but not confirmed: Order placed \(1 commit didn't go through; /);
  });

  it("doesn't run a commit whose target changed after you said yes", async () => {
    plan = [click("#place")];
    guards = { "#place": [check("commit", "place"), check("commit", "place-but-different")] };
    await runTaskLoop("buy it", deps);
    expect(ran).toEqual([]);
    expect(lines).toContain("✕ Not done: the page changed before “click #place (next)” ran.");
    expect(last()).toMatch(/^Finished, but not confirmed/);
  });

  it("stops at Stop without running the commit", async () => {
    plan = [click("#place")];
    guards = { "#place": check("commit", "place") };
    decisions = ["stop"];
    await runTaskLoop("buy it", deps);
    expect(ran).toEqual([]);
    expect(last()).toBe("⏹ Task stopped.");
  });
});

describe("no false successes", () => {
  it("won't call the task done when a step didn't show on the page", async () => {
    plan = [type("#qty"), click("#place")];
    guards = { "#qty": check("draft", "qty"), "#place": check("commit", "place") };
    verdicts = { "#qty": { verified: false, how: "the field doesn't hold the text" } };
    await runTaskLoop("buy it", deps);
    expect(lines).toContain("Draft · type into #qty — applied, unverified: the field doesn't hold the text");
    expect(seen[2]?.[0]).toBe("UNVERIFIED [draft] type into #qty (the field doesn't hold the text)");
    expect(last()).toBe(
      "Finished, but not confirmed: Order placed (1 step applied without the page showing it)",
    );
  });

  it("treats the page's report that a step didn't run as not done", async () => {
    plan = [type("#card")];
    failures = { "#card": "blocked_sensitive" };
    await runTaskLoop("pay", deps);
    expect(ipc.agentVerifyStep).not.toHaveBeenCalled();
    expect(seen[1]).toEqual(["✕ NOT DONE (blocked sensitive): type into #card"]);
    expect(last()).toBe("Finished, but not confirmed: Order placed (the last step didn't work)");
  });

  it("never runs a blocked step, and stops after two", async () => {
    plan = [type("#password"), type("#otp")];
    guards = {
      "#password": check("draft", "pw", "Flux's agent never types into password fields"),
      "#otp": check("draft", "otp", "Flux's agent never types into one-time code fields"),
    };
    await runTaskLoop("sign in", deps);
    expect(ran).toEqual([]);
    expect(seen[1]).toEqual([
      "✕ NOT ALLOWED (Flux's agent never types into password fields): type into #password",
    ]);
    expect(last()).toBe("Task stopped: the next steps aren't ones Flux will take.");
  });

  it("confirms a later success after a step it recovered from", async () => {
    plan = [click("#gone"), click("#here")];
    failures = { "#gone": "not_found" };
    await runTaskLoop("open it", deps);
    expect(last()).toBe("✓ Order placed");
  });
});

describe("Stop", () => {
  it("stops before the next step runs on its own", async () => {
    plan = [type("#qty"), click("a.next")];
    let stop = false;
    deps.stopped = () => stop;
    ipc.agentRunAction.mockImplementation(async (a: AgentAction) => {
      ran.push("selector" in a ? a.selector : "");
      stop = true;
    });
    await runTaskLoop("buy it", deps);
    expect(ran).toEqual(["#qty"]);
    expect(last()).toBe("⏹ Task stopped.");
  });
});

describe("sign-in and CAPTCHA hand off", () => {
  it("skips a page once and doesn't offer it again", async () => {
    ipc.agentPageFacts.mockResolvedValue(page({ sign_in: true }));
    plan = [click("a.guest")];
    choices = ["skip"];
    await runTaskLoop("buy it", deps);
    expect(deps.nextChoice).toHaveBeenCalledTimes(1);
    expect(seen[0]?.[0]).toMatch(/^\(skipped a page that needs the user to sign in/);
    expect(deps.showHandoff).toHaveBeenLastCalledWith(null);
  });

  it("keeps waiting and carries on by itself once the sign-in is gone", async () => {
    ipc.agentPageFacts
      .mockResolvedValueOnce(page({ captcha: true })) // the step's first look
      .mockResolvedValueOnce(page({ captcha: true })) // still there
      .mockResolvedValue(page()); // solved
    choices = ["wait"];
    await runTaskLoop("buy it", deps);
    expect(deps.showHandoff).toHaveBeenCalledWith({ what: "captcha", waiting: true });
    expect(deps.showHandoff).toHaveBeenLastCalledWith(null);
    expect(last()).toBe("✓ Order placed");
  });

  it("stops at Stop", async () => {
    ipc.agentPageFacts.mockResolvedValue(page({ sign_in: true }));
    choices = ["stop"];
    await runTaskLoop("buy it", deps);
    expect(ipc.agentTaskStep).not.toHaveBeenCalled();
    expect(last()).toBe("⏹ Task stopped.");
  });
});
