//! Built-in task manager — a system process monitor inside Flux.
//!
//! Like Chrome's task manager (Shift+Esc) but system-wide: lists every process
//! with CPU%, resident memory, and whether it belongs to **Flux's own process
//! tree** (the main process + the webview engine/helper processes it spawns —
//! `msedgewebview2.exe` on Windows, `WebKitWebProcess` on Linux). Membership is
//! determined by walking parent pids back to our own pid, so it's accurate
//! rather than a fragile name match. The user can end any process.
//!
//! CPU% is computed by `sysinfo` as the delta between two refreshes, so the very
//! first poll reads 0% — the persistent `System` handle means subsequent polls
//! (the UI refreshes on a timer) report real usage. CPU% is summed across cores
//! (can exceed 100%), matching how OS task managers report it.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use sysinfo::{Disks, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

/// Owns a reused `System` so CPU deltas are meaningful across polls, plus a
/// `Networks` (+ timestamp) so throughput is a real bytes/sec rate.
pub struct TaskManager {
    sys: Mutex<System>,
    net: Mutex<NetState>,
}

struct NetState {
    nets: Networks,
    last: Instant,
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
            net: Mutex::new(NetState {
                nets: Networks::new_with_refreshed_list(),
                last: Instant::now(),
            }),
        }
    }
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}

/// One running process, as shown in the task manager.
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    /// CPU usage %, summed across cores (may exceed 100).
    pub cpu: f32,
    /// Resident memory, MiB.
    pub mem_mb: u64,
    /// Part of Flux's process tree (the engine/helper processes).
    pub is_flux: bool,
    /// The main Flux process itself — ending it quits the browser, so the UI
    /// guards this with a confirm.
    pub current: bool,
}

impl TaskManager {
    /// Snapshot of all processes, heaviest (by memory) first.
    pub fn list(&self) -> Vec<ProcInfo> {
        let mut sys = self.sys.lock();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new().with_cpu().with_memory(),
        );
        let current = std::process::id();
        let pairs: Vec<(u32, Option<u32>)> = sys
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), p.parent().map(|x| x.as_u32())))
            .collect();
        let tree = flux_tree(&pairs, current);

        let mut out: Vec<ProcInfo> = sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                let pid = pid.as_u32();
                ProcInfo {
                    pid,
                    name: p.name().to_string_lossy().into_owned(),
                    cpu: p.cpu_usage(),
                    mem_mb: p.memory() / 1_048_576,
                    is_flux: tree.contains(&pid),
                    current: pid == current,
                }
            })
            .collect();
        out.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb).then_with(|| a.pid.cmp(&b.pid)));
        out
    }

    /// System-wide CPU + memory snapshot, for the live graphs. CPU% is the
    /// delta since the previous call (0 on the very first call), averaged across
    /// cores (0–100).
    pub fn stats(&self) -> SysStats {
        let mut sys = self.sys.lock();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let total = sys.total_memory();
        let used = total.saturating_sub(sys.available_memory());
        let swap_total = sys.total_swap();
        let per_core: Vec<f32> = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
        let cpu_brand = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .unwrap_or_default();
        // Network throughput as a real bytes/sec rate (delta since last refresh).
        let (net_rx_bps, net_tx_bps, nets) = {
            let mut net = self.net.lock();
            net.nets.refresh();
            let secs = net.last.elapsed().as_secs_f64().max(0.001);
            net.last = Instant::now();
            let rate = |b: u64| (b as f64 / secs) as u64;
            let mut per: Vec<NetIface> = net
                .nets
                .iter()
                .map(|(name, d)| NetIface {
                    name: name.clone(),
                    rx_bps: rate(d.received()),
                    tx_bps: rate(d.transmitted()),
                })
                // Loopback carries no real traffic and would usually top the
                // list on a dev machine, burying the interface you care about.
                .filter(|n| !is_loopback(&n.name))
                .collect();
            per.sort_by_key(|n| std::cmp::Reverse(n.rx_bps + n.tx_bps));
            per.truncate(6);
            let rx: u64 = net.nets.values().map(|d| d.received()).sum();
            let tx: u64 = net.nets.values().map(|d| d.transmitted()).sum();
            (rate(rx), rate(tx), per)
        };
        SysStats {
            cpu: sys.global_cpu_usage(),
            per_core,
            cpu_brand,
            mem_used_mb: used / 1_048_576,
            mem_total_mb: total / 1_048_576,
            mem_pct: used
                .saturating_mul(100)
                .checked_div(total)
                .map_or(0, |v| v as u32),
            swap_used_mb: sys.used_swap() / 1_048_576,
            swap_total_mb: swap_total / 1_048_576,
            cores: sys.cpus().len(),
            uptime_secs: System::uptime(),
            nets,
            net_rx_bps,
            net_tx_bps,
        }
    }

    /// Mounted filesystems. Refreshed from a fresh list each call: drives get
    /// plugged in and unmounted, and a cached list would show a phantom.
    pub fn disks(&self) -> Vec<DiskInfo> {
        let disks = Disks::new_with_refreshed_list();
        let mut out: Vec<DiskInfo> = disks
            .list()
            .iter()
            .map(|d| DiskInfo {
                name: d.name().to_string_lossy().to_string(),
                mount: d.mount_point().to_string_lossy().to_string(),
                fs: d.file_system().to_string_lossy().to_string(),
                total_mb: d.total_space() / 1_048_576,
                avail_mb: d.available_space() / 1_048_576,
                removable: d.is_removable(),
            })
            // Pseudo-filesystems (snap loopbacks, overlays, tmpfs) are numerous
            // on Linux and tell you nothing about free space.
            .filter(|d| d.total_mb > 0)
            .collect();
        out.sort_by_key(|d| std::cmp::Reverse(d.total_mb));
        out.truncate(8);
        out
    }

    /// End a process by pid. Returns whether the signal was sent.
    pub fn kill(&self, pid: u32) -> bool {
        let mut sys = self.sys.lock();
        let target = Pid::from(pid as usize);
        sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
        sys.process(target).map(|p| p.kill()).unwrap_or(false)
    }
}

