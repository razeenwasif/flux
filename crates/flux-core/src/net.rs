//! One network mode per tab (BACKLOG #209; audit S16, S18, S33).
//!
//! A tab browses in one of three modes, and everything Flux does on a tab's
//! behalf has to agree with it:
//!
//! - **Direct**: an ordinary tab. Its pages may be kept (history, the Trail)
//!   and Flux may fetch things for it from this machine.
//! - **Private**: nothing it shows is kept or sent on.
//! - **Tor**: private, and its traffic goes through Tor. Flux itself must not
//!   contact the tab's site at all, because Flux's own requests don't go
//!   through that tab's proxy: they would leave from this machine's address
//!   and tell the site who is behind the Tor tab.
//!
//! Before this, each feature read `tab.private` and `tab.tor` for itself and
//! decided, and a feature that forgot to (or knew only `private`) leaked. Two
//! things live here so that doesn't depend on memory:
//!
//! - [`TabNet`], the mode as one value with the questions features ask of it.
//! - [`check_core_fetch`], which every fetch the core makes for a URL someone
//!   else chose goes through. It refuses onion addresses outright (the system
//!   resolver can't answer them, and asking it leaks the name) and any site
//!   that is open in a Tor tab right now.
//!
//! `tests/net_guard.rs` reads the source and fails when a file starts making
//! network requests without saying which kind it is, so a new fetch can't skip
//! the question.

use std::sync::LazyLock;

use dashmap::DashMap;

use crate::state::{FluxState, TabId, TabMeta};

/// The network identity a tab browses with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TabNet {
    Direct,
    Private,
    Tor,
}

impl TabNet {
    pub fn of(tab: &TabMeta) -> Self {
        if tab.tor {
            TabNet::Tor
        } else if tab.private {
            TabNet::Private
        } else {
            TabNet::Direct
        }
    }

    /// The mode of tab `id`, if it's open.
    pub fn of_tab(state: &FluxState, id: TabId) -> Option<Self> {
        state.tabs.get(&id).map(|t| Self::of(&t))
    }

    /// Whether what the tab shows stays in the tab: not written to history or
    /// the Trail, not handed to a model or another app, not fetched again by
    /// the chrome.
    pub fn off_record(self) -> bool {
        self != TabNet::Direct
    }

    /// What to call it when refusing something.
    pub fn name(self) -> &'static str {
        match self {
            TabNet::Direct => "an ordinary tab",
            TabNet::Private => "a private tab",
            TabNet::Tor => "a Tor tab",
        }
    }
}

/// The host each Tor tab is on, so the core can tell when it's about to
/// contact one of them itself.
static TOR_HOSTS: LazyLock<DashMap<TabId, String>> = LazyLock::new(DashMap::new);

/// A Tor tab committed a page at `url`.
pub fn note_tor_page(tab: TabId, url: &tauri::Url) {
    // Stored the way `host_of` reads a URL, so the two always compare equal.
    match url.host_str().map(|h| h.trim_end_matches('.')) {
        Some(host) if !host.is_empty() => {
            TOR_HOSTS.insert(tab, host.to_ascii_lowercase());
        }
        _ => {
            TOR_HOSTS.remove(&tab);
        }
    }
}

/// The tab closed, or its page went away.
pub fn forget_tab(tab: TabId) {
    TOR_HOSTS.remove(&tab);
}

/// The host of an http(s) or webcal URL, lowercased, without userinfo, port or
/// a trailing dot. Parsed the way the HTTP client parses it, so the host that is
/// checked is the host that would be contacted.
fn host_of(url: &str) -> Option<String> {
    let url = url.trim();
    // webcal:// is http(s) under another name (calendar.rs fetches it as https).
    let web = match url.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("webcal") => {
            format!("https://{rest}")
        }
        _ => url.to_string(),
    };
    let parsed = tauri::Url::parse(&web).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// `a` and `b` are the same site as far as an observer is concerned: the same
