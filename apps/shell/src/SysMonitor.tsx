/**
 * System monitor — CPU, memory, GPU, disks and network in one dense card at the
 * head of the connections rail, so the machine's load is glanceable without
 * opening the task-manager tab and losing the page you're on.
 *
 * Same data as `flux://tasks` (`tasks_stats` / `gpu_stats` / `tasks_disks`) —
 * this is a second *view*, not a second collector. Disks get their own far
 * slower timer: enumerating volumes measured 30–53s on a machine with a sleeping
 * external drive, so the backend answers from cache and refreshes behind it. The
 * card fills in late rather than stalling the rail.
 *
 * Polling stops entirely while the card is collapsed, and `visibleInterval`
 * stops it again while the window is hidden — a rail widget nobody can see
 * shouldn't cost anything.
 *
 * Absent hardware is *omitted*, not zeroed: no NVIDIA driver means no GPU group,
 * because a GPU row reading 0% would claim the card is idle rather than unread.
 */
import { For, Show, createEffect, createSignal, type Component } from "solid-js";

import { gpuStats, tasksDisks, tasksStats, type DiskInfo, type GpuInfo, type SysStats } from "./ipc";
import { visibleInterval } from "./poll";

/** Live stats tick. Matches the task manager's cadence. */
const TICK_MS = 2000;
/** Disks change on the timescale of plugging a drive in, not of a poll loop. */
const DISK_TICK_MS = 30_000;

const gb = (mb: number): string => (mb / 1024).toFixed(mb >= 10240 ? 0 : 1);

const fmtBps = (b: number): string => {
  if (b < 1024) return `${b | 0} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB/s`;
  return `${(b / 1048576).toFixed(1)} MB/s`;
};

/** Saturation colour. Named channels, never literals (ADR 0015) — a hardcoded
 *  green here would read as "fine" in one theme and as an error in another.
 *  Thresholds are deliberately high: a machine sitting at 60% memory is a
 *  machine working normally, and a meter that shouts at normal is a meter you
 *  learn to ignore by the time it matters. */
const load = (pct: number): string =>
  pct >= 88 ? "var(--flux-warn)" : pct >= 70 ? "rgb(var(--accent-hot-rgb))" : "var(--flux-ok)";

/** One labelled meter. `pct` only drives the fill; `val` is the number you read,
 *  which is why network (a rate, not a fraction) can use this too. */
const Bar: Component<{ label: string; pct: number; val: string; title?: string; color?: string }> = (p) => (
  <div class="sysmon-row" title={p.title}>
    <span class="sysmon-label">{p.label}</span>
    <span class="sysmon-track">
      <span
        class="sysmon-fill"
        style={{ width: `${Math.max(0, Math.min(100, p.pct))}%`, background: p.color ?? load(p.pct) }}
      />
    </span>
    <span class="sysmon-val">{p.val}</span>
  </div>
);

