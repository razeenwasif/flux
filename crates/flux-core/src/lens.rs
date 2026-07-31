//! Visual Lens (#115) — identify what's on the page with a LOCAL vision model.
//!
//! The frontend captures the active page to a PNG (#54), then calls this with the
//! path. We base64 the image and ask a multimodal model over Ollama's
//! `/api/generate` `images` field — `gemma3:4b` by default (`FLUX_VISION_MODEL`
//! overrides). Fully local, no cloud, like the rest of the agent.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

fn ollama_url() -> String {
    std::env::var("FLUX_OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into())
}
fn vision_model() -> String {
    std::env::var("FLUX_VISION_MODEL").unwrap_or_else(|_| "gemma3:4b".into())
}

const DEFAULT_PROMPT: &str = "You are a visual identifier, like Google Lens. Look at this screenshot of a web page \
and identify the main subject — a product, book, plant, animal, landmark, artwork, food, logo, or notable text. \
State what it is by name, then a short, useful description. If uncertain, give your best guess and say so. Be concise.";

/// Ask the local vision model about a base64 image. Shared by the page-capture
/// Lens and uploaded images.
pub(crate) fn vision_call(b64: String, prompt: Option<String>) -> Result<String, String> {
    if b64.is_empty() {
        return Err("no image data".into());
    }
    let model = vision_model();
    let user = prompt.unwrap_or_default();
    let p = if user.trim().is_empty() {
        DEFAULT_PROMPT.to_string()
    } else {
        user
    };
    let body = json!({
        "model": model,
        "prompt": p,
        "images": [b64],
        "stream": false,
        "keep_alive": "30m",
    });
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(180))
        .build()
        .post(&format!("{}/api/generate", ollama_url()))
        .send_json(body)
        .map_err(|e| {
            format!(
                "vision model request failed — is `{model}` pulled? (`ollama pull {model}`). {e}"
            )
        })?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    v.get("response")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("no answer from `{model}`"))
}

/// Identify the captured image at `image_path` with the local vision model.
/// `prompt` overrides the default "what is this" framing (e.g. a follow-up).
#[tauri::command]
pub async fn agent_lens(image_path: String, prompt: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&image_path)
            .map_err(|e| format!("couldn't read the page capture: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        vision_call(b64, prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ask the local vision model about an uploaded image (base64, no data: prefix).
#[tauri::command]
pub async fn agent_vision(image_b64: String, prompt: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || vision_call(image_b64, prompt))
        .await
        .map_err(|e| e.to_string())?
}
