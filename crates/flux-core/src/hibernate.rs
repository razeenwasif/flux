//! Tab-hibernation state preservation (BACKLOG #45 follow-up).
//!
//! Holds per-tab scroll + form state captured when a tab is backgrounded, so a
//! woken (reloaded) tab restores it. **RAM only** — never persisted to disk; the
//! capture script (`hibernate.js`) excludes password fields. A `wake_pending`
//! flag, set when a tab is actually hibernated, ensures the state is re-applied
//! only on the wake reload — not on a tab's ordinary in-page navigations.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::prefetch::PrefetchModel;
use crate::state::TabId;

/// How far into the "likely next" future a fully-confident prediction protects a
/// tab from eviction, in seconds. A tab the model is 100% sure you'll revisit
/// next must be idle this much *longer* than an unpredicted tab before it's a
/// better eviction target (scaled by confidence). 30 min.
const PROTECT_HORIZON_SECS: f64 = 1800.0;
/// Confidence (%) at/above which we mark a candidate "protected" in the UI.
const PROTECT_MARK_PCT: u32 = 50;

struct Entry {
    state: String,
    wake_pending: bool,
}

#[derive(Default)]
pub struct HibernateStore {
    entries: DashMap<TabId, Entry>,
}

impl HibernateStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn capture(&self, id: TabId, state: String) {
        self.entries
            .entry(id)
            .and_modify(|e| e.state = state.clone())
            .or_insert(Entry { state, wake_pending: false });
    }

    /// Arm restore for `id` — called when the tab is hibernated.
    pub fn mark_wake(&self, id: TabId) {
        if let Some(mut e) = self.entries.get_mut(&id) {
            e.wake_pending = true;
        }
    }

    /// The captured state to restore on a wake reload, if armed (one-shot).
    pub fn take_for_restore(&self, id: TabId) -> Option<String> {
        let mut e = self.entries.get_mut(&id)?;
        if e.wake_pending {
            e.wake_pending = false;
            Some(e.state.clone())
        } else {
            None
        }
    }

    pub fn remove(&self, id: TabId) {
        self.entries.remove(&id);
    }
}

/// Page → Rust: store a tab's captured scroll/form state (a `fluxtab` plugin
/// command, like `dom_publish`, so the remote page may call it).
#[tauri::command]
pub fn hibernate_capture(store: State<'_, HibernateStore>, tab_id: TabId, state: String) {
    store.capture(tab_id, state);
}

// ─── Belady/Markov eviction ranking (BACKLOG #106) ───────────────────────────
//
// Plain LRU evicts the least-recently-*used* tab. Belady's optimal policy evicts
// the one used farthest in the *future* (arXiv 1202.5539 applies the same idea
// to register spilling). We can't see the future, but the #103 Markov model
// predicts the likely next navigation from the current page — so we discount a
// candidate's idle time by how likely the model thinks you'll return to it next,
// turning "least recently used" into "least likely to be needed soon."

/// A background tab the frontend is considering hibernating.
#[derive(Deserialize, specta::Type)]pub struct HibernateCandidate {
    pub tab_id: TabId,
    /// The tab's current page URL (its host drives the prediction match).
    pub url: String,
    /// Seconds since the tab was last active.
    pub idle_secs: u64,
}

/// One candidate's eviction priority. Higher `score` → evict sooner.
#[derive(Serialize, Debug, PartialEq, specta::Type)]pub struct EvictionRank {
    pub tab_id: TabId,
    pub score: f64,
    /// The model expects you back here next → shown as "kept" in the UI.
    pub protected: bool,
}

/// Pure ranker: order `candidates` worst-first (best to evict). `predicted` maps
/// host → confidence% that it's the next navigation from the current page.
fn rank(candidates: &[HibernateCandidate], predicted: &std::collections::HashMap<String, u32>) -> Vec<EvictionRank> {
    let mut ranked: Vec<EvictionRank> = candidates
        .iter()
        .map(|c| {
            let conf = host_of(&c.url).and_then(|h| predicted.get(h)).copied().unwrap_or(0);
            // Discount idle time by predicted-next likelihood: a likely-next tab
            // behaves as if it were used more recently, so it's evicted later.
            let keep_bonus = (conf as f64 / 100.0) * PROTECT_HORIZON_SECS;
            EvictionRank {
                tab_id: c.tab_id,
                score: c.idle_secs as f64 - keep_bonus,
                protected: conf >= PROTECT_MARK_PCT,
            }
        })
        .collect();
    // Evict highest score first; stable tiebreak on tab id for determinism.
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.tab_id.cmp(&b.tab_id)));
    ranked
}

/// Host of a URL (`https://a.b/c` → `a.b`), dependency-free.
fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next().unwrap_or("");
    (!host.is_empty()).then_some(host)
}

/// Rank background tabs for hibernation worst-first (BACKLOG #106). The frontend
/// passes its background candidates + the active page URL; we consult the #103
/// Markov model and return Belady-style eviction priorities. The UI sleeps from
/// the top of the list and skips any it wants to keep.
#[tauri::command]
pub fn hibernate_rank(
    prefetch: State<'_, PrefetchModel>,
    current_url: String,
    candidates: Vec<HibernateCandidate>,
) -> Vec<EvictionRank> {
    let predicted: std::collections::HashMap<String, u32> =
        prefetch.hints(&current_url, 32).into_iter().map(|h| (h.host, h.confidence)).collect();
    rank(&candidates, &predicted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn predicted_next_tab_is_evicted_later_than_a_stale_one() {
        // Tab 1: idle 10 min, but the model says we'll go back to its host next.
        // Tab 2: idle 5 min, no prediction.
        let cands = vec![
            HibernateCandidate { tab_id: 1, url: "https://docs.com/a".into(), idle_secs: 600 },
            HibernateCandidate { tab_id: 2, url: "https://blog.com/b".into(), idle_secs: 300 },
        ];
        let mut predicted = HashMap::new();
        predicted.insert("docs.com".to_string(), 90u32); // strong return signal

        let ranked = rank(&cands, &predicted);
        // Despite being idle longer, tab 1 is protected → tab 2 evicts first.
        assert_eq!(ranked[0].tab_id, 2, "the unpredicted, less-idle tab evicts first");
        assert!(ranked[1].protected, "the predicted tab is marked kept");
    }

    #[test]
    fn falls_back_to_lru_without_predictions() {
        let cands = vec![
            HibernateCandidate { tab_id: 1, url: "https://a.com/".into(), idle_secs: 100 },
            HibernateCandidate { tab_id: 2, url: "https://b.com/".into(), idle_secs: 900 },
            HibernateCandidate { tab_id: 3, url: "https://c.com/".into(), idle_secs: 400 },
        ];
        let ranked = rank(&cands, &HashMap::new());
        // No predictions → pure LRU: most-idle (2) first, least-idle (1) last.
        assert_eq!(ranked.iter().map(|r| r.tab_id).collect::<Vec<_>>(), vec![2, 3, 1]);
        assert!(ranked.iter().all(|r| !r.protected));
    }

    #[test]
    fn weak_prediction_does_not_protect() {
        let cands = vec![
            HibernateCandidate { tab_id: 1, url: "https://x.com/".into(), idle_secs: 1000 },
        ];
        let mut predicted = HashMap::new();
        predicted.insert("x.com".to_string(), 25u32); // below PROTECT_MARK_PCT
        let ranked = rank(&cands, &predicted);
        assert!(!ranked[0].protected);
        // …but the small bonus still nudges its score down a touch.
        assert!(ranked[0].score < 1000.0);
    }
}
