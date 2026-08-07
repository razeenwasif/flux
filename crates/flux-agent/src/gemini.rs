//! Gemini backend — the opt-in cloud escalation (#175).
//!
//! Flux's agent is local by default and stays that way. This backend exists for
//! the jobs a 12–26B on one GPU genuinely can't do: summarising a folder of
//! lecture PDFs, long reasoning chains, anything whose prompt outgrows a 16k
//! window. It is never selected implicitly — `route.rs` requires the user to
//! turn it on, and the toggle resets to local on every launch.
//!
//! **Everything in the prompt leaves the machine.** The planner's prompts carry
//! page DOM text, PDF contents, vault notes and terminal output, so enabling
//! this is a real disclosure to Google, not a performance setting. That is why
//! the switch is manual, non-persistent, and shown in the UI while it's on.
//!
//! Two things make this more than an HTTP call:
//!
//!   * **Schema dialect.** Ollama is handed JSON Schema directly and grammar-
//!     constrains generation with it. Gemini's `responseSchema` is an OpenAPI
//!     subset that rejects or ignores several things Flux's schemas use —
//!     `oneOf`, `const`, `additionalProperties`, union `type` arrays. Sending
//!     them unchanged is how you get a 400, or worse, a silently unconstrained
//!     reply. [`to_gemini_schema`] translates; it's pure and heavily tested.
//!   * **`maxLength` is advisory here.** The note-body cap is a *hard* stop under
//!     Ollama's grammar. Gemini may or may not honour it, so [`clamp_to_schema`]
//!     re-imposes it on the way back rather than trusting the wire.

use std::time::Duration;

use serde_json::{json, Value};

use crate::{AgentError, Inference};

/// Where the Generative Language API lives. Overridable for testing against a
/// local stub; not something a user needs to set.
const DEFAULT_API: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Fallback model when the user hasn't picked one. Deliberately a *flash* tier:
/// this is the escalation path for prompts that are too big, not a request to
/// spend as much as possible. The UI lists what the key can actually reach
/// (`list_models`), so this only matters before a first choice is made.
pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";

pub fn api_base() -> String {
    std::env::var("FLUX_GEMINI_API").unwrap_or_else(|_| DEFAULT_API.into())
}

pub fn default_model() -> String {
    std::env::var("FLUX_GEMINI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into())
}

// ─── Schema translation ──────────────────────────────────────────────────────

/// Translate a Flux JSON Schema into Gemini's `responseSchema` dialect.
///
/// The mappings, each of which exists because Flux's schemas actually use the
/// left-hand side (`action_schema`, `note_action_schema`):
///
/// | Flux (JSON Schema)          | Gemini (OpenAPI subset)          |
/// |-----------------------------|----------------------------------|
/// | `oneOf: [...]`              | `anyOf: [...]`                   |
/// | `const: "click"`            | `type: STRING, enum: ["click"]`  |
/// | `type: ["string", "null"]`  | `type: STRING, nullable: true`   |
/// | `additionalProperties: false` | *dropped* (unsupported)        |
/// | `type: "string"`            | `type: "STRING"` (proto enum)    |
///
/// Type names are upper-cased because `Schema.type` is a protobuf enum, and
/// proto3's JSON mapping matches enum *names* — `"string"` is not the name,
/// `"STRING"` is. Some endpoints are lenient about it; relying on that is how
/// you get a failure that only shows up on one model.
///
/// Unknown keywords are passed through rather than dropped: if Gemini gains
/// support for something, it starts working without a change here, and if it
/// rejects it the error names the keyword.
pub fn to_gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                match k.as_str() {
                    // Not supported, and harmless to lose: it only ever *tightens*
                    // an object, and the variant's `required` list still pins the
                    // shape we parse into.
                    "additionalProperties" => {}
                    // `oneOf` means "exactly one"; `anyOf` means "at least one".
                    // For these schemas the variants are disjoint (each pins a
                    // distinct `action`), so the two coincide.
                    "oneOf" => {
                        out.insert("anyOf".into(), to_gemini_schema(v));
                    }
                    // A single-valued enum is how this dialect spells a constant.
                    "const" => {
                        out.insert("enum".into(), json!([v.clone()]));
                        out.entry("type").or_insert_with(|| json!("STRING"));
                    }
                    "type" => {
                        let (ty, nullable) = normalize_type(v);
                        if let Some(t) = ty {
                            out.insert("type".into(), json!(t));
                        }
                        if nullable {
                            out.insert("nullable".into(), json!(true));
                        }
                    }
                    _ => {
                        out.insert(k.clone(), to_gemini_schema(v));
                    }
                }
            }
            // An `enum` with no `type` is ambiguous here; Gemini wants both.
            if out.contains_key("enum") && !out.contains_key("type") {
                out.insert("type".into(), json!("STRING"));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(to_gemini_schema).collect()),
        other => other.clone(),
    }
}

