//! OpenAI-compatible backend — the agent's model on another machine's GPU.
//!
//! For a server that speaks the OpenAI API rather than Ollama's: llama.cpp's
//! `llama-server` (what Nexus serves from its Inference tab, at
//! `http://<node>:8080/v1`), vLLM, LM Studio. It stands in for the local Ollama
//! model with the same prompts and the same structured output, so the laptop
//! only sends text and the weights live where the VRAM is. Chosen in Settings
//! (Model server); see `flux_core::modelserver`.
//!
//! The server is on the home network, so it isn't always there. When it can't
//! be reached the request goes to the fallback (the laptop's own Ollama), and
//! for a short while after that every request does, rather than each one
//! waiting out a connect timeout first.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{AgentError, Inference};

/// Output ceilings, as the Ollama backend uses: structured replies stop when
/// the object closes, so theirs is a safety cap; chat gets room to finish.
const STRUCTURED_MAX_TOKENS: u32 = 1536;
const CHAT_MAX_TOKENS: u32 = 2048;
/// How long to keep going straight to the fallback after the server was out
/// of reach.
const DOWN_FOR_MS: u64 = 60_000;

/// `http://host:8080`, `http://host:8080/`, `http://host:8080/v1/` → `http://host:8080/v1`.
pub fn api_base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.ends_with("/v1") {
        u.to_string()
    } else {
        format!("{u}/v1")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Why a request didn't come back with a reply.
enum CallError {
    /// No answer from the server at all (off, asleep, another network).
    Unreachable(String),
    Other(AgentError),
}

pub struct OpenAiBackend {
    base: String,
    key: Option<String>,
    model: String,
    fallback: Option<Box<dyn Inference>>,
    /// When the server last couldn't be reached (ms since the epoch; 0 = never).
    down_since: AtomicU64,
}

impl OpenAiBackend {
    pub fn new(
        url: &str,
        key: Option<String>,
        model: &str,
        fallback: Option<Box<dyn Inference>>,
    ) -> Self {
        Self {
            base: api_base(url),
            key: key.filter(|k| !k.trim().is_empty()),
            model: model.to_string(),
            fallback,
            down_since: AtomicU64::new(0),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    fn post(&self, body: &Value, read: Duration) -> Result<ureq::Response, CallError> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(read)
            .build();
        let mut req = agent.post(&format!("{}/chat/completions", self.base));
        if let Some(k) = &self.key {
            req = req.set("Authorization", &format!("Bearer {k}"));
        }
        match req.send_json(body.clone()) {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(code, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                Err(CallError::Other(AgentError::Inference(status_message(
                    code, &text, &self.base,
                ))))
            }
            Err(ureq::Error::Transport(t)) => Err(CallError::Unreachable(format!(
                "can't reach the model server at {}: {t}",
                self.base
            ))),
        }
    }

    fn body(&self, prompt: &str, schema: Option<&Value>, structured: bool, stream: bool) -> Value {
        let mut b = json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": if structured { 0.1 } else { 0.6 },
            "max_tokens": if structured { STRUCTURED_MAX_TOKENS } else { CHAT_MAX_TOKENS },
            "stream": stream,
        });
        if structured {
            b["response_format"] = match schema {
                // llama-server turns this into a grammar, so the reply is
                // constrained to the schema as Ollama's `format` constrains it.
                Some(s) => json!({
                    "type": "json_schema",
                    "json_schema": { "name": "flux", "strict": true, "schema": s },
                }),
                None => json!({ "type": "json_object" }),
            };
        }
        b
    }

    fn complete_once(
        &self,
        prompt: &str,
        schema: Option<&Value>,
        structured: bool,
    ) -> Result<String, CallError> {
        let resp = self.post(
            &self.body(prompt, schema, structured, false),
            Duration::from_secs(300),
        )?;
        let v: Value = resp.into_json().map_err(|e| {
            CallError::Other(AgentError::Inference(format!(
                "model server reply unreadable: {e}"
            )))
        })?;
        v["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| {
                CallError::Other(AgentError::Inference(format!(
                    "model server sent no reply text: {v}"
                )))
            })
    }

    fn stream_once(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, CallError> {
        let resp = self.post(
            &self.body(prompt, None, false, true),
            Duration::from_secs(120),
        )?;
        let mut full = String::new();
        for line in BufReader::new(resp.into_reader()).lines() {
            let line = line.map_err(|e| {
                CallError::Other(AgentError::Inference(format!("stream broke off: {e}")))
            })?;
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue; // blank keep-alives, `event:` lines
            };
            if data == "[DONE]" {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                if !t.is_empty() {
                    on_token(t);
                    full.push_str(t);
                }
            }
        }
        Ok(full)
    }

    /// Run `call` against the server, or the fallback when the server is out
    /// of reach (or was a moment ago).
    fn run<T>(
        &self,
        call: impl FnOnce() -> Result<T, CallError>,
        fallback: impl FnOnce(&dyn Inference) -> Result<T, AgentError>,
    ) -> Result<T, AgentError> {
        let recently_down =
            now_ms().saturating_sub(self.down_since.load(Ordering::Relaxed)) < DOWN_FOR_MS;
        if recently_down {
            if let Some(fb) = &self.fallback {
                return fallback(fb.as_ref());
            }
        }
        match call() {
            Ok(v) => {
                self.down_since.store(0, Ordering::Relaxed);
                Ok(v)
            }
            Err(CallError::Unreachable(why)) => {
                self.down_since.store(now_ms(), Ordering::Relaxed);
                match &self.fallback {
                    Some(fb) => {
                        tracing::warn!(target: "flux::agent", %why, "model server out of reach; using the local model");
                        fallback(fb.as_ref())
                    }
                    None => Err(AgentError::Inference(why)),
                }
            }
            Err(CallError::Other(e)) => Err(e),
        }
    }
}

