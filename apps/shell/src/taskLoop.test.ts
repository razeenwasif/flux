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
vi.mock("./ipc", async (importOriginal) => ({
  ...ipc,
  // The real formatter: the step lines tested here show its output.
  typedText: (await importOriginal<typeof import("./ipc")>()).typedText,
}));

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
let plan: (AgentAction | AgentAction[])[];
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
    const next = plan.shift() ?? finish;
    return Array.isArray(next) ? next : [next];
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
    expect(lines).toContain(
      "Draft · type “hi” into #qty — applied, unverified: the field doesn't hold the text",
    );
    expect(seen[2]?.[0]).toBe("UNVERIFIED [draft] type “hi” into #qty (the field doesn't hold the text)");
    expect(last()).toBe(
      "Finished, but not confirmed: Order placed (1 step applied without the page showing it)",
    );
  });

  it("treats the page's report that a step didn't run as not done", async () => {
    plan = [type("#card")];
    failures = { "#card": "blocked_sensitive" };
    await runTaskLoop("pay", deps);
    expect(ipc.agentVerifyStep).not.toHaveBeenCalled();
    expect(seen[1]).toEqual(["✕ NOT DONE (blocked sensitive): type “hi” into #card"]);
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
      "✕ NOT ALLOWED (Flux's agent never types into password fields): type “hi” into #password",
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

describe("a batch: several steps from one look at the page", () => {
  const moved: StepVerdict = { verified: true, how: "the page moved" };
  const named = (kind: StepGuard["kind"], label: string, found = true): StepCheck => ({
    ...check(kind, label),
    before: page({ target: { found, label } as PageFacts["target"] }),
  });

  it("runs them in order for one model call, and looks again", async () => {
    plan = [[type("#a"), type("#b"), click("#go")]];
    await runTaskLoop("fill it in", deps);
    expect(ran).toEqual(["#a", "#b", "#go"]);
    expect(ipc.agentTaskStep).toHaveBeenCalledTimes(2);
    expect(seen[1]).toHaveLength(3);
    expect(last()).toBe("✓ Order placed");
  });

  it("still asks about the commit in it, once, and looks again after it", async () => {
    plan = [[type("#a"), click("#send"), click("#after")]];
    guards = { "#a": check("draft", "a"), "#send": check("commit", "send") };
    await runTaskLoop("send it", deps);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["#a", "#send"]);
  });

  it("doesn't run what's left when you skip the commit", async () => {
    plan = [[click("#send"), type("#after")]];
    guards = { "#send": check("commit", "send") };
    decisions = ["skip"];
    await runTaskLoop("send it", deps);
    expect(ran).toEqual([]);
  });

  it("stops at the first step that fails", async () => {
    plan = [[type("#a"), type("#b"), type("#c")]];
    failures = { "#b": "page_changed" };
    await runTaskLoop("fill it in", deps);
    expect(ran).toEqual(["#a", "#b"]);
    expect(seen[1]?.[1]).toBe("✕ NOT DONE (page changed): type “hi” into #b");
  });

  it("stops at a step the page doesn't show", async () => {
    plan = [[click("#dead"), click("#next")]];
    verdicts = { "#dead": { verified: false, how: "nothing on the page changed" } };
    await runTaskLoop("go", deps);
    expect(ran).toEqual(["#dead"]);
  });

  it("stops when the page moves: the rest was planned for the page it left", async () => {
    plan = [[click("#link"), click("#old")]];
    verdicts = { "#link": moved };
    await runTaskLoop("go", deps);
    expect(ran).toEqual(["#link"]);
    expect(ipc.agentTaskStep).toHaveBeenCalledTimes(2);
  });

  it("is refused step by step, and a refused step ends it", async () => {
    plan = [[type("#ok"), type("#password"), type("#after")]];
    guards = { "#password": check("draft", "pw", "Flux's agent never types into a password field") };
    await runTaskLoop("sign in", deps);
    expect(ran).toEqual(["#ok"]);
  });

  it("hands over to a sign-in that appears partway through", async () => {
    plan = [[click("#a"), click("#b")]];
    guards = { "#b": { ...check("read", "b"), before: page({ sign_in: true }) } };
    await runTaskLoop("go", deps);
    expect(ran).toEqual(["#a"]);
  });

  it("a target that's gone goes back to the model, and isn't a refusal", async () => {
    plan = [click("3:e1"), click("3:e2"), click("4:e1")];
    guards = { "3:e1": named("read", "Gone", false), "3:e2": named("read", "Gone", false) };
    await runTaskLoop("go", deps);
    expect(ran).toEqual(["4:e1"]);
    expect(seen[1]?.[0]).toContain("NOT DONE (it isn't on the page now)");
    expect(last()).toBe("✓ Order placed");
  });

  it("names a ref's element, not the ref, in the feed and to the model", async () => {
    plan = [click("7:e3")];
    guards = { "7:e3": named("read", "More details") };
    await runTaskLoop("go", deps);
    const said = lines.join("\n") + seen.flat().join("\n");
    expect(said).toContain("click “More details” (next)");
    expect(said).not.toContain("7:e3");
  });
});

describe("what a type step shows before it runs (audit S9)", () => {
  it("quotes the text and makes hidden characters visible", async () => {
    const { typedText } = await import("./ipc");
    expect(typedText("hi")).toBe("“hi”");
    expect(typedText("a\nb‮c")).toBe("“a⏎b\\u202ec”");
    expect(typedText("x".repeat(250))).toBe(`“${"x".repeat(200)}…”`);
  });
});