/// Map a JSON Schema `type` to `(gemini_type, nullable)`.
///
/// `["string", "null"]` is the idiom Flux uses for an optional field, and this
/// dialect expresses it as a type plus a `nullable` flag instead.
fn normalize_type(v: &Value) -> (Option<String>, bool) {
    match v {
        Value::String(s) => (Some(s.to_uppercase()), false),
        Value::Array(list) => {
            let nullable = list.iter().any(|t| t.as_str() == Some("null"));
            let ty = list
                .iter()
                .filter_map(|t| t.as_str())
                .find(|t| *t != "null")
                .map(|t| t.to_uppercase());
            (ty, nullable)
        }
        _ => (None, false),
    }
}

/// Re-impose the schema's `maxLength` bounds on a parsed reply.
///
/// Under Ollama a `maxLength` is part of the grammar the model is constrained
/// against, so it cannot be exceeded. Here it is a hint the service may ignore,
/// and the constraint it encodes is real: `NOTE_BODY_MAX` exists because an
/// unbounded note body once consumed an entire generation budget and produced
/// nothing usable.
///
/// Over-long strings are truncated at a **character boundary** rather than the
/// whole reply being rejected — for a note body, slightly short beats losing the
/// summary — and truncation is reported so the caller can say so.
pub fn clamp_to_schema(value: &mut Value, schema: &Value) -> bool {
    let mut clamped = false;
    clamp_inner(value, schema, &mut clamped);
    clamped
}

fn clamp_inner(value: &mut Value, schema: &Value, clamped: &mut bool) {
    let Some(sch) = schema.as_object() else {
        return;
    };

    // A union: apply whichever branch this value actually satisfies. Matching on
    // the `action` discriminant keeps it cheap and unambiguous for these schemas.
    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = sch.get(key).and_then(|v| v.as_array()) {
            if let Some(v) = pick_variant(value, variants) {
                clamp_inner(value, v, clamped);
            }
            return;
        }
    }

    if let (Some(max), Some(s)) = (
        sch.get("maxLength").and_then(|m| m.as_u64()),
        value.as_str(),
    ) {
        let max = max as usize;
        if s.chars().count() > max {
            let cut: String = s.chars().take(max).collect();
            *value = Value::String(cut);
            *clamped = true;
        }
        return;
    }

    if let Some(props) = sch.get("properties").and_then(|p| p.as_object()) {
        if let Some(obj) = value.as_object_mut() {
            for (k, sub) in props {
                if let Some(v) = obj.get_mut(k) {
                    clamp_inner(v, sub, clamped);
                }
            }
        }
        return;
    }

    if let Some(items) = sch.get("items") {
        if let Some(arr) = value.as_array_mut() {
            for v in arr {
                clamp_inner(v, items, clamped);
            }
        }
    }
}

