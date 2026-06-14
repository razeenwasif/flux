//! Ollama inference backend — the primary Flux Agent brain.
//!
//! Talks to a local Ollama server (`http://localhost:11434`) over HTTP rather
//! than embedding llama.cpp: Ollama owns model loading + GPU offload, the user
//! already has the Gemma models pulled, and this is pure Rust (no FFI/build
//! toolchain). `format: "json"` forces the model to emit valid JSON, which the
//! planner parses into an `AgentAction`.
//!
//! Config (env): `FLUX_MODEL` (default `gemma4:12b-it-qat`), `FLUX_OLLAMA_URL`.

use std::time::Duration;

use crate::{AgentError, Inference};

pub const DEFAULT_MODEL: &str = "gemma4:12b-it-qat";
pub const DEFAULT_URL: &str = "http://localhost:11434";

pub struct OllamaBackend {
    agent: ureq::Agent,
    endpoint: String,
    model: String,
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
            endpoint: std::env::var("FLUX_OLLAMA_URL").unwrap_or_else(|_| DEFAULT_URL.into()),
            model: std::env::var("FLUX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }
}

impl Default for OllamaBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a `/api/generate` body. `json` forces structured JSON output (DOM
/// actions); plain text + a warmer temperature is used for chat. Split out so
/// it's unit-testable without a live server.
fn generate_body(model: &str, prompt: &str, json: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": {
            "temperature": if json { 0.1 } else { 0.6 },
            "num_predict": if json { 512 } else { 1024 }
        }
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
            .send_json(generate_body(&self.model, prompt, json))
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
