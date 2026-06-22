/**
 * flux://tasks — built-in task manager (BACKLOG #107). System-wide process
 * monitor with live CPU / memory graphs up top and a sortable process list
 * below (name / CPU% / resident memory, end-task). Flux's own process tree is
 * flagged. DOM-rendered, polls only while open. CPU% is summed across cores and
 * reads 0 on the first poll (sysinfo needs two samples for a delta).
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import { tasksKill, tasksList, tasksStats, type ProcInfo, type SysStats } from "./ipc";
import { activeId, updateTabTitle } from "./store";

type SortKey = "mem" | "cpu" | "name";
const HISTORY = 60; // samples kept (~2.5 min at 2.5s/poll)

/** A live area-graph of a 0–100 series (newest sample on the right). */
const Graph: Component<{ data: number[]; color: string; label: string; value: string; sub?: string }> = (props) => {
  const W = 140, H = 44;
  const geom = createMemo(() => {
    const d = props.data;
    if (!d.length) return { line: "", area: "" };
    const step = W / Math.max(1, HISTORY - 1);
    const pts = d.map((v, i) => {
      const x = W - (d.length - 1 - i) * step;
      const y = H - (Math.min(100, Math.max(0, v)) / 100) * H;
      return [x, y] as const;
    });
    const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const firstX = pts[0]![0];
    const lastX = pts[pts.length - 1]![0];
    const area = `${firstX.toFixed(1)},${H} ${line} ${lastX.toFixed(1)},${H}`;
    return { line, area };
  });
  return (
    <div class="tm-graph">
      <div class="tm-graph-head">
        <span class="tm-graph-label">{props.label}</span>
        <span class="tm-graph-val" style={{ color: props.color }}>{props.value}</span>
      </div>
      <svg class="tm-graph-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polygon points={geom().area} fill={props.color} opacity="0.16" />
        <polyline points={geom().line} fill="none" stroke={props.color} stroke-width="1.6" vector-effect="non-scaling-stroke" />
      </svg>
      <Show when={props.sub}><div class="tm-graph-sub">{props.sub}</div></Show>
    </div>
  );
};

const TasksPage: Component = () => {
  const [procs, setProcs] = createSignal<ProcInfo[]>([]);
  const [stats, setStats] = createSignal<SysStats | null>(null);
  const [cpuHist, setCpuHist] = createSignal<number[]>([]);
  const [memHist, setMemHist] = createSignal<number[]>([]);
  const [sort, setSort] = createSignal<SortKey>("mem");
  const [busy, setBusy] = createSignal<number | null>(null);

  const refresh = () => {
    void tasksList().then((p) => setProcs(p ?? [])).catch(() => {});
    void tasksStats()
      .then((s) => {
        if (!s) return;
        setStats(s);
        setCpuHist((h) => [...h, s.cpu].slice(-HISTORY));
        setMemHist((h) => [...h, s.mem_pct].slice(-HISTORY));
      })
      .catch(() => {});
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Task Manager");
    visibleInterval(refresh, 2500);
  });

  const sorted = createMemo(() => {
    const k = sort();
    return [...procs()].sort((a, b) =>
      k === "name" ? a.name.localeCompare(b.name) : k === "cpu" ? b.cpu - a.cpu : b.mem_mb - a.mem_mb,
    );
  });
  const fluxProcs = createMemo(() => procs().filter((p) => p.is_flux));
  const fluxMem = createMemo(() => fluxProcs().reduce((s, p) => s + p.mem_mb, 0));
  const gb = (mb: number) => (mb / 1024).toFixed(1);

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
      {props.label}{sort() === props.k ? " ↓" : ""}
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
        <div class="tm-graphs">
          <Graph
            data={cpuHist()}
            color="var(--flux-teal)"
            label="CPU"
            value={`${(stats()?.cpu ?? 0).toFixed(0)}%`}
            sub={stats() ? `${stats()!.cores} cores` : undefined}
          />
          <Graph
            data={memHist()}
            color="#9a7bff"
            label="Memory"
            value={`${stats()?.mem_pct ?? 0}%`}
            sub={stats() ? `${gb(stats()!.mem_used_mb)} / ${gb(stats()!.mem_total_mb)} GB` : undefined}
          />
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
                <button class="tm-kill" disabled={busy() === p.pid} onClick={() => void end(p)} title="End task">✕</button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default TasksPage;
