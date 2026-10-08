//! Pillar 3 explainers (ADR 0013, M5) — turn signals Flux already has into
//! plain language. Low-risk by construction: these *describe*, they never block,
//! decide, or act.
//!
//! **The numbers are computed in Rust; the model only phrases them.** A local
//! 4B model asked to "summarize this tracker graph" will happily invent a
//! plausible-looking count. So every figure in a narrative comes from a
//! deterministic aggregation, the model is handed those figures as facts, and if
//! it's unavailable (or wanders) the deterministic sentence is what ships. The
//! explainer is therefore always available and always numerically honest.

use crate::trackers::TrackerGraph;

/// Phrases that mark a cookie / consent banner. Deterministic detection so the
/// model is never woken just to notice a banner exists.
const CONSENT_PHRASES: &[&str] = &[
    "we use cookies",
    "uses cookies",
    "accept all cookies",
    "accept cookies",
    "your privacy choices",
    "manage preferences",
    "manage your preferences",
    "cookie preferences",
    "cookie policy",
    "legitimate interest",
    "our partners",
    "consent to the use of cookies",
];

/// The genuine "refuse" controls, in preference order (most explicitly total
/// first). **Rust owns this list** — it is injected into `consent.js`, so the
/// model can never choose what gets clicked (read ≠ act, ADR 0013 Pillar 0).
/// Lowercase; matched against a control's accessible name.
pub const REJECT_TERMS: &[&str] = &[
    "reject all",
    "reject all cookies",
    "decline all",
    "refuse all",
    "deny all",
    "only necessary",
    "necessary only",
    "use necessary cookies only",
    "essential only",
    "only essential",
    "strictly necessary",
    "continue without accepting",
    "reject",
    "decline",
];

/// What a banner *says*, as opposed to the link names a site footer carries on
/// every page ("Cookie Policy · Your Privacy Choices · Cookie Preferences").
/// A match needs one of these, so a footer alone never reads as a banner.
const CONSENT_VOICE: &[&str] = &[
    "we use cookies",
    "uses cookies",
    "accept all",
    "accept cookies",
    "allow all",
    "reject all",
    "legitimate interest",
    "consent to the use of cookies",
];

/// Does this page text look like it carries a consent banner? Requires two
/// distinct phrases so an article *about* cookies doesn't trip it, one of them
/// in a banner's own voice so a footer's link list doesn't either.
pub fn looks_like_consent(text: &str) -> bool {
    let t = text.to_lowercase();
    CONSENT_VOICE.iter().any(|p| t.contains(p))
        && CONSENT_PHRASES.iter().filter(|p| t.contains(**p)).count() >= 2
}

/// The injectable reject script, with the Rust-owned vocabulary baked in.
pub fn reject_js() -> String {
    let terms = serde_json::to_string(REJECT_TERMS).unwrap_or_else(|_| "[]".into());
    include_str!("../../assets/consent.js").replace("__FLUX_REJECT_TERMS__", &terms)
}

/// Deterministic aggregation of a tracker graph — the facts a narrative may use.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackerFacts {
    pub sites: usize,
    pub third_parties: usize,
    pub requests: u32,
    pub blocked: u32,
    /// The third party present on the most sites, with that site count.
    pub top_hub: Option<(String, u32)>,
}

/// Aggregate the graph. Pure — no model, no I/O.
pub fn tracker_facts(graph: &TrackerGraph) -> TrackerFacts {
    let sites = graph.nodes.iter().filter(|n| n.kind == "site").count();
    let thirds: Vec<_> = graph.nodes.iter().filter(|n| n.kind == "third").collect();
    // Sum the edges: each (first party, third party) pair once, with both its
    // counts. Not the site nodes: `TrackerStore::graph` tallies `blocked` only on
    // the third-party end, so every site's `blocked` is 0.
    let requests = graph
        .edges
        .iter()
        .fold(0u32, |a, e| a.saturating_add(e.requests));
    let blocked = graph
        .edges
        .iter()
        .fold(0u32, |a, e| a.saturating_add(e.blocked));
    // The hub that reaches the most first parties — the one that can actually
    // stitch your browsing together, which is the point worth making.
    let top_hub = thirds
        .iter()
        .max_by_key(|n| (n.degree, n.requests))
        .filter(|n| n.degree > 0)
        .map(|n| (n.id.clone(), n.degree));
    TrackerFacts {
        sites,
        third_parties: thirds.len(),
        requests,
        blocked,
        top_hub,
    }
}

