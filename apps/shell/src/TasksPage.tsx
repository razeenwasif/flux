/**
 * flux://tasks — built-in task manager (BACKLOG #107). System-wide process
 * monitor: name / CPU% / resident memory, with Flux's own process tree flagged
 * and one-click "end task". DOM-rendered (no webview), like flux://resources.
 * Polls only while open. CPU% is summed across cores (matches OS task managers),
 * and reads 0 on the very first poll (sysinfo needs two samples for a delta).
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { tasksKill, tasksList, type ProcInfo } from "./ipc";
import { activeId, updateTabTitle } from "./store";

type SortKey = "mem" | "cpu" | "name";

const TasksPage: Component = () => {
  const [procs, setProcs] = createSignal<ProcInfo[]>([]);
  const [sort, setSort] = createSignal<SortKey>("mem");
  const [busy, setBusy] = createSignal<number | null>(null);

  const refresh = () => {
    void tasksList().then((p) => setProcs(p ?? [])).catch(() => {});
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Task Manager");
    refresh();
    const t = window.setInterval(refresh, 2500);
    onCleanup(() => clearInterval(t));
  });

  const sorted = createMemo(() => {
    const k = sort();
    return [...procs()].sort((a, b) =>
      k === "name" ? a.name.localeCompare(b.name) : k === "cpu" ? b.cpu - a.cpu : b.mem_mb - a.mem_mb,
    );
  });
  const fluxProcs = createMemo(() => procs().filter((p) => p.is_flux));
  const fluxMem = createMemo(() => fluxProcs().reduce((s, p) => s + p.mem_mb, 0));

  const end = async (p: ProcInfo) => {
    if (p.current && !window.confirm("End the main Flux process? This quits the browser.")) return;
    setBusy(p.pid);
    try {
      await tasksKill(p.pid);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const SortTh = (props: { k: SortKey; label: string }) => (
    <button classList={{ "tm-th": true, active: sort() === props.k }} onClick={() => setSort(props.k)}>
      {props.label}
      {sort() === props.k ? " ↓" : ""}
    </button>
  );

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🗂️ Task Manager</div>
        <span class="res-mem">
          {procs().length} processes · Flux: {fluxProcs().length} ({fluxMem()} MB)
        </span>
        <button class="hist-clear" onClick={refresh}>↻ Refresh</button>
      </header>

      <div class="hist-body">
        <div class="res-note">
          Live system processes. <b>Flux</b>-tagged rows are the browser's own engine/helper
          processes. CPU% is summed across cores and settles after the first refresh.
        </div>
        <div class="tm-row tm-header">
          <span class="tm-badge" />
          <SortTh k="name" label="Process" />
          <span class="tm-pid">PID</span>
          <SortTh k="cpu" label="CPU" />
          <SortTh k="mem" label="Memory" />
          <span class="tm-act" />
        </div>
        <Show when={sorted().length > 0} fallback={<div class="hist-empty">Reading processes…</div>}>
          <For each={sorted()}>
            {(p) => (
              <div classList={{ "tm-row": true, flux: p.is_flux, self: p.current }}>
                <span class="tm-badge" title={p.is_flux ? "Flux process" : "System process"}>
                  {p.current ? "★" : p.is_flux ? "●" : ""}
                </span>
                <span class="tm-name" title={p.name}>{p.name || "(unknown)"}</span>
                <span class="tm-pid">{p.pid}</span>
                <span classList={{ "tm-cpu": true, hot: p.cpu >= 25 }}>{p.cpu.toFixed(1)}%</span>
                <span class="tm-mem">{p.mem_mb} MB</span>
                <button class="tm-kill" disabled={busy() === p.pid} onClick={() => void end(p)} title="End task">
                  ✕
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default TasksPage;
