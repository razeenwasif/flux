//! Push-to-talk voice input — offline speech-to-text via Vosk, reusing the model
//! AudioPulse already ships.
//!
//! The frontend records mic audio in the browser (Web Audio) as little-endian
//! mono i16 PCM and sends it base64-encoded with its sample rate; we feed it to a
//! Vosk recognizer and hand back the transcript. Gated behind the `voice` cargo
//! feature and loaded dynamically so Windows builds don't need an MSVC
//! `libvosk.lib` import library just to link Flux. Without the feature the command
//! compiles but returns a clear "not built" message, so the default build stays
//! lean (mirrors the `llama` feature).

#[cfg(feature = "voice")]
use std::{
    ffi::{CStr, CString},
    os::raw::{c_char, c_float, c_int},
    path::{Path, PathBuf},
};

/// Decode base64 little-endian i16 PCM into samples.
#[cfg(feature = "voice")]
fn decode_pcm(b64: &str) -> Result<Vec<i16>, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

/// The Vosk model path — `FLUX_VOSK_MODEL`, else AudioPulse's bundled model.
#[cfg(feature = "voice")]
fn model_path() -> Option<String> {
    if let Ok(p) = std::env::var("FLUX_VOSK_MODEL") {
        return Some(p);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let cand = format!("{home}/AudioPulse/third_party/vosk/model");
    std::path::Path::new(&cand).is_dir().then_some(cand)
}

#[cfg(feature = "voice")]
#[repr(C)]
struct VoskModel {
    _private: [u8; 0],
}

#[cfg(feature = "voice")]
#[repr(C)]
struct VoskRecognizer {
    _private: [u8; 0],
}

#[cfg(feature = "voice")]
type VoskModelNew = unsafe extern "C" fn(*const c_char) -> *mut VoskModel;
#[cfg(feature = "voice")]
type VoskModelFree = unsafe extern "C" fn(*mut VoskModel);
#[cfg(feature = "voice")]
type VoskRecognizerNew = unsafe extern "C" fn(*mut VoskModel, c_float) -> *mut VoskRecognizer;
#[cfg(feature = "voice")]
// Grammar-restricted recognizer: only the phrases in the JSON grammar (+ "[unk]")
// are recognized — used for reliable, low-false-trigger wake-word spotting.
type VoskRecognizerNewGrm =
    unsafe extern "C" fn(*mut VoskModel, c_float, *const c_char) -> *mut VoskRecognizer;
#[cfg(feature = "voice")]
type VoskRecognizerFree = unsafe extern "C" fn(*mut VoskRecognizer);
#[cfg(feature = "voice")]
type VoskAcceptWaveform = unsafe extern "C" fn(*mut VoskRecognizer, *const i16, c_int) -> c_int;
#[cfg(feature = "voice")]
type VoskFinalResult = unsafe extern "C" fn(*mut VoskRecognizer) -> *const c_char;

#[cfg(feature = "voice")]
struct VoskApi {
    _lib: libloading::Library,
    model_new: VoskModelNew,
    model_free: VoskModelFree,
    recognizer_new: VoskRecognizerNew,
    recognizer_new_grm: VoskRecognizerNewGrm,
    recognizer_free: VoskRecognizerFree,
    accept_waveform: VoskAcceptWaveform,
    final_result: VoskFinalResult,
}

#[cfg(feature = "voice")]
impl VoskApi {
    fn load() -> Result<Self, String> {
        let candidates = vosk_library_candidates();
        let mut errors = Vec::new();

        for path in candidates {
            // Keep the library handle in VoskApi so copied function pointers stay valid.
            let lib = match unsafe { load_vosk_library(&path) } {
                Ok(lib) => lib,
                Err(err) => {
                    let exists = if path.exists() { "exists" } else { "missing" };
                    errors.push(format!("{} [{exists}] ({err})", path.display()));
                    continue;
                }
            };

            return unsafe {
                Ok(Self {
                    model_new: load_symbol(&lib, b"vosk_model_new\0")?,
                    model_free: load_symbol(&lib, b"vosk_model_free\0")?,
                    recognizer_new: load_symbol(&lib, b"vosk_recognizer_new\0")?,
                    recognizer_new_grm: load_symbol(&lib, b"vosk_recognizer_new_grm\0")?,
                    recognizer_free: load_symbol(&lib, b"vosk_recognizer_free\0")?,
                    accept_waveform: load_symbol(&lib, b"vosk_recognizer_accept_waveform_s\0")?,
                    final_result: load_symbol(&lib, b"vosk_recognizer_final_result\0")?,
                    _lib: lib,
                })
            };
        }

        Err(format!(
            "Vosk native library could not be loaded. Put {} and its companion DLLs in the same folder, set FLUX_VOSK_LIBRARY to the full DLL path, or set FLUX_VOSK_LIB_DIR to that folder. Tried: {}",
            vosk_library_name(),
            errors.join("; "),
        ))
    }
}

#[cfg(feature = "voice")]
unsafe fn load_symbol<T: Copy>(lib: &libloading::Library, name: &[u8]) -> Result<T, String> {
    let symbol = unsafe { lib.get::<T>(name) }
        .map_err(|e| format!("missing Vosk symbol {}: {e}", String::from_utf8_lossy(name)))?;
    Ok(*symbol)
}

#[cfg(feature = "voice")]
fn vosk_library_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "libvosk.dll"
    } else if cfg!(target_os = "macos") {
        "libvosk.dylib"
    } else {
        "libvosk.so"
    }
}