/// What a refused request means, in the words the agent panel shows.
fn status_message(code: u16, body: &str, base: &str) -> String {
    let detail: String = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match code {
        401 | 403 => format!(
            "the model server at {base} refused the API key ({code}). A server that issues a new key each \
             time it starts (Nexus does) needs the new one in Settings → Model server."
        ),
        404 => format!("the model server at {base} has no /chat/completions ({code}): is that the OpenAI API's address?"),
        _ => format!("the model server at {base} answered {code}: {detail}"),
    }
}

/// The models the server offers (`GET /models`): what Settings lists, and how
/// it tests the address and key.
pub fn list_models(url: &str, key: Option<&str>) -> Result<Vec<String>, AgentError> {
    let base = api_base(url);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(10))
        .build();
    let mut req = agent.get(&format!("{base}/models"));
    if let Some(k) = key.filter(|k| !k.trim().is_empty()) {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    let v: Value = match req.call() {
        Ok(r) => r
            .into_json()
            .map_err(|e| AgentError::Inference(format!("model list unreadable: {e}")))?,
        Err(ureq::Error::Status(code, resp)) => {
            return Err(AgentError::Inference(status_message(
                code,
                &resp.into_string().unwrap_or_default(),
                &base,
            )))
        }
        Err(ureq::Error::Transport(t)) => {
            return Err(AgentError::Inference(format!("can't reach {base}: {t}")))
        }
    };
    Ok(v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

impl Inference for OpenAiBackend {
    fn complete(&self, prompt: &str, schema: Option<&Value>) -> Result<String, AgentError> {
        self.run(
            || self.complete_once(prompt, schema, true),
            |fb| fb.complete(prompt, schema),
        )
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        self.run(
            || self.complete_once(prompt, None, false),
            |fb| fb.chat(prompt),
        )
    }

    fn chat_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        // A stream that has started is the server's; only one that never
        // connected falls back (`run` sees Unreachable before any token).
        let mut sent = false;
        let mut forward = |t: &str| {
            sent = true;
            on_token(t);
        };
        match self.stream_once(prompt, &mut forward) {
            Ok(v) => {
                self.down_since.store(0, Ordering::Relaxed);
                Ok(v)
            }
            Err(CallError::Unreachable(why)) if !sent => {
                self.down_since.store(now_ms(), Ordering::Relaxed);
                match &self.fallback {
                    Some(fb) => {
                        tracing::warn!(target: "flux::agent", %why, "model server out of reach; using the local model");
                        fb.chat_stream(prompt, on_token)
                    }
                    None => Err(AgentError::Inference(why)),
                }
            }
            Err(CallError::Unreachable(why)) => Err(AgentError::Inference(why)),
            Err(CallError::Other(e)) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_base_always_ends_in_v1() {
        for u in [
            "http://192.168.68.200:8080",
            "http://192.168.68.200:8080/",
            "http://192.168.68.200:8080/v1",
            " http://192.168.68.200:8080/v1/ ",
        ] {
            assert_eq!(api_base(u), "http://192.168.68.200:8080/v1");
        }
    }

    #[test]
    fn structured_requests_carry_the_schema_and_chat_does_not() {
        let b = OpenAiBackend::new("http://x:8080", Some("k".into()), "gemma", None);
        let schema = json!({ "type": "object" });
        let s = b.body("act", Some(&schema), true, false);
        assert_eq!(s["response_format"]["type"], "json_schema");
        assert_eq!(s["response_format"]["json_schema"]["schema"], schema);
        assert_eq!(s["temperature"], 0.1);
        assert_eq!(s["messages"][0]["content"], "act");
        let free_json = b.body("act", None, true, false);
        assert_eq!(free_json["response_format"]["type"], "json_object");
        let chat = b.body("hi", None, false, true);
        assert!(chat.get("response_format").is_none());
        assert_eq!(chat["stream"], true);
    }

    struct Local;
    impl Inference for Local {
        fn complete(&self, _: &str, _: Option<&Value>) -> Result<String, AgentError> {
            Ok("{\"from\":\"local\"}".into())
        }
        fn chat(&self, _: &str) -> Result<String, AgentError> {
            Ok("local".into())
        }
    }

    #[test]
    fn an_unreachable_server_falls_back_and_stays_fallen_back_a_while() {
        // Nothing listens on a port we just bound and dropped.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let b = OpenAiBackend::new(
            &format!("http://127.0.0.1:{port}"),
            None,
            "m",
            Some(Box::new(Local)),
        );
        assert_eq!(b.chat("hi").unwrap(), "local");
        assert!(b.down_since.load(Ordering::Relaxed) > 0);
        let mut got = String::new();
        assert_eq!(
            b.chat_stream("hi", &mut |t| got.push_str(t)).unwrap(),
            "local"
        );
        assert_eq!(got, "local");
        // With no fallback, it says where it couldn't reach.
        let alone = OpenAiBackend::new(&format!("http://127.0.0.1:{port}"), None, "m", None);
        let err = alone.chat("hi").unwrap_err().to_string();
        assert!(err.contains("can't reach the model server"), "{err}");
    }

    #[test]
    fn a_refused_key_says_what_to_do() {
        let m = status_message(
            401,
            "{\"error\":{\"message\":\"Invalid API Key\"}}",
            "http://x:8080/v1",
        );
        assert!(
            m.contains("refused the API key") && m.contains("Settings"),
            "{m}"
        );
        let other = status_message(
            500,
            "{\"error\":{\"message\":\"boom\"}}",
            "http://x:8080/v1",
        );
        assert!(other.ends_with("boom"), "{other}");
    }
}
