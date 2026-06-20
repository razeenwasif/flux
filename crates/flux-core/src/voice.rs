//! Push-to-talk voice input — offline speech-to-text via Vosk, reusing the model
//! AudioPulse already ships.
//!
//! The frontend records mic audio in the browser (Web Audio) as little-endian
//! mono i16 PCM and sends it base64-encoded with its sample rate; we feed it to a
//! Vosk recognizer and hand back the transcript. Gated behind the `voice` cargo
//! feature because it needs the native `libvosk` (Linux: AudioPulse's
//! `third_party/vosk/libvosk.so`; Windows: `libvosk.dll`). Without the feature the
//! command compiles but returns a clear "not built" message, so the default build
//! stays lean (mirrors the `llama` feature).

/// Decode base64 little-endian i16 PCM into samples.
#[cfg(feature = "voice")]
fn decode_pcm(b64: &str) -> Result<Vec<i16>, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    Ok(bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
}

/// The Vosk model path — `FLUX_VOSK_MODEL`, else AudioPulse's bundled model.
#[cfg(feature = "voice")]
fn model_path() -> Option<String> {
    if let Ok(p) = std::env::var("FLUX_VOSK_MODEL") {
        return Some(p);
    }
    let home = std::env::var("HOME").ok()?;
    let cand = format!("{home}/AudioPulse/third_party/vosk/model");
    std::path::Path::new(&cand).is_dir().then_some(cand)
}

#[cfg(feature = "voice")]
fn transcribe(pcm: &[i16], sample_rate: f32) -> Result<String, String> {
    use vosk::{CompleteResult, Model, Recognizer};
    // The model is heavy (~tens of MB) — load once and keep it resident.
    static MODEL: std::sync::OnceLock<Option<Model>> = std::sync::OnceLock::new();
    let model = MODEL
        .get_or_init(|| model_path().and_then(Model::new))
        .as_ref()
        .ok_or("Vosk model not found — set FLUX_VOSK_MODEL to a model dir (e.g. AudioPulse's third_party/vosk/model)")?;
    let mut rec = Recognizer::new(model, sample_rate).ok_or("couldn't create the Vosk recognizer")?;
    rec.accept_waveform(pcm).map_err(|e| format!("vosk decode: {e}"))?;
    let text = match rec.final_result() {
        CompleteResult::Single(r) => r.text.to_string(),
        CompleteResult::Multiple(_) => String::new(),
    };
    Ok(text.trim().to_string())
}

/// Transcribe a recorded utterance (base64 LE-i16 PCM at `sample_rate` Hz).
#[tauri::command]
pub async fn voice_transcribe(pcm_b64: String, sample_rate: f32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "voice")]
        {
            let pcm = decode_pcm(&pcm_b64)?;
            transcribe(&pcm, sample_rate)
        }
        #[cfg(not(feature = "voice"))]
        {
            let _ = (pcm_b64, sample_rate);
            Err("voice input isn't built into this binary — rebuild with `--features voice` (needs libvosk)".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
