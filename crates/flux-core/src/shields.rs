//! Content-blocker shields (BACKLOG #57) — the policy layer over `flux-filter`.
//!
//! Holds the compiled filter engine plus the user's choices: a **global** on/off
//! and a **per-site allowlist** (turn shields off for a site you trust), checked
//! before the engine runs. The native request interceptor (ADR 0007) calls
//! [`ShieldsState::should_block`] for every request; the frontend drives the
//! toggles and reads the blocked-request count for the shields badge.
//!
//! On macOS the rules run inside WebKit, which reports each block back through a
//! private navigation-delegate callback (`netfilter`); that feeds the same
//! per-page counts Windows gets from its request hook. Elements the user hides
//! with the picker are saved per site and served with the cosmetic CSS.

use std::collections::{BTreeMap, HashMap};
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
/// What `webkit-cb.json` was made from: a hash of its inputs.
const CB_STAMP_FILE: &str = "webkit-cb.stamp";
/// WebKit refuses to compile very large rule sets (Safari documents 150k);
/// stay well under it — the hot ~10% of EasyList does the real blocking anyway.
const CB_MAX_RULES: usize = 75_000;

/// The user's shields choices, as saved to `shields.json`.
#[derive(Serialize, Deserialize)]
#[serde(default)]
struct ShieldsPrefs {
    enabled: bool,
    sites_off: Vec<String>,
    /// Elements hidden with the picker: host → CSS selectors.
    hidden: BTreeMap<String, Vec<String>>,
}

impl Default for ShieldsPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            sites_off: Vec::new(),
            hidden: BTreeMap::new(),
        }
    }
}

/// Hidden elements kept per site, and the longest selector kept: a picked
/// element's path is a few hundred bytes at most.
const HIDDEN_PER_SITE: usize = 200;
const SELECTOR_MAX: usize = 1000;
/// Blocked domains listed per page in the popover.
const PAGE_DOMAINS: usize = 12;

/// What one page has had blocked since it loaded.
#[derive(Default)]
struct PageBlocks {
    blocked: u32,
    /// Registrable domain → requests blocked.
    domains: HashMap<String, u32>,
}

