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

use crate::dom::cap_utf8;
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
    /// Origin of each tab's last *committed* document, as the engine reported
    /// it at `PageLoadEvent::Started` (the commit event on every backend). Not
    /// `Webview::url()`: WebKit reports the *provisional* URL there while the
    /// old, still-scriptable document is alive.
    committed: DashMap<TabId, String>,
}

impl HibernateStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn capture(&self, id: TabId, state: String) {
        self.entries
            .entry(id)
            .and_modify(|e| e.state = state.clone())
            .or_insert(Entry {
                state,
                wake_pending: false,
            });
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

    /// Record the origin of the document `id` just committed.
    pub fn note_commit(&self, id: TabId, url: &tauri::Url) {
        self.committed
            .insert(id, url.origin().ascii_serialization());
    }

    /// Store state a page captured, once it is bound to the page that sent it.
    /// `u` is page-supplied and is the only same-page check `__fluxRestore`
    /// makes (a missing `u` skips it), so require it, and require its origin to
    /// be the tab's committed document: a page must not stash values labelled
    /// for another site, navigate there, and have the wake reload fill them in.
    fn capture_checked(&self, id: TabId, state: &str) -> Result<(), String> {
        let mut captured: HibernateState =
            serde_json::from_str(state).map_err(|e| e.to_string())?;
        captured.validate_limits()?;
        let committed = self
            .committed
            .get(&id)
            .map(|o| o.value().clone())
            .ok_or("no committed page for this tab")?;
        let claimed = captured
            .u
            .as_deref()
            .and_then(|u| tauri::Url::parse(u).ok())
            .map(|u| u.origin().ascii_serialization());
        if committed == "null" || claimed.as_deref() != Some(committed.as_str()) {
            return Err("hibernate state does not match the committed page".into());
        }
        let safe_json = serde_json::to_string(&captured).map_err(|e| e.to_string())?;
        self.capture(id, safe_json);
        Ok(())
    }

    pub fn remove(&self, id: TabId) {
        self.entries.remove(&id);
        self.committed.remove(&id);
    }
}

/// A single captured form field's state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormFieldState {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub field_type: String,
    #[serde(default)]
    pub v: Option<String>,
    #[serde(default)]
    pub c: Option<bool>,
}

/// Bounded typed structure for captured scroll/form state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HibernateState {
    #[serde(default)]
    pub u: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub f: Vec<FormFieldState>,
}

impl HibernateState {
    pub fn validate_limits(&mut self) -> Result<(), String> {
        if self.f.len() > 300 {
            return Err("too many form fields in hibernate state".into());
        }
        if let Some(u) = &self.u {
            if u.len() > 4096 {
                return Err("url in hibernate state too long".into());
            }
        }
        // These strings come from the page. `String::truncate` panics when the
        // cut lands mid-character, which aborts the browser, so cap on a char
        // boundary instead.
        for field in &mut self.f {
            field.id = cap_utf8(std::mem::take(&mut field.id), 256);
            field.name = cap_utf8(std::mem::take(&mut field.name), 256);
            field.field_type = cap_utf8(std::mem::take(&mut field.field_type), 64);
            if let Some(v) = field.v.take() {
                field.v = Some(cap_utf8(v, 65536));
            }
        }
        Ok(())
    }
}

fn caller_tab(webview: &tauri::Webview) -> Result<TabId, String> {
    webview
        .label()
        .strip_prefix("tab-")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "not a tab webview".into())
}

