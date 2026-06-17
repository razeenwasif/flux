//! flux-filter — network content filtering (ad/tracker blocking).
//!
//! The matching engine for Flux's request-interception layer (BACKLOG #91/#57).
//! Wraps Brave's `adblock` engine: parse filter lists (EasyList/uBO syntax) and
//! decide block/allow per network request. Pure Rust and deterministic, so the
//! *decisions* are unit-tested here, independent of the native webview wiring
//! that calls them (ADR 0007).
//!
//! ## Threading
//!
//! `adblock::Engine` is `!Send`/`!Sync` (internal `Rc`/`RefCell`), so it can't
//! live in Tauri's shared state directly. We serialize the engine once (the
//! bytes *are* `Send + Sync`) and lazily deserialize a **thread-local** engine
//! on first use per thread — so [`Filter`] is `Send + Sync` while matching stays
//! single-threaded and cheap. This is the pattern Brave itself uses.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;

/// Identifies a distinct rule set, so each thread re-deserializes only when the
/// rules actually change.
static GENERATION: AtomicUsize = AtomicUsize::new(1);

thread_local! {
    /// Per-thread deserialized engine, tagged with the generation it was built
    /// from. `!Send` `Engine` never leaves its thread.
    static LOCAL_ENGINE: RefCell<Option<(usize, Engine)>> = const { RefCell::new(None) };
}

/// A compiled, thread-safe handle to a set of filter rules.
pub struct Filter {
    /// The serialized engine — `Send + Sync`, deserialized per-thread on demand.
    serialized: Arc<Vec<u8>>,
    generation: usize,
    enabled: AtomicBool,
}

impl Filter {
    /// Build from filter rules — `rules` is one rule per line, EasyList/uBO syntax.
    pub fn from_rules<S: AsRef<str>>(rules: &[S]) -> Self {
        let mut set = FilterSet::new(false);
        let lines: Vec<String> = rules.iter().map(|s| s.as_ref().to_string()).collect();
        set.add_filters(&lines, ParseOptions::default());
        let engine = Engine::from_filter_set(set, true);
        Self {
            serialized: Arc::new(engine.serialize()),
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
            enabled: AtomicBool::new(true),
        }
    }

    /// Parse a whole filter list given as one blob (e.g. a downloaded EasyList).
    pub fn from_list(list: &str) -> Self {
        let rules: Vec<&str> = list.lines().collect();
        Self::from_rules(&rules)
    }

    /// An empty (pass-everything) filter — the no-rules baseline.
    pub fn empty() -> Self {
        Self::from_rules::<&str>(&[])
    }

