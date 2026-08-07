//! Gemini cloud escalation — key storage and the switch (#175).
//!
//! Flux's agent is local by default. This module owns the *only* path by which
//! that stops being true, and it is built to make that path deliberate:
//!
//!   * The API key lives in the **OS keyring**, never in localStorage and never
//!     read back into the renderer — the same handling as the ElevenLabs key in
//!     `tts.rs`, which is the existing precedent for an opt-in cloud service.
//!   * Escalation is **per session**. `flux_agent::route` holds the flag in an
//!     atomic that starts false on every launch, so a key stored today does not
//!     silently route tomorrow's browsing off-device.
//!   * The switch **refuses to turn on** unless a key is present and the model
//!     is reachable, so "on" in the UI always means requests really are leaving.
//!
//! What escalation actually discloses: the planner's prompts carry page DOM
//! text, PDF contents, vault notes and terminal output. This is a disclosure
//! decision, not a speed setting, and the UI says so.

use flux_agent::{route, GeminiBackend, RouteStatus};

const SERVICE: &str = "flux.gemini";
const ACCOUNT: &str = "api-key";

/// Tidy a pasted key. People paste `key=AIza…`, a quoted value, or a whole
/// `X-goog-api-key: AIza…` header line; all of those should just work rather
/// than being stored verbatim and failing later with "key rejected".
fn normalize(raw: &str) -> String {
    let mut k = raw.trim();
    for p in ["x-goog-api-key:", "api-key:", "api_key=", "key=", "key:"] {
        if k.len() >= p.len() && k[..p.len()].eq_ignore_ascii_case(p) {
            k = k[p.len()..].trim();
        }
    }
    k.trim_matches(['"', '\'']).trim().to_string()
}

/// Last 4 characters only — enough to tell two keys apart in an error message
/// without putting a credential in a log.
fn label(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

fn stored_key() -> Option<String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| normalize(&k))
        .filter(|k| !k.is_empty())
}

/// Store (or with an empty string, clear) the Gemini API key.
///
/// Clearing also tears the cloud backend out of the router, which revokes the
/// session's escalation — see `RoutingBackend::set_cloud`.
#[tauri::command]
pub fn gemini_set_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let key = normalize(&key);
    if key.is_empty() {
        let _ = entry.delete_credential();
        crate::agent_bridge::router().set_cloud(None);
        return Ok(());
    }
    let _ = entry.delete_credential();
    entry.set_password(&key).map_err(|e| e.to_string())?;
    // Read it back: a keyring that accepts a write and returns something else is
    // the failure the ElevenLabs path had to learn about the hard way.
    let saved = entry.get_password().map_err(|e| {
        format!("could not read the saved Gemini key back from the OS keyring: {e}")
    })?;
    if normalize(&saved) != key {
        return Err(format!(
            "the saved Gemini key did not round-trip through the OS keyring (entered {}, read back {})",
            label(&key),
            label(&normalize(&saved))
        ));
    }
    Ok(())
}

/// Whether a key is stored — so the UI can show its state without the key ever
/// reaching the renderer.
#[tauri::command]
pub fn gemini_has_key() -> bool {
    stored_key().is_some()
}

/// Check the stored key against the API before anything depends on it.
#[tauri::command]
pub async fn gemini_verify_key() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let key =
            stored_key().ok_or("no Gemini API key set — add one in Settings → Integrations")?;
        flux_agent::gemini::verify_key(&key).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Models this key can reach. Asked rather than hardcoded, so a new model line-up
/// doesn't require a Flux release.
#[tauri::command]
pub async fn gemini_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let key =
            stored_key().ok_or("no Gemini API key set — add one in Settings → Integrations")?;
        flux_agent::gemini::list_models(&key).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The default model, for the UI to preselect before the list has loaded.
#[tauri::command]
pub fn gemini_default_model() -> String {
    flux_agent::gemini::default_model()
}

/// Turn cloud escalation on or off for **this session**.
///
/// Turning it on requires a stored key **and checks it works** before the switch
/// flips. Costing one round trip here buys the difference between "the toggle
/// refused, and nothing was sent" and the alternative — a switch that reads
/// "cloud", a question that errors, and no way to tell whether the prompt left
/// the machine before it failed. For a control whose whole job is to be
/// trustworthy about egress, that ambiguity is the thing to avoid.
///
/// Turning it off leaves the key in place: the user is declining to use it now,
/// not discarding it. Returns the resulting route, so the caller shows what is
/// true rather than what was asked for.
#[tauri::command]
pub async fn agent_cloud_set(on: bool, model: String) -> Result<RouteStatus, String> {
    let router = crate::agent_bridge::router();
    if !on {
        route::request_cloud(false);
        return Ok(route::status(router.has_cloud()));
    }
    let key = stored_key()
        .ok_or("no Gemini API key set — add one in Settings → Integrations before escalating")?;
    let probe_key = key.clone();
    tauri::async_runtime::spawn_blocking(move || flux_agent::gemini::verify_key(&probe_key))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    router.set_cloud(Some(Box::new(GeminiBackend::new(key, &model))));
    route::request_cloud(true);
    tracing::warn!(
        target: "flux::agent",
        model = %if model.trim().is_empty() { flux_agent::gemini::default_model() } else { model },
        "cloud escalation ON — agent prompts (page text, notes, terminal output) now leave this machine"
    );
    Ok(route::status(router.has_cloud()))
}

/// What the next agent request will actually do.
#[tauri::command]
pub fn agent_cloud_status() -> RouteStatus {
    route::status(crate::agent_bridge::router().has_cloud())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_ways_a_key_gets_pasted() {
        // Each of these is a real shape someone copies out of AI Studio, a curl
        // snippet, or a .env file. Storing them verbatim fails later as a
        // confusing "key rejected" rather than here as a paste problem.
        for raw in [
            "AIzaTESTKEY",
            "  AIzaTESTKEY  ",
            "\"AIzaTESTKEY\"",
            "key=AIzaTESTKEY",
            "X-goog-api-key: AIzaTESTKEY",
            "api_key=AIzaTESTKEY",
        ] {
            assert_eq!(normalize(raw), "AIzaTESTKEY", "failed on {raw:?}");
        }
        assert_eq!(
            normalize("   "),
            "",
            "blank stays blank so it reads as a clear"
        );
    }

    #[test]
    fn label_shows_only_the_tail() {
        // Error messages have to distinguish two keys without printing either.
        let l = label("AIzaSECRETvalue1234");
        assert_eq!(l, "…1234");
        assert!(!l.contains("SECRET"));
    }
}