/// Page → Rust: store a tab's captured scroll/form state (a `fluxtab` plugin
/// command, like `dom_publish`, so the remote page may call it).
#[tauri::command]
pub fn hibernate_capture(
    webview: tauri::Webview,
    store: State<'_, HibernateStore>,
    tab_id: Option<TabId>,
    state: String,
) -> Result<(), String> {
    let tab = caller_tab(&webview)?;
    if let Some(tid) = tab_id {
        if tid != tab {
            return Err("tab_id mismatch with caller webview".into());
        }
    }
    store.capture_checked(tab, &state)
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
#[derive(Deserialize, specta::Type)]
pub struct HibernateCandidate {
    pub tab_id: TabId,
    /// The tab's current page URL (its host drives the prediction match).
    pub url: String,
    /// Seconds since the tab was last active.
    pub idle_secs: u64,
}

/// One candidate's eviction priority. Higher `score` → evict sooner.
#[derive(Serialize, Debug, PartialEq, specta::Type)]
pub struct EvictionRank {
    pub tab_id: TabId,
    pub score: f64,
    /// The model expects you back here next → shown as "kept" in the UI.
    pub protected: bool,
}

/// Pure ranker: order `candidates` worst-first (best to evict). `predicted` maps
/// host → confidence% that it's the next navigation from the current page.
fn rank(
    candidates: &[HibernateCandidate],
    predicted: &std::collections::HashMap<String, u32>,
) -> Vec<EvictionRank> {
    let mut ranked: Vec<EvictionRank> = candidates
        .iter()
        .map(|c| {
            let conf = host_of(&c.url)
                .and_then(|h| predicted.get(h))
                .copied()
                .unwrap_or(0);
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
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.tab_id.cmp(&b.tab_id))
    });
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
    let predicted: std::collections::HashMap<String, u32> = prefetch
        .hints(&current_url, 32)
        .into_iter()
        .map(|h| (h.host, h.confidence))
        .collect();
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
            HibernateCandidate {
                tab_id: 1,
                url: "https://docs.com/a".into(),
                idle_secs: 600,
            },
            HibernateCandidate {
                tab_id: 2,
                url: "https://blog.com/b".into(),
                idle_secs: 300,
            },
        ];
        let mut predicted = HashMap::new();
        predicted.insert("docs.com".to_string(), 90u32); // strong return signal

        let ranked = rank(&cands, &predicted);
        // Despite being idle longer, tab 1 is protected → tab 2 evicts first.
        assert_eq!(
            ranked[0].tab_id, 2,
            "the unpredicted, less-idle tab evicts first"
        );
        assert!(ranked[1].protected, "the predicted tab is marked kept");
    }

    #[test]
    fn falls_back_to_lru_without_predictions() {
        let cands = vec![
            HibernateCandidate {
                tab_id: 1,
                url: "https://a.com/".into(),
                idle_secs: 100,
            },
            HibernateCandidate {
                tab_id: 2,
                url: "https://b.com/".into(),
                idle_secs: 900,
            },
            HibernateCandidate {
                tab_id: 3,
                url: "https://c.com/".into(),
                idle_secs: 400,
            },
        ];
        let ranked = rank(&cands, &HashMap::new());
        // No predictions → pure LRU: most-idle (2) first, least-idle (1) last.
        assert_eq!(
            ranked.iter().map(|r| r.tab_id).collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
        assert!(ranked.iter().all(|r| !r.protected));
    }

    #[test]
    fn weak_prediction_does_not_protect() {
        let cands = vec![HibernateCandidate {
            tab_id: 1,
            url: "https://x.com/".into(),
            idle_secs: 1000,
        }];
        let mut predicted = HashMap::new();
        predicted.insert("x.com".to_string(), 25u32); // below PROTECT_MARK_PCT
        let ranked = rank(&cands, &predicted);
        assert!(!ranked[0].protected);
        // …but the small bonus still nudges its score down a touch.
        assert!(ranked[0].score < 1000.0);
    }

    #[test]
    fn capture_is_bound_to_the_committed_page() {
        let store = HibernateStore::new();
        let state =
            |u: &str| format!(r#"{{"u":{u},"f":[{{"name":"iban","type":"text","v":"X"}}]}}"#);
        // Nothing committed yet: there is no page to bind the state to.
        assert!(store
            .capture_checked(1, &state(r#""https://evil.example/""#))
            .is_err());
        store.note_commit(1, &"https://evil.example/home".parse().unwrap());
        // Labelled for another site, or not labelled at all: refused.
        for u in [r#""https://bank.example/transfer""#, "null"] {
            assert!(store.capture_checked(1, &state(u)).is_err(), "{u}");
        }
        store.mark_wake(1);
        assert_eq!(store.take_for_restore(1), None, "nothing was stored");
        // The page's own state, on any path of its origin (SPA routes), is kept.
        store
            .capture_checked(1, &state(r#""https://evil.example/other""#))
            .unwrap();
        store.mark_wake(1);
        assert!(store.take_for_restore(1).is_some());
        // An opaque origin (data:, file:) never matches anything.
        store.note_commit(2, &"data:text/html,hi".parse().unwrap());
        assert!(store
            .capture_checked(2, &state(r#""data:text/html,hi""#))
            .is_err());
    }

    #[test]
    fn validate_limits_caps_page_strings_on_char_boundaries() {
        // Byte 256 / 64 / 65536 each land inside a 2-byte 'é'.
        let field = FormFieldState {
            id: format!("{}é", "a".repeat(255)),
            name: format!("{}é", "b".repeat(255)),
            field_type: format!("{}é", "t".repeat(63)),
            v: Some(format!("{}é", "v".repeat(65535))),
            c: None,
        };
        let mut st = HibernateState {
            u: None,
            x: None,
            y: None,
            f: vec![field],
        };
        st.validate_limits().unwrap();
        let f = &st.f[0];
        assert_eq!(f.id.len(), 255);
        assert_eq!(f.name.len(), 255);
        assert_eq!(f.field_type.len(), 63);
        assert_eq!(f.v.as_deref().map(str::len), Some(65535));
    }
}
