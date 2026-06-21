//! Porcupine wake-word config. Stores the Picovoice access key in the OS keyring
//! and reads the user's keyword (`.ppn`) + model (`porcupine_params.pv`) files,
//! handing the renderer base64 so the Porcupine **Web** SDK can run the dedicated
//! wake-word model locally.
//!
//! Detection itself runs in the browser, on-device — no audio leaves the machine.
//! The access key necessarily reaches the renderer at runtime (the JS SDK needs
//! it), but it's never stored in plaintext/localStorage; the keyring holds it and
//! only `porcupine_has_key` (a bool) is otherwise exposed.

use base64::Engine as _;

const SERVICE: &str = "flux.porcupine";
const ACCOUNT: &str = "access-key";

/// Store (or, with an empty string, clear) the Picovoice access key.
#[tauri::command]
pub fn porcupine_set_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    if key.trim().is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(key.trim()).map_err(|e| e.to_string())
    }
}

/// Whether a Picovoice access key is stored.
#[tauri::command]
pub fn porcupine_has_key() -> bool {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PorcupineConfig {
    access_key: String,
    keyword_b64: String,
    model_b64: String,
}

fn read_b64(path: &str, what: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("can't read {what} ({path}): {e}"))?;
    if bytes.is_empty() {
        return Err(format!("{what} file is empty: {path}"));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Resolve everything the Web SDK needs: the access key (keyring) + the keyword
/// and model files (read from the configured paths → base64).
#[tauri::command]
pub fn porcupine_config(ppn_path: String, model_path: String) -> Result<PorcupineConfig, String> {
    let access_key = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "no Porcupine access key set — add it in Settings → Integrations".to_string())?;
    if access_key.trim().is_empty() {
        return Err("no Porcupine access key set — add it in Settings → Integrations".into());
    }
    if ppn_path.trim().is_empty() {
        return Err("set the path to your “Hey Gemma” .ppn keyword file".into());
    }
    if model_path.trim().is_empty() {
        return Err("set the path to the porcupine_params .pv model file".into());
    }
    Ok(PorcupineConfig {
        access_key: access_key.trim().to_string(),
        keyword_b64: read_b64(ppn_path.trim(), "keyword (.ppn)")?,
        model_b64: read_b64(model_path.trim(), "model (.pv)")?,
    })
}
