//! llama.cpp backend (feature = "llama").
//!
//! Loads a GGUF (default: Gemma-4-12B-IT Q4_K_M) with full GPU offload and
//! mmap'd weights — the OS page cache makes second boot effectively free,
//! and unified-memory machines (Apple Silicon) never duplicate the weights
//! between "RAM" and "VRAM".

use crate::{AgentError, Inference};

pub struct LlamaBackend {
    // Holds llama_cpp_2::LlamaModel + a reusable context. The context is
    // recreated per request in v0 (simple, correct); a follow-up issue adds
    // KV-cache reuse keyed on the (stable) system-prompt prefix, which is
    // what gets first-token under the 350 ms budget.
    _private: (),
}

impl LlamaBackend {
    pub fn load(model_path: &str) -> Result<Self, AgentError> {
        // Skeleton: real implementation wires llama_cpp_2:
        //   let backend = LlamaBackend::init()?;
        //   let params  = LlamaModelParams::default().with_n_gpu_layers(u32::MAX); // full offload
        //   let model   = LlamaModel::load_from_file(&backend, model_path, &params)?;
        tracing::info!(target: "flux::agent", %model_path, "loading GGUF (mmap, full GPU offload)");
        let _ = model_path;
        Err(AgentError::Inference(
            "llama backend scaffolded but not yet wired — see issue 'Wire llama-cpp-2'".into(),
        ))
    }
}

impl Inference for LlamaBackend {
    fn complete(&self, _prompt: &str, _grammar: Option<&str>) -> Result<String, AgentError> {
        // Real impl: build a sampler chain with LlamaGrammar::from_str(grammar)
        // so decoding is constrained at the logit level, temp 0.1, then decode
        // until <end_of_turn>.
        Err(AgentError::Inference("not yet wired".into()))
    }
}
