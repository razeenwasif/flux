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
    let requests = graph.nodes.iter().filter(|n| n.kind == "site").map(|n| n.requests).sum();
    let blocked = graph.nodes.iter().filter(|n| n.kind == "site").map(|n| n.blocked).sum();
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
            edges: vec![TrackerEdge {
                source: 0,
                target: 2,
                requests: 25,
                blocked: 20,
            }],
        }
    }

    #[test]
    fn facts_are_aggregated_from_first_parties_only() {
        let f = tracker_facts(&graph());
        assert_eq!(f.sites, 2);
        assert_eq!(f.third_parties, 2);
        // Requests/blocked sum the SITE nodes — counting thirds too would
        // double-count the same traffic from the other end of the edge.
        assert_eq!(f.requests, 100);
        assert_eq!(f.blocked, 75);
        assert_eq!(f.top_hub, Some(("google-analytics.com".into(), 2)));
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