/// Which union branch a value belongs to, by its pinned `action` discriminant.
fn pick_variant<'a>(value: &Value, variants: &'a [Value]) -> Option<&'a Value> {
    let action = value.get("action").and_then(|a| a.as_str());
    variants.iter().find(|v| {
        let Some(spec) = v
            .get("properties")
            .and_then(|p| p.get("action"))
            .and_then(|a| a.as_object())
        else {
            return false;
        };
        // Post-translation this is `enum: [x]`; pre-translation it's `const: x`.
        let want = spec.get("const").and_then(|c| c.as_str()).or_else(|| {
            spec.get("enum")
                .and_then(|e| e.get(0))
                .and_then(|c| c.as_str())
        });
        want.is_some() && want == action
    })
}

// ─── Backend ─────────────────────────────────────────────────────────────────

pub struct GeminiBackend {
    agent: ureq::Agent,
    key: String,
    model: String,
}

impl GeminiBackend {
    /// `key` is the Google AI Studio API key; `model` empty ⇒ [`default_model`].
    pub fn new(key: String, model: &str) -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                // Long prompts on a pro-tier model are slow; this is the point of
                // escalating, so allow for it.
                .timeout_read(Duration::from_secs(300))
                .build(),
            key,
            model: if model.trim().is_empty() {
                default_model()
            } else {
                model.trim().to_string()
            },
        }
    }

    pub fn model(&self) -> String {
        self.model.clone()
    }

    fn url(&self, method: &str) -> String {
        format!("{}/models/{}:{}", api_base(), self.model, method)
    }

    fn body(&self, prompt: &str, schema: Option<&Value>) -> Value {
        let mut cfg = json!({
            // Structured calls want determinism; free chat wants a little room.
            "temperature": if schema.is_some() { 0.1 } else { 0.7 },
        });
        if let Some(s) = schema {
            cfg["responseMimeType"] = json!("application/json");
            cfg["responseSchema"] = to_gemini_schema(s);
        }
        json!({
            "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
            "generationConfig": cfg,
        })
    }

    fn post(&self, method: &str, body: &Value) -> Result<String, AgentError> {
        let resp = self
            .agent
            .post(&self.url(method))
            // Header, not `?key=`: a query string lands in logs and proxy traces.
            .set("x-goog-api-key", &self.key)
            .set("Content-Type", "application/json")
            .send_json(body.clone());
        match resp {
            Ok(r) => r
                .into_string()
                .map_err(|e| AgentError::Inference(format!("gemini: {e}"))),
            Err(ureq::Error::Status(code, r)) => {
                let detail = r.into_string().unwrap_or_default();
                Err(AgentError::Inference(explain_status(code, &detail)))
            }
            Err(e) => Err(AgentError::Inference(format!("gemini: {e}"))),
        }
    }
}

/// Turn an API error into something that says what to do about it.
///
/// The default — a bare status code and a JSON blob — is exactly as useful as
/// "inference failed", which is the failure mode this codebase keeps having to
/// fix. The three that actually happen to a user get named.
fn explain_status(code: u16, detail: &str) -> String {
    let msg = serde_json::from_str::<Value>(detail)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| detail.chars().take(300).collect());
    match code {
        400 => format!(
            "gemini: rejected the request ({msg}) — if this mentions the schema, \
             it's a translation gap in to_gemini_schema, not your key"
        ),
        401 | 403 => format!(
            "gemini: key rejected ({msg}) — check the API key in Settings → Integrations. \
             A Gemini app subscription is not an API key; you need one from Google AI Studio"
        ),
        429 => {
            format!("gemini: rate limited or out of quota ({msg}) — the local model still works")
        }
        _ => format!("gemini: HTTP {code} ({msg})"),
    }
}