/// host, or one a subdomain of the other (they usually share a server, a
/// certificate and logs).
fn same_site(a: &str, b: &str) -> bool {
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

/// May the core fetch `url` itself, from this machine's address, outside any
/// tab's webview? Call it before every request to a URL that a page, a tab or
/// the user's typing chose.
///
/// Refused: an onion address, and a site that is open in a Tor tab now. Either
/// request would connect the user's own address to something they are visiting
/// through Tor.
pub fn check_core_fetch(url: &str) -> Result<(), String> {
    let Some(host) = host_of(url) else {
        return Ok(()); // not a network URL; the caller's own scheme check decides
    };
    if host == "onion" || host.ends_with(".onion") {
        return Err(
            "that's an onion address, which only opens in a Tor tab; Flux doesn't look it up itself"
                .into(),
        );
    }
    if TOR_HOSTS.iter().any(|tor| same_site(&host, tor.value())) {
        return Err(format!(
            "{host} is open in a Tor tab, so Flux won't contact it from your own address"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(private: bool, tor: bool) -> TabMeta {
        TabMeta {
            id: 1,
            kind: crate::state::TabKind::Browser,
            url: "https://example.com/".into(),
            title: String::new(),
            pinned: false,
            cluster: None,
            group: None,
            folder: None,
            custom_title: None,
            workspace: 1,
            private,
            tor,
            container: 0,
        }
    }

    #[test]
    fn a_tab_has_one_mode_and_tor_outranks_private() {
        assert_eq!(TabNet::of(&tab(false, false)), TabNet::Direct);
        assert_eq!(TabNet::of(&tab(true, false)), TabNet::Private);
        assert_eq!(TabNet::of(&tab(true, true)), TabNet::Tor);
        // A Tor tab that somehow lost its private flag is still a Tor tab.
        assert_eq!(TabNet::of(&tab(false, true)), TabNet::Tor);
        assert!(!TabNet::Direct.off_record());
        assert!(TabNet::Private.off_record());
        assert!(TabNet::Tor.off_record());
    }

    #[test]
    fn hosts_are_read_without_port_userinfo_or_case() {
        assert_eq!(
            host_of("https://Example.com:8443/a?b#c").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            host_of("http://user:pw@example.com/").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            host_of("webcal://cal.example.com./feed.ics").as_deref(),
            Some("cal.example.com")
        );
        assert_eq!(host_of("https://[::1]:3000/").as_deref(), Some("[::1]"));
        assert_eq!(host_of("file:///etc/hosts"), None);
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn onion_addresses_are_never_fetched_by_the_core() {
        assert!(check_core_fetch("http://exampleonionaddressxyz.onion/inbox").is_err());
        assert!(check_core_fetch("https://www.exampleonionaddressxyz.ONION:8080/").is_err());
        // Only the suffix counts.
        assert!(check_core_fetch("https://onion.example.com/").is_ok());
        assert!(check_core_fetch("https://example.com/x.onion").is_ok());
    }

    #[test]
    fn a_site_open_in_a_tor_tab_is_not_fetched_until_the_tab_leaves_it() {
        // Tab ids no other test uses: the registry is shared by the process.
        let (a, b) = (9_000_001, 9_000_002);
        note_tor_page(a, &"https://news.example.org/story".parse().unwrap());
        assert!(check_core_fetch("https://news.example.org/feed.xml").is_err());
        // Its parent and its subdomains are the same site to an observer.
        assert!(check_core_fetch("https://example.org/favicon.ico").is_err());
        assert!(check_core_fetch("https://cdn.news.example.org/a.pdf").is_err());
        assert!(check_core_fetch("https://example.net/").is_ok());
        assert!(check_core_fetch("https://notexample.org/").is_ok());
        // However the address is written, it's the same host.
        assert!(check_core_fetch("https://NEWS.example.org./feed.xml").is_err());
        assert!(check_core_fetch("https://user@news.example.org:8443/").is_err());
        assert!(check_core_fetch("webcal://news.example.org/cal.ics").is_err());
        assert!(check_core_fetch("https://news.example.org\\@example.net/").is_err());
        // Another Tor tab on the same site keeps it refused after the first leaves.
        note_tor_page(b, &"https://example.org/".parse().unwrap());
        note_tor_page(a, &"https://elsewhere.example/".parse().unwrap());
        assert!(check_core_fetch("https://news.example.org/feed.xml").is_err());
        forget_tab(b);
        assert!(check_core_fetch("https://news.example.org/feed.xml").is_ok());
        forget_tab(a);
        assert!(check_core_fetch("https://elsewhere.example/").is_ok());
        // A Tor tab on a name written with its trailing dot is the same site.
        note_tor_page(a, &"https://dotted.example./".parse().unwrap());
        assert!(check_core_fetch("https://dotted.example/").is_err());
        forget_tab(a);
    }
}
