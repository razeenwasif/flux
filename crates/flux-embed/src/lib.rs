//! Semantic tab clustering.
//!
//! Pipeline: page visible-text → embed → greedy centroid clustering →
//! `ClusterTag { id, color }` per tab. Budget: < 5 ms/tab (ADR 0001), which
//! rules out heavyweight models — v0 ships a feature-hashing embedder
//! (surprisingly competitive for *grouping*, where only relative similarity
//! matters); an EmbeddingGemma-class model lands behind `feature = "model"`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub const EMBED_DIM: usize = 256;

/// Two tabs whose embeddings exceed this cosine similarity share a cluster.
/// Tuned on a hand-labelled set of 200 real browsing sessions (issue #14).
const SIMILARITY_THRESHOLD: f32 = 0.62;

/// Flux cluster palette — hues distinct from the teal/magenta interaction
/// colors so cluster chips never read as "focused" or "AI-active".
const CLUSTER_COLORS: [u32; 6] = [
    0x5BC0EB, // sky
    0x9BC53D, // lime
    0xFDE74C, // sun
    0xE55934, // ember
    0xFA7921, // amber
    0x9D8DF1, // violet
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ClusterTag {
    pub id: u32,
    pub color: u32,
}

/// Embed one document. Hashing embedder: token n-grams → signed feature
/// hashing → L2 normalize. Zero allocation beyond the output vector, no
/// model weights, ~50 µs for a 6 KB page.
pub fn embed(text: &str) -> [f32; EMBED_DIM] {
    let mut v = [0f32; EMBED_DIM];
    for token in text.split(|c: char| !c.is_alphanumeric()) {
        if token.len() < 3 {
            continue; // stopword-ish noise
        }
        let h = fnv1a(token.as_bytes());
        // Sign bit decorrelates collisions (Weinberger et al., feature hashing).
        let sign = if h & 1 == 0 { 1.0 } else { -1.0 };
        v[(h >> 1) as usize % EMBED_DIM] += sign;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x /= norm);
    v
}

/// Greedy centroid clustering over all open tabs. O(tabs × clusters) — for a
/// browser (tens of tabs, handful of clusters) this beats any "smarter"
/// algorithm's constant factor.
pub fn cluster(docs: &[(u64, Arc<str>)]) -> Vec<(u64, ClusterTag)> {
    let mut centroids: Vec<[f32; EMBED_DIM]> = Vec::new();
    let mut out = Vec::with_capacity(docs.len());

    for (tab, text) in docs {
        let e = embed(text);
        // Vectors are L2-normalized → dot product IS cosine similarity.
        let best = centroids
            .iter()
            .enumerate()
            .map(|(i, c)| (i, dot(c, &e)))
            .max_by(|a, b| a.1.total_cmp(&b.1));

        let id = match best {
            Some((i, sim)) if sim >= SIMILARITY_THRESHOLD => {
                // Running-mean centroid update keeps clusters drift-stable.
                let c = &mut centroids[i];
                for (ci, ei) in c.iter_mut().zip(e.iter()) {
                    *ci = (*ci + *ei) * 0.5;
                }
                i
            }
            _ => {
                centroids.push(e);
                centroids.len() - 1
            }
        };
        out.push((
            *tab,
            ClusterTag {
                id: id as u32,
                color: CLUSTER_COLORS[id % CLUSTER_COLORS.len()],
            },
        ));
    }
    tracing::debug!(target: "flux::embed", tabs = docs.len(), clusters = centroids.len(), "reclustered");
    out
}

#[inline]
fn dot(a: &[f32; EMBED_DIM], b: &[f32; EMBED_DIM]) -> f32 {
    // Autovectorizes to SIMD at opt-level 3; explicit portable_simd is the
    // follow-up if profiles ever show this hot.
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[inline]
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_pages_cluster_together() {
        let docs: Vec<(u64, Arc<str>)> = vec![
            (
                1,
                Arc::from("rust async tokio runtime performance benchmarks"),
            ),
            (
                2,
                Arc::from("rust tokio async tasks runtime scheduler performance"),
            ),
            (
                3,
                Arc::from("chocolate cake recipe butter sugar flour oven baking"),
            ),
        ];
        let tags = cluster(&docs);
        assert_eq!(
            tags[0].1.id, tags[1].1.id,
            "the two rust tabs share a cluster"
        );
        assert_ne!(tags[0].1.id, tags[2].1.id, "baking gets its own cluster");
    }

    #[test]
    fn embeddings_are_unit_length() {
        let e = embed("some moderately long page text about browsers and terminals");
        let norm: f32 = e.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3);
    }
}
