//! Ollama inference backend — the primary Flux Agent brain.
//!
//! Talks to a local Ollama server (`http://localhost:11434`) over HTTP rather
//! than embedding llama.cpp: Ollama owns model loading + GPU offload, the user
//! already has the Gemma models pulled, and this is pure Rust (no FFI/build
//! toolchain). `format: "json"` forces the model to emit valid JSON, which the
//! planner parses into an `AgentAction`.
//!
//! Config (env): `FLUX_MODEL` (default `gemma4:12b-it-qat`), `FLUX_OLLAMA_URL`.

use std::sync::RwLock;
use std::time::Duration;

use crate::{AgentError, Inference};

pub const DEFAULT_MODEL: &str = "gemma4:12b-it-qat";
pub const DEFAULT_URL: &str = "http://localhost:11434";

/// Runtime model override (BACKLOG #81). `None` → env `FLUX_MODEL` / the default.
/// Set from Settings so the user can switch Ollama models without a restart.
static MODEL: RwLock<Option<String>> = RwLock::new(None);

fn endpoint() -> String {
    std::env::var("FLUX_OLLAMA_URL").unwrap_or_else(|_| DEFAULT_URL.into())
}

/// The model the agent will use right now.
pub fn active_model() -> String {
    MODEL
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| std::env::var("FLUX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()))
}

/// Switch the agent's model (empty → revert to the env/default).
pub fn set_model(name: &str) {
    if let Ok(mut g) = MODEL.write() {
        *g = if name.trim().is_empty() { None } else { Some(name.to_string()) };
    }
}

/// List models the local Ollama server has pulled (`/api/tags`). Empty if the
/// server isn't reachable.
pub fn list_models() -> Vec<String> {
    let url = format!("{}/api/tags", endpoint());
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).build();
    let Ok(resp) = agent.get(&url).call() else { return Vec::new() };
    let Ok(value) = resp.into_json::<serde_json::Value>() else { return Vec::new() };
    value
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

/// The embedding model used for semantic search (BACKLOG #11). `FLUX_EMBED_MODEL`
/// overrides the default. Must be pulled in Ollama (`ollama pull embeddinggemma`).
pub const DEFAULT_EMBED_MODEL: &str = "embeddinggemma";
pub fn embed_model() -> String {
    std::env::var("FLUX_EMBED_MODEL").unwrap_or_else(|_| DEFAULT_EMBED_MODEL.into())
}

/// Embed `text` via Ollama's `/api/embed`, L2-normalized so cosine == dot.
/// `None` on any failure (server down, model not pulled) → callers fall back to
/// the local hashing embedder, so search always works.
pub fn embed_remote(text: &str) -> Option<Vec<f32>> {
    let url = format!("{}/api/embed", endpoint());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(30))
        .build();
    let resp = agent
        .post(&url)
        .send_json(serde_json::json!({ "model": embed_model(), "input": text }))
        .ok()?;
    let value: serde_json::Value = resp.into_json().ok()?;
    // `/api/embed` returns { "embeddings": [[...]] }.
    let arr = value.get("embeddings")?.as_array()?.first()?.as_array()?;
    let mut v: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
    if v.is_empty() {
        return None;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    Some(v)
}

pub struct OllamaBackend {
    agent: ureq::Agent,
    endpoint: String,
}

impl OllamaBackend {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                // Fail fast if no server is listening (e.g. Ollama not running
                // / wrong host) instead of hanging…
                .timeout_connect(Duration::from_secs(5))
                // …but allow many seconds for the model to actually generate.
                .timeout_read(Duration::from_secs(180))
                .build(),
            endpoint: endpoint(),
        }
    }

    pub fn model(&self) -> String {
        active_model()
    }
}

impl Default for OllamaBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// Keep the model resident between agent turns (default 30 min). Eliminates the
/// cold model-load latency on each `/api/generate` — the most reliable agent
/// latency win we fully control (BACKLOG #102). `FLUX_OLLAMA_KEEPALIVE`.
fn keep_alive() -> String {
    std::env::var("FLUX_OLLAMA_KEEPALIVE").unwrap_or_else(|_| "30m".into())
}

/// Cap the context window: a 12B model's quality degrades long before its full
/// window fills, prompt-eval cost is linear in context, and a smaller window
/// bounds RAM. `FLUX_OLLAMA_NUM_CTX` (default 4096).
fn num_ctx() -> u32 {
    std::env::var("FLUX_OLLAMA_NUM_CTX").ok().and_then(|s| s.parse().ok()).unwrap_or(4096)
}

