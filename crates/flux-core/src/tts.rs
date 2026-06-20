//! Local neural TTS via **Piper** (offline) — gives Gemma a spoken voice without
//! any cloud service. We shell out to the `piper` binary, feed it text on stdin,
//! and return the synthesized WAV (base64) for the webview to play.
//!
//! No cargo feature gates this: Piper is a subprocess, so the default build always
//! carries the command and simply returns a friendly error when Piper or its voice
//! model isn't installed. The frontend treats that error as "fall back to the OS
//! `speechSynthesis` voice", so the conversational loop works either way — Piper is
//! purely the higher-quality, still-fully-local upgrade.
//!
//! Privacy: text never leaves the machine; Piper synthesizes locally and we hand
//! the audio straight back to the webview. Nothing is written to disk.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

fn piper_bin() -> String {
    std::env::var("FLUX_PIPER_BIN").unwrap_or_else(|_| "piper".into())
}

/// The Piper voice model (`.onnx`) — `FLUX_PIPER_MODEL`, else a common local spot.
fn piper_model() -> Result<String, String> {
    if let Ok(m) = std::env::var("FLUX_PIPER_MODEL") {
        return Ok(m);
    }
    // Convention: a voice dropped next to AudioPulse's models or the user's data dir.
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        for cand in [
            format!("{home}/.local/share/piper/voice.onnx"),
            format!("{home}/AudioPulse/third_party/piper/voice.onnx"),
        ] {
            if std::path::Path::new(&cand).is_file() {
                return Ok(cand);
            }
        }
    }
    Err("Piper voice not found — set FLUX_PIPER_MODEL to a .onnx voice (its .onnx.json must sit beside it)".into())
}

/// Synthesize `text` to a WAV with Piper; returns the WAV as base64 for the webview
/// to play (`new Audio('data:audio/wav;base64,…')`). Errors are expected when Piper
/// isn't installed — the caller falls back to the OS voice.
#[tauri::command]
pub async fn voice_speak(text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = text.trim().to_string();
        if t.is_empty() {
            return Err("nothing to speak".into());
        }
        let model = piper_model()?;
        let mut child = Command::new(piper_bin())
            .args(["--model", &model, "--output_file", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("couldn't run Piper ({e}) — install it or set FLUX_PIPER_BIN"))?;
        // Write the text on a thread so a large reply can't deadlock against a
        // filling stdout pipe; dropping the handle there signals EOF to Piper.
        let mut stdin = child.stdin.take().ok_or("no piper stdin")?;
        std::thread::spawn(move || {
            let _ = stdin.write_all(t.as_bytes());
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err: String = String::from_utf8_lossy(&out.stderr).chars().take(200).collect();
            return Err(format!("piper failed: {err}"));
        }
        if out.stdout.is_empty() {
            return Err("piper produced no audio".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── ElevenLabs (cloud TTS) ───────────────────────────────────────────────────
//
// Opt-in and explicitly NOT local: when this engine is chosen, Gemma's reply
// *text* is sent to ElevenLabs to synthesize speech (the mic audio / STT stay
// local — only the text leaves). The API key lives in the OS keyring, never in
// the renderer or localStorage.

const EL_SERVICE: &str = "flux.elevenlabs";
const EL_ACCOUNT: &str = "api-key";
const EL_API: &str = "https://api.elevenlabs.io/v1";

fn el_http() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build()
}

fn el_key() -> Result<String, String> {
    let entry = keyring::Entry::new(EL_SERVICE, EL_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(k) if !normalize_el_key(&k).is_empty() => Ok(normalize_el_key(&k)),
        _ => Err("no ElevenLabs API key set — add it in Settings → Integrations".into()),
    }
}

fn el_err(action: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => format!(
            "ElevenLabs {action}: API key rejected (401). Flux cleaned common pasted-key wrappers; regenerate the key in ElevenLabs and save it again."
        ),
        ureq::Error::Status(code, r) => {
            let body: String = r.into_string().unwrap_or_default().chars().take(180).collect();
            format!("ElevenLabs {action} failed ({code}): {body}")
        }
        e => format!("ElevenLabs {action} failed: {e}"),
    }
}

fn normalize_el_key(key: &str) -> String {
    let mut k = key.trim().trim_matches(['"', '\'', '`']).trim().to_string();
    if let Some(extracted) = extract_el_key_candidate(&k) {
        k = extracted;
    }
    for _ in 0..8 {
        let lower = k.to_ascii_lowercase();
        if let Some(rest) = prefixed_value(&k, "authorization:")
            .or_else(|| prefixed_value(&k, "xi-api-key:"))
            .or_else(|| prefixed_value(&k, "x-api-key:"))
            .or_else(|| prefixed_value(&k, "api-key:"))
            .or_else(|| prefixed_value(&k, "elevenlabs_api_key="))
            .or_else(|| prefixed_value(&k, "xi_api_key="))
            .or_else(|| prefixed_value(&k, "api_key="))
            .or_else(|| prefixed_value(&k, "key="))
        {
            k = rest.to_string();
            continue;
        }
        if lower.starts_with("bearer ") {
            k = k["bearer ".len()..].trim().to_string();
            continue;
        }
        if let Some((left, right)) = k.split_once('=') {
            if left.to_ascii_lowercase().contains("key") {
                k = right.trim().to_string();
                continue;
            }
        }
        break;
    }
    k.trim().trim_matches(['"', '\'', '`']).trim().to_string()
}

fn prefixed_value<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .to_ascii_lowercase()
        .starts_with(prefix)
        .then(|| value[prefix.len()..].trim().trim_matches(['"', '\'', '`']).trim())
}

fn extract_el_key_candidate(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    for marker in [
        "xi-api-key",
        "x-api-key",
        "authorization",
        "elevenlabs_api_key",
        "xi_api_key",
        "api_key",
    ] {
        if let Some(idx) = lower.find(marker) {
            if let Some(token) = first_key_token(&input[idx + marker.len()..]) {
                return Some(token);
            }
        }
    }
    let tokens: Vec<String> = input
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .filter_map(|token| {
            let token = token.trim().trim_matches(['"', '\'', '`']).trim();
            is_plausible_el_key(token).then(|| token.to_string())
        })
        .collect();
    tokens
        .iter()
        .find(|token| token.starts_with("sk_"))
        .cloned()
        .or_else(|| tokens.first().cloned())
}

fn first_key_token(input: &str) -> Option<String> {
    input
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .find_map(|token| {
            let token = token.trim().trim_matches(['"', '\'', '`']).trim();
            is_plausible_el_key(token).then(|| token.to_string())
        })
}

fn is_plausible_el_key(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    token.len() >= 20
        && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !matches!(
            lower.as_str(),
            "authorization" | "bearer" | "elevenlabs_api_key" | "xi_api_key" | "xi-api-key" | "api_key"
        )
}

/// Store (or, with an empty string, clear) the ElevenLabs API key in the keyring.
#[tauri::command]
pub fn elevenlabs_set_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(EL_SERVICE, EL_ACCOUNT).map_err(|e| e.to_string())?;
    let key = normalize_el_key(&key);
    if key.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(&key).map_err(|e| e.to_string())
    }
}

