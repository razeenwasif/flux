//! Content-blocker shields (BACKLOG #57) — the policy layer over `flux-filter`.
//!
//! Holds the compiled filter engine plus the user's choices: a **global** on/off
//! and a **per-site allowlist** (turn shields off for a site you trust), checked
//! before the engine runs. The native request interceptor (ADR 0007) calls
//! [`ShieldsState::should_block`] for every request; the frontend drives the
//! toggles and reads the blocked-request count for the shields badge.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use flux_filter::Filter;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::cache::TtlCache;

/// Decision-cache bounds. Most page loads re-request the same tracker/CDN/beacon
/// URLs, so memoizing the engine verdict per `(url, source-host, type)` skips the
/// match entirely on the hot path (BACKLOG #99 — the tokenized engine is already
/// fast, so the win is *not re-running it* for repeats). Bounded + short-TTL so a
/// rule refresh or a long session can't grow it without bound.
const DECISION_CACHE_CAP: usize = 8192;
const DECISION_CACHE_TTL: Duration = Duration::from_secs(600);

/// The bundled curated starter list (major ad/tracker networks) — always active,
/// so blocking works offline / before the big lists download.
const DEFAULT_FILTERS: &str = include_str!("../assets/default-filters.txt");

/// Upstream filter lists fetched + cached on top of the bundled default.
/// `(cache filename, url)`.
const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt"),
];

/// Re-fetch a cached list once it's older than this.
const MAX_AGE_DAYS: u64 = 5;

pub struct ShieldsState {
    filter: RwLock<Filter>,
    /// Page hosts where the user turned shields OFF (allowlist).
    off_for: DashMap<String, ()>,
    enabled: AtomicBool,
    blocked: AtomicU64,
    /// Memoized engine verdicts: `(url \u{1} source-host \u{1} type) → blocked?`
    /// The global toggle + per-site allowlist are checked *before* this, so a
    /// cached value is the pure rule-engine decision and stays valid across
    /// those toggles. Cleared when the rule set is rebuilt.
    decisions: TtlCache<String, bool>,
    /// The observed **hot set**: rules that have actually fired, with a
    /// distinct-context fire count. arXiv 1810.09160 found ~90% of EasyList
    /// never matches real traffic; this surfaces the live ~10% on *this* user's
    /// browsing. Recorded only on the engine path (cache misses), so the hot
    /// path stays a single map lookup.
    fired_rules: DashMap<String, u64>,
    /// Where fetched lists are cached (`None` → bundled default only; tests).
    filters_dir: Option<PathBuf>,
}

impl Default for ShieldsState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ShieldsState {
    /// Start with the bundled default list (fast — parsing the big lists is
    /// deferred to [`refresh`](Self::refresh) on a background thread).
    pub fn new(filters_dir: Option<PathBuf>) -> Self {
        Self {
            filter: RwLock::new(Filter::from_list(DEFAULT_FILTERS)),
            off_for: DashMap::new(),
            enabled: AtomicBool::new(true),
            blocked: AtomicU64::new(0),
            decisions: TtlCache::new(DECISION_CACHE_CAP, Some(DECISION_CACHE_TTL)),
            fired_rules: DashMap::new(),
            filters_dir,
        }
    }

    /// Fetch any stale/missing upstream lists, then rebuild the filter from the
    /// bundled default + every cached list and swap it in. Blocking + heavy
    /// (parses tens of thousands of rules) — call from a background thread.
    pub fn refresh(&self) {
        let Some(dir) = &self.filters_dir else { return };
        let _ = std::fs::create_dir_all(dir);
        for (name, url) in LISTS {
            let path = dir.join(name);
            if is_stale(&path) {
                match fetch(url) {
                    Ok(body) if body.len() > 1024 => {
                        let _ = std::fs::write(&path, body);
                    }
                    Ok(_) => tracing::warn!(target: "flux::shields", "{url}: suspiciously small, kept old"),
                    Err(e) => tracing::warn!(target: "flux::shields", "{url}: {e}"),
                }
            }
        }
        let mut text = String::from(DEFAULT_FILTERS);
        for (name, _) in LISTS {
            if let Ok(s) = std::fs::read_to_string(dir.join(name)) {
                text.push('\n');
                text.push_str(&s);
            }
        }
        self.install_filter(Filter::from_list(&text));
        tracing::info!(target: "flux::shields", "content-filter lists refreshed ({} bytes of rules)", text.len());
    }

