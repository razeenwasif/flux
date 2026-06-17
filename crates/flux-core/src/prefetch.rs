//! Predictive prefetch model (BACKLOG #103).
//!
//! Research basis: the prefetcher papers in `research/RESEARCH.md` (Pangloss
//! Markov-chain prefetching, arXiv 1906.00877; 2D adaptive degree, arXiv
//! 1505.03899; SPPAM confidence/bandwidth throttling, arXiv 2602.04100) all
//! converge on three transferable principles, applied here to navigation:
//!
//! 1. **Predict from history** — model next-navigation as a per-origin Markov
//!    chain (`from-host → to-host` transition counts). Per-origin keying mirrors
//!    Pangloss's per-page delta tracking so interleaved tabs don't pollute one
//!    another's predictions.
//! 2. **Decay old behavior (LFU)** — halve a source's counts once they overflow,
//!    so the model tracks *recent* habits rather than ancient history.
//! 3. **Gate by confidence and resources** — only surface a hint above a
//!    probability threshold (and after enough samples), and emit nothing at all
//!    while the machine is under memory/bandwidth pressure. A wrong preconnect
//!    wastes a socket; the gate keeps speculation honest.
//!
//! The output is a ranked list of **hosts to preconnect** (DNS + TCP + TLS
//! warmup) for the likely next navigation — the cheap, safe speculation. Issuing
//! the actual preconnect is the webview layer's job (a `<link rel=preconnect>`
//! injection or engine hint); this module only decides *what* and *whether*.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::Serialize;
use tauri::State;

/// Need at least this many transitions observed *from* a host before we trust a
/// prediction for it (avoids preconnecting off a single coincidental click).
const MIN_SAMPLES: u64 = 3;
/// Minimum P(next = host) to bother preconnecting. A preconnect costs a socket,
/// so we stay conservative (cf. SPPAM's usefulness gating).
const MIN_CONFIDENCE: f64 = 0.20;
/// Once a source host's total transition count passes this, halve all its edge
/// counts (Pangloss-style LFU aging) so recent behavior dominates.
const DECAY_THRESHOLD: u64 = 256;

#[derive(Default)]
struct Model {
    /// `from-host → (to-host → count)`.
    edges: HashMap<String, HashMap<String, u64>>,
}

pub struct PrefetchModel {
    inner: RwLock<Model>,
    /// Set when the resource governor (#70) reports memory/bandwidth pressure —
    /// while true, [`hints`](Self::hints) returns nothing.
    under_pressure: AtomicBool,
}

impl Default for PrefetchModel {
    fn default() -> Self {
        Self::new()
    }
}

/// A predicted next host worth preconnecting, with the model's confidence (%).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PrefetchHint {
    pub host: String,
    pub confidence: u32,
}

impl PrefetchModel {
    pub fn new() -> Self {
        Self { inner: RwLock::new(Model::default()), under_pressure: AtomicBool::new(false) }
    }

    /// Record an observed navigation `from → to`. No-op if either URL has no
    /// host or the navigation is same-host (self-loops add no predictive value).
    pub fn record(&self, from_url: &str, to_url: &str) {
        let (Some(from), Some(to)) = (host_of(from_url), host_of(to_url)) else { return };
        if from == to {
            return;
        }
        let (from, to) = (from.to_string(), to.to_string());
        let mut g = self.inner.write();
        let bucket = g.edges.entry(from).or_default();
        *bucket.entry(to).or_insert(0) += 1;
        // LFU aging: halve once the source gets busy, dropping anything that
        // decays to zero so the map can't accumulate dead edges.
        let total: u64 = bucket.values().sum();
        if total >= DECAY_THRESHOLD {
            bucket.values_mut().for_each(|c| *c /= 2);
            bucket.retain(|_, c| *c > 0);
        }
    }

    /// Set/clear the resource-pressure gate (#70 → #103). Under pressure we stop
    /// emitting hints rather than spend RAM/bandwidth on speculation.
    pub fn set_under_pressure(&self, on: bool) {
        self.under_pressure.store(on, Ordering::Relaxed);
    }

    /// Hosts to preconnect for the likely next navigation from `current_url`,
    /// most-confident first, capped at `max`. Empty when under pressure, when
    /// the host is unknown/under-sampled, or when nothing clears the confidence
    /// threshold.
    pub fn hints(&self, current_url: &str, max: usize) -> Vec<PrefetchHint> {
        if max == 0 || self.under_pressure.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let Some(host) = host_of(current_url) else { return Vec::new() };
        let g = self.inner.read();
        let Some(edges) = g.edges.get(host) else { return Vec::new() };
        let total: u64 = edges.values().sum();
        if total < MIN_SAMPLES {
            return Vec::new();
        }
        let mut ranked: Vec<PrefetchHint> = edges
            .iter()
            .filter_map(|(h, &c)| {
                let p = c as f64 / total as f64;
                (p >= MIN_CONFIDENCE).then(|| PrefetchHint {
                    host: h.clone(),
                    confidence: (p * 100.0).round() as u32,
                })
            })
            .collect();
        // Highest confidence first; stable tiebreak on host for determinism.
        ranked.sort_by(|a, b| b.confidence.cmp(&a.confidence).then_with(|| a.host.cmp(&b.host)));
        ranked.truncate(max);
        ranked
    }
}