pub struct ShieldsState {
    filter: RwLock<Filter>,
    /// Page hosts where the user turned shields OFF (allowlist).
    off_for: DashMap<String, ()>,
    enabled: AtomicBool,
    blocked: AtomicU64,
    /// Per tab: what its current page has had blocked (reset at each commit).
    pages: DashMap<crate::state::TabId, PageBlocks>,
    /// Elements the user hid with the picker: host → CSS selectors.
    hidden: DashMap<String, Vec<String>>,
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
            pages: DashMap::new(),
            hidden: DashMap::new(),
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
        self.hidden = saved.hidden.into_iter().collect();
        self.prefs = Some(path);
        self
    }

    fn save_prefs(&self) {
        let Some(path) = &self.prefs else { return };
        let mut sites_off: Vec<String> = self.off_for.iter().map(|e| e.key().clone()).collect();
        sites_off.sort();
        let enabled = self.enabled.load(Ordering::Relaxed);
        let hidden = self
            .hidden
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();
        crate::persist::queue_json_pretty(
            path,
            &ShieldsPrefs {
                enabled,
                sites_off,
                hidden,
            },
            crate::persist::Durability::Barrier,
        );
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
                        let _ = crate::persist::write_atomic_with(
                            &path,
                            body.as_bytes(),
                            crate::persist::Durability::Barrier,
                        );
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
    ///
    /// Skipped when the rules are the ones the file was made from (the stamp
    /// beside it): regenerating meant re-translating ~3.6 MB of rules and
    /// writing 7.8 MB on every launch, and on macOS a rewritten file means a new
    /// WebKit compile (netfilter names the compiled list after this file).
    fn write_content_blocker(&self, rules: &str) {
        let Some(dir) = &self.filters_dir else { return };
        let json_path = dir.join(CB_JSON_FILE);
        let stamp_path = dir.join(CB_STAMP_FILE);
        let stamp = format!("{:016x}", rules_stamp(rules));
        let current = std::fs::read_to_string(&stamp_path).is_ok_and(|s| s.trim() == stamp);
        if current && json_path.exists() {
            tracing::info!(target: "flux::shields", "content-blocker JSON already current");
            return;
        }
        match flux_filter::to_content_blocker_json(rules, CB_MAX_RULES) {
            Some(json) => {
                let _ = crate::persist::write_atomic_with(
                    &json_path,
                    json.as_bytes(),
                    crate::persist::Durability::Barrier,
                );
                // After the JSON: a crash between the two leaves an old stamp,
                // so the next launch rebuilds rather than trusting a stale file.
                let _ = crate::persist::write_atomic_with(
                    &stamp_path,
                    stamp.as_bytes(),
                    crate::persist::Durability::Barrier,
                );
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
        let mut css = self.filter.read().cosmetic_css(url);
        if let Some(picked) = host_of(url).and_then(|h| self.hidden.get(h)) {
            // One rule per selector: an invalid one in a list would void the rest.
            for sel in picked.iter() {
                css.push_str(sel);
                css.push_str("{display:none!important}\n");
            }
        }
        css
    }

    /// Whether the rules should run on a page at `url` (on, and not turned off
    /// for its site). The native layers apply this per navigation.
    pub fn applies_to(&self, url: &str) -> bool {
        self.enabled.load(Ordering::Relaxed)
            && host_of(url).is_none_or(|h| !self.off_for.contains_key(h))
    }

    /// A request the native rules blocked (macOS: WebKit reports it after the
    /// fact). Counts toward the session total and the page's tally.
    pub fn record_native_block(&self, tab: Option<crate::state::TabId>, url: &str) {
        self.blocked.fetch_add(1, Ordering::Relaxed);
        self.note_page_block(tab, url);
    }

    /// Add one blocked request to `tab`'s current page.
    pub fn note_page_block(&self, tab: Option<crate::state::TabId>, url: &str) {
        let Some(tab) = tab else { return };
        let domain = crate::trackers::registrable(url)
            .or_else(|| host_of(url).map(str::to_string))
            .unwrap_or_else(|| "other".into());
        let mut page = self.pages.entry(tab).or_default();
        page.blocked = page.blocked.saturating_add(1);
        *page.domains.entry(domain).or_insert(0) += 1;
    }

    /// Requests blocked on `tab`'s current page.
    pub fn page_count(&self, tab: crate::state::TabId) -> u32 {
        self.pages.get(&tab).map_or(0, |p| p.blocked)
    }

    /// A new document committed in `tab`: its tally starts over.
    pub fn page_reset(&self, tab: crate::state::TabId) {
        self.pages.remove(&tab);
    }

    /// The tab closed.
    pub fn forget_page(&self, tab: crate::state::TabId) {
        self.pages.remove(&tab);
    }

    /// `tab`'s page: requests blocked, and the busiest domains.
    fn page_view(&self, tab: Option<crate::state::TabId>) -> (u32, Vec<BlockedDomain>) {
        let Some(page) = tab.and_then(|t| self.pages.get(&t)) else {
            return (0, Vec::new());
        };
        let mut domains: Vec<BlockedDomain> = page
            .domains
            .iter()
            .map(|(d, n)| BlockedDomain {
                domain: d.clone(),
                count: *n,
            })
            .collect();
        domains.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.domain.cmp(&b.domain)));
        domains.truncate(PAGE_DOMAINS);
        (page.blocked, domains)
    }

    /// Keep an element the user picked hidden on `host`. False when the
    /// selector isn't usable (empty, too long, or a rule-breaking character).
    pub fn hide_on_site(&self, host: &str, selector: &str) -> bool {
        let sel = selector.trim();
        if host.is_empty()
            || sel.is_empty()
            || sel.len() > SELECTOR_MAX
            || sel.contains(['{', '}', '<'])
        {
            return false;
        }
        {
            let mut list = self.hidden.entry(host.to_string()).or_default();
            if !list.iter().any(|s| s == sel) {
                if list.len() >= HIDDEN_PER_SITE {
                    list.remove(0);
                }
                list.push(sel.to_string());
            }
        }
        self.save_prefs();
        true
    }

    /// Show everything the picker hid on `host` again.
    pub fn unhide_site(&self, host: &str) {
        if self.hidden.remove(host).is_some() {
            self.save_prefs();
        }
    }

    fn hidden_on(&self, host: &str) -> u32 {
        self.hidden.get(host).map_or(0, |l| l.len() as u32)
    }

    fn status(&self, tab: Option<crate::state::TabId>, host: Option<&str>) -> ShieldsStatus {
        let cache = self.decisions.stats();
        let (page_blocked, page_domains) = self.page_view(tab);
        ShieldsStatus {
            backend: if cfg!(windows) {
                "webview2"
            } else if cfg!(any(target_os = "macos", target_os = "linux")) {
                "webkit"
            } else {
                "unsupported"
            }
            .into(),
            request_metrics: cfg!(windows) || crate::netfilter::reports_blocks(),
            request_controls: cfg!(windows),
            site_controls: cfg!(windows) || crate::netfilter::reports_blocks(),
            element_picker: crate::netfilter::can_pick_elements(),
            attachment: "not_requested".into(),
            enabled: self.enabled.load(Ordering::Relaxed),
            blocked: self.blocked.load(Ordering::Relaxed),
            sites_off: self.off_for.iter().map(|e| e.key().clone()).collect(),
            cache_hit_pct: cache.hit_pct(),
            cache_len: cache.len,
            rules_fired: self.fired_rules.len(),
            page_blocked,
            page_domains,
            site_hidden: host.map_or(0, |h| self.hidden_on(h)),
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
    /// Whether HTTPS upgrades, lean mode and tracking levels are wired.
    pub request_controls: bool,
    /// Whether the global and per-site Shields switches take effect.
    pub site_controls: bool,
    /// Whether "Hide an element" works here (macOS).
    pub element_picker: bool,
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
    /// Requests blocked on the requested tab's current page.
    pub page_blocked: u32,
    /// The domains they went to, busiest first.
    pub page_domains: Vec<BlockedDomain>,
    /// Elements hidden with the picker on the requested tab's site.
    pub site_hidden: u32,
}

#[derive(Serialize, specta::Type)]
pub struct BlockedDomain {
    pub domain: String,
    pub count: u32,
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

/// FNV-1a over everything the content-blocker JSON depends on: the rules, the
/// rule cap and the Flux version (whose translator wrote it).
fn rules_stamp(rules: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let parts: [&[u8]; 3] = [
        env!("CARGO_PKG_VERSION").as_bytes(),
        &(CB_MAX_RULES as u64).to_le_bytes(),
        rules.as_bytes(),
    ];
    for part in parts {
        for &b in part {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
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

/// The host of `tab`'s page, from Flux's own record of it.
fn tab_host(app: &AppHandle, tab: Option<crate::state::TabId>) -> Option<String> {
    let state = app.try_state::<crate::state::FluxState>()?;
    let url = state.tabs.get(&tab?)?.url.clone();
    host_of(&url).map(str::to_string)
}

#[tauri::command]
pub fn shields_status(
    app: AppHandle,
    state: State<'_, ShieldsState>,
    tab_id: Option<crate::state::TabId>,
) -> ShieldsStatus {
    let host = tab_host(&app, tab_id);
    let mut status = state.status(tab_id, host.as_deref());
    status.attachment = crate::netfilter::attachment(tab_id);
    status
}

#[tauri::command]
pub fn shields_set_enabled(app: AppHandle, state: State<'_, ShieldsState>, on: bool) {
    state.enabled.store(on, Ordering::Relaxed);
    state.save_prefs();
    crate::netfilter::reapply(&app);
}

/// Turn shields on/off for one site (`on = false` allowlists the host).
#[tauri::command]
pub fn shields_set_site(app: AppHandle, state: State<'_, ShieldsState>, host: String, on: bool) {
    if on {
        state.off_for.remove(&host);
    } else {
        state.off_for.insert(host, ());
    }
    state.save_prefs();
    crate::netfilter::reapply(&app);
}

/// Let the user click an element on `tab_id`'s page to hide it there for good.
/// Resolves when they pick one (true) or press Esc (false).
#[tauri::command]
pub async fn shields_pick_element(
    app: AppHandle,
    tab_id: crate::state::TabId,
) -> Result<bool, String> {
    let Some(selector) = crate::netfilter::pick_element(&app, tab_id).await? else {
        return Ok(false);
    };
    let host = tab_host(&app, Some(tab_id)).ok_or("this page has no site to remember it for")?;
    if !app.state::<ShieldsState>().hide_on_site(&host, &selector) {
        return Err("that element can't be hidden by a rule".into());
    }
    Ok(true)
}

/// Show the elements hidden on `host` again (from the next load).
#[tauri::command]
pub fn shields_unhide_site(state: State<'_, ShieldsState>, host: String) {
    state.unhide_site(&host);
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

        let st = s.status(None, None);
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
        assert!(s.status(None, None).cache_len >= 1);
        s.install_filter(Filter::from_list(DEFAULT_FILTERS)); // the swap refresh() performs
        assert_eq!(
            s.status(None, None).cache_len,
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
        assert!(back
            .status(None, None)
            .sites_off
            .contains(&"broken.example".to_string()));
        assert!(back.enabled.load(Ordering::Relaxed));

        back.enabled.store(false, Ordering::Relaxed);
        back.save_prefs();
        assert!(!ShieldsState::new(None)
            .with_prefs(path)
            .enabled
            .load(Ordering::Relaxed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_tallies_its_blocks_and_starts_over_on_commit() {
        let s = ShieldsState::new(None);
        s.record_native_block(Some(7), "https://stats.doubleclick.net/a.js");
        s.record_native_block(Some(7), "https://ad.doubleclick.net/b.gif");
        s.record_native_block(Some(7), "https://www.google-analytics.com/ga.js");
        s.record_native_block(None, "https://ad.doubleclick.net/peek.gif");
        let st = s.status(Some(7), None);
        assert_eq!(st.blocked, 4, "the session total counts every block");
        assert_eq!(st.page_blocked, 3);
        assert_eq!(st.page_domains[0].domain, "doubleclick.net");
        assert_eq!(st.page_domains[0].count, 2);
        assert_eq!(st.page_domains[1].domain, "google-analytics.com");
        assert_eq!(s.page_count(7), 3);
        s.page_reset(7);
        assert_eq!(s.status(Some(7), None).page_blocked, 0);
        assert_eq!(s.status(Some(7), None).blocked, 4);
    }

    #[test]
    fn the_switches_decide_where_the_rules_run() {
        let s = ShieldsState::new(None);
        assert!(s.applies_to("https://news.com/story"));
        assert!(s.applies_to("about:blank"), "no site: on");
        s.off_for.insert("news.com".into(), ());
        assert!(!s.applies_to("https://news.com/story"));
        assert!(s.applies_to("https://other.com/"));
        s.enabled.store(false, Ordering::Relaxed);
        assert!(!s.applies_to("https://other.com/"));
    }

    #[test]
    fn picked_elements_stay_hidden_on_their_site() {
        let dir = std::env::temp_dir().join(format!("flux-shields-hide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("shields.json");
        let s = ShieldsState::new(None).with_prefs(path.clone());
        assert!(s.hide_on_site("news.com", "div.promo > aside:nth-of-type(2)"));
        assert!(
            s.hide_on_site("news.com", "div.promo > aside:nth-of-type(2)"),
            "again is fine"
        );
        assert!(
            !s.hide_on_site("news.com", "a{color:red}"),
            "no rule-breaking braces"
        );
        assert!(!s.hide_on_site("news.com", "  "));
        assert_eq!(s.status(None, Some("news.com")).site_hidden, 1);

        let css = s.cosmetic_css("https://news.com/today");
        assert!(css.contains("div.promo > aside:nth-of-type(2){display:none!important}"));
        assert!(!s.cosmetic_css("https://other.com/").contains("promo"));

        // Saved: a restart keeps it.
        let back = ShieldsState::new(None).with_prefs(path.clone());
        assert!(back
            .cosmetic_css("https://news.com/")
            .contains("aside:nth-of-type(2)"));
        // Shields off for the site: nothing hidden there.
        back.off_for.insert("news.com".into(), ());
        assert!(back.cosmetic_css("https://news.com/").is_empty());
        back.off_for.remove("news.com");
        back.unhide_site("news.com");
        assert!(!back.cosmetic_css("https://news.com/").contains("aside"));
        assert_eq!(back.status(None, Some("news.com")).site_hidden, 0);
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