    /// Swap in a rebuilt rule set and invalidate the decision cache — every
    /// memoized verdict was computed against the old rules (#99).
    fn install_filter(&self, filter: Filter) {
        *self.filter.write() = filter;
        self.decisions.clear();
    }

    /// The interception verdict for one request. `source_url` is the page making
    /// it (its host drives the per-site allowlist + first-/third-party rules).
    pub fn should_block(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        if let Some(host) = host_of(source_url) {
            if self.off_for.contains_key(host) {
                return false;
            }
        }
        let blocked = self.engine_verdict(url, source_url, request_type);
        if blocked {
            self.blocked.fetch_add(1, Ordering::Relaxed);
        }
        blocked
    }

    /// The pure rule-engine verdict, served from the decision cache when we've
    /// seen this `(url, source-host, type)` recently. On a miss we run the engine
    /// and, if it blocked, record the firing rule into the hot set (#99).
    fn engine_verdict(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        let src_host = host_of(source_url).unwrap_or(source_url);
        let key = format!("{url}\u{1}{src_host}\u{1}{request_type}");
        if let Some(v) = self.decisions.get(&key) {
            return v;
        }
        let (blocked, rule) = self.filter.read().check(url, source_url, request_type);
        if let Some(rule) = rule {
            *self.fired_rules.entry(rule).or_insert(0) += 1;
        }
        self.decisions.insert(key, blocked);
        blocked
    }

    /// Element-hiding CSS for a page (empty if shields are off globally or for
    /// this site). Injected per page-load by the webview layer (ADR 0007).
    pub fn cosmetic_css(&self, url: &str) -> String {
        if !self.enabled.load(Ordering::Relaxed) {
            return String::new();
        }
        if let Some(host) = host_of(url) {
            if self.off_for.contains_key(host) {
                return String::new();
            }
        }
        self.filter.read().cosmetic_css(url)
    }

    fn status(&self) -> ShieldsStatus {
        let cache = self.decisions.stats();
        ShieldsStatus {
            enabled: self.enabled.load(Ordering::Relaxed),
            blocked: self.blocked.load(Ordering::Relaxed),
            sites_off: self.off_for.iter().map(|e| e.key().clone()).collect(),
            cache_hit_pct: cache.hit_pct(),
            cache_len: cache.len,
            rules_fired: self.fired_rules.len(),
        }
    }

    /// The observed hot set: rules that actually fired this session, busiest
    /// first, capped at `limit`. The empirical "keep these synchronous" tier of
    /// arXiv 1810.09160. (`limit = 0` → all.)
    pub fn hot_rules(&self, limit: usize) -> Vec<HotRule> {
        let mut v: Vec<HotRule> = self
            .fired_rules
            .iter()
            .map(|e| HotRule { rule: e.key().clone(), hits: *e.value() })
            .collect();
        v.sort_by(|a, b| b.hits.cmp(&a.hits).then_with(|| a.rule.cmp(&b.rule)));
        if limit > 0 {
            v.truncate(limit);
        }
        v
    }
}

#[derive(Serialize, specta::Type)]
pub struct ShieldsStatus {
    /// Global shields on/off.
    pub enabled: bool,
    /// Requests blocked this session.
    pub blocked: u64,
    /// Hosts the user has allowlisted (shields off).
    pub sites_off: Vec<String>,
    /// Decision-cache hit ratio (%) — how often a verdict was served without
    /// re-running the engine (BACKLOG #99).
    pub cache_hit_pct: u32,
    /// Live entries in the decision cache.
    pub cache_len: usize,
    /// Distinct rules observed firing this session (the live hot set vs the
    /// tens of thousands of loaded rules — the 1810.09160 "most rules are dead"
    /// signal, on the user's own traffic).
    pub rules_fired: usize,
}

#[derive(Serialize, specta::Type)]
pub struct HotRule {
    pub rule: String,
    pub hits: u64,
}

/// Host of a URL (`https://a.b.com/x` → `a.b.com`), best-effort and dependency
/// -free (the URL is already validated upstream).
fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1)?;
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?; // strip userinfo
    Some(host.split(':').next().unwrap_or(host)) // strip port
}

/// A cached list is stale if missing or older than [`MAX_AGE_DAYS`].
fn is_stale(path: &Path) -> bool {
    match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(mtime) => mtime.elapsed().map(|e| e.as_secs() > MAX_AGE_DAYS * 86_400).unwrap_or(true),
        Err(_) => true,
    }
}