#[cfg(feature = "voice")]
fn vosk_library_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("FLUX_VOSK_LIBRARY") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            candidates.push(parent.join(vosk_library_name()));
        }
        candidates.push(path);
    }
    if let Some(path) = std::env::var_os("FLUX_VOSK_DLL") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            candidates.push(parent.join(vosk_library_name()));
        }
        candidates.push(path);
    }
    if let Some(dir) = std::env::var_os("FLUX_VOSK_LIB_DIR") {
        candidates.push(PathBuf::from(dir).join(vosk_library_name()));
    }
    if let Some(dir) = std::env::var_os("FLUX_VOSK_DIR") {
        candidates.push(PathBuf::from(dir).join(vosk_library_name()));
    }
    if let Some(model) =
        model_path().and_then(|p| PathBuf::from(p).parent().map(|p| p.to_path_buf()))
    {
        candidates.push(model.join(vosk_library_name()));
    }
    candidates.push(PathBuf::from(vosk_library_name()));

    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped.iter().any(|seen: &PathBuf| seen == &candidate) {
            deduped.push(candidate);
        }
    }
    deduped
}

#[cfg(all(feature = "voice", target_os = "windows"))]
unsafe fn load_vosk_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    let lib = unsafe {
        libloading::os::windows::Library::load_with_flags(
            path.as_os_str(),
            libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH,
        )
    }?;
    Ok(lib.into())
}

#[cfg(all(feature = "voice", not(target_os = "windows")))]
unsafe fn load_vosk_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    unsafe { libloading::Library::new(path) }
}

#[cfg(feature = "voice")]
fn vosk_api() -> Result<&'static VoskApi, String> {
    static API: std::sync::OnceLock<Result<VoskApi, String>> = std::sync::OnceLock::new();
    API.get_or_init(VoskApi::load)
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(feature = "voice")]
struct ModelHandle {
    ptr: *mut VoskModel,
}

#[cfg(feature = "voice")]
unsafe impl Send for ModelHandle {}
#[cfg(feature = "voice")]
unsafe impl Sync for ModelHandle {}

#[cfg(feature = "voice")]
impl Drop for ModelHandle {
    fn drop(&mut self) {
        if let Ok(api) = vosk_api() {
            unsafe { (api.model_free)(self.ptr) };
        }
    }
}

#[cfg(feature = "voice")]
fn model() -> Result<&'static ModelHandle, String> {
    static MODEL: std::sync::OnceLock<Result<ModelHandle, String>> = std::sync::OnceLock::new();
    MODEL
        .get_or_init(|| {
            let api = vosk_api()?;
            let path = model_path().ok_or("Vosk model not found; set FLUX_VOSK_MODEL to a model dir (e.g. AudioPulse's third_party/vosk/model)")?;
            let path = CString::new(path).map_err(|_| "Vosk model path contains an interior NUL byte".to_string())?;
            let ptr = unsafe { (api.model_new)(path.as_ptr()) };
            if ptr.is_null() {
                Err("Vosk could not load the model at FLUX_VOSK_MODEL".to_string())
            } else {
                Ok(ModelHandle { ptr })
            }
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(feature = "voice")]
struct RecognizerHandle<'a> {
    api: &'a VoskApi,
    ptr: *mut VoskRecognizer,
}

#[cfg(feature = "voice")]
impl Drop for RecognizerHandle<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.recognizer_free)(self.ptr) };
    }
}

#[cfg(feature = "voice")]
fn transcribe(pcm: &[i16], sample_rate: f32) -> Result<String, String> {
    transcribe_inner(pcm, sample_rate, None)
}

#[cfg(feature = "voice")]
fn transcribe_inner(
    pcm: &[i16],
    sample_rate: f32,
    grammar: Option<&str>,
) -> Result<String, String> {
    let api = vosk_api()?;
    let model = model()?;
    let rec = match grammar {
        Some(g) => {
            let cg =
                CString::new(g).map_err(|_| "wake grammar has an interior NUL byte".to_string())?;
            unsafe { (api.recognizer_new_grm)(model.ptr, sample_rate as c_float, cg.as_ptr()) }
        }
        None => unsafe { (api.recognizer_new)(model.ptr, sample_rate as c_float) },
    };
    if rec.is_null() {
        return Err("couldn't create the Vosk recognizer".into());
    }
    let rec = RecognizerHandle { api, ptr: rec };
    let sample_count: c_int = pcm
        .len()
        .try_into()
        .map_err(|_| "voice sample is too large for Vosk".to_string())?;
    let accepted = unsafe { (api.accept_waveform)(rec.ptr, pcm.as_ptr(), sample_count) };
    if accepted < 0 {
        return Err("vosk decode failed".into());
    }
    let result = unsafe { CStr::from_ptr((api.final_result)(rec.ptr)) }.to_string_lossy();
    let text = serde_json::from_str::<serde_json::Value>(&result)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default();
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
            Err("voice input isn't built into the running flux.exe. Reinstall with `scripts\\install-windows.ps1 -Voice`, or launch the voice-enabled `target\\release\\flux.exe` you built with `--features voice,custom-protocol`.".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wake-word spotting: a **grammar-restricted** Vosk pass that only recognizes the
/// wake phrase (everything else collapses to "[unk]"), so it's far less prone to
/// false triggers than full transcription. Returns the recognized text (e.g.
/// "hey gemma" / "gemma" / "") for the frontend to match.
#[tauri::command]
pub async fn wake_transcribe(pcm_b64: String, sample_rate: f32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "voice")]
        {
            let pcm = decode_pcm(&pcm_b64)?;
            transcribe_inner(
                &pcm,
                sample_rate,
                Some("[\"hey gemma\", \"gemma\", \"hey gems\", \"gems\", \"gem\", \"[unk]\"]"),
            )
        }
        #[cfg(not(feature = "voice"))]
        {
            let _ = (pcm_b64, sample_rate);
            Err("voice not built".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
