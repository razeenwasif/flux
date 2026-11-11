//! Each page webview's committed URL (audit S8).
//!
//! `Webview::url()` is WKWebView's `URL`, which moves to a navigation's target
//! as soon as it starts, while the old document is still the one running
//! script (hibernate.rs warns about the same thing). So a page could start a
//! navigation to `https://bank.example:81/` (a port that hangs) and then ask
//! for a password fill, and every check that read `url()` saw the bank.
//!
//! Wry's `PageLoadEvent::Started` fires when a navigation commits, on every
//! backend. Recording its URL per webview label gives the document that is
//! actually running; [`url_of`] answers only while the live URL is still on
//! that document's origin (same-origin moves such as `pushState` keep their
//! current path), and refuses while a move to another origin is under way.

use std::sync::OnceLock;

use dashmap::DashMap;

fn map() -> &'static DashMap<String, tauri::Url> {
    static M: OnceLock<DashMap<String, tauri::Url>> = OnceLock::new();
    M.get_or_init(DashMap::new)
}

/// A navigation committed in `label`: its document is now `url`'s.
pub fn note(label: &str, url: &tauri::Url) {
    map().insert(label.to_string(), url.clone());
}

/// The webview is gone or unloaded.
pub fn forget(label: &str) {
    map().remove(label);
}

/// The URL of the document `webview` is running, for a check that decides
/// what the page may have. An error while it has no committed page yet or is
/// moving to another origin.
pub fn url_of(webview: &tauri::Webview) -> Result<tauri::Url, String> {
    let committed = map()
        .get(webview.label())
        .map(|u| u.clone())
        .ok_or("the page hasn't finished opening")?;
    let live = webview.url().map_err(|e| e.to_string())?;
    check(&committed, live)
}

fn check(committed: &tauri::Url, live: tauri::Url) -> Result<tauri::Url, String> {
    if live.origin() != committed.origin() {
        return Err("the page is moving to another site; try again once it has loaded".into());
    }
    Ok(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn a_pending_move_to_another_origin_is_refused() {
        let at = u("https://evil.example/login");
        // WKWebView's URL already shows the target; the evil page still runs.
        assert!(check(&at, u("https://bank.example:81/")).is_err());
        // Same host, other port: another origin too.
        assert!(check(&u("https://bank.example/"), u("https://bank.example:81/")).is_err());
        // pushState on the same origin keeps the live path.
        let ok = check(&u("https://bank.example/a"), u("https://bank.example/b?x")).unwrap();
        assert_eq!(ok.path(), "/b");
    }

    #[test]
    fn notes_are_per_label_and_forgotten() {
        note("tab-990001", &u("https://a.example/"));
        assert_eq!(
            map().get("tab-990001").unwrap().host_str(),
            Some("a.example")
        );
        forget("tab-990001");
        assert!(map().get("tab-990001").is_none());
    }
}