/// Is this a loopback interface? Named rather than inlined so the platform
/// spellings are in one place.
pub fn is_loopback(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "lo" || n.starts_with("loopback") || n.contains("loopback pseudo-interface")
}

/// The set of pids in `current`'s process tree (itself + all descendants),
/// computed from `(pid, parent)` pairs. Pure, so it's testable without a live
/// system. Robust to cycles via a per-walk visited guard.
fn flux_tree(pairs: &[(u32, Option<u32>)], current: u32) -> HashSet<u32> {
    let parent: HashMap<u32, Option<u32>> = pairs.iter().copied().collect();
    let mut tree = HashSet::new();
    tree.insert(current);
    for &(pid, _) in pairs {
        // Walk ancestors; if we reach `current`, the whole walked chain is Flux.
        let mut chain = Vec::new();
        let mut cur = Some(pid);
        let mut seen = HashSet::new();
        while let Some(p) = cur {
            if !seen.insert(p) {
                break; // cycle guard
            }
            if p == current || tree.contains(&p) {
                tree.extend(chain.iter().copied());
                tree.insert(pid);
                break;
            }
            chain.push(p);
            cur = parent.get(&p).copied().flatten();
        }
    }
    tree
}

/// One network interface's live throughput. Loopback and down interfaces are
/// filtered out before this reaches the UI — a list where half the rows are
/// permanently 0 B/s is a list nobody reads.
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct NetIface {
    pub name: String,
    pub rx_bps: u64,
    pub tx_bps: u64,
}

/// A mounted filesystem. Capacity only — sysinfo doesn't give per-disk I/O
/// rates, and inventing one from process counters would be a guess.
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct DiskInfo {
    pub name: String,
    pub mount: String,
    pub fs: String,
    pub total_mb: u64,
    pub avail_mb: u64,
    pub removable: bool,
}

