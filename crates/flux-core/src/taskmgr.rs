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
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

/// Owns a reused `System` so CPU deltas are meaningful across polls.
pub struct TaskManager(Mutex<System>);

impl TaskManager {
    pub fn new() -> Self {
        Self(Mutex::new(System::new()))
    }
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}

/// One running process, as shown in the task manager.
#[derive(Serialize, Debug, Clone, PartialEq)]
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
        let mut sys = self.0.lock();
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
        let mut sys = self.0.lock();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let total = sys.total_memory();
        let used = total.saturating_sub(sys.available_memory());
        SysStats {
            cpu: sys.global_cpu_usage(),
            mem_used_mb: used / 1_048_576,
            mem_total_mb: total / 1_048_576,
            mem_pct: if total > 0 { (used.saturating_mul(100) / total) as u32 } else { 0 },
            cores: sys.cpus().len(),
        }
    }

    /// End a process by pid. Returns whether the signal was sent.
    pub fn kill(&self, pid: u32) -> bool {
        let mut sys = self.0.lock();
        let target = Pid::from(pid as usize);
        sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
        sys.process(target).map(|p| p.kill()).unwrap_or(false)
    }
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

/// System-wide CPU + memory, for the task-manager graphs.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SysStats {
    /// CPU usage % averaged across cores (0–100).
    pub cpu: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub mem_pct: u32,
    pub cores: usize,
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

#[tauri::command]
pub fn tasks_kill(state: State<'_, TaskManager>, pid: u32) -> bool {
    state.kill(pid)
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
        assert!(tree.contains(&100) && tree.contains(&101) && tree.contains(&102) && tree.contains(&103));
        assert!(!tree.contains(&200) && !tree.contains(&201), "unrelated tree excluded");
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
        let me = procs.iter().find(|p| p.pid == std::process::id()).expect("self present");
        assert!(me.current && me.is_flux);
        for w in procs.windows(2) {
            assert!(w[0].mem_mb >= w[1].mem_mb, "sorted by memory desc");
        }
    }
}
