//! Unified text embedding (BACKLOG #11).
//!
//! Prefers a real model via Ollama (`embeddinggemma` by default) for semantic
//! quality — synonymy, paraphrase, cross-lingual — and **falls back to the
//! local hashing embedder** (`flux-embed`) when Ollama isn't running or the
//! model isn't pulled, so search never breaks (it's just less sharp offline).
//!
//! Vectors carry which embedder produced them ([`Embedder`]) because the two
//! have different dimensions and aren't comparable; a store that switches
//! embedders (e.g. the user pulls the model) must re-embed its corpus to keep
//! cosine meaningful. All vectors are L2-normalized, so cosine == dot product.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Embedder {
    /// Real model via Ollama (`embed_remote`).
    Model,
    /// Local feature-hashing fallback (`flux-embed`).
    Hash,
}

/// Embed `text`, returning the vector and which embedder produced it. Tries the
/// model first, falls back to hashing.
pub fn embed(text: &str) -> (Vec<f32>, Embedder) {
    match flux_agent::ollama::embed_remote(text) {
        Some(v) => (v, Embedder::Model),
        None => (flux_embed::embed(text).to_vec(), Embedder::Hash),
    }
}

/// Embed with a *specific* embedder (so a store can keep its whole corpus on one
/// kind). `None` if that embedder is unavailable (Model, with Ollama down).
pub fn embed_with(text: &str, kind: Embedder) -> Option<Vec<f32>> {
    match kind {
        Embedder::Model => flux_agent::ollama::embed_remote(text),
        Embedder::Hash => Some(flux_embed::embed(text).to_vec()),
    }
}

/// Embed many texts with a specific embedder in one shot — one batched Ollama call
/// for Model, a fast local map for Hash. `None` (Model) if Ollama is unavailable.
pub fn embed_batch(texts: &[String], kind: Embedder) -> Option<Vec<Vec<f32>>> {
    match kind {
        Embedder::Model => flux_agent::ollama::embed_remote_batch(texts),
        Embedder::Hash => Some(
            texts
                .iter()
                .map(|t| flux_embed::embed(t).to_vec())
                .collect(),
        ),
    }
}

/// The embedder [`embed`] would use right now (Model if Ollama answers, else
/// Hash) — used to decide whether a persisted corpus needs re-embedding.
pub fn current() -> Embedder {
    if let Some((at, kind)) = *PROBE.lock() {
        if at.elapsed() < PROBE_TTL {
            return kind;
        }
    }
    let kind = if flux_agent::ollama::has_embed_model() {
        Embedder::Model
    } else {
        Embedder::Hash
    };
    *PROBE.lock() = Some((Instant::now(), kind));
    kind
}

/// Last probe result and when it was taken.
///
/// This function reads as a cheap accessor and was called like one - on the boot
/// path, on file search, on watch evaluation - but every call was an HTTP round
/// trip to Ollama. Ollama starting, stopping, or having a model pulled are all
/// human-scale events, so a minute-stale answer is fine; the cost of asking is
/// not.
static PROBE: Mutex<Option<(Instant, Embedder)>> = Mutex::new(None);
const PROBE_TTL: Duration = Duration::from_secs(60);

/// Forget the cached probe, so the next `current()` asks again. For when the user
/// has just changed something that would change the answer (pulled the model,
/// started the server) and shouldn't wait out the TTL.
pub fn invalidate_probe() {
    *PROBE.lock() = None;
}

/// Cosine similarity for L2-normalized vectors (== dot product). Mismatched
/// lengths → 0 (different embedders aren't comparable).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {

    #[test]
    fn current_is_cached_rather_than_probed_per_call() {
        // `current()` reads like a cheap accessor and was called like one, but
        // each call was an HTTP round trip. Works whether or not Ollama is up:
        // what's asserted is that the answer is memoized and stable.
        invalidate_probe();
        let first = current();
        assert!(
            PROBE.lock().is_some(),
            "first call should populate the cache"
        );
        let stamp = PROBE.lock().map(|(at, _)| at);
        for _ in 0..5 {
            assert_eq!(current(), first, "cached probe must be stable");
        }
        assert_eq!(
            PROBE.lock().map(|(at, _)| at),
            stamp,
            "a cached call re-probed instead of reusing the answer"
        );
    }

    #[test]
    fn invalidating_the_probe_forces_a_fresh_answer() {
        current();
        invalidate_probe();
        assert!(PROBE.lock().is_none(), "invalidate should clear the cache");
    }
    use super::*;

    // These assert env-independent invariants (whether or not Ollama is up). The
    // Model path is exercised at runtime, not in unit tests.

    #[test]
    fn hash_embedder_is_always_available_and_256_dim() {
        let v = embed_with("rust ownership and borrowing", Embedder::Hash).unwrap();
        assert_eq!(v.len(), flux_embed::EMBED_DIM);
    }

    #[test]
    fn embed_returns_a_nonempty_vector() {
        // Whichever embedder is used, the vector is non-empty and its kind is
        // self-consistent with embed_with.
        let (v, kind) = embed("hello world content");
        assert!(!v.is_empty());
        assert_eq!(
            embed_with("hello world content", kind).map(|x| x.len()),
            Some(v.len())
        );
    }

    #[test]
    fn cosine_ranks_related_higher_on_the_hash_embedder() {
        let a = embed_with("memory safety in rust", Embedder::Hash).unwrap();
        let b = embed_with("rust borrow checker and lifetimes", Embedder::Hash).unwrap();
        let c = embed_with("tomato basil pasta recipe", Embedder::Hash).unwrap();
        assert!(cosine(&a, &b) > cosine(&a, &c));
        assert_eq!(cosine(&a, &[0.1, 0.2]), 0.0); // length mismatch → 0
    }
}
