//! Pluggable search backend.
//!
//! The omnibox sends raw user input here; `SearchConfig::resolve` decides
//! whether it's a URL to navigate to or a query to search, applies any
//! `!bang`/keyword routing, and returns a final URL. Search engines are pure
//! data — a name, a URL template, an optional suggest template, an optional
//! keyword — so adding the user's own engine (or making it the default) is a
//! config change, never a code change. That's the whole point of #68.
//!
//! This crate is intentionally Tauri-free and pure so the resolution logic is
//! unit-tested in isolation; `flux-core` adds persistence + IPC commands.

use serde::{Deserialize, Serialize};

/// A search engine, defined entirely by templates. `{query}` in a template is
/// replaced with the percent-encoded query.
///
/// Example (the user's own engine):
/// ```
/// # use flux_search::SearchEngine;
/// let mine = SearchEngine {
///     id: "flux".into(),
///     name: "Flux Search".into(),
///     keyword: Some("f".into()),
///     search_template: "https://search.example.com/?q={query}".into(),
///     suggest_template: Some("https://search.example.com/ac?q={query}".into()),
/// };
/// assert_eq!(mine.search_url("rust lang"), "https://search.example.com/?q=rust%20lang");
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchEngine {
    /// Stable id (used by `default_id`, set/remove).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional omnibox keyword / bang, e.g. `g` → `!g query` or `g query`.
    #[serde(default)]
    pub keyword: Option<String>,
    /// Full-search URL template containing `{query}`.
    pub search_template: String,
    /// Optional autocomplete endpoint template containing `{query}`
    /// (consumed by the suggestions UI — BACKLOG #32).
    #[serde(default)]
    pub suggest_template: Option<String>,
}

impl SearchEngine {
    /// Build the URL to navigate to for a full search of `query`.
    pub fn search_url(&self, query: &str) -> String {
        self.search_template.replace("{query}", &percent_encode(query))
    }

    /// Build the suggestions endpoint URL, if this engine defines one.
    pub fn suggest_url(&self, query: &str) -> Option<String> {
        self.suggest_template
            .as_ref()
            .map(|t| t.replace("{query}", &percent_encode(query)))
    }
}

/// The result of resolving omnibox input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// Input was a URL/host → go straight there.
    Navigate { url: String },
    /// Input was a query → search with `engine`.
    Search { engine: String, url: String },
}

impl Resolution {
    /// The URL to load, regardless of how it was resolved.
    pub fn url(&self) -> &str {
        match self {
            Resolution::Navigate { url } | Resolution::Search { url, .. } => url,
        }
    }
}

/// The configured set of engines + which is the default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub engines: Vec<SearchEngine>,
    pub default_id: String,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self::with_builtin_defaults()
    }
}

impl SearchConfig {
    /// Seed with a few common engines. The user replaces/overrides these — to
    /// make their own engine the default, add it and set `default_id` (or call
    /// the `search_add_engine` / `search_set_default` commands).
    pub fn with_builtin_defaults() -> Self {
        Self {
            default_id: "ddg".into(),
            engines: vec![
                SearchEngine {
                    id: "ddg".into(),
                    name: "DuckDuckGo".into(),
                    keyword: Some("ddg".into()),
                    search_template: "https://duckduckgo.com/?q={query}".into(),
                    suggest_template: Some("https://duckduckgo.com/ac/?q={query}&type=list".into()),
                },
                SearchEngine {
                    id: "google".into(),
                    name: "Google".into(),
                    keyword: Some("g".into()),
                    search_template: "https://www.google.com/search?q={query}".into(),
                    suggest_template: Some(
                        "https://suggestqueries.google.com/complete/search?client=firefox&q={query}".into(),
                    ),
                },
                SearchEngine {
                    id: "bing".into(),
                    name: "Bing".into(),
                    keyword: Some("b".into()),
                    search_template: "https://www.bing.com/search?q={query}".into(),
                    suggest_template: None,
                },
            ],
        }
    }

    pub fn engine(&self, id: &str) -> Option<&SearchEngine> {
        self.engines.iter().find(|e| e.id == id)
    }

    /// The default engine (falls back to the first if `default_id` is stale).
    pub fn default_engine(&self) -> &SearchEngine {
        self.engine(&self.default_id).unwrap_or(&self.engines[0])
    }

    fn engine_by_keyword(&self, kw: &str) -> Option<&SearchEngine> {
        self.engines.iter().find(|e| e.keyword.as_deref() == Some(kw))
    }

