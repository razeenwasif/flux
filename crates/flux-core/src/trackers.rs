//! Tracker graph (BACKLOG #129) — privacy made visual.
//!
//! The request interceptor (#91) sees every subresource request and its source
//! page. Here we record, per first-party site, which third-party domains it talks
//! to (and how many were blocked by shields/lean), then hand the UI a node/edge
//! graph: sites and third parties, with ubiquitous trackers surfacing as
//! high-degree hubs. In-memory + live — it fills as you browse, and `tracker_clear`
//! resets it. Nothing is persisted or sent anywhere.

use std::collections::{HashMap, HashSet};

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

/// Cap edges handed to the renderer (keeps the force layout legible + fast).
const MAX_EDGES: usize = 300;

#[derive(Default, Clone, Copy)]
struct Counts {
    requests: u32,
    blocked: u32,
}

#[derive(Default)]
pub struct TrackerStore {
    /// first-party registrable domain → (third-party domain → counts).
    sites: DashMap<String, Mutex<HashMap<String, Counts>>>,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct TrackerNode {
    pub id: String,
    /// "site" (a first party you visited) or "third" (a third party it contacted).
    pub kind: String,
    pub requests: u32,
    pub blocked: u32,
    /// Number of incident edges (a third party touched by many sites = a hub).
    pub degree: u32,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct TrackerEdge {
    pub source: usize,
    pub target: usize,
    pub requests: u32,
    pub blocked: u32,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct TrackerGraph {
    pub nodes: Vec<TrackerNode>,
    pub edges: Vec<TrackerEdge>,
}

impl TrackerStore {
    /// Record one request from `source` (the page) to `url`, and whether it was
    /// blocked. Cheap + lock-light; ignores first-party + non-host requests.
    pub fn record(&self, source: &str, url: &str, blocked: bool) {
        let (Some(first), Some(third)) = (registrable(source), registrable(url)) else {
            return;
        };
        if first == third {
            return; // first-party request — not interesting for the tracker graph
        }
        let inner = self.sites.entry(first).or_default();
        let mut map = inner.lock();
        let c = map.entry(third).or_default();
        c.requests = c.requests.saturating_add(1);
        if blocked {
            c.blocked = c.blocked.saturating_add(1);
        }
    }

    pub fn clear(&self) {
        self.sites.clear();
    }

    pub fn graph(&self) -> TrackerGraph {
        struct Raw {
            first: String,
            third: String,
            requests: u32,
            blocked: u32,
        }
        let site_keys: HashSet<String> = self.sites.iter().map(|s| s.key().clone()).collect();
        let mut raw: Vec<Raw> = Vec::new();
        for site in self.sites.iter() {
            let first = site.key().clone();
            for (third, c) in site.value().lock().iter() {
                raw.push(Raw {
                    first: first.clone(),
                    third: third.clone(),
                    requests: c.requests,
                    blocked: c.blocked,
                });
            }
        }
        raw.sort_by(|a, b| b.requests.cmp(&a.requests));
        raw.truncate(MAX_EDGES);

        let mut idx: HashMap<String, usize> = HashMap::new();
        let mut nodes: Vec<TrackerNode> = Vec::new();
        let mut edges: Vec<TrackerEdge> = Vec::new();
        for r in &raw {
            let si = node_idx(&r.first, &mut nodes, &mut idx, &site_keys);
            let ti = node_idx(&r.third, &mut nodes, &mut idx, &site_keys);
            nodes[si].requests = nodes[si].requests.saturating_add(r.requests);
            nodes[si].degree += 1;
            nodes[ti].requests = nodes[ti].requests.saturating_add(r.requests);
            nodes[ti].blocked = nodes[ti].blocked.saturating_add(r.blocked);
            nodes[ti].degree += 1;
            edges.push(TrackerEdge {
                source: si,
                target: ti,
                requests: r.requests,
                blocked: r.blocked,
            });
        }
        TrackerGraph { nodes, edges }
    }
}

fn node_idx(
    id: &str,
    nodes: &mut Vec<TrackerNode>,
    idx: &mut HashMap<String, usize>,
    sites: &HashSet<String>,
) -> usize {
    if let Some(&i) = idx.get(id) {
        return i;
    }
    let i = nodes.len();
    idx.insert(id.to_string(), i);
    nodes.push(TrackerNode {
        id: id.to_string(),
        kind: if sites.contains(id) { "site" } else { "third" }.to_string(),
        requests: 0,
        blocked: 0,
        degree: 0,
    });
    i
}

/// URL/host → registrable domain (last two labels), `None` for hostless schemes,
/// IPs, localhost, or single-label hosts. Crude (no Public Suffix List) but good
/// enough to collapse `ssl.google-analytics.com` → `google-analytics.com`.
fn registrable(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host = authority
        .rsplit('@')
        .next()?
        .split(':')
        .next()?
        .trim_start_matches("www.");
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    // Skip bare IPv4.
    if host.split('.').all(|l| l.parse::<u8>().is_ok()) {
        return None;
    }
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return None;
    }
    Some(labels[labels.len() - 2..].join("."))
}

#[tauri::command]
pub fn tracker_graph(store: State<'_, TrackerStore>) -> TrackerGraph {
    store.graph()
}

#[tauri::command]
pub fn tracker_clear(store: State<'_, TrackerStore>) {
    store.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrable_collapses_subdomains() {
        assert_eq!(
            registrable("https://ssl.google-analytics.com/ga.js").as_deref(),
            Some("google-analytics.com")
        );
        assert_eq!(
            registrable("https://www.bbc.com/news").as_deref(),
            Some("bbc.com")
        );
        assert_eq!(registrable("about:blank"), None);
        assert_eq!(registrable("https://localhost:3000/x"), None);
        assert_eq!(registrable("https://127.0.0.1/x"), None);
    }

    #[test]
    fn graph_links_sites_to_third_parties() {
        let s = TrackerStore::default();
        s.record(
            "https://news.com/a",
            "https://google-analytics.com/ga.js",
            true,
        );
        s.record(
            "https://news.com/b",
            "https://google-analytics.com/ga.js",
            true,
        );
        s.record(
            "https://shop.com/x",
            "https://google-analytics.com/c.js",
            true,
        );
        s.record("https://news.com/a", "https://news.com/app.js", false); // first-party → ignored
        let g = s.graph();
        // 3 nodes: news.com, shop.com (sites) + google-analytics.com (third hub).
        assert_eq!(g.nodes.len(), 3);
        let hub = g
            .nodes
            .iter()
            .find(|n| n.id == "google-analytics.com")
            .unwrap();
        assert_eq!(hub.kind, "third");
        assert_eq!(hub.degree, 2); // contacted by two sites
        assert!(g
            .nodes
            .iter()
            .any(|n| n.id == "news.com" && n.kind == "site"));
        assert_eq!(g.edges.len(), 2);
    }
}
