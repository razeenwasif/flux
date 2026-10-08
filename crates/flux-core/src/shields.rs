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
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
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
#[cfg(not(feature = "native-smoke"))]
const DEFAULT_FILTERS: &str = include_str!("../assets/default-filters.txt");
// Deterministic local request, translated by the same filter engine and installed
// by the same native backend. Never part of the shipping filter list.
#[cfg(feature = "native-smoke")]
const DEFAULT_FILTERS: &str = concat!(
    include_str!("../assets/default-filters.txt"),
    "\n/flux-smoke-blocked.js\n"
);

/// Upstream filter lists fetched + cached on top of the bundled default.
/// `(cache filename, url)`.
const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    (
        "easyprivacy.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
    ),
];

/// Re-fetch a cached list once it's older than this.
const MAX_AGE_DAYS: u64 = 5;

/// Filename of the WebKit content-blocker JSON inside `filters_dir`.
const CB_JSON_FILE: &str = "webkit-cb.json";
/// WebKit refuses to compile very large rule sets (Safari documents 150k);
/// stay well under it — the hot ~10% of EasyList does the real blocking anyway.
const CB_MAX_RULES: usize = 75_000;

/// The user's shields choices, as saved to `shields.json`.
#[derive(Serialize, Deserialize)]
#[serde(default)]
struct ShieldsPrefs {
    enabled: bool,
    sites_off: Vec<String>,
}

