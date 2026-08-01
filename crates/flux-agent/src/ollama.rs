//! Ollama inference backend — the primary Flux Agent brain.
//!
//! Talks to a local Ollama server (`http://localhost:11434`) over HTTP rather
//! than embedding llama.cpp: Ollama owns model loading + GPU offload, the user
//! already has the Gemma models pulled, and this is pure Rust (no FFI/build
//! toolchain). For DOM actions the planner passes the `AgentAction` JSON Schema
//! as `format` (`crate::action_schema`), so the model is constrained to the exact
//! shape; chat streams free text token-by-token (`stream:true`).
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

thread_local! {
    /// Per-thread model override for domain routing (#120). The agent runs each
    /// completion on its own blocking thread, so forcing a model here routes just
    /// that one call without touching the user's global choice or other threads.
    static MODEL_OVERRIDE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Run `f` with the agent model forced to `model` on THIS thread, restoring the
/// previous value after — used to route an in-domain question to a specialist.
pub fn with_model<T>(model: &str, f: impl FnOnce() -> T) -> T {
    let prev = MODEL_OVERRIDE.with(|m| m.borrow_mut().replace(model.to_string()));
    let out = f();
    MODEL_OVERRIDE.with(|m| *m.borrow_mut() = prev);
    out
}

/// The model the agent will use right now — a thread-local routing override wins,
/// then the global runtime override, then `FLUX_MODEL` / the default.
pub fn active_model() -> String {
    if let Some(m) = MODEL_OVERRIDE.with(|m| m.borrow().clone()) {
        return m;
    }
    MODEL
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| std::env::var("FLUX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()))
}

/// Switch the agent's model (empty → revert to the env/default).
pub fn set_model(name: &str) {
    if let Ok(mut g) = MODEL.write() {
        *g = if name.trim().is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
}

/// List models the local Ollama server has pulled (`/api/tags`). Empty if the
/// server isn't reachable.
pub fn list_models() -> Vec<String> {
    let url = format!("{}/api/tags", endpoint());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .build();
    let Ok(resp) = agent.get(&url).call() else {
        return Vec::new();
    };
    let Ok(value) = resp.into_json::<serde_json::Value>() else {
        return Vec::new();
    };
    value
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The embedding model used for semantic search (BACKLOG #11). `FLUX_EMBED_MODEL`
/// overrides the default. Must be pulled in Ollama (`ollama pull embeddinggemma`).
pub const DEFAULT_EMBED_MODEL: &str = "embeddinggemma";
pub fn embed_model() -> String {
    std::env::var("FLUX_EMBED_MODEL").unwrap_or_else(|_| DEFAULT_EMBED_MODEL.into())
}

/// Is the configured embedding model pulled and the server answering?
///
/// Deliberately `/api/tags` rather than a real embed. A trial embed was the old
/// reachability check, and it has two costs a *probe* must not pay: it can make
/// Ollama load the model into VRAM (seconds), and it inherits the 30s read
/// timeout below. Listing tags touches no model and answers in milliseconds,
/// while still distinguishing "server up with the model pulled" from "server up
/// but the model was never fetched" - which is the whole question being asked.
pub fn has_embed_model() -> bool {
    let url = format!("{}/api/tags", endpoint());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(1))
        // A probe that waits is a probe that hangs the caller. If a local server
        // can't list its models in two seconds, treat it as unavailable and use
        // the hashing embedder; being wrong here costs search sharpness, not
        // correctness.
        .timeout_read(Duration::from_secs(2))
        .build();
    let Ok(resp) = agent.get(&url).call() else {
        return false;
    };
    let Ok(value) = resp.into_json::<serde_json::Value>() else {
        return false;
    };
    let want = embed_model();
    // Tags carry an explicit version ("embeddinggemma:latest"); a configured name
    // without one should still match.
    let base = |n: &str| n.split(':').next().unwrap_or(n).to_string();
    value
        .get("models")
        .and_then(|m| m.as_array())
        .is_some_and(|models| {
            models.iter().any(|m| {
                m.get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| n == want || base(n) == base(&want))
            })
        })
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
    let mut v: Vec<f32> = arr
        .iter()
        .filter_map(|x| x.as_f64().map(|f| f as f32))
        .collect();
    if v.is_empty() {
        return None;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    Some(v)
}

/// Batch-embed many texts in ONE `/api/embed` call (Ollama accepts an array
/// `input`). Returns one L2-normalized vector per input, in order, or `None` on
/// any error / shape mismatch. Used by the file-search semantic re-rank (#88/#11).
pub fn embed_remote_batch(texts: &[String]) -> Option<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Some(Vec::new());
    }
    let url = format!("{}/api/embed", endpoint());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .post(&url)
        .send_json(serde_json::json!({ "model": embed_model(), "input": texts }))
        .ok()?;
    let value: serde_json::Value = resp.into_json().ok()?;
    let arr = value.get("embeddings")?.as_array()?;
    if arr.len() != texts.len() {
        return None;
    }
    let mut out = Vec::with_capacity(arr.len());
    for emb in arr {
        let mut v: Vec<f32> = emb
            .as_array()?
            .iter()
            .filter_map(|x| x.as_f64().map(|f| f as f32))
            .collect();
        if v.is_empty() {
            return None;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 1e-6 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        out.push(v);
    }
    Some(out)
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

/// Baseline context window: a 12B model's quality degrades long before its full
/// window fills, prompt-eval cost is linear in context, and a smaller window
/// bounds RAM. This is a *floor*, grown per-request by [`ctx_for`].
const DEFAULT_NUM_CTX: u32 = 4096;

/// Ceiling on auto-grown context. Bounds RAM — the low-memory wedge is the whole
/// point of Flux — even if a caller hands us an enormous prompt.
pub(crate) const MAX_AUTO_CTX: u32 = 16384;

/// An explicit user override, which always wins over auto-sizing.
fn num_ctx_override() -> Option<u32> {
    std::env::var("FLUX_OLLAMA_NUM_CTX")
        .ok()
        .and_then(|s| s.parse().ok())
}

/// Rough token count, for sizing only. ~3 chars/token deliberately *over*-counts
/// for English prose: under-counting is the failure that hurts, because it
/// silently truncates the prompt.
pub(crate) fn estimate_tokens(s: &str) -> u32 {
    u32::try_from(s.len() / 3).unwrap_or(u32::MAX)
}

/// The context window for THIS request — big enough to hold the prompt *and*
/// leave room to answer.
///
/// `num_ctx` covers prompt + output together. A fixed 4096 silently truncated
/// our longest prompts (`flag_policy` sends a 12 KB document, `chat_pages` 12 KB
/// of tabs), and Ollama drops the *oldest* tokens — which is exactly where the
/// "reply with one JSON object" instruction lives. The model then sees a bare
/// document with no task, rambles, and hits the output cap: a truncated-JSON
/// parse error that looks like model weakness but is our own configuration.
/// So grow to fit, clamped both ways.
fn ctx_for(prompt: &str, out_cap: i32) -> u32 {
    if let Some(v) = num_ctx_override() {
        return v;
    }
    estimate_tokens(prompt)
        .saturating_add(u32::try_from(out_cap.max(0)).unwrap_or(0))
        .saturating_add(256) // slack for the template/BOS the server adds
        .clamp(DEFAULT_NUM_CTX, MAX_AUTO_CTX)
}

/// Output-token cap for free-text chat. A generous **positive** default (2048, up
/// from the old 1024) so long answers don't get cut off — but NOT `-1`: some Ollama/
/// llama.cpp builds treat `num_predict = -1` as a tiny value and stop after a few
/// words, the opposite of "infinite". Bounded by `num_ctx` regardless.
/// `FLUX_OLLAMA_NUM_PREDICT` overrides (e.g. `-1` if your build handles it, or a
/// smaller cap). Structured replies use [`STRUCTURED_PREDICT_CAP`] instead.
pub(crate) fn num_predict() -> i32 {
    std::env::var("FLUX_OLLAMA_NUM_PREDICT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2048)
}

/// Extra Ollama `options` merged over the defaults, as a JSON object string in
/// `FLUX_OLLAMA_OPTIONS`. This is the **speculative-decoding hook** (arXiv
/// 2203.16487): draft-model / `num_*` knobs land here when the local Ollama
/// build exposes them — Flux passes them through without a rebuild. Speculative
/// decoding itself is governed server-side by Ollama/llama.cpp; this lets the
/// user turn it on. Invalid/non-object JSON is ignored.
fn extra_options() -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = std::env::var("FLUX_OLLAMA_OPTIONS").ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .as_object()
        .cloned()
}

/// Merge `extra` over `base` (extra wins). Pure, so the passthrough is testable
/// without touching the process environment.
fn merge_options(
    mut base: serde_json::Value,
    extra: Option<serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra) {
        for (k, v) in e {
            b.insert(k, v);
        }
    }
    base
}

/// Token ceiling for **structured** (schema-constrained) completions.
///
/// This is a safety ceiling, not a length target: with `format` set, generation
/// is grammar-constrained and stops naturally when the object closes, so raising
/// the cap costs nothing on a well-behaved reply — it only changes what happens
/// to a verbose one. Too low and the JSON is cut off mid-string, which surfaces
/// as an opaque parse error and silently disables the feature (a terse model
/// fits; a wordier one of the same family does not — see `assess_phishing` on a
/// 26B council build). The longest legitimate output is `flag_policy`'s three
/// clauses (~1400 chars before Rust clamps them), so leave real headroom.
const STRUCTURED_PREDICT_CAP: i32 = 1536;

/// Build a `/api/generate` body. A `format` (a JSON Schema, or the bare string
/// `"json"`) constrains structured output for DOM actions and gets the cooler
/// temperature; `None` is free-text chat with a warmer one. `stream` toggles
/// newline-delimited chunked responses. Split out so it's unit-testable without
/// a live server.
fn generate_body(
    model: &str,
    prompt: &str,
    format: Option<serde_json::Value>,
    stream: bool,
) -> serde_json::Value {
    let structured = format.is_some();
    let out_cap = if structured {
        STRUCTURED_PREDICT_CAP
    } else {
        num_predict()
    };
    let ctx = ctx_for(prompt, out_cap);
    // The last hop where a prompt can be silently shortened. Everything upstream
    // caps by character count; this is where those characters meet a token
    // budget, and if the prompt needs more tokens than `ctx` allows, the server
    // drops the oldest — the instructions — without telling anyone.
    tracing::debug!(
        target: "flux::ollama",
        prompt_chars = prompt.len(),
        est_tokens = estimate_tokens(prompt),
        num_ctx = ctx,
        out_cap,
        structured,
        "sending prompt"
    );
    let mut options = merge_options(
        serde_json::json!({
            "temperature": if structured { 0.1 } else { 0.6 },
            "num_predict": out_cap,
            "num_ctx": ctx,
        }),
        extra_options(),
    );
    // Neutralize the repetition penalty for schema-constrained output. JSON is
    // *legitimately* repetitive — `"clause":`, `"why":`, quotes and braces recur
    // by definition — so a penalty punishes exactly the tokens the grammar
    // requires: the model steers away from closing a string and rambles. A model
    // whose Modelfile sets one for prose (e.g. `repeat_penalty 1.2`) is otherwise
    // fighting the schema on every call. Structured only; an explicit
    // FLUX_OLLAMA_OPTIONS value still wins.
    if structured {
        if let Some(o) = options.as_object_mut() {
            o.entry("repeat_penalty")
                .or_insert_with(|| serde_json::json!(1.0));
        }
    }
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": stream,
        "keep_alive": keep_alive(),
        "options": options,
    });
    if let Some(f) = format {
        body["format"] = f;
    }
    body
}

/// Interpret a non-streaming `/api/generate` reply.
///
/// Ollama reports **why** it stopped. `done_reason:"length"` means the token cap
/// was hit, so the JSON is cut off mid-token — the caller would otherwise see an
/// inscrutable "EOF while parsing a string", treat it as "model unavailable",
/// and silently disable the feature. Naming the real cause (and the fix) is the
/// difference between a five-minute config change and an afternoon of hunting
/// imagined model weakness. Pure, so both paths are testable without a server.
fn read_generate_response(
    value: &serde_json::Value,
    model: &str,
) -> Result<String, AgentError> {
    if value.get("done_reason").and_then(|v| v.as_str()) == Some("length") {
        return Err(AgentError::Inference(format!(
            "ollama: output truncated at the token cap (model `{model}` is more verbose \
             than num_predict={STRUCTURED_PREDICT_CAP} allows) — raise it with \
             FLUX_OLLAMA_OPTIONS='{{\"num_predict\":3072}}' or use a terser model"
        )));
    }
    value
        .get("response")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| AgentError::Inference(format!("ollama: no `response` field in {value}")))
}

