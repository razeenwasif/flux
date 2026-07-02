//! Process-wide Flux Agent planner.
//!
//! Backend is chosen at first use and reused for every request:
//!   * default      → Ollama (local server, the user's Gemma models)
//!   * FLUX_AGENT_BACKEND=mock → deterministic heuristic (dev/CI, no model)
//!   * feature `llama` + FLUX_AGENT_BACKEND=llama → in-process llama.cpp

use std::sync::OnceLock;

use flux_agent::{AgentPlanner, Inference, MockBackend, OllamaBackend};

fn make_backend() -> Box<dyn Inference> {
    match std::env::var("FLUX_AGENT_BACKEND").as_deref() {
        Ok("mock") => Box::new(MockBackend),
        #[cfg(feature = "llama")]
        Ok("llama") => {
            let model = std::env::var("FLUX_MODEL_PATH")
                .unwrap_or_else(|_| "models/gemma-4-12b-it-q4_k_m.gguf".into());
            // A missing/corrupt GGUF must not abort the whole browser
            // (panic="abort" in release): fall back to Ollama and keep booting.
            match flux_agent::llama::LlamaBackend::load(&model) {
                Ok(b) => Box::new(b),
                Err(e) => {
                    tracing::error!(target: "flux::agent", model, error = %e, "GGUF load failed; falling back to Ollama");
                    Box::new(OllamaBackend::new())
                }
            }
        }
        // Default: talk to the local Ollama server (FLUX_MODEL / FLUX_OLLAMA_URL).
        _ => {
            let backend = OllamaBackend::new();
            tracing::info!(target: "flux::agent", model = backend.model(), "using Ollama backend");
            Box::new(backend)
        }
    }
}

pub fn planner() -> &'static AgentPlanner {
    static PLANNER: OnceLock<AgentPlanner> = OnceLock::new();
    PLANNER.get_or_init(|| AgentPlanner::new(make_backend()))
}