/// Host of a URL, dependency-free (`https://a.b.com/x` → `a.b.com`).
fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next().unwrap_or(host);
    (!host.is_empty()).then_some(host)
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Page/chrome → Rust: record a navigation transition (`from` may be empty on a
/// fresh tab — then it's ignored).
#[tauri::command]
pub fn prefetch_record(state: State<'_, PrefetchModel>, from: String, to: String) {
    state.record(&from, &to);
}

/// Rust → chrome: the hosts worth preconnecting next from `url`. The chrome
/// issues the preconnect (e.g. injects `<link rel=preconnect>`).
#[tauri::command]
pub fn prefetch_hints(state: State<'_, PrefetchModel>, url: String, max: usize) -> Vec<PrefetchHint> {
    state.hints(&url, max)
}

/// Resource governor → model: pause/resume speculation under memory pressure.
#[tauri::command]
pub fn prefetch_set_pressure(state: State<'_, PrefetchModel>, on: bool) {
    state.set_under_pressure(on);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn train(m: &PrefetchModel, from: &str, to: &str, n: usize) {
        for _ in 0..n {
            m.record(from, to);
        }
    }

    #[test]
    fn predicts_the_dominant_next_host() {
        let m = PrefetchModel::new();
        // From news.com: 8× to cdn.com, 2× to ads.com.
        train(&m, "https://news.com/a", "https://cdn.com/x", 8);
        train(&m, "https://news.com/b", "https://ads.com/y", 2);
        let hints = m.hints("https://news.com/home", 5);
        assert_eq!(hints[0].host, "cdn.com");
        assert!(hints[0].confidence >= 75, "got {}", hints[0].confidence);
        // ads.com at 20% sits right at the threshold and should also appear.
        assert!(hints.iter().any(|h| h.host == "ads.com"));
    }

    #[test]
    fn ignores_low_confidence_and_under_sampled() {
        let m = PrefetchModel::new();
        // Spread thinly: each target is 1/5 = 20% but only after enough samples.
        for t in ["a", "b", "c", "d", "e"] {
            m.record("https://hub.com/p", &format!("https://{t}.com/"));
        }
        // 5 samples ≥ MIN_SAMPLES; each at exactly 20% == threshold → kept.
        let hints = m.hints("https://hub.com/p", 10);
        assert_eq!(hints.len(), 5);

        // A host seen only twice is under-sampled → no hints.
        let m2 = PrefetchModel::new();
        train(&m2, "https://x.com/", "https://y.com/", 2);
        assert!(m2.hints("https://x.com/", 5).is_empty());
    }

    #[test]
    fn respects_max_and_self_loops_ignored() {
        let m = PrefetchModel::new();
        train(&m, "https://s.com/1", "https://a.com/", 5);
        train(&m, "https://s.com/2", "https://b.com/", 4);
        train(&m, "https://s.com/3", "https://c.com/", 3);
        m.record("https://s.com/x", "https://s.com/y"); // self-loop: ignored
        let hints = m.hints("https://s.com/", 2);
        assert_eq!(hints.len(), 2, "max honored");
        assert!(!hints.iter().any(|h| h.host == "s.com"), "no self-prediction");
    }

    #[test]
    fn pressure_gate_silences_hints() {
        let m = PrefetchModel::new();
        train(&m, "https://news.com/a", "https://cdn.com/x", 9);
        assert!(!m.hints("https://news.com/", 5).is_empty());
        m.set_under_pressure(true);
        assert!(m.hints("https://news.com/", 5).is_empty(), "no speculation under pressure");
        m.set_under_pressure(false);
        assert!(!m.hints("https://news.com/", 5).is_empty());
    }

    #[test]
    fn decay_keeps_recent_behavior() {
        let m = PrefetchModel::new();
        // Push well past the decay threshold toward old.com…
        train(&m, "https://p.com/", "https://old.com/", 300);
        // …then a burst toward new.com. After aging, new.com should be able to
        // overtake within a bounded number of fresh observations.
        train(&m, "https://p.com/", "https://new.com/", 200);
        let hints = m.hints("https://p.com/", 5);
        assert!(hints.iter().any(|h| h.host == "new.com"));
    }

    #[test]
    fn host_parsing_edges() {
        assert_eq!(host_of("https://a.b.com/x?y"), Some("a.b.com"));
        assert_eq!(host_of("http://u@h.com:8443/p"), Some("h.com"));
        assert_eq!(host_of("bare.host/path"), Some("bare.host"));
        assert_eq!(host_of(""), None);
    }
}