impl OllamaBackend {
    fn generate(
        &self,
        prompt: &str,
        format: Option<serde_json::Value>,
    ) -> Result<String, AgentError> {
        let url = format!("{}/api/generate", self.endpoint);
        let resp = self
            .agent
            .post(&url)
            .send_json(generate_body(&active_model(), prompt, format, false))
            .map_err(|e| AgentError::Inference(format!("ollama request to {url}: {e}")))?;

        let value: serde_json::Value = resp
            .into_json()
            .map_err(|e| AgentError::Inference(format!("ollama response decode: {e}")))?;

        read_generate_response(&value, &active_model())
    }

    /// Stream a free-text completion: `/api/generate` with `stream:true` returns
    /// newline-delimited JSON objects, each `{ "response": "<chunk>", "done": … }`.
    /// We relay each chunk to `on_token` and accumulate the full text (BACKLOG #82).
    fn generate_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        use std::io::BufRead;
        let url = format!("{}/api/generate", self.endpoint);
        let resp = self
            .agent
            .post(&url)
            .send_json(generate_body(&active_model(), prompt, None, true))
            .map_err(|e| AgentError::Inference(format!("ollama request to {url}: {e}")))?;

        let mut reader = std::io::BufReader::new(resp.into_reader());
        let mut full = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // stream closed
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // A malformed chunk shouldn't abort a good stream; skip it.
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                        continue;
                    };
                    if let Some(tok) = value.get("response").and_then(|v| v.as_str()) {
                        if !tok.is_empty() {
                            full.push_str(tok);
                            on_token(tok);
                        }
                    }
                    if value.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                        break;
                    }
                }
                Err(e) => return Err(AgentError::Inference(format!("ollama stream read: {e}"))),
            }
        }
        Ok(full)
    }
}

