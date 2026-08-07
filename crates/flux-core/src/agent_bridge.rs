//! Process-wide Flux Agent planner.
//!
//! The *local* backend is chosen at first use and reused for every request:
//!   * default      → Ollama (local server, the user's Gemma models)
//!   * FLUX_AGENT_BACKEND=mock → deterministic heuristic (dev/CI, no model)
//!   * feature `llama` + FLUX_AGENT_BACKEND=llama → in-process llama.cpp
//!
//! That backend is then wrapped in a [`RoutingBackend`] (#175), which keeps a
//! second, optional *cloud* backend beside it. The router is local-first and
//! stays local unless the user explicitly escalates for the session — see
//! `flux_agent::route` for the rules, and `crate::gemini` for the commands that
//! install a key.

use std::sync::{Arc, OnceLock};

use flux_agent::{AgentPlanner, Inference, MockBackend, OllamaBackend, RoutingBackend};

fn make_local() -> Box<dyn Inference> {
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

/// The router, reachable after the planner is built so a key entered later can
/// install the cloud backend without rebuilding anything.
pub fn router() -> &'static Arc<RoutingBackend> {
    static ROUTER: OnceLock<Arc<RoutingBackend>> = OnceLock::new();
    ROUTER.get_or_init(|| Arc::new(RoutingBackend::new(make_local())))
}

pub fn planner() -> &'static AgentPlanner {
    static PLANNER: OnceLock<AgentPlanner> = OnceLock::new();
    PLANNER.get_or_init(|| AgentPlanner::new(Box::new(Arc::clone(router()))))
}
