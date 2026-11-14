//! Every file in the core that makes a network request says which kind it is
//! (BACKLOG #209, the Flux Hardening Plan's Layer 2).
//!
//! A request Flux makes itself leaves from this machine's address, outside any
//! tab's proxy. For a URL that a page, a tab or the user's typing chose, that
//! can tell a site who is behind a Tor tab, so those go through
//! `net::check_core_fetch` first. A request to a fixed place (a service the user
//! set up, a local helper, Flux's own lists) has no such question to ask.
//!
//! The audits kept finding fetches that nobody had asked the question of,
//! because nothing made a new one stand out. This test does: a source file that
//! starts using `ureq` or opening sockets fails here until it is put in one of
//! the two lists below, by someone who has looked at where its URLs come from.

use std::path::Path;

/// Files whose requests go to a URL someone else chose. Each must ask
/// `net::check_core_fetch` before it connects.
const GUARDED: &[&str] = &[
    "calendar.rs", // a calendar feed the user subscribes to
    "favicon.rs",  // the icon of whatever site a tab is on
    "feeds.rs",    // a feed the user subscribes to
    "framing.rs",  // whether a site refuses to be framed
    "pdf.rs",      // a PDF a page or the user opened
    "watch.rs",    // a page the user asked to watch
];

/// Files whose requests go to a fixed place, with what that place is.
const FIXED: &[(&str, &str)] = &[
    ("audioviz.rs", "its own audio helper on this machine"),
    ("currency.rs", "the exchange-rate service"),
    ("error.rs", "only names ureq's error type"),
    ("indexer.rs", "the embedding model's server"),
    (
        "kb.rs",
        "the embedding model's server and the user's own Scroll",
    ),
    ("lens.rs", "the vision model's server"),
    ("mail.rs", "the mail server the user set up"),
    ("netspeed.rs", "the speed test's host"),
    ("omni.rs", "the user's own Omni index"),
    ("phonelink.rs", "this Mac's own phone link"),
    (
        "proxy.rs",
        "builds clients for others; fetches nothing itself",
    ),
    (
        "search.rs",
        "the search engine's suggestions, skipped for private and Tor tabs",
    ),
    ("services.rs", "health checks of the user's own services"),
    ("shields.rs", "the filter lists"),
    ("spotify.rs", "Spotify's API"),
    ("tor.rs", "asks the local port whether it is Tor"),
    ("tts.rs", "the speech service the user set up"),
];

/// What marks a file as making network requests: building or using a `ureq`
/// client (directly, or through the proxy setting's `agent_builder`), or
/// opening a socket.
const NEEDLES: &[&str] = &["ureq::", "agent_builder(", "TcpStream::connect"];

fn sources(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).expect("read src").flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, base, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let name = path
                .strip_prefix(base)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/");
            out.push((name, std::fs::read_to_string(&path).expect("read source")));
        }
    }
}

#[test]
fn every_file_that_makes_requests_is_classified() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &src, &mut files);
    assert!(files.len() > 50, "found the core's sources");

    let mut problems = Vec::new();
    let mut networked = Vec::new();
    for (name, text) in &files {
        // net.rs is the guard itself, and talks about ureq without using it.
        if name == "net.rs" || !NEEDLES.iter().any(|n| text.contains(n)) {
            continue;
        }
        networked.push(name.as_str());
        let guarded = GUARDED.contains(&name.as_str());
        let fixed = FIXED.iter().any(|(f, _)| f == name);
        match (guarded, fixed) {
            (false, false) => problems.push(format!(
                "{name} makes network requests but is in neither list in tests/net_guard.rs. \
                 If a page, a tab or the user chooses its URL, call net::check_core_fetch first \
                 and add it to GUARDED; if it only talks to a fixed place, add it to FIXED and say where."
            )),
            (true, true) => problems.push(format!("{name} is in both lists")),
            (true, false) if !text.contains("net::check_core_fetch") => problems.push(format!(
                "{name} fetches URLs someone else chose but never calls net::check_core_fetch"
            )),
            _ => {}
        }
    }
    // The lists don't keep names that no longer apply.
    for name in GUARDED.iter().chain(FIXED.iter().map(|(f, _)| f)) {
        if !networked.contains(name) {
            problems.push(format!(
                "{name} is listed in tests/net_guard.rs but makes no network requests now: remove it"
            ));
        }
    }
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}