/// Pull the text out of a `generateContent` response, explaining the ways it can
/// come back empty rather than returning "".
///
/// A browser agent reads arbitrary web pages, so tripping a safety filter is a
/// question of when, not if — and a blocked reply arrives as a *successful*
/// response with no text in it. Silently returning empty there would look like
/// the model had nothing to say.
fn extract_text(raw: &str) -> Result<String, AgentError> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|e| AgentError::Inference(format!("gemini: unparseable response: {e}")))?;

    if let Some(reason) = v["promptFeedback"]["blockReason"].as_str() {
        return Err(AgentError::Inference(format!(
            "gemini: the prompt was blocked ({reason}) — page content can trip this; \
             the local model has no such filter"
        )));
    }

    let cand = &v["candidates"][0];
    let text: String = cand["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    if text.is_empty() {
        return match cand["finishReason"].as_str() {
            Some("SAFETY") | Some("PROHIBITED_CONTENT") => Err(AgentError::Inference(
                "gemini: the reply was blocked by a safety filter — page content can trip \
                 this; the local model has no such filter"
                    .into(),
            )),
            Some("MAX_TOKENS") => Err(AgentError::Inference(
                "gemini: hit the output limit before producing anything".into(),
            )),
            Some(other) => Err(AgentError::Inference(format!(
                "gemini: no output (finishReason {other})"
            ))),
            None => Err(AgentError::Inference("gemini: empty response".into())),
        };
    }
    Ok(text)
}

impl Inference for GeminiBackend {
    fn complete(&self, prompt: &str, schema: Option<&Value>) -> Result<String, AgentError> {
        let raw = self.post("generateContent", &self.body(prompt, schema))?;
        let text = extract_text(&raw)?;
        // Re-impose maxLength: see `clamp_to_schema`.
        let Some(schema) = schema else {
            return Ok(text);
        };
        let Ok(mut parsed) = serde_json::from_str::<Value>(&text) else {
            // Not JSON — hand it back and let the caller's repair path try, the
            // same as the local backend does.
            return Ok(text);
        };
        if clamp_to_schema(&mut parsed, schema) {
            tracing::warn!(target: "flux::agent", "gemini exceeded a maxLength; truncated to the schema bound");
        }
        Ok(parsed.to_string())
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        let raw = self.post("generateContent", &self.body(prompt, None))?;
        extract_text(&raw)
    }

    fn chat_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        use std::io::{BufRead, BufReader};

        let resp = self
            .agent
            .post(&format!("{}?alt=sse", self.url("streamGenerateContent")))
            .set("x-goog-api-key", &self.key)
            .set("Content-Type", "application/json")
            .send_json(self.body(prompt, None));
        let reader = match resp {
            Ok(r) => BufReader::new(r.into_reader()),
            Err(ureq::Error::Status(code, r)) => {
                let detail = r.into_string().unwrap_or_default();
                return Err(AgentError::Inference(explain_status(code, &detail)));
            }
            Err(e) => return Err(AgentError::Inference(format!("gemini: {e}"))),
        };

        let mut full = String::new();
        for line in reader.lines() {
            let line = line.map_err(|e| AgentError::Inference(format!("gemini: {e}")))?;
            let Some(payload) = line.strip_prefix("data: ") else {
                continue;
            };
            if payload.trim() == "[DONE]" {
                break;
            }
            // A chunk that doesn't parse is a keepalive or a partial frame, not a
            // failure — the stream is still live, so skip rather than abort.
            let Ok(v) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
                for t in parts.iter().filter_map(|p| p["text"].as_str()) {
                    full.push_str(t);
                    on_token(t);
                }
            }
        }
        if full.is_empty() {
            return Err(AgentError::Inference(
                "gemini: the stream produced no text (a safety filter or an empty candidate)"
                    .into(),
            ));
        }
        Ok(full)
    }
}

