//! System/process memory readout for memory-pressure tab eviction (BACKLOG #45).
//!
//! The frontend polls this; when free system memory is genuinely low it
//! hibernates the least-recently-used background tabs (which frees their
//! webviews' RAM). Reading actual memory means it adapts to the machine and
//! stays quiet while there's headroom — no fixed per-machine cap to guess.

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::System;
use tauri::State;

/// A reused `System` handle (constructing one per call is wasteful).
pub struct SysMon(Mutex<System>);

impl SysMon {
    pub fn new() -> Self {
        Self(Mutex::new(System::new()))
    }
}

impl Default for SysMon {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
pub struct MemInfo {
    pub total_mb: u64,
    pub available_mb: u64,
    /// Flux's own resident set, MiB (0 if unavailable).
    pub process_mb: u64,
    /// Available system memory as a percentage of total.
    pub available_pct: u32,
}

#[tauri::command]
pub fn mem_status(mon: State<'_, SysMon>) -> MemInfo {
    let mut sys = mon.0.lock();
    sys.refresh_memory();
    let total = sys.total_memory(); // bytes (sysinfo 0.30+)
    let available = sys.available_memory();
    let available_pct = if total > 0 { (available.saturating_mul(100) / total) as u32 } else { 100 };

    // Flux's RSS — best-effort; refresh just our process.
    let process_mb = sysinfo::get_current_pid()
        .ok()
        .and_then(|pid| {
            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                true,
                sysinfo::ProcessRefreshKind::new().with_memory(),
            );
            sys.process(pid).map(|p| p.memory())
        })
        .map(|b| b / 1_048_576)
        .unwrap_or(0);

    MemInfo {
        total_mb: total / 1_048_576,
        available_mb: available / 1_048_576,
        process_mb,
        available_pct,
    }
}
