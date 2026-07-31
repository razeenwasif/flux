/**
 * flux://tasks — the built-in task manager (BACKLOG #107).
 *
 * **Answer-first.** A conventional monitor shows you numbers and leaves you to
 * find the culprit; this one names it. A verdict line says what is constrained
 * right now and what is holding it, every resource card names its own top
 * consumer (an idea taken from COSMIC's 2026 system monitor), and memory is a
 * treemap rather than a sorted column — because "one process holds 6 GB" and
 * "forty processes hold 150 MB each" are the same number in a list and obviously
 * different shapes as areas.
 *
 * Underneath it is still the same data: CPU overall + per core, memory and swap,
 * network throughput, GPUs via nvidia-smi, and a sortable process list with
 * end-task. Flux's own tree is called out because "lighter than Chrome" is a
 * claim this project makes and should be checkable.
 *
 * DOM-rendered, polls only while visible.
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
import { groupByName, squarify } from "./treemap";

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

  /** The heaviest process for a resource — what each card names. */
  const topBy = (key: "cpu" | "mem_mb") => createMemo(() => [...procs()].sort((a, b) => b[key] - a[key])[0]);
  const topCpu = topBy("cpu");
  const topMem = topBy("mem_mb");

  /**
   * What's actually constrained, in a sentence.
   *
   * Thresholds, not a score: a machine at 91% memory is in a different state
   * from one at 60%, and averaging the two into an index would hide which. Order
   * matters — memory pressure hurts more than a busy CPU, which is transient.
   */
  const verdict = createMemo(() => {
    const s = stats();
    if (!s) return null;
    const mem = s.mem_pct;
    const cpu = s.cpu;
    const swapping = s.swap_total_mb > 0 && s.swap_used_mb / s.swap_total_mb > 0.25;
    if (swapping)
      return {
        level: "bad" as const,
        what: "Swapping",
        why: `${gb(s.swap_used_mb)} GB of swap in use — the machine is out of RAM and paging to disk.`,
      };
    if (mem >= 90)
      return {
        level: "bad" as const,
        what: "Memory is the constraint",
        why: `${mem}% used${topMem() ? `, and ${topMem()!.name} holds ${gb(topMem()!.mem_mb)} GB` : ""}.`,
      };
    if (cpu >= 85)
      return {
        level: "warn" as const,
        what: "CPU is saturated",
        why: `${cpu.toFixed(0)}% across ${s.cores} cores${topCpu() ? `, mostly ${topCpu()!.name}` : ""}.`,
      };
    if (mem >= 75)
      return {
        level: "warn" as const,
        what: "Memory is getting tight",
        why: `${mem}% used${topMem() ? `, ${topMem()!.name} is the largest at ${gb(topMem()!.mem_mb)} GB` : ""}.`,
      };
    return {
      level: "ok" as const,
      what: "Nothing is under pressure",
      why: `${mem}% memory, ${cpu.toFixed(0)}% CPU, ${procs().length} processes.`,
    };
  });

  /** Memory as areas. Grouped by name: a browser is dozens of processes, and
   *  dozens of tiles reading "chrome" say less than one that sums them. */
  // Nine, not more: past that the tail tiles become slivers whose area a reader
  // can't judge, which is the whole reason for using a treemap. The remainder
  // still counts — it's gathered into "other" so the areas sum to the whole.
  const memGroups = createMemo(() => groupByName(procs(), 9));
  const [focus, setFocus] = createSignal<string | null>(null);
  const listed = createMemo(() => {
    const f = focus();
    return f ? sorted().filter((p) => p.name === f) : sorted();
  });

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

      {/* The answer, before the data. */}
      <Show when={verdict()}>
        {(v) => (
          <div classList={{ "tm-verdict": true, [v().level]: true }}>
            <span class="tm-verdict-dot" />
            <strong>{v().what}</strong>
            <span class="tm-verdict-why">{v().why}</span>
          </div>
        )}
      </Show>

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
          <Show when={topCpu()}>
            {(t) => (
              <div class="tm-top" title="Heaviest process on this resource">
                <span class="tm-top-label">hottest</span>
                <span class="tm-top-name">{t().name}</span>
                <span class="tm-top-val">{t().cpu.toFixed(0)}%</span>
              </div>
            )}
          </Show>
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
          <Show when={topMem()}>
            {(t) => (
              <div class="tm-top" title="Heaviest process on this resource">
                <span class="tm-top-label">largest</span>
                <span class="tm-top-name">{t().name}</span>
                <span class="tm-top-val">{gb(t().mem_mb)} GB</span>
              </div>
            )}
          </Show>
        </div>

        {/* Memory as area, not as a column of numbers. "One process holds 6 GB"
            and "forty hold 150 MB each" read identically in a sorted list and
            are obviously different here. Click a tile to filter the list. */}
        <div class="tm-card tm-card-wide">
          <div class="tm-card-head">
            <span>Memory map</span>
            <Show when={focus()} fallback={<span class="tm-card-sub">click a block to filter</span>}>
              <button class="tm-clear-focus" onClick={() => setFocus(null)}>
                showing {focus()} — clear ✕
              </button>
            </Show>
          </div>
          <div class="tm-map">
            <For
              each={squarify(
                memGroups().map((g) => ({ value: g.mem_mb, datum: g })),
                { x: 0, y: 0, w: 100, h: 100 },
              )}
            >
              {(tile) => (
                <button
                  classList={{
                    "tm-tile": true,
                    on: focus() === tile.datum.name,
                    flux: tile.datum.name.toLowerCase().includes("flux"),
                  }}
                  style={{
                    left: `${tile.x}%`,
                    top: `${tile.y}%`,
                    width: `${tile.width}%`,
                    height: `${tile.height}%`,
                  }}
                  title={`${tile.datum.name} — ${gb(tile.datum.mem_mb)} GB across ${tile.datum.count} process${tile.datum.count === 1 ? "" : "es"}`}
                  onClick={() => setFocus((f) => (f === tile.datum.name ? null : tile.datum.name))}
                >
                  {/* Always rendered; CSS hides them when the tile is too small
                      to hold them. A percentage threshold can't do this job — 11%
                      of a 1000px card is roomy and 11% of a 300px panel is 33px —
                      so each tile is its own query container and the cutoff is in
                      pixels. The tooltip always carries the full figure. */}
                  <span class="tm-tile-name">{tile.datum.name}</span>
                  <span class="tm-tile-val">{gb(tile.datum.mem_mb)} GB</span>
                </button>
              )}
            </For>
          </div>
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
          <Show when={listed().length > 0} fallback={<div class="tm-empty">Reading processes…</div>}>
            <For each={listed()}>
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