    /// Resolve omnibox input into a final URL.
    ///
    /// Order: explicit `!bang`/keyword search → URL detection → default search.
    pub fn resolve(&self, input: &str) -> Resolution {
        let q = input.trim();
        if q.is_empty() {
            return Resolution::Navigate { url: "about:blank".into() };
        }

        // `!g query` or `g query` → force-search `query` with that engine's
        // keyword. Requires a following space + non-empty remainder so a bare
        // `g` (or a real host like `g.co`) isn't hijacked.
        if let Some((head, rest)) = q.split_once(' ') {
            let kw = head.strip_prefix('!').unwrap_or(head);
            if !rest.trim().is_empty() {
                if let Some(engine) = self.engine_by_keyword(kw) {
                    return Resolution::Search {
                        engine: engine.id.clone(),
                        url: engine.search_url(rest.trim()),
                    };
                }
            }
        }

        if looks_like_url(q) {
            return Resolution::Navigate { url: normalize_url(q) };
        }

        let engine = self.default_engine();
        Resolution::Search { engine: engine.id.clone(), url: engine.search_url(q) }
    }
}

// ─── URL detection ──────────────────────────────────────────────────────────

/// Heuristic: does this omnibox input look like a URL/host (vs a search query)?
pub fn looks_like_url(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() || s.contains(char::is_whitespace) {
        return false;
    }
    // Explicit scheme or known pseudo-schemes.
    if s.contains("://") || s.starts_with("about:") || s.starts_with("file:") {
        return true;
    }
    // Host is everything before the first '/'; strip a :port.
    let host = s.split('/').next().unwrap_or(s);
    let host = host.rsplit_once(':').map_or(host, |(h, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) { h } else { host }
    });
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if is_ipv4(host) {
        return true;
    }
    // domain.tld with an alphabetic TLD ≥ 2 chars, all label chars valid.
    if let Some((domain, tld)) = host.rsplit_once('.') {
        let valid_chars = host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        let good_tld = tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic());
        if valid_chars && good_tld && !domain.is_empty() {
            return true;
        }
    }
    false
}

fn is_ipv4(host: &str) -> bool {
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4 && octets.iter().all(|o| o.parse::<u8>().is_ok())
}

/// Add `https://` if the input has no scheme.
pub fn normalize_url(s: &str) -> String {
    let s = s.trim();
    if s.contains("://") || s.starts_with("about:") || s.starts_with("file:") {
        s.to_string()
    } else {
        format!("https://{s}")
    }
}

// ─── Percent-encoding (query component, dependency-free) ─────────────────────

/// Percent-encode a query for safe placement in a URL query value. Leaves the
/// RFC 3986 unreserved set intact; everything else → %XX (spaces → %20).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 0xf));
            }
        }
    }
    out
}

fn hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SearchConfig {
        SearchConfig::with_builtin_defaults()
    }

    #[test]
    fn plain_query_searches_with_default() {
        let r = cfg().resolve("how to write a tauri plugin");
        assert!(matches!(&r, Resolution::Search { engine, .. } if engine == "ddg"));
        assert_eq!(r.url(), "https://duckduckgo.com/?q=how%20to%20write%20a%20tauri%20plugin");
    }

    #[test]
    fn urls_and_hosts_navigate() {
        for input in ["rust-lang.org", "https://docs.rs/tauri", "localhost:1420", "192.168.0.1", "github.com/flux/flux"] {
            assert!(matches!(cfg().resolve(input), Resolution::Navigate { .. }), "{input} should navigate");
        }
    }

    #[test]
    fn single_word_and_numbers_search_not_navigate() {
        for input in ["rust", "3.14", "what is 2+2"] {
            assert!(matches!(cfg().resolve(input), Resolution::Search { .. }), "{input} should search");
        }
    }

    #[test]
    fn bang_and_keyword_route_to_engine() {
        let c = cfg();
        assert!(matches!(c.resolve("!g rust traits"), Resolution::Search { engine, .. } if engine == "google"));
        assert!(matches!(c.resolve("g rust traits"), Resolution::Search { engine, .. } if engine == "google"));
        // A bare keyword with no query is NOT hijacked — `g.co` is a real host.
        assert!(matches!(c.resolve("g.co"), Resolution::Navigate { .. }));
    }

    #[test]
    fn bare_host_is_normalized_with_https() {
        assert_eq!(cfg().resolve("example.com").url(), "https://example.com");
    }

    #[test]
    fn custom_engine_can_be_default() {
        let mut c = cfg();
        c.engines.push(SearchEngine {
            id: "flux".into(),
            name: "Flux Search".into(),
            keyword: Some("f".into()),
            search_template: "https://search.flux.dev/q/{query}".into(),
            suggest_template: None,
        });
        c.default_id = "flux".into();
        let r = c.resolve("vector databases");
        assert_eq!(r.url(), "https://search.flux.dev/q/vector%20databases");
    }
}