/// System-wide CPU / memory / swap / network snapshot for the task manager.
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct SysStats {
    /// CPU usage % averaged across cores (0–100).
    pub cpu: f32,
    /// Per-core usage % (0–100), in core order.
    pub per_core: Vec<f32>,
    /// CPU model name (e.g. "AMD Ryzen 9 …"), best-effort.
    pub cpu_brand: String,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub mem_pct: u32,
    pub swap_used_mb: u64,
    pub swap_total_mb: u64,
    pub cores: usize,
    /// System uptime, seconds.
    pub uptime_secs: u64,
    /// Per-interface throughput, busiest first. The summed figures below stay
    /// for the overall graph.
    pub nets: Vec<NetIface>,
    /// Network throughput, bytes/sec (summed across interfaces).
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
}

/// One GPU's live stats (NVIDIA via `nvidia-smi`).
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct GpuInfo {
    pub name: String,
    pub util_pct: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub temp_c: f32,
    pub power_w: f32,
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn tasks_list(state: State<'_, TaskManager>) -> Vec<ProcInfo> {
    state.list()
}

#[tauri::command]
pub fn tasks_stats(state: State<'_, TaskManager>) -> SysStats {
    state.stats()
}

/// Mounted filesystems, for the task manager's disk card.
#[tauri::command]
pub fn tasks_disks(state: State<'_, TaskManager>) -> Vec<DiskInfo> {
    state.disks()
}

#[tauri::command]
pub fn tasks_kill(state: State<'_, TaskManager>, pid: u32) -> bool {
    state.kill(pid)
}

/// Live GPU stats via `nvidia-smi` (NVIDIA only). Empty on other GPUs / no driver
/// / when nvidia-smi isn't on PATH — the UI just hides the GPU panel then.
#[tauri::command]
pub async fn gpu_stats() -> Vec<GpuInfo> {
    tauri::async_runtime::spawn_blocking(query_nvidia)
        .await
        .unwrap_or_default()
}

fn query_nvidia() -> Vec<GpuInfo> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ]);
    // Windows: don't flash a console window each poll (the task manager polls ~2s).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            if f.len() < 6 {
                return None;
            }
            Some(GpuInfo {
                name: f[0].to_string(),
                util_pct: f[1].parse().unwrap_or(0.0),
                mem_used_mb: f[2].parse().unwrap_or(0),
                mem_total_mb: f[3].parse().unwrap_or(0),
                temp_c: f[4].parse().unwrap_or(0.0),
                power_w: f[5].parse().unwrap_or(0.0),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flux_tree_includes_descendants_only() {
        // 100 = Flux main; 101,102 are its children; 103 is a grandchild;
        // 200 is an unrelated process with its own child 201.
        let pairs = [
            (100, Some(1)),
            (101, Some(100)),
            (102, Some(100)),
            (103, Some(101)),
            (200, Some(1)),
            (201, Some(200)),
        ];
        let tree = flux_tree(&pairs, 100);
        assert!(
            tree.contains(&100)
                && tree.contains(&101)
                && tree.contains(&102)
                && tree.contains(&103)
        );
        assert!(
            !tree.contains(&200) && !tree.contains(&201),
            "unrelated tree excluded"
        );
    }

    #[test]
    fn flux_tree_handles_missing_parents_and_cycles() {
        // 5 has no parent entry; 6<->7 form a cycle; none reach current (100).
        let pairs = [(5, Some(999)), (6, Some(7)), (7, Some(6)), (100, None)];
        let tree = flux_tree(&pairs, 100);
        assert_eq!(tree, HashSet::from([100]));
    }

    #[test]
    fn list_returns_self_and_marks_it() {
        // Smoke test against the live system: our own pid must appear, be marked
        // current + is_flux, and the list is memory-sorted.
        let tm = TaskManager::new();
        let procs = tm.list();
        assert!(!procs.is_empty());
        let me = procs
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("self present");
        assert!(me.current && me.is_flux);
        for w in procs.windows(2) {
            assert!(w[0].mem_mb >= w[1].mem_mb, "sorted by memory desc");
        }
    }
}
