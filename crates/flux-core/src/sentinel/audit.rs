//! Sentinel action audit log (ADR 0013, Pillar 0).
//!
//! Every action the agent runs on the user's behalf is appended here and sealed
//! at rest with the same AES-256-GCM key ladder the trace stores use
//! (`trace::sealed`). Append-only (oldest evicted past a cap), lazy-hydrated and
//! flushed on the shared 60s tick, exactly like the trace stores.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::trace::now_ms;

/// Keep the log bounded — it's a recent-activity record, not forensics forever.
const MAX_ENTRIES: usize = 1000;

/// One logged agent action.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct AuditEntry {
    /// Unix ms when it ran.
    pub ms: u64,
    /// The tab it acted on.
    pub tab: u64,
    /// Human-readable action (`AgentAction::describe()`).
    pub action: String,
    /// The matched destructive-deny-list term, if the action was flagged (#104).
    pub destructive: Option<String>,
    /// Whether this ran with explicit user approval (the normal path). `false`
    /// would flag an action that reached execution without confirmation — a red
    /// flag the read≠act gate is meant to make impossible.
    pub confirmed: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct AuditData {
    entries: Vec<AuditEntry>,
}

/// Per-process audit store, sealed to `sentinel/audit.json`.
#[derive(Default)]
pub struct SentinelAudit {
    inner: RwLock<AuditData>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
}

impl SentinelAudit {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            ..Default::default()
        }
    }

    /// Load from disk exactly once (lazy, race-proof — mirrors the trace stores).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        let Some((json, was_plaintext)) = crate::trace::sealed::load_string(path) else {
            return;
        };
        let Ok(loaded) = serde_json::from_str::<AuditData>(&json) else {
            return;
        };
        if was_plaintext {
            self.dirty.store(true, Ordering::Relaxed); // re-seal a legacy plaintext read
        }
        let mut d = self.inner.write();
        if d.entries.is_empty() {
            *d = loaded;
        }
    }

    /// Append an action to the log (append-only; oldest evicted past the cap).
    pub fn record(&self, mut entry: AuditEntry) {
        self.hydrate();
        if entry.ms == 0 {
            entry.ms = now_ms();
        }
        {
            let mut d = self.inner.write();
            d.entries.push(entry);
            let n = d.entries.len();
            if n > MAX_ENTRIES {
                d.entries.drain(0..n - MAX_ENTRIES);
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// The log, newest-first (for the trust/debug surface).
    pub fn list(&self) -> Vec<AuditEntry> {
        self.hydrate();
        self.inner.read().entries.iter().rev().cloned().collect()
    }

    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        let d = self.inner.read();
        crate::trace::sealed::save_json_sealed(path, &*d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_newest_first_and_caps() {
        let dir = std::env::temp_dir().join(format!("flux-audit-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let a = SentinelAudit::empty(dir.join("audit.json"));
        for i in 0..(MAX_ENTRIES + 5) {
            a.record(AuditEntry {
                ms: (i + 1) as u64,
                tab: 1,
                action: format!("click {i}"),
                destructive: None,
                confirmed: true,
            });
        }
        let list = a.list();
        assert_eq!(list.len(), MAX_ENTRIES, "log is capped");
        assert_eq!(list[0].action, format!("click {}", MAX_ENTRIES + 4), "newest first");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
