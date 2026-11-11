//! Process-wide Flux Agent planner.
//!
//! The backend is chosen at first use and reused for every request:
//!   * default      → this Mac's Ollama (the user's Gemma models; FLUX_MODEL /
//!     FLUX_OLLAMA_URL)
//!   * FLUX_AGENT_BACKEND=mock → deterministic heuristic (dev/CI, no model)
//!   * feature `llama` + FLUX_AGENT_BACKEND=llama → in-process llama.cpp
//!
//! It is the only model Flux runs itself. Fairy (`crate::fairy`) is the agent
//! you talk to; this one powers what Flux does on device: Sentinel's checks,
//! form help, cited page answers, notes answers, Boost drafts, note writing,
//! Trail summaries and the agent panel's local chips. Nothing here sends a
//! prompt off this machine.

use std::sync::OnceLock;

use flux_agent::{AgentPlanner, Inference, MockBackend};

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
                    Box::new(flux_agent::OllamaBackend::new())
                }
            }
        }
        _ => Box::new(flux_agent::OllamaBackend::new()),
    }
}

pub fn planner() -> &'static AgentPlanner {
    static PLANNER: OnceLock<AgentPlanner> = OnceLock::new();
    PLANNER.get_or_init(|| AgentPlanner::new(make_backend()))
}