    /// Master on/off (the global shields toggle). Disabled → blocks nothing.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Run `f` with this rule set's thread-local engine (deserialized on first
    /// use per thread / when the rules change). Returns `R::default()` if the
    /// engine can't be rebuilt.
    fn with_engine<R: Default>(&self, f: impl FnOnce(&Engine) -> R) -> R {
        LOCAL_ENGINE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let stale = slot.as_ref().map(|(g, _)| *g != self.generation).unwrap_or(true);
            if stale {
                let mut engine = Engine::from_filter_set(FilterSet::new(false), false);
                if engine.deserialize(&self.serialized).is_err() {
                    return R::default();
                }
                *slot = Some((self.generation, engine));
            }
            f(&slot.as_ref().unwrap().1)
        })
    }

    /// Should this request be blocked?
    ///
    /// * `url`          — the request URL.
    /// * `source_url`   — the page making it (first-vs-third-party).
    /// * `request_type` — adblock resource type: `"script"`, `"image"`,
    ///   `"stylesheet"`, `"xmlhttprequest"`, `"sub_frame"`, `"font"`, `"media"`,
    ///   `"websocket"`, `"ping"`, `"other"`, …
    ///
    /// Fails safe: an unparseable URL is never blocked.
    pub fn should_block(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        self.check(url, source_url, request_type).0
    }

    /// Like [`should_block`](Self::should_block) but also returns the **matching
    /// rule** (when blocked), so callers can observe *which* filters actually
    /// fire — the basis for the hot/cold rule tiering in BACKLOG #99 (arXiv
    /// 1810.09160 found ~90% of EasyList rules never match real traffic). The
    /// returned string is the canonical filter text from the engine.
    pub fn check(&self, url: &str, source_url: &str, request_type: &str) -> (bool, Option<String>) {
        if !self.enabled.load(Ordering::Relaxed) {
            return (false, None);
        }
        let req = match Request::new(url, source_url, request_type) {
            Ok(r) => r,
            Err(_) => return (false, None),
        };
        self.with_engine(|engine| {
            let r = engine.check_network_request(&req);
            (r.matched, if r.matched { r.filter } else { None })
        })
    }

    /// Element-hiding CSS for `url` — the selectors the cosmetic rules say to
    /// hide, as one `… { display: none !important; }` rule (empty if none /
    /// disabled). Inject it into the page to remove ad slots + leftover
    /// placeholders. (Generic class/id cosmetics that need the page's live DOM
    /// aren't included — that's a runtime-reporting follow-up.)
    pub fn cosmetic_css(&self, url: &str) -> String {
        if !self.enabled.load(Ordering::Relaxed) {
            return String::new();
        }
        self.with_engine(|engine| {
            let res = engine.url_cosmetic_resources(url);
            if res.hide_selectors.is_empty() {
                return String::new();
            }
            let selectors = res.hide_selectors.iter().cloned().collect::<Vec<_>>().join(",");
            format!("{selectors} {{ display: none !important; }}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Filter {
        Filter::from_list(
            "||ads.example.com^\n\
             ||tracker.net^$third-party\n\
             /banner_ad.\n\
             @@||example.com/allowed/ads.js\n",
        )
    }

    #[test]
    fn blocks_tracker_host() {
        assert!(sample().should_block("https://ads.example.com/a.js", "https://news.com", "script"));
    }

    #[test]
    fn blocks_ad_path() {
        assert!(sample().should_block("https://cdn.site.com/banner_ad.png", "https://site.com", "image"));
    }

    #[test]
    fn allows_unmatched() {
        assert!(!sample().should_block("https://site.com/app.js", "https://site.com", "script"));
    }

    #[test]
    fn exception_unblocks() {
        assert!(!sample().should_block("https://example.com/allowed/ads.js", "https://example.com", "script"));
    }

    #[test]
    fn disabled_blocks_nothing() {
        let f = sample();
        f.set_enabled(false);
        assert!(!f.should_block("https://ads.example.com/a.js", "https://news.com", "script"));
    }

    #[test]
    fn empty_filter_passes_all() {
        assert!(!Filter::empty().should_block("https://ads.example.com/a.js", "https://news.com", "script"));
    }

    #[test]
    fn is_send_and_sync() {
        fn assert_ss<T: Send + Sync>() {}
        assert_ss::<Filter>();
    }

    #[test]
    fn check_reports_matching_rule() {
        let (blocked, rule) = sample().check("https://ads.example.com/a.js", "https://news.com", "script");
        assert!(blocked);
        assert!(rule.is_some(), "a blocked request should name the rule that fired");
        // An allowed request names no rule.
        let (blocked, rule) = sample().check("https://site.com/app.js", "https://site.com", "script");
        assert!(!blocked);
        assert!(rule.is_none());
    }

    #[test]
    fn cosmetic_hides_site_specific_selector() {
        let f = Filter::from_list("example.com##.sponsored-ad\n");
        let css = f.cosmetic_css("https://example.com/page");
        assert!(css.contains(".sponsored-ad"), "got: {css}");
        assert!(css.contains("display: none"), "got: {css}");
    }

    #[test]
    fn cosmetic_empty_when_no_rules_or_disabled() {
        let f = Filter::from_list("example.com##.ad\n");
        assert_eq!(f.cosmetic_css("https://other.com/p"), ""); // different site
        f.set_enabled(false);
        assert_eq!(f.cosmetic_css("https://example.com/p"), ""); // disabled
    }
}
