/**
 * Macros (BACKLOG #67) — a footer ⏺ popover to record + replay browsing flows.
 * A popover (not a page) so the active tab stays the page you're recording /
 * replaying against. Record captures navigations + clicks + input changes;
 * replay walks them back with waits. Best-effort (selectors drift on changed
 * pages) — the honest limit of record/replay.
 */
import { For, Show, createEffect, createSignal, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  macroCancelRecord,
  macroDelete,
  macroRename,
  macroRun,
  macroStartRecord,
  macroStopRecord,
  macrosList,
  macrosStatus,
  type Macro,
} from "./ipc";

const Macros: Component<{ initialOpen?: boolean }> = (props) => {
  const [open, setOpen] = createSignal(!!props.initialOpen);
  const [list, setList] = createSignal<Macro[]>([]);
  const [recording, setRecording] = createSignal(false);
  const [steps, setSteps] = createSignal(0);
  const [name, setName] = createSignal("");
  const [running, setRunning] = createSignal<number | null>(null);
  const [edit, setEdit] = createSignal<number | null>(null);

  const refresh = () => {
    void macrosList()
      .then(setList)
      .catch(() => {});
    void macrosStatus()
      .then((s) => {
        setRecording(s.recording);
        setSteps(s.step_count);
      })
      .catch(() => {});
  };
  createEffect(() => {
    if (!open()) return;
    // Poll faster while recording so the live step count updates (the effect
    // re-runs when `recording()` flips, swapping the interval).
    visibleInterval(refresh, recording() ? 700 : 2000);
  });

  const start = () =>
    void macroStartRecord().then(() => {
      setName("");
      refresh();
    });
  const save = () =>
    void macroStopRecord(name().trim()).then(() => {
      setName("");
      refresh();
    });
  const discard = () => void macroCancelRecord().then(refresh);
  const run = async (id: number) => {
    setRunning(id);
    try {
      await macroRun(id);
    } finally {
      setRunning(null);
    }
  };
  const del = (id: number) => void macroDelete(id).then(refresh);

  return (
    <div style={{ display: "contents" }}>
      <button
        classList={{ "icon-btn": true, active: open(), "rec-pulse": recording() }}
        title="Macros — record & replay flows"
        onClick={() => setOpen((v) => !v)}
      >
        ⏺
      </button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover shields-pop footer-pop">
          <div class="shields-row">
            <span class="shields-label">Macros</span>
          </div>

          <Show
            when={recording()}
            fallback={
              <button class="macro-rec" onClick={start}>
                ● Record a flow
              </button>
            }
          >
            <div class="macro-recording">
              <span class="macro-rec-dot" /> Recording — {steps()} step{steps() === 1 ? "" : "s"}
            </div>
            <div class="macro-note">Click around / type / navigate in the page, then save.</div>
            <input
              class="boost-input"
              placeholder="Name this macro…"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <div class="macro-actions">
              <button class="boost-apply" onClick={save}>
                ✓ Save macro
              </button>
              <button class="macro-discard" onClick={discard}>
                Discard
              </button>
            </div>
          </Show>

          <Show when={list().length > 0}>
            <div class="shields-sep" />
            <For each={list()}>
              {(m) => (
                <div class="macro-row">
                  <button
                    class="macro-run"
                    title="Run macro"
                    disabled={running() != null}
                    onClick={() => void run(m.id)}
                  >
                    {running() === m.id ? "…" : "▶"}
                  </button>
                  <Show
                    when={edit() === m.id}
                    fallback={
                      <span
                        class="macro-name"
                        onDblClick={() => setEdit(m.id)}
                        title={`${m.steps.length} steps`}
                      >
                        {m.name}
                      </span>
                    }
                  >
                    <input
                      class="macro-rename"
                      value={m.name}
                      autofocus
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim();
                        if (v) void macroRename(m.id, v).then(refresh);
                        setEdit(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        else if (e.key === "Escape") setEdit(null);
                      }}
                    />
                  </Show>
                  <span class="macro-count">{m.steps.length}</span>
                  <button class="macro-del" title="Delete" onClick={() => del(m.id)}>
                    ✕
                  </button>
                </div>
              )}
            </For>
          </Show>
          <Show when={list().length === 0 && !recording()}>
            <div class="macro-note">No macros yet. Record a flow to automate it.</div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Macros;