impl Default for ShieldsPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            sites_off: Vec::new(),
        }
    }
}

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
    /// Where the global toggle + per-site allowlist are saved (`None` →
    /// in-memory only; tests).
    prefs: Option<PathBuf>,
    /// List-refresh coalescing: `None` while idle, `Some(again)` while a
    /// refresh (download + full rebuild) runs; `again` marks a forced request
    /// that arrived meanwhile and still needs a pass of its own.
    refresh_run: Mutex<Option<bool>>,
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
        let s = Self {
            filter: RwLock::new(Filter::from_list(DEFAULT_FILTERS)),
            off_for: DashMap::new(),
            enabled: AtomicBool::new(true),
            blocked: AtomicU64::new(0),
            decisions: TtlCache::new(DECISION_CACHE_CAP, Some(DECISION_CACHE_TTL)),
            fired_rules: DashMap::new(),
            filters_dir,
            prefs: None,
            refresh_run: Mutex::new(None),
        };
        // Seed the content-blocker JSON from the bundled list so the native
        // layer (WebKitGTK) has rules before the first background refresh
        // lands — webviews open in the same boot tick. Cheap: the bundled
        // list is small. refresh() overwrites it with the full lists.
        if cfg!(feature = "native-smoke") || s.content_blocker_json().is_none() {
            s.write_content_blocker(DEFAULT_FILTERS);
        }
        s
    }

    /// Restore the global toggle + per-site allowlist from `path` (missing or
    /// unreadable → on, no exceptions) and save every change back there. They
    /// used to live only in memory and silently reset on restart.
    pub fn with_prefs(mut self, path: PathBuf) -> Self {
        let saved: ShieldsPrefs = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        *self.enabled.get_mut() = saved.enabled;
        self.off_for = saved.sites_off.into_iter().map(|h| (h, ())).collect();
        self.prefs = Some(path);
        self
    }

    fn save_prefs(&self) {
        let Some(path) = &self.prefs else { return };
        let mut sites_off: Vec<String> = self.off_for.iter().map(|e| e.key().clone()).collect();
        sites_off.sort();
        let enabled = self.enabled.load(Ordering::Relaxed);
        crate::persist::save_json_pretty(path, &ShieldsPrefs { enabled, sites_off });
    }

    /// Fetch any stale/missing upstream lists, then rebuild the filter from the
    /// bundled default + every cached list and swap it in. Blocking + heavy
    /// (parses tens of thousands of rules) — call from a background thread.
    pub fn refresh(&self) {
        self.refresh_lists(false);
    }

    /// [`refresh`](Self::refresh); `force` re-downloads even fresh lists (the
    /// user's "Update filter lists"). One run at a time: a request that lands
    /// mid-run doesn't start a second full rebuild beside it (that run re-reads
    /// every cached list anyway); a forced one gets one more pass after it.
    pub fn refresh_lists(&self, force: bool) {
        let Some(dir) = &self.filters_dir else { return };
        {
            let mut run = self.refresh_run.lock();
            if let Some(again) = run.as_mut() {
                *again |= force;
                return;
            }
            *run = Some(false);
        }
        let mut force = force;
        loop {
            self.rebuild(dir, force);
            let mut run = self.refresh_run.lock();
            if *run != Some(true) {
                *run = None;
                return;
            }
            *run = Some(false);
            force = true;
        }
    }

    fn rebuild(&self, dir: &Path, force: bool) {
        let _ = std::fs::create_dir_all(dir);
        for (name, url) in LISTS {
            let path = dir.join(name);
            if force || is_stale(&path) {
                match fetch(url) {
                    Ok(body) if body.len() > 1024 => {
                        // Atomic: a torn list would be trusted as fresh for days.
                        let _ = crate::persist::write_atomic(&path, body.as_bytes());
                    }
                    Ok(_) => {
                        tracing::warn!(target: "flux::shields", "{url}: suspiciously small, kept old")
                    }
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
        self.write_content_blocker(&text);
    }

    /// Persist the rules as WebKit content-blocker JSON (`webkit-cb.json`) —
    /// the *native* blocking layer for engines with no per-request hook:
    /// WebKitGTK compiles it via `UserContentFilterStore` (see `netfilter`),
    /// and the same file serves WKWebView if Flux lands on macOS. Written on
    /// every platform (cheap, keeps this testable); only consumed off Windows.
    fn write_content_blocker(&self, rules: &str) {
        let Some(dir) = &self.filters_dir else { return };
        match flux_filter::to_content_blocker_json(rules, CB_MAX_RULES) {
            Some(json) => {
                let _ = crate::persist::write_atomic(&dir.join(CB_JSON_FILE), json.as_bytes());
                tracing::info!(target: "flux::shields", bytes = json.len(), "content-blocker JSON written");
            }
            None => {
                tracing::warn!(target: "flux::shields", "no rules translated to content-blocker JSON")
            }
        }
    }

    /// Path of the persisted content-blocker JSON, if it has been produced.
    pub fn content_blocker_json(&self) -> Option<PathBuf> {
        let p = self.filters_dir.as_ref()?.join(CB_JSON_FILE);
        p.exists().then_some(p)
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
            backend: if cfg!(windows) {
                "webview2"
            } else if cfg!(any(target_os = "macos", target_os = "linux")) {
                "webkit"
            } else {
                "unsupported"
            }
            .into(),
            request_metrics: cfg!(windows),
            request_controls: cfg!(windows),
            attachment: "not_requested".into(),
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
            .map(|e| HotRule {
                rule: e.key().clone(),
                hits: *e.value(),
            })
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
    /// Native blocker backend: webview2, webkit, or unsupported.
    pub backend: String,
    /// Whether the native request path reports counters.
    pub request_metrics: bool,
    /// Whether global/site request policy, HTTPS upgrades and lean mode are wired.
    pub request_controls: bool,
    /// Requested tab's installation: not_requested, pending, attached, failed, unavailable.
    pub attachment: String,
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
        Ok(mtime) => mtime
            .elapsed()
            .map(|e| e.as_secs() > MAX_AGE_DAYS * 86_400)
            .unwrap_or(true),
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
pub fn shields_status(
    state: State<'_, ShieldsState>,
    tab_id: Option<crate::state::TabId>,
) -> ShieldsStatus {
    let mut status = state.status();
    status.attachment = crate::netfilter::attachment(tab_id);
    status
}

#[tauri::command]
pub fn shields_set_enabled(state: State<'_, ShieldsState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
    state.save_prefs();
}

/// Turn shields on/off for one site (`on = false` allowlists the host).
#[tauri::command]
pub fn shields_set_site(state: State<'_, ShieldsState>, host: String, on: bool) {
    if on {
        state.off_for.remove(&host);
    } else {
        state.off_for.insert(host, ());
    }
    state.save_prefs();
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
    state
        .filter
        .read()
        .should_block(&url, &source, &request_type)
}

/// Re-fetch the upstream filter lists + rebuild, on a background thread (the
/// download + parse are heavy). Fire-and-forget.
#[tauri::command]
pub fn shields_refresh(app: AppHandle) {
    // Forced: the plain refresh skips lists under five days old, which after
    // the boot refresh is nearly always all of them.
    std::thread::spawn(move || app.state::<ShieldsState>().refresh_lists(true));
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
        assert!(s.should_block(
            "https://www.google-analytics.com/analytics.js",
            "https://news.com",
            "script"
        ));
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
        assert!(
            st.cache_hit_pct > 0,
            "repeats should hit the cache: {}",
            st.cache_hit_pct
        );
        assert!(st.cache_len >= 1);
        assert!(
            st.rules_fired >= 1,
            "a blocked request should populate the hot set"
        );

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
        assert_eq!(
            s.status().cache_len,
            0,
            "rebuilding the rule set must invalidate verdicts"
        );
    }

    #[test]
    fn refresh_requests_coalesce_instead_of_stacking_rebuilds() {
        let dir = std::env::temp_dir().join(format!("flux-shields-refresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Just-written cached lists are fresh: a plain refresh rebuilds from
        // them without downloading anything.
        for (name, _) in LISTS {
            std::fs::write(dir.join(name), "||flux-refresh-test.example^\n").unwrap();
        }
        let s = ShieldsState::new(Some(dir.clone()));
        let (url, page) = ("https://flux-refresh-test.example/t.js", "https://news.com");

        // A refresh is already running: requests return at once instead of
        // starting a second full rebuild beside it, and a forced one is queued.
        *s.refresh_run.lock() = Some(false);
        s.refresh_lists(true);
        s.refresh();
        assert_eq!(
            *s.refresh_run.lock(),
            Some(true),
            "forced pass queued, not dropped"
        );
        assert!(
            !s.should_block(url, page, "script"),
            "nothing rebuilt beside it"
        );

        *s.refresh_run.lock() = None; // idle again (the forced pass would download)
        s.refresh();
        assert!(s.should_block(url, page, "script"));
        assert_eq!(*s.refresh_run.lock(), None, "back to idle");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn toggle_and_allowlist_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("flux-shields-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("shields.json");
        let s = ShieldsState::new(None).with_prefs(path.clone());
        assert!(s.enabled.load(Ordering::Relaxed), "on by default");
        s.off_for.insert("broken.example".into(), ());
        s.save_prefs();
        let back = ShieldsState::new(None).with_prefs(path.clone());
        assert!(back.status().sites_off.contains(&"broken.example".to_string()));
        assert!(back.enabled.load(Ordering::Relaxed));

        back.enabled.store(false, Ordering::Relaxed);
        back.save_prefs();
        assert!(!ShieldsState::new(None).with_prefs(path).enabled.load(Ordering::Relaxed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.com/x?y"), Some("a.b.com"));
        assert_eq!(host_of("http://user@h.com:8080/p"), Some("h.com"));
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn content_blocker_json_written_and_discoverable() {
        let dir = std::env::temp_dir().join(format!("flux-shields-cb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = ShieldsState::new(Some(dir.clone()));
        // new() seeds the JSON from the bundled list, before any refresh.
        assert!(s.content_blocker_json().is_some(), "seeded at construction");
        s.write_content_blocker("||ads.example.com^\n@@||example.com/ok.js\n");
        let p = s.content_blocker_json().expect("JSON persisted");
        let rules: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).expect("valid JSON");
        assert!(rules.iter().any(|r| r["action"]["type"] == "block"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