impl Inference for OllamaBackend {
    fn complete(
        &self,
        prompt: &str,
        schema: Option<&serde_json::Value>,
    ) -> Result<String, AgentError> {
        // A schema constrains the shape; with none, fall back to free JSON.
        self.generate(
            prompt,
            Some(
                schema
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::String("json".into())),
            ),
        )
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        self.generate(prompt, None)
    }

    fn chat_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        self.generate_stream(prompt, on_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_body_is_schema_constrained() {
        // Actions pass the AgentAction JSON Schema as `format` (BACKLOG #82) —
        // stronger than the old bare `format:"json"`.
        let schema = crate::action_schema(true);
        let b = generate_body("gemma4:12b-it-qat", "find the link", Some(schema), false);
        assert_eq!(b["model"], "gemma4:12b-it-qat");
        assert_eq!(b["prompt"], "find the link");
        assert_eq!(b["stream"], false);
        assert!(
            b["format"]["oneOf"].is_array(),
            "format is the action schema, not just \"json\""
        );
        assert_eq!(b["options"]["temperature"], 0.1);
        // Latency levers (#102): model kept warm + context capped.
        assert!(b.get("keep_alive").is_some());
        assert!(b["options"]["num_ctx"].is_number());
    }

    #[test]
    fn stream_flag_threads_through() {
        let b = generate_body("m", "hi", None, true);
        assert_eq!(b["stream"], true);
        assert!(b.get("format").is_none()); // streaming chat is free-text
    }

    #[test]
    fn chat_lets_long_replies_finish() {
        // Free-text chat no longer caps output at 1024 (the mid-sentence cut-off);
        // default -1 lets the model finish, bounded by num_ctx.
        let chat = generate_body("m", "explain in detail", None, true);
        assert_eq!(chat["options"]["num_predict"], 2048);
        // Structured (JSON-schema) replies are bounded by a *safety ceiling*, not
        // a length target: grammar-constrained generation stops when the object
        // closes. The old 512 assumed "structured replies are short", which held
        // for a terse model and broke on a wordier one of the same family — the
        // JSON was cut mid-string and the feature silently stopped working.
        let structured = generate_body(
            "m",
            "act",
            Some(serde_json::json!({ "type": "object" })),
            false,
        );
        assert_eq!(structured["options"]["num_predict"], STRUCTURED_PREDICT_CAP);
        const { assert!(STRUCTURED_PREDICT_CAP >= 1536) }; // headroom for flag_policy's 3 clauses
    }

    #[test]
    fn context_grows_to_fit_long_prompts() {
        // Short prompt → the cheap baseline (prompt-eval cost is linear in ctx).
        assert_eq!(ctx_for("hi", 512), DEFAULT_NUM_CTX);

        // flag_policy's 12 KB document must NOT be silently truncated: num_ctx
        // covers prompt AND output, and Ollama drops the OLDEST tokens — exactly
        // where "reply with one JSON object" lives. The model would then see a
        // bare document with no task and ramble past the output cap.
        let doc = "x".repeat(12 * 1024);
        let ctx = ctx_for(&doc, STRUCTURED_PREDICT_CAP);
        assert!(ctx > DEFAULT_NUM_CTX, "grew for a long prompt");
        assert!(
            ctx >= estimate_tokens(&doc) + STRUCTURED_PREDICT_CAP as u32,
            "room for the prompt AND the answer"
        );

        // Bounded — RAM is the whole wedge.
        assert_eq!(ctx_for(&"y".repeat(10_000_000), 512), MAX_AUTO_CTX);
    }

    #[test]
    fn structured_calls_neutralize_a_prose_repeat_penalty() {
        // JSON is legitimately repetitive; a penalty fights the grammar.
        let structured = generate_body("m", "act", Some(serde_json::json!({})), false);
        assert_eq!(structured["options"]["repeat_penalty"], 1.0);
        // Free-text chat leaves the model's own value alone.
        let chat = generate_body("m", "explain", None, true);
        assert!(chat["options"].get("repeat_penalty").is_none());
    }

    #[test]
    fn truncated_output_reports_the_cap_not_a_parse_error() {
        // The failure this replaced: a cut-off reply reached serde as
        // "EOF while parsing a string", which every caller reads as
        // "model unavailable" and silently falls back on.
        let truncated = serde_json::json!({
            "response": "{\"reasons\": [\"it asks for your PayPal",
            "done": true,
            "done_reason": "length"
        });
        let err = read_generate_response(&truncated, "gemma4:26b-council").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("truncated"), "{msg}");
        assert!(msg.contains("gemma4:26b-council"), "names the model: {msg}");
        assert!(msg.contains("num_predict"), "says how to fix it: {msg}");

        // A normal reply is unaffected.
        let ok = serde_json::json!({ "response": "{\"a\":1}", "done_reason": "stop" });
        assert_eq!(read_generate_response(&ok, "m").unwrap(), "{\"a\":1}");
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
        let b = generate_body("gemma4:12b-it-qat", "hello", None, false);
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
