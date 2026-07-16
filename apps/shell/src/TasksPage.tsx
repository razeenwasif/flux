/**
 * flux://tasks — built-in task manager (BACKLOG #107), btop-style. A full-page
 * system monitor: CPU (overall graph + per-core bars), memory + swap, network
 * throughput, GPU(s) via nvidia-smi, and a sortable process list with end-task.
 * Flux's own process tree is flagged. DOM-rendered, polls only while visible.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  gpuStats,
  tasksKill,
  tasksList,
  tasksStats,
  type GpuInfo,
  type ProcInfo,
  type SysStats,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

type SortKey = "mem" | "cpu" | "name";
const HISTORY = 90; // samples kept (~3 min at 2s/poll)

const gb = (mb: number) => (mb / 1024).toFixed(1);
const pctOf = (used: number, total: number) => (total > 0 ? Math.round((used * 100) / total) : 0);
const loadColor = (pct: number) => (pct >= 85 ? "#ff6b6b" : pct >= 55 ? "#f5c451" : "var(--flux-teal)");
const fmtBps = (b: number): string => {
  if (b < 1024) return `${b | 0} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB/s`;
  return `${(b / 1048576).toFixed(1)} MB/s`;
};
const fmtUptime = (s: number): string => {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ") || "0m";
};

/** A live area-graph of a 0–100 series (newest sample on the right), stretched. */
const Graph: Component<{ data: number[]; color: string }> = (props) => {
  const W = 240,
    H = 40;
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
    return { line, area: `${pts[0]![0].toFixed(1)},${H} ${line} ${pts[pts.length - 1]![0].toFixed(1)},${H}` };
  });
  return (
    <svg class="tm-graph-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={geom().area} fill={props.color} opacity="0.16" />
      <polyline
        points={geom().line}
        fill="none"
        stroke={props.color}
        stroke-width="1.6"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
};

/** A labelled horizontal fill bar (RAM / swap / VRAM). */
const Bar: Component<{ label: string; pct: number; text: string; color: string }> = (p) => (
  <div class="tm-bar-row">
    <span class="tm-bar-label">{p.label}</span>
    <div class="tm-bar">
      <div class="tm-bar-fill" style={{ width: `${Math.min(100, p.pct)}%`, background: p.color }} />
    </div>
    <span class="tm-bar-text">{p.text}</span>
  </div>
);