/// Models this key can actually reach, newest-looking first.
///
/// Asked rather than hardcoded: the model line-up changes faster than this file
/// does, and a stale constant list is how a working key ends up looking broken.
/// Only models advertising `generateContent` are returned — embedding models
/// can't answer a prompt.
pub fn list_models(key: &str) -> Result<Vec<String>, AgentError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build();
    let raw = match agent
        .get(&format!("{}/models?pageSize=200", api_base()))
        .set("x-goog-api-key", key)
        .call()
    {
        Ok(r) => r
            .into_string()
            .map_err(|e| AgentError::Inference(format!("gemini: {e}")))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(AgentError::Inference(explain_status(code, &detail)));
        }
        Err(e) => return Err(AgentError::Inference(format!("gemini: {e}"))),
    };
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| AgentError::Inference(format!("gemini: unparseable model list: {e}")))?;
    let mut out: Vec<String> = v["models"]
        .as_array()
        .map(|ms| {
            ms.iter()
                .filter(|m| {
                    m["supportedGenerationMethods"]
                        .as_array()
                        .map(|g| g.iter().any(|s| s.as_str() == Some("generateContent")))
                        .unwrap_or(false)
                })
                .filter_map(|m| m["name"].as_str())
                .map(|n| n.trim_start_matches("models/").to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.reverse(); // later version numbers sort last ascending, so show them first
    Ok(out)
}

/// Confirm a key works before it is relied on, returning the model count so the
/// UI can say something concrete instead of "OK".
pub fn verify_key(key: &str) -> Result<String, AgentError> {
    let models = list_models(key)?;
    if models.is_empty() {
        return Err(AgentError::Inference(
            "gemini: the key works but exposes no chat-capable models".into(),
        ));
    }
    Ok(format!("Key verified — {} models available", models.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_the_constructs_flux_actually_uses() {
        // This is `action_schema`'s shape: a oneOf of variants, each pinning the
        // discriminant with `const` and closing the object.
        let flux = json!({
            "oneOf": [{
                "type": "object",
                "properties": {
                    "action": { "const": "click" },
                    "selector": { "type": "string" },
                    "folder": { "type": ["string", "null"] },
                },
                "required": ["action", "selector"],
                "additionalProperties": false,
            }]
        });
        let g = to_gemini_schema(&flux);

        assert!(g.get("oneOf").is_none(), "oneOf must become anyOf");
        let variant = &g["anyOf"][0];
        assert_eq!(variant["type"], "OBJECT", "types are proto enum names");
        assert!(
            variant.get("additionalProperties").is_none(),
            "unsupported keyword must be dropped, not sent"
        );
        // `const` → single-valued enum, with the type Gemini requires alongside.
        assert_eq!(variant["properties"]["action"]["enum"], json!(["click"]));
        assert_eq!(variant["properties"]["action"]["type"], "STRING");
        // Union type → type + nullable.
        assert_eq!(variant["properties"]["folder"]["type"], "STRING");
        assert_eq!(variant["properties"]["folder"]["nullable"], true);
        // `required` is supported and must survive untouched.
        assert_eq!(variant["required"], json!(["action", "selector"]));
    }

    #[test]
    fn gives_a_bare_enum_the_type_it_needs() {
        let g = to_gemini_schema(&json!({ "enum": ["csv", "json"] }));
        assert_eq!(g["type"], "STRING");
        assert_eq!(g["enum"], json!(["csv", "json"]));
    }

    #[test]
    fn passes_through_keywords_it_does_not_know() {
        // Forward-compatible on purpose: an unknown keyword is forwarded so new
        // support starts working without a change here.
        let g = to_gemini_schema(&json!({ "type": "string", "maxLength": 42, "description": "x" }));
        assert_eq!(g["maxLength"], 42);
        assert_eq!(g["description"], "x");
    }

    #[test]
    fn translates_the_real_schemas_without_leaving_unsupported_keywords() {
        // The actual schemas, not a hand-written stand-in — this is what catches
        // a construct being added upstream that the translator doesn't know.
        for schema in [crate::action_schema(true), crate::note_action_schema()] {
            let g = to_gemini_schema(&schema);
            let mut bad = Vec::new();
            walk(&g, &mut |k, v| {
                if matches!(k, "oneOf" | "const" | "additionalProperties") {
                    bad.push(k.to_string());
                }
                if k == "type" {
                    if let Some(s) = v.as_str() {
                        assert_eq!(s, s.to_uppercase(), "type must be a proto enum name");
                    } else {
                        bad.push("type-array".into());
                    }
                }
            });
            assert!(
                bad.is_empty(),
                "untranslated keywords reached Gemini: {bad:?}"
            );
        }
    }

    fn walk(v: &Value, f: &mut impl FnMut(&str, &Value)) {
        match v {
            Value::Object(m) => {
                for (k, sub) in m {
                    f(k, sub);
                    walk(sub, f);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, f)),
            _ => {}
        }
    }

    #[test]
    fn clamps_an_over_long_body_instead_of_losing_the_note() {
        // Ollama enforces maxLength in the grammar; Gemini may ignore it, and the
        // cap exists for a reason — so it is re-imposed here.
        let schema = json!({
            "oneOf": [{
                "type": "object",
                "properties": {
                    "action": { "const": "new_note" },
                    "body": { "type": "string", "maxLength": 10 },
                },
            }]
        });
        let mut v = json!({ "action": "new_note", "body": "abcdefghijKLMNOP" });
        assert!(clamp_to_schema(&mut v, &schema), "should report clamping");
        assert_eq!(v["body"], "abcdefghij");

        // Within bounds ⇒ untouched, and no false report.
        let mut ok = json!({ "action": "new_note", "body": "short" });
        assert!(!clamp_to_schema(&mut ok, &schema));
        assert_eq!(ok["body"], "short");
    }

    #[test]
    fn clamps_on_a_character_boundary() {
        // Truncating by bytes would split a multi-byte char and produce invalid
        // UTF-8 — or panic on a slice. Count characters.
        let schema = json!({ "type": "string", "maxLength": 3 });
        let mut v = json!("héllo wörld");
        assert!(clamp_to_schema(&mut v, &schema));
        assert_eq!(v, "hél");
    }

    #[test]
    fn clamping_understands_the_translated_dialect_too() {
        // The variant picker has to work whether it sees `const` (pre-translation)
        // or `enum: [x]` (post-translation), since either may be in hand.
        let translated = to_gemini_schema(&json!({
            "oneOf": [{
                "type": "object",
                "properties": {
                    "action": { "const": "new_note" },
                    "body": { "type": "string", "maxLength": 4 },
                },
            }]
        }));
        let mut v = json!({ "action": "new_note", "body": "toolong" });
        assert!(clamp_to_schema(&mut v, &translated));
        assert_eq!(v["body"], "tool");
    }

    #[test]
    fn reports_a_blocked_prompt_rather_than_an_empty_reply() {
        // A safety block is a 200 with no text. Returning "" would look like the
        // model simply had nothing to say.
        let raw = json!({ "promptFeedback": { "blockReason": "SAFETY" } }).to_string();
        let err = extract_text(&raw).unwrap_err().to_string();
        assert!(err.contains("blocked"), "{err}");

        let raw =
            json!({ "candidates": [{ "finishReason": "SAFETY", "content": { "parts": [] } }] })
                .to_string();
        let err = extract_text(&raw).unwrap_err().to_string();
        assert!(err.contains("safety filter"), "{err}");
    }

    #[test]
    fn joins_multi_part_replies() {
        let raw = json!({
            "candidates": [{ "content": { "parts": [{ "text": "one " }, { "text": "two" }] } }]
        })
        .to_string();
        assert_eq!(extract_text(&raw).unwrap(), "one two");
    }

    #[test]
    fn a_rejected_key_says_a_subscription_is_not_a_key() {
        // The exact confusion this feature invites, so the error pre-empts it.
        let msg = explain_status(
            403,
            &json!({ "error": { "message": "API key not valid" } }).to_string(),
        );
        assert!(msg.contains("AI Studio"), "{msg}");
        assert!(msg.contains("not an API key"), "{msg}");
    }

    #[test]
    fn structured_requests_ask_for_json_and_carry_the_schema() {
        let b = GeminiBackend::new("k".into(), "m");
        let body = b.body("hi", Some(&json!({ "type": "object" })));
        assert_eq!(
            body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(body["generationConfig"]["responseSchema"]["type"], "OBJECT");
        // Free chat must not pin a mime type, or plain replies come back as JSON.
        let chat = b.body("hi", None);
        assert!(chat["generationConfig"].get("responseMimeType").is_none());
    }
}