/// The always-available sentence, built from the facts alone. This is the
/// fallback *and* the source of truth the model is asked to rephrase.
pub fn tracker_sentence(f: &TrackerFacts) -> String {
    if f.sites == 0 || f.third_parties == 0 {
        return "No third-party tracking recorded yet — browse a little and this fills in.".into();
    }
    let pct = if f.requests > 0 {
        (f.blocked as f64 / f.requests as f64 * 100.0).round() as u32
    } else {
        0
    };
    let mut s = format!(
        "Across {} site{} you visited, {} third-part{} were contacted. \
         Flux blocked {} of {} requests ({pct}%).",
        f.sites,
        if f.sites == 1 { "" } else { "s" },
        f.third_parties,
        if f.third_parties == 1 { "y" } else { "ies" },
        f.blocked,
        f.requests,
    );
    if let Some((host, degree)) = &f.top_hub {
        if *degree > 1 {
            s.push_str(&format!(
                " {host} appeared on {degree} of them, so it could link those visits together."
            ));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trackers::{TrackerEdge, TrackerNode};

    fn node(id: &str, kind: &str, requests: u32, blocked: u32, degree: u32) -> TrackerNode {
        TrackerNode {
            id: id.into(),
            kind: kind.into(),
            requests,
            blocked,
            degree,
        }
    }

    fn graph() -> TrackerGraph {
        TrackerGraph {
            nodes: vec![
                node("bbc.com", "site", 40, 30, 2),
                node("news.example", "site", 60, 45, 2),
                node("google-analytics.com", "third", 50, 40, 2),
                node("ads.example", "third", 20, 15, 1),
            ],
            edges: vec![edge(0, 2, 40, 30), edge(1, 2, 40, 30), edge(1, 3, 20, 15)],
        }
    }

    fn edge(source: usize, target: usize, requests: u32, blocked: u32) -> TrackerEdge {
        TrackerEdge {
            source,
            target,
            requests,
            blocked,
        }
    }

    #[test]
    fn consent_detection_needs_two_signals() {
        assert!(looks_like_consent(
            "We use cookies and similar technologies. Accept all cookies or manage preferences."
        ));
        // An article merely discussing cookies must not trip the banner UI.
        assert!(!looks_like_consent(
            "This post explains how a cookie policy is written and why it matters."
        ));
        assert!(!looks_like_consent("Nothing to do with consent at all."));
        // A footer's link list names the policy on every page but never asks.
        assert!(!looks_like_consent(
            "Privacy Policy · Cookie Policy · Your Privacy Choices · Cookie Preferences"
        ));
        // IAB TCF banners ("We and our partners … legitimate interest") still match.
        assert!(looks_like_consent(
            "We and our partners store and access information. Some rely on legitimate interest."
        ));
    }

    #[test]
    fn reject_js_bakes_in_the_rust_owned_vocabulary() {
        let js = reject_js();
        assert!(!js.contains("__FLUX_REJECT_TERMS__"), "placeholder substituted");
        assert!(js.contains("\"reject all\""), "terms are baked in as JSON");
        // The click vocabulary must never be model-supplied — it ships in Rust.
        assert!(REJECT_TERMS.iter().all(|t| js.contains(t)));
    }

    #[test]
    fn facts_are_aggregated_from_first_parties_only() {
        let f = tracker_facts(&graph());
        assert_eq!(f.sites, 2);
        assert_eq!(f.third_parties, 2);
        // Requests/blocked sum the edges — each (site, third party) pair once,
        // so the same traffic isn't counted from both ends.
        assert_eq!(f.requests, 100);
        assert_eq!(f.blocked, 75);
        assert_eq!(f.top_hub, Some(("google-analytics.com".into(), 2)));
    }

    #[test]
    fn facts_report_what_the_real_graph_blocked() {
        // The producer puts `blocked` on the third-party node only, so summing
        // site nodes said "Flux blocked 0 of N" however much shields blocked.
        let store = crate::trackers::TrackerStore::default();
        for i in 0..4 {
            store.record("https://bbc.com/news", "https://ads.example/px", i < 3);
        }
        store.record("https://news.example/", "https://ads.example/px", false);
        let f = tracker_facts(&store.graph());
        assert_eq!((f.requests, f.blocked), (5, 3));
    }

    #[test]
    fn sentence_states_real_numbers_and_the_hub() {
        let s = tracker_sentence(&tracker_facts(&graph()));
        assert!(s.contains("2 sites"));
        assert!(s.contains("2 third-parties"));
        assert!(s.contains("blocked 75 of 100 requests (75%)"));
        assert!(s.contains("google-analytics.com appeared on 2"));
    }

    #[test]
    fn empty_graph_says_so_instead_of_dividing_by_zero() {
        let empty = TrackerGraph { nodes: vec![], edges: vec![] };
        let f = tracker_facts(&empty);
        assert_eq!(f.requests, 0);
        assert!(tracker_sentence(&f).contains("No third-party tracking recorded"));
    }

    #[test]
    fn singular_grammar_and_lone_hub_are_handled() {
        let g = TrackerGraph {
            nodes: vec![
                node("bbc.com", "site", 10, 0, 1),
                node("ads.example", "third", 10, 0, 1),
            ],
            edges: vec![],
        };
        let s = tracker_sentence(&tracker_facts(&g));
        assert!(s.contains("1 site "), "singular: {s}");
        assert!(s.contains("1 third-party "), "singular: {s}");
        // degree 1 → no "could link those visits" claim (it links nothing).
        assert!(!s.contains("link those visits"), "{s}");
    }
}