/// Extra Ollama `options` merged over the defaults, as a JSON object string in
/// `FLUX_OLLAMA_OPTIONS`. This is the **speculative-decoding hook** (arXiv
/// 2203.16487): draft-model / `num_*` knobs land here when the local Ollama
/// build exposes them — Flux passes them through without a rebuild. Speculative
/// decoding itself is governed server-side by Ollama/llama.cpp; this lets the
/// user turn it on. Invalid/non-object JSON is ignored.
fn extra_options() -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = std::env::var("FLUX_OLLAMA_OPTIONS").ok()?;
    serde_json::from_str::<serde_json::Value>(&raw).ok()?.as_object().cloned()
}

/// Merge `extra` over `base` (extra wins). Pure, so the passthrough is testable
/// without touching the process environment.
fn merge_options(mut base: serde_json::Value, extra: Option<serde_json::Map<String, serde_json::Value>>) -> serde_json::Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra) {
        for (k, v) in e {
            b.insert(k, v);
        }
    }
    base
}

/// Build a `/api/generate` body. `json` forces structured JSON output (DOM
/// actions); plain text + a warmer temperature is used for chat. Split out so
/// it's unit-testable without a live server.
fn generate_body(model: &str, prompt: &str, json: bool) -> serde_json::Value {
    let options = merge_options(
        serde_json::json!({
            "temperature": if json { 0.1 } else { 0.6 },
            "num_predict": if json { 512 } else { 1024 },
            "num_ctx": num_ctx(),
        }),
        extra_options(),
    );
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "keep_alive": keep_alive(),
        "options": options,
    });
    if json {
        body["format"] = serde_json::Value::String("json".into());
    }
    body
}

impl OllamaBackend {
    fn generate(&self, prompt: &str, json: bool) -> Result<String, AgentError> {
        let url = format!("{}/api/generate", self.endpoint);
        let resp = self
            .agent
            .post(&url)
            .send_json(generate_body(&active_model(), prompt, json))
            .map_err(|e| AgentError::Inference(format!("ollama request to {url}: {e}")))?;

        let value: serde_json::Value = resp
            .into_json()
            .map_err(|e| AgentError::Inference(format!("ollama response decode: {e}")))?;

        value
            .get("response")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| AgentError::Inference(format!("ollama: no `response` field in {value}")))
    }
}

impl Inference for OllamaBackend {
    fn complete(&self, prompt: &str, _grammar: Option<&str>) -> Result<String, AgentError> {
        self.generate(prompt, true)
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        self.generate(prompt, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_body_is_json_constrained() {
        let b = generate_body("gemma4:12b-it-qat", "find the link", true);
        assert_eq!(b["model"], "gemma4:12b-it-qat");
        assert_eq!(b["prompt"], "find the link");
        assert_eq!(b["stream"], false);
        assert_eq!(b["format"], "json");
        assert_eq!(b["options"]["temperature"], 0.1);
        // Latency levers (#102): model kept warm + context capped.
        assert!(b.get("keep_alive").is_some());
        assert!(b["options"]["num_ctx"].is_number());
    }

    #[test]
    fn options_passthrough_merges_and_overrides() {
        let mut extra = serde_json::Map::new();
        extra.insert("num_ctx".into(), serde_json::json!(8192)); // override a default
        extra.insert("draft_model".into(), serde_json::json!("gemma4:2b")); // a new knob
        let merged = merge_options(
            serde_json::json!({ "temperature": 0.1, "num_ctx": 4096 }),
            Some(extra),
        );
        assert_eq!(merged["num_ctx"], 8192, "extra options override defaults");
        assert_eq!(merged["draft_model"], "gemma4:2b", "new knobs pass through");
        assert_eq!(merged["temperature"], 0.1, "untouched defaults survive");
    }

    #[test]
    fn chat_body_is_plain_text() {
        let b = generate_body("gemma4:12b-it-qat", "hello", false);
        assert!(b.get("format").is_none()); // no JSON constraint for chat
        assert_eq!(b["options"]["temperature"], 0.6);
    }

    #[test]
    fn model_defaults_and_env_override() {
        // Default (no env) — don't assert on the live env, just the constant.
        assert_eq!(DEFAULT_MODEL, "gemma4:12b-it-qat");
        assert!(DEFAULT_URL.starts_with("http://"));
    }
}