const TasksPage: Component = () => {
  const [procs, setProcs] = createSignal<ProcInfo[]>([]);
  const [stats, setStats] = createSignal<SysStats | null>(null);
  const [gpus, setGpus] = createSignal<GpuInfo[]>([]);
  const [cpuHist, setCpuHist] = createSignal<number[]>([]);
  const [memHist, setMemHist] = createSignal<number[]>([]);
  const [netHist, setNetHist] = createSignal<number[]>([]);
  const [gpuHist, setGpuHist] = createSignal<number[]>([]);
  const [netPeak, setNetPeak] = createSignal(1);
  const [sort, setSort] = createSignal<SortKey>("cpu");
  const [busy, setBusy] = createSignal<number | null>(null);

  const refresh = () => {
    void tasksList()
      .then((p) => setProcs(p ?? []))
      .catch(() => {});
    void tasksStats()
      .then((s) => {
        if (!s) return;
        setStats(s);
        setCpuHist((h) => [...h, s.cpu].slice(-HISTORY));
        setMemHist((h) => [...h, s.mem_pct].slice(-HISTORY));
        const rate = s.net_rx_bps + s.net_tx_bps;
        setNetPeak((pk) => Math.max(pk * 0.97, rate, 1)); // peak decays so the graph re-scales
        setNetHist((h) => [...h, rate].slice(-HISTORY));
      })
      .catch(() => {});
    void gpuStats()
      .then((g) => {
        setGpus(g ?? []);
        if (g?.[0]) setGpuHist((h) => [...h, g[0]!.util_pct].slice(-HISTORY));
      })
      .catch(() => {});
  };
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Task Manager");
    visibleInterval(refresh, 2000);
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
    <div class="tm-page">
      <header class="tm-head">
        <div class="tm-title">🗂️ Task Manager</div>
        <Show when={stats()}>
          {(s) => (
            <span class="tm-sub" title={s().cpu_brand}>
              {s().cpu_brand || "CPU"} · {s().cores} cores · up {fmtUptime(s().uptime_secs)} ·{" "}
              {procs().length} procs · Flux {fluxProcs().length} ({fluxMem()} MB)
            </span>
          )}
        </Show>
        <button class="tm-refresh" title="Refresh now" onClick={refresh}>
          ↻
        </button>
      </header>

      <div class="tm-grid">
        {/* CPU — overall graph + per-core bars */}
        <div class="tm-card tm-card-wide">
          <div class="tm-card-head">
            <span>CPU</span>
            <span class="tm-card-val" style={{ color: loadColor(stats()?.cpu ?? 0) }}>
              {(stats()?.cpu ?? 0).toFixed(0)}%
            </span>
          </div>
          <Graph data={cpuHist()} color="var(--flux-teal)" />
          <div class="tm-cores">
            <For each={stats()?.per_core ?? []}>
              {(c, i) => (
                <div class="tm-core" title={`core ${i()}: ${c.toFixed(0)}%`}>
                  <div class="tm-core-bar">
                    <div
                      class="tm-core-fill"
                      style={{ height: `${Math.min(100, c)}%`, background: loadColor(c) }}
                    />
                  </div>
                  <span class="tm-core-n">{i()}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        {/* Memory + swap */}
        <div class="tm-card">
          <div class="tm-card-head">
            <span>Memory</span>
            <span class="tm-card-val" style={{ color: "#9a7bff" }}>
              {stats()?.mem_pct ?? 0}%
            </span>
          </div>
          <Graph data={memHist()} color="#9a7bff" />
          <Show when={stats()}>
            {(s) => (
              <>
                <Bar
                  label="RAM"
                  pct={s().mem_pct}
                  text={`${gb(s().mem_used_mb)} / ${gb(s().mem_total_mb)} GB`}
                  color="#9a7bff"
                />
                <Show when={s().swap_total_mb > 0}>
                  <Bar
                    label="Swap"
                    pct={pctOf(s().swap_used_mb, s().swap_total_mb)}
                    text={`${gb(s().swap_used_mb)} / ${gb(s().swap_total_mb)} GB`}
                    color="#ec7bd0"
                  />
                </Show>
              </>
            )}
          </Show>
        </div>

        {/* Network */}
        <div class="tm-card">
          <div class="tm-card-head">
            <span>Network</span>
          </div>
          <Graph data={netHist().map((r) => (r / netPeak()) * 100)} color="#5bc0eb" />
          <Show when={stats()}>
            {(s) => (
              <div class="tm-net">
                <span class="tm-net-dn">↓ {fmtBps(s().net_rx_bps)}</span>
                <span class="tm-net-up">↑ {fmtBps(s().net_tx_bps)}</span>
              </div>
            )}
          </Show>
        </div>

        {/* GPU(s) — only when nvidia-smi reports any */}
        <For each={gpus()}>
          {(g, i) => (
            <div class="tm-card">
              <div class="tm-card-head">
                <span title={g.name}>GPU{gpus().length > 1 ? ` ${i()}` : ""}</span>
                <span class="tm-card-val" style={{ color: loadColor(g.util_pct) }}>
                  {g.util_pct.toFixed(0)}%
                </span>
              </div>
              <Show when={i() === 0}>
                <Graph data={gpuHist()} color="#7CF5B0" />
              </Show>
              <Bar
                label="VRAM"
                pct={pctOf(g.mem_used_mb, g.mem_total_mb)}
                text={`${gb(g.mem_used_mb)} / ${gb(g.mem_total_mb)} GB`}
                color="#7CF5B0"
              />
              <div class="tm-gpu-meta">
                <span class="tm-gpu-name" title={g.name}>
                  {g.name}
                </span>
                <span>
                  {g.temp_c.toFixed(0)}°C · {g.power_w.toFixed(0)} W
                </span>
              </div>
            </div>
          )}
        </For>
      </div>

      {/* Process list */}
      <div class="tm-proc">
        <div class="tm-row tm-header">
          <span class="tm-badge" />
          <SortTh k="name" label="Process" />
          <span class="tm-pid">PID</span>
          <SortTh k="cpu" label="CPU" />
          <SortTh k="mem" label="Memory" />
          <span class="tm-act" />
        </div>
        <div class="tm-proc-list">
          <Show when={sorted().length > 0} fallback={<div class="tm-empty">Reading processes…</div>}>
            <For each={sorted()}>
              {(p) => (
                <div classList={{ "tm-row": true, flux: p.is_flux, self: p.current }}>
                  <span class="tm-badge" title={p.is_flux ? "Flux process" : "System process"}>
                    {p.current ? "★" : p.is_flux ? "●" : ""}
                  </span>
                  <span class="tm-name" title={p.name}>
                    {p.name || "(unknown)"}
                  </span>
                  <span class="tm-pid">{p.pid}</span>
                  <span classList={{ "tm-cpu": true, hot: p.cpu >= 25 }}>{p.cpu.toFixed(1)}%</span>
                  <span class="tm-mem">{p.mem_mb} MB</span>
                  <button
                    class="tm-kill"
                    disabled={busy() === p.pid}
                    onClick={() => void end(p)}
                    title="End task"
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default TasksPage;
