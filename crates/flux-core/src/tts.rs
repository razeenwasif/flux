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

use std::io::Write;
use std::process::{Command, Stdio};

use base64::Engine as _;

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
