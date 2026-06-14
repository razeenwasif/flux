//! Process-wide Flux Agent planner.
//!
//! The model is loaded exactly once (weights are mmap'd GGUF — the OS shares
//! pages, we never copy them) and reused for every request. Swapping the
//! backend is a feature flag, not a code change.

use std::sync::OnceLock;

use flux_agent::{AgentPlanner, Inference};

#[cfg(feature = "llama")]
fn make_backend() -> Box<dyn Inference> {
    // Gemma-class 12B, 4-bit. Path overridable for model hot-swapping.
    let model = std::env::var("FLUX_MODEL_PATH")
        .unwrap_or_else(|_| "models/gemma-4-12b-it-q4_k_m.gguf".into());
    Box::new(flux_agent::llama::LlamaBackend::load(&model).expect("failed to load GGUF model"))
}

#[cfg(not(feature = "llama"))]
fn make_backend() -> Box<dyn Inference> {
    // Deterministic heuristic backend: keeps the full pipeline (plan →
    // compile → inject) exercisable in dev/CI without 8 GB of weights.
    Box::new(flux_agent::MockBackend)
}

pub fn planner() -> &'static AgentPlanner {
    static PLANNER: OnceLock<AgentPlanner> = OnceLock::new();
    PLANNER.get_or_init(|| AgentPlanner::new(make_backend()))
}
