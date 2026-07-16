//! Whisper.cpp speech-to-text (subprocess) — far more accurate command
//! transcription than the small Vosk model, especially with accents or noise.
//!
//! Like Piper TTS, this shells out to a binary (`whisper-cli`) rather than linking
//! a C++ library, so the default build needs no extra toolchain and Windows avoids
//! the import-lib pain. Whisper requires 16 kHz mono audio, so we resample the
//! browser's mic PCM, write a temp WAV, run whisper, and read the transcript.
//!
//! Privacy: fully local — audio goes to a temp file that's deleted immediately
//! after, and the model runs on-device. Used only for the *command* utterance
//! (after the wake word), where ~1–3 s of CPU latency is acceptable.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;

fn whisper_bin() -> String {
    std::env::var("FLUX_WHISPER_BIN").unwrap_or_else(|_| "whisper-cli".into())
}

/// The ggml whisper model — `FLUX_WHISPER_MODEL`, else a couple of common spots.
fn whisper_model() -> Result<String, String> {
    if let Ok(m) = std::env::var("FLUX_WHISPER_MODEL") {
        return Ok(m);
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        for cand in [
            format!("{home}/.local/share/whisper/ggml-base.en.bin"),
            format!("{home}/whisper.cpp/models/ggml-base.en.bin"),
            format!("{home}/AudioPulse/third_party/whisper/ggml-base.en.bin"),
        ] {
            if Path::new(&cand).is_file() {
                return Ok(cand);
            }
        }
    }
    Err("set FLUX_WHISPER_MODEL to a ggml whisper model (e.g. ggml-base.en.bin)".into())
}

fn decode_pcm(b64: &str) -> Result<Vec<i16>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

/// Linear-resample to 16 kHz (whisper's required rate).
fn resample_to_16k(input: &[i16], in_rate: u32) -> Vec<i16> {
    if in_rate == 16_000 || input.is_empty() {
        return input.to_vec();
    }
    let ratio = 16_000_f64 / in_rate as f64;
    let out_len = ((input.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = src - idx as f64;
        let a = input.get(idx).copied().unwrap_or(0) as f64;
        let b = input.get(idx + 1).copied().unwrap_or(a as i16) as f64;
        out.push((a + (b - a) * frac).round() as i16);
    }
    out
}

fn temp_wav() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("flux-stt-{}-{n}.wav", std::process::id()))
}

fn write_wav_16k(path: &Path, samples: &[i16]) -> Result<(), String> {
    let data_len = (samples.len() * 2) as u32;
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_len).to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&1u16.to_le_bytes()); // mono
    h.extend_from_slice(&16_000u32.to_le_bytes()); // sample rate
    h.extend_from_slice(&(16_000u32 * 2).to_le_bytes()); // byte rate
    h.extend_from_slice(&2u16.to_le_bytes()); // block align
    h.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_len.to_le_bytes());
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(&h).map_err(|e| e.to_string())?;
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        pcm.extend_from_slice(&s.to_le_bytes());
    }
    f.write_all(&pcm).map_err(|e| e.to_string())?;
    Ok(())
}

/// Strip whisper's non-speech markers + join lines.
fn clean(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .replace("[BLANK_AUDIO]", "")
        .replace("[ Silence ]", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Transcribe a recorded utterance (base64 LE-i16 PCM at `sample_rate` Hz) with
/// whisper.cpp. Returns the transcript text.
#[tauri::command]
pub async fn stt_whisper(pcm_b64: String, sample_rate: f32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pcm = decode_pcm(&pcm_b64)?;
        if pcm.is_empty() {
            return Ok(String::new());
        }
        let pcm16 = resample_to_16k(&pcm, sample_rate as u32);
        let model = whisper_model()?;
        let path = temp_wav();
        write_wav_16k(&path, &pcm16)?;
        let result = Command::new(whisper_bin())
            .args([
                "-m",
                &model,
                "-f",
                &path.to_string_lossy(),
                "-nt",
                "-np",
                "-l",
                "en",
            ])
            .output();
        let _ = std::fs::remove_file(&path);
        let out = result.map_err(|e| {
            format!("couldn't run whisper ({e}) — install whisper.cpp or set FLUX_WHISPER_BIN")
        })?;
        if !out.status.success() {
            let err: String = String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(200)
                .collect();
            return Err(format!("whisper failed: {err}"));
        }
        Ok(clean(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}
