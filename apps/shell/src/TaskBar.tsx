/**
 * The /task bar (taskLoop.ts): what the agent is doing, with Stop; a commit
 * waiting for Do it / Skip / Stop; or a sign-in or CAPTCHA handed to you.
 * Its own chunk, loaded with the first /task.
 */
import { Show, type Component } from "solid-js";
import type { AgentAction, StepGuard } from "./ipc";
import type { Blocker, HandoffChoice } from "./taskLoop";

export interface TaskBarProps {
  /** Planning the next step. */
  working: boolean;
  stopped: boolean;
  step: { action: AgentAction; n: number; guard: StepGuard } | null;
  handoff: { what: Blocker; waiting: boolean } | null;
  onStop: () => void;
  onDecide: (d: "approve" | "skip" | "stop") => void;
  onHandoff: (c: HandoffChoice) => void;
}

const TaskBar: Component<TaskBarProps> = (p) => (
  <div class="agent-task-bar">
    <Show
      when={p.handoff}
      fallback={
        <Show
          when={p.step}
          fallback={
            <div class="agent-approve">
              <span class="agent-task-status">
                {p.stopped ? "stopping…" : p.working ? "planning next step…" : "working…"}
              </span>
              <button class="agent-approve-no" disabled={p.stopped} onClick={p.onStop}>
                ⏹ Stop
              </button>
            </div>
          }
        >
          {(s) => (
            <div class="agent-task-step">
              <div class="agent-task-step-label" title={s().guard.why}>
                Step {s().n} commits: {s().guard.preview}
              </div>
              <div class="agent-approve">
                <button class="agent-approve-yes" onClick={() => p.onDecide("approve")}>
                  ✓ Do it
                </button>
                <button class="agent-approve-no" onClick={() => p.onDecide("skip")}>
                  Skip
                </button>
                <button class="agent-approve-no" onClick={() => p.onDecide("stop")}>
                  ⏹ Stop
                </button>
              </div>
            </div>
          )}
        </Show>
      }
    >
      {(h) => (
        <div class="agent-task-step">
          <div class="agent-task-step-label">
            {h().what === "captcha"
              ? "The page wants you to prove you're human."
              : "The page needs you to sign in."}{" "}
            {h().waiting ? "Waiting for you, up to 90 seconds…" : "Do it in the page, then:"}
          </div>
          <div class="agent-approve">
            <button class="agent-approve-yes" onClick={() => p.onHandoff("done")}>
              I'm done
            </button>
            <button class="agent-approve-no" onClick={() => p.onHandoff("skip")}>
              Skip this page
            </button>
            <Show when={!h().waiting}>
              <button class="agent-approve-no" onClick={() => p.onHandoff("wait")}>
                Keep waiting
              </button>
            </Show>
            <button class="agent-approve-no" onClick={() => p.onHandoff("stop")}>
              ⏹ Stop
            </button>
          </div>
        </div>
      )}
    </Show>
  </div>
);

export default TaskBar;