/// Whether an ElevenLabs API key is stored (so the UI can show key-set state
/// without ever reading the key back into the renderer).
#[tauri::command]
pub fn elevenlabs_has_key() -> bool {
    keyring::Entry::new(EL_SERVICE, EL_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| !normalize_el_key(&k).is_empty())
        .unwrap_or(false)
}

/// Verify that the stored key is accepted by ElevenLabs before the user tries to
/// import a voice or synthesize speech.
#[tauri::command]
pub async fn elevenlabs_verify_key() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = el_key()?;
        el_http()
            .get(&format!("{EL_API}/voices"))
            .set("xi-api-key", &key)
            .call()
            .map_err(|e| el_err("verify key", e))?;
        Ok("Key verified".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct ElVoice {
    id: String,
    name: String,
}

fn clean_el_path_segment(label: &str, value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("missing {label}"));
    }
    if !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("{label} contains invalid characters"));
    }
    Ok(v.to_string())
}

fn el_get_voice(key: &str, voice_id: &str) -> Result<ElVoice, ureq::Error> {
    let v: Value = el_http()
        .get(&format!("{EL_API}/voices/{voice_id}"))
        .set("xi-api-key", key)
        .call()?
        .into_json()
        .unwrap_or_else(|_| json!({}));
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or(voice_id);
    Ok(ElVoice { id: voice_id.to_string(), name: name.to_string() })
}

