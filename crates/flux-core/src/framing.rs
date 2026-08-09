//! Can this site be embedded in a pane? (#180)
//!
//! An app pane is an iframe, and a site that refuses framing produces the worst
//! possible failure: the browser fires `load` as normal and leaves a blank
//! rectangle. No error, no event, and the console message lands somewhere the
//! user never looks.
//!
//! The obvious frontend trick — a blocked frame stays on the initial
//! `about:blank`, which is same-origin and therefore readable — **does not
//! work**. Measured against Chromium: a frame refused by `X-Frame-Options`
//! reports as cross-origin exactly like a loaded one, so the check said "loaded"
//! for a site that had plainly been refused.
//!
//! So don't infer it — ask. One `HEAD` before the pane opens reads the same two
//! headers the browser will act on, which is deterministic, testable without a
//! browser, and lets the pane show the fallback immediately rather than flashing
//! an empty window first.

use serde::Serialize;

/// Whether `url` may be framed by Flux, and why not when it may not.
#[derive(Serialize, Debug, Clone, Default, PartialEq, specta::Type)]
pub struct FramePolicy {
    /// Safe to put in an iframe.
    pub framable: bool,
    /// The header that refused, for a message that names the thing to change.
    /// Empty when `framable`, or when the site couldn't be reached.
    pub reason: String,
}

impl FramePolicy {
    fn ok() -> Self {
        FramePolicy {
            framable: true,
            reason: String::new(),
        }
    }
    fn refused(reason: impl Into<String>) -> Self {
        FramePolicy {
            framable: false,
            reason: reason.into(),
        }
    }
}

/// Decide from the two headers that govern framing.
///
/// `frame-ancestors` wins where both are present — that's the spec, and it's why
/// this takes both rather than checking `X-Frame-Options` first and returning.
///
/// Flux frames from its own app origin, which is never the site's origin, so
/// `SAMEORIGIN` and `'self'` are refusals here even though they are permissive
/// for the site itself. The one thing treated as permission is an explicit
/// wildcard.
pub fn decide(x_frame_options: Option<&str>, csp: Option<&str>) -> FramePolicy {
    if let Some(csp) = csp {
        if let Some(list) = frame_ancestors(csp) {
            let list = list.trim();
            if list.is_empty() || list.eq_ignore_ascii_case("'none'") {
                return FramePolicy::refused("Content-Security-Policy: frame-ancestors 'none'");
            }
            // A wildcard is the only blanket yes. Anything else is a list of
            // origins that won't include a desktop app's.
            if list.split_whitespace().any(|t| t == "*") {
                return FramePolicy::ok();
            }
            return FramePolicy::refused(format!(
                "Content-Security-Policy: frame-ancestors {list}"
            ));
        }
    }
    match x_frame_options.map(str::trim) {
        // Absent, blank, or an explicit blanket yes.
        None | Some("") => FramePolicy::ok(),
        Some(v) if v.eq_ignore_ascii_case("allowall") => FramePolicy::ok(),
        Some(v) => FramePolicy::refused(format!("X-Frame-Options: {}", v.to_uppercase())),
    }
}

/// Pull the `frame-ancestors` directive out of a CSP header, if present.
///
/// Returns `Some("")` for a bare `frame-ancestors` with no sources, which is a
/// refusal — distinct from `None`, which means the directive isn't there at all
/// and `X-Frame-Options` still gets a say.
fn frame_ancestors(csp: &str) -> Option<String> {
    csp.split(';')
        .map(str::trim)
        .find(|d| {
            d.split_whitespace()
                .next()
                .map(|n| n.eq_ignore_ascii_case("frame-ancestors"))
                .unwrap_or(false)
        })
        .map(|d| d.split_whitespace().skip(1).collect::<Vec<_>>().join(" "))
}

/// Ask the site whether it can be framed.
///
/// A site we can't reach is reported as **framable**: the pane then tries, and
/// the user sees the site's own failure rather than a message from us claiming
/// a refusal that may not exist. Guessing "refused" on a flaky network would
/// route a working app to the fallback for no reason.
#[tauri::command]
pub async fn frame_policy(url: String) -> FramePolicy {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(5))
            .timeout_read(std::time::Duration::from_secs(5))
            .build();
        // HEAD, because only the headers matter — no reason to pull the document.
        let Ok(resp) = agent.head(&url).call() else {
            return FramePolicy::ok();
        };
        decide(
            resp.header("x-frame-options"),
            resp.header("content-security-policy"),
        )
    })
    .await
    .unwrap_or_else(|_| FramePolicy::ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_headers_means_framable() {
        assert!(decide(None, None).framable);
        assert!(decide(Some(""), None).framable);
    }

    #[test]
    fn sameorigin_refuses_because_flux_is_not_that_origin() {
        // The case that started this: Firebase Hosting's default, which reads as
        // permissive but never includes a desktop app's origin.
        let p = decide(Some("SAMEORIGIN"), None);
        assert!(!p.framable);
        assert!(p.reason.contains("X-Frame-Options"), "{}", p.reason);
        assert!(p.reason.contains("SAMEORIGIN"), "{}", p.reason);
        // Case and padding vary between servers.
        assert!(!decide(Some("  sameorigin "), None).framable);
        assert!(!decide(Some("DENY"), None).framable);
    }

    #[test]
    fn allowall_is_the_explicit_yes() {
        assert!(decide(Some("ALLOWALL"), None).framable);
        assert!(decide(Some("allowall"), None).framable);
    }

    #[test]
    fn frame_ancestors_overrides_x_frame_options() {
        // Per spec, and the reason `decide` takes both rather than short-circuiting.
        assert!(decide(Some("DENY"), Some("frame-ancestors *")).framable);
        assert!(!decide(Some("ALLOWALL"), Some("frame-ancestors 'none'")).framable);
    }

    #[test]
    fn reads_frame_ancestors_out_of_a_full_policy() {
        let csp = "default-src 'self'; script-src 'self' cdn.example.com; frame-ancestors 'self'; img-src *";
        let p = decide(None, Some(csp));
        assert!(!p.framable, "'self' is not us");
        assert!(p.reason.contains("frame-ancestors 'self'"), "{}", p.reason);

        // A directive that isn't there leaves the decision to X-Frame-Options.
        assert!(decide(None, Some("default-src 'self'; img-src *")).framable);
        assert!(!decide(Some("DENY"), Some("default-src 'self'")).framable);
    }

    #[test]
    fn a_bare_or_none_frame_ancestors_refuses() {
        assert!(!decide(None, Some("frame-ancestors")).framable);
        assert!(!decide(None, Some("frame-ancestors 'none'")).framable);
        assert!(!decide(None, Some("frame-ancestors 'NONE'")).framable);
    }

    #[test]
    fn a_wildcard_inside_a_list_is_still_permission() {
        assert!(decide(None, Some("frame-ancestors https://a.example *")).framable);
        // …but a list of real origins is not.
        assert!(
            !decide(
                None,
                Some("frame-ancestors https://a.example https://b.example")
            )
            .framable
        );
    }

    #[test]
    fn a_refusal_always_says_which_header_to_change() {
        for (xfo, csp) in [
            (Some("DENY"), None),
            (Some("SAMEORIGIN"), None),
            (None, Some("frame-ancestors 'self'")),
            (None, Some("frame-ancestors")),
        ] {
            let p = decide(xfo, csp);
            assert!(!p.framable);
            assert!(
                !p.reason.is_empty(),
                "a refusal with no reason leaves the user nothing to act on"
            );
        }
    }
}