/// Download a filter list (a few MB) — generous timeout, off the main thread.
fn fetch(url: &str) -> Result<String, String> {
    ureq::get(url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn shields_status(state: State<'_, ShieldsState>) -> ShieldsStatus {
    state.status()
}

#[tauri::command]
pub fn shields_set_enabled(state: State<'_, ShieldsState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
}

/// Turn shields on/off for one site (`on = false` allowlists the host).
#[tauri::command]
pub fn shields_set_site(state: State<'_, ShieldsState>, host: String, on: bool) {
    if on {
        state.off_for.remove(&host);
    } else {
        state.off_for.insert(host, ());
    }
}

/// Diagnostic / agent hook: would this request be blocked? (Does not count.)
#[tauri::command]
pub fn shields_check(
    state: State<'_, ShieldsState>,
    url: String,
    source: String,
    request_type: String,
) -> bool {
    if !state.enabled.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(host) = host_of(&source) {
        if state.off_for.contains_key(host) {
            return false;
        }
    }
    state.filter.read().should_block(&url, &source, &request_type)
}

/// Re-fetch the upstream filter lists + rebuild, on a background thread (the
/// download + parse are heavy). Fire-and-forget.
#[tauri::command]
pub fn shields_refresh(app: AppHandle) {
    std::thread::spawn(move || app.state::<ShieldsState>().refresh());
}

/// The session's hot rule set — the filters that actually fired, busiest first
/// (BACKLOG #99). Surfaced in the shields UI as "N of your loaded rules are
/// doing the work."
#[tauri::command]
pub fn shields_hot_rules(state: State<'_, ShieldsState>, limit: usize) -> Vec<HotRule> {
    state.hot_rules(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_list_blocks_a_major_tracker() {
        let s = ShieldsState::new(None);
        assert!(s.should_block("https://www.google-analytics.com/analytics.js", "https://news.com", "script"));
        assert!(s.should_block("https://doubleclick.net/ad", "https://news.com", "image"));
        assert!(!s.should_block("https://news.com/app.js", "https://news.com", "script"));
    }

    #[test]
    fn global_toggle_and_per_site_allowlist() {
        let s = ShieldsState::new(None);
        let (url, page) = ("https://google-analytics.com/ga.js", "https://news.com");
        assert!(s.should_block(url, page, "script"));

        // Allowlist the page host → no longer blocked there.
        s.off_for.insert("news.com".into(), ());
        assert!(!s.should_block(url, page, "script"));
        // …but still blocked on another site.
        assert!(s.should_block(url, "https://other.com", "script"));

        // Global off → nothing blocked anywhere.
        s.enabled.store(false, Ordering::Relaxed);
        assert!(!s.should_block(url, "https://other.com", "script"));
    }

    #[test]
    fn decision_cache_serves_repeats_and_tracks_hot_rules() {
        let s = ShieldsState::new(None);
        let (url, page) = ("https://google-analytics.com/ga.js", "https://news.com");
        // First call: engine path (cache miss) → records the firing rule.
        assert!(s.should_block(url, page, "script"));
        // Repeat: served from the decision cache.
        assert!(s.should_block(url, page, "script"));
        assert!(s.should_block(url, page, "script"));

        let st = s.status();
        assert!(st.cache_hit_pct > 0, "repeats should hit the cache: {}", st.cache_hit_pct);
        assert!(st.cache_len >= 1);
        assert!(st.rules_fired >= 1, "a blocked request should populate the hot set");

        let hot = s.hot_rules(10);
        assert!(!hot.is_empty());
        assert!(hot[0].hits >= 1);
    }

    #[test]
    fn rebuilding_rules_clears_decision_cache() {
        let s = ShieldsState::new(None);
        assert!(s.should_block("https://doubleclick.net/ad", "https://news.com", "image"));
        s.should_block("https://doubleclick.net/ad", "https://news.com", "image");
        assert!(s.status().cache_len >= 1);
        s.install_filter(Filter::from_list(DEFAULT_FILTERS)); // the swap refresh() performs
        assert_eq!(s.status().cache_len, 0, "rebuilding the rule set must invalidate verdicts");
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.com/x?y"), Some("a.b.com"));
        assert_eq!(host_of("http://user@h.com:8080/p"), Some("h.com"));
        assert_eq!(host_of("not a url"), None);
    }
}