fn el_find_shared_owner(key: &str, voice_id: &str) -> Result<Option<String>, String> {
    let resp = el_http()
        .get(&format!("{EL_API}/shared-voices"))
        .query("search", voice_id)
        .query("page_size", "100")
        .set("xi-api-key", key)
        .call()
        .map_err(|e| el_err("search shared voices", e))?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    let list = v.get("voices").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    Ok(list.iter().find_map(|voice| {
        let id = voice.get("voice_id").and_then(|x| x.as_str())?;
        if id != voice_id {
            return None;
        }
        voice
            .get("public_owner_id")
            .or_else(|| voice.get("public_user_id"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string())
    }))
}

/// The voices available on the configured ElevenLabs account.
#[tauri::command]
pub async fn elevenlabs_voices() -> Result<Vec<ElVoice>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = el_key()?;
        let resp = el_http()
            .get(&format!("{EL_API}/voices"))
            .set("xi-api-key", &key)
            .call()
            .map_err(|e| el_err("list voices", e))?;
        let v: Value = resp.into_json().map_err(|e| e.to_string())?;
        let list = v.get("voices").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        Ok(list
            .iter()
            .filter_map(|voice| {
                let id = voice.get("voice_id").and_then(|x| x.as_str())?;
                let name = voice.get("name").and_then(|n| n.as_str()).unwrap_or(id);
                Some(ElVoice { id: id.to_string(), name: name.to_string() })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add a Voice Library / shared voice to the configured account, then return the
/// account voice ID that can be used for TTS.
#[tauri::command]
pub async fn elevenlabs_import_voice(
    voice_id: String,
    public_owner_id: String,
    name: String,
) -> Result<ElVoice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let voice_id = clean_el_path_segment("voice ID", &voice_id)?;
        let key = el_key()?;

        let owner = if public_owner_id.trim().is_empty() {
            if let Ok(v) = el_get_voice(&key, &voice_id) {
                return Ok(v);
            }
            el_find_shared_owner(&key, &voice_id)?.ok_or_else(|| {
                "ElevenLabs could not find that shared voice. Paste the full voice-library link, or add the voice in ElevenLabs first.".to_string()
            })?
        } else {
            public_owner_id.trim().to_string()
        };
        let owner = clean_el_path_segment("public owner ID", &owner)?;
        let new_name = if name.trim().is_empty() {
            format!("Flux {}", voice_id.chars().take(8).collect::<String>())
        } else {
            name.trim().to_string()
        };

        match el_http()
            .post(&format!("{EL_API}/voices/add/{owner}/{voice_id}"))
            .set("xi-api-key", &key)
            .set("content-type", "application/json")
            .send_json(json!({ "new_name": new_name, "bookmarked": true }))
        {
            Ok(resp) => {
                let v: Value = resp.into_json().map_err(|e| e.to_string())?;
                let id = v.get("voice_id").and_then(|x| x.as_str()).unwrap_or(&voice_id);
                Ok(ElVoice { id: id.to_string(), name: name.trim().to_string() })
            }
            Err(e) => match el_get_voice(&key, &voice_id) {
                Ok(v) => Ok(v),
                Err(_) => Err(el_err("add shared voice", e)),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Synthesize `text` with ElevenLabs; returns base64 MP3 for the webview to play.
#[tauri::command]
pub async fn elevenlabs_speak(text: String, voice_id: String, model_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = text.trim().to_string();
        if t.is_empty() {
            return Err("nothing to speak".into());
        }
        if voice_id.trim().is_empty() {
            return Err("no ElevenLabs voice selected".into());
        }
        let key = el_key()?;
        let model = if model_id.trim().is_empty() { "eleven_turbo_v2_5" } else { model_id.trim() };
        let resp = el_http()
            .post(&format!("{EL_API}/text-to-speech/{}", voice_id.trim()))
            .set("xi-api-key", &key)
            .set("accept", "audio/mpeg")
            .send_json(json!({
                "text": t,
                "model_id": model,
                "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 }
            }))
            .map_err(|e| el_err("synthesize", e))?;
        let mut bytes = Vec::new();
        resp.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return Err("ElevenLabs returned no audio".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::normalize_el_key;

    const KEY: &str = "sk_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJK";

    #[test]
    fn normalizes_labeled_elevenlabs_keys() {
        assert_eq!(normalize_el_key(KEY), KEY);
        assert_eq!(normalize_el_key(&format!("Bearer {KEY}")), KEY);
        assert_eq!(normalize_el_key(&format!("xi-api-key: {KEY}")), KEY);
        assert_eq!(normalize_el_key(&format!("ELEVENLABS_API_KEY={KEY}")), KEY);
    }

    #[test]
    fn extracts_key_from_snippets() {
        assert_eq!(normalize_el_key(&format!(r#"{{"xi-api-key":"{KEY}"}}"#)), KEY);
        assert_eq!(normalize_el_key(&format!(r#"curl -H "xi-api-key: {KEY}" https://api.elevenlabs.io/v1/voices"#)), KEY);
    }
}