const SysMonitor: Component = () => {
  const [open, setOpen] = createSignal(localStorage.getItem("flux.sysmon") !== "0");
  const [stats, setStats] = createSignal<SysStats | null>(null);
  const [gpus, setGpus] = createSignal<GpuInfo[]>([]);
  const [disks, setDisks] = createSignal<DiskInfo[]>([]);
  const [diskTried, setDiskTried] = createSignal(false);
  /** Decaying ceiling for the network meter. A fixed scale is useless — a link
   *  idles at a few KB/s and peaks in the tens of MB/s — and a non-decaying max
   *  would leave the bar pinned near zero for the rest of the session after one
   *  download. */
  const [netPeak, setNetPeak] = createSignal(1);

  const toggle = () => {
    const v = !open();
    setOpen(v);
    localStorage.setItem("flux.sysmon", v ? "1" : "0");
  };

  const refresh = () => {
    void tasksStats()
      .then((s) => {
        if (!s) return;
        setStats(s);
        setNetPeak((pk) => Math.max(pk * 0.97, s.net_rx_bps + s.net_tx_bps, 1));
      })
      .catch(() => {});
    void gpuStats()
      .then((g) => setGpus(g ?? []))
      .catch(() => {});
  };

  const refreshDisks = () => {
    void tasksDisks()
      .then((d) => {
        setDisks(d ?? []);
        setDiskTried(true);
      })
      .catch(() => setDiskTried(true));
  };

  // Keyed on `open()`: collapsing disposes the effect, and with it both timers
  // (visibleInterval registers its own onCleanup in this scope). Expanding
  // re-runs it, which also refetches immediately so the card is never stale on
  // the frame it appears.
  createEffect(() => {
    if (!open()) return;
    visibleInterval(refresh, TICK_MS);
    visibleInterval(refreshDisks, DISK_TICK_MS);
  });

  const memPct = () => stats()?.mem_pct ?? 0;
  const netRate = () => (stats() ? stats()!.net_rx_bps + stats()!.net_tx_bps : 0);

  return (
    <div class="sysmon" classList={{ open: open() }}>
      <div class="sysmon-head">
        <button
          class="sysmon-toggle"
          title={open() ? "Hide system monitor" : "Show system monitor"}
          onClick={toggle}
        >
          <span class="sysmon-spark">◍</span>
          <span class="sysmon-label-head">System</span>
          <span class="sysmon-caret">{open() ? "▾" : "▸"}</span>
        </button>
      </div>

      <Show when={open()}>
        <div class="sysmon-body">
          <Show when={stats()} fallback={<div class="sysmon-empty">Reading system stats…</div>}>
            {(s) => (
              <>
                <div class="sysmon-cap">Processor</div>
                <Bar
                  label="CPU"
                  pct={s().cpu}
                  val={`${s().cpu.toFixed(0)}%`}
                  title={`${s().cpu_brand || "CPU"} · ${s().cores} cores`}
                />

                <div class="sysmon-cap">Memory</div>
                <Bar
                  label="RAM"
                  pct={memPct()}
                  val={`${gb(s().mem_used_mb)}/${gb(s().mem_total_mb)}G`}
                  title={`${memPct()}% of ${gb(s().mem_total_mb)} GB in use`}
                />
                {/* Swap only when it's actually in play. On a machine with
                    plenty of RAM the row is a permanent zero; on one that's
                    thrashing it's the whole story. */}
                <Show when={s().swap_total_mb > 0 && s().swap_used_mb > 0}>
                  <Bar
                    label="Swap"
                    pct={Math.round((s().swap_used_mb * 100) / Math.max(1, s().swap_total_mb))}
                    val={`${gb(s().swap_used_mb)}/${gb(s().swap_total_mb)}G`}
                    title="Swap in use — the system is out of physical memory"
                  />
                </Show>
              </>
            )}
          </Show>

          {/* GPU: NVIDIA only (via nvidia-smi). The whole group is absent on any
              other card rather than showing an honest-looking zero. */}
          <Show when={gpus().length > 0}>
            <div class="sysmon-cap">Graphics</div>
            <For each={gpus()}>
              {(g, i) => (
                <>
                  <Bar
                    label={gpus().length > 1 ? `GPU${i()}` : "GPU"}
                    pct={g.util_pct}
                    val={`${g.util_pct.toFixed(0)}%`}
                    title={`${g.name} · ${g.temp_c.toFixed(0)}°C · ${g.power_w.toFixed(0)} W`}
                  />
                  <Bar
                    label="VRAM"
                    pct={g.mem_total_mb > 0 ? (g.mem_used_mb * 100) / g.mem_total_mb : 0}
                    val={`${gb(g.mem_used_mb)}/${gb(g.mem_total_mb)}G`}
                    title={`${g.name} video memory`}
                  />
                </>
              )}
            </For>
          </Show>

          <div class="sysmon-cap">Disks</div>
          <Show
            when={disks().length > 0}
            fallback={
              <div class="sysmon-empty">{diskTried() ? "No volumes reported." : "Reading volumes…"}</div>
            }
          >
            <For each={disks()}>
              {(d) => {
                const used = () =>
                  d.total_mb > 0 ? Math.round(((d.total_mb - d.avail_mb) * 100) / d.total_mb) : 0;
                return (
                  <Bar
                    label={`${d.mount}${d.removable ? " ⏏" : ""}`}
                    pct={used()}
                    val={`${gb(d.avail_mb)}G free`}
                    title={`${d.name || d.mount} (${d.fs}) — ${used()}% used of ${gb(d.total_mb)} GB`}
                  />
                );
              }}
            </For>
          </Show>

          <div class="sysmon-cap">Network</div>
          <Show when={stats()} fallback={<div class="sysmon-empty">—</div>}>
            {(s) => (
              <>
                <Bar
                  label="Net"
                  pct={(netRate() * 100) / netPeak()}
                  val={fmtBps(netRate())}
                  color="rgb(var(--accent-rgb))"
                  title="Total throughput, scaled against this session's decaying peak"
                />
                <div class="sysmon-net">
                  <span class="sysmon-net-dn">↓ {fmtBps(s().net_rx_bps)}</span>
                  <span class="sysmon-net-up">↑ {fmtBps(s().net_tx_bps)}</span>
                </div>
                {/* Which interface is doing the work — the summed figure can't
                    tell the ethernet from the VPN, which is usually the
                    question. Loopback is filtered out server-side. */}
                <For each={s().nets.slice(0, 3)}>
                  {(n) => (
                    <div class="sysmon-iface" title={n.name}>
                      <span class="sysmon-iface-name">{n.name}</span>
                      <span class="sysmon-iface-rate">↓ {fmtBps(n.rx_bps)}</span>
                      <span class="sysmon-iface-rate">↑ {fmtBps(n.tx_bps)}</span>
                    </div>
                  )}
                </For>
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default SysMonitor;
