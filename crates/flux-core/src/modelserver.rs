//! Settings → Model server: where the agent's model runs.
//!
//! The laptop's own Ollama by default. Or a server on another machine that
//! speaks the OpenAI API (llama.cpp's `llama-server`, which is what Nexus serves
//! from a desktop's GPU), with the laptop's Ollama as the fallback whenever that
//! machine can't be reached. Only the agent's generation moves: the Indexer's
//! embeddings stay on the local Ollama.
//!
//! The address and model live in `model_server.json` in the app's data folder;
//! the API key in the OS keyring, like the Gemini key (it's a credential, and
//! Nexus issues a new one every time it serves).

use std::path::PathBuf;
use std::sync::OnceLock;

use flux_agent::{Inference, OllamaBackend, OpenAiBackend};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "flux.modelserver";
const ACCOUNT: &str = "api-key";

/// What's saved. `kind` is "local" (this machine's Ollama) or "openai".
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct ModelServer {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub model: String,
}

impl ModelServer {
    fn is_remote(&self) -> bool {
        self.kind == "openai" && !self.url.trim().is_empty()
    }
}

/// What Settings shows: the saved settings, and whether a key is stored (the
/// key itself never goes back to the page).
#[derive(Serialize)]
pub struct ModelServerView {
    pub kind: String,
    pub url: String,
    pub model: String,
    pub has_key: bool,
}

static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Where the settings live; set once at startup, before the agent first runs.
pub fn init(path: PathBuf) {
    let _ = PATH.set(path);
}

fn load() -> ModelServer {
    PATH.get()
        .and_then(|p| crate::persist::load_json_or_quarantine(p))
        .unwrap_or_default()
}

fn save(cfg: &ModelServer) -> Result<(), String> {
    let path = PATH.get().ok_or("settings aren't ready yet")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::persist::save_json_pretty(path, cfg, crate::persist::Durability::Barrier);
    Ok(())
}

fn stored_key() -> Option<String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| tidy_key(&k))
        .filter(|k| !k.is_empty())
}

/// A pasted key as the server wants it: people paste the whole header line
/// (`Authorization: Bearer sk-…`) as often as the key.
fn tidy_key(raw: &str) -> String {
    let mut k = raw.trim();
    for p in ["authorization:", "bearer"] {
        if k.get(..p.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(p))
        {
            k = k[p.len()..].trim();
        }
    }
    k.trim_matches(['"', '\'']).trim().to_string()
}

/// Store the key, or with an empty one remove it.
fn set_key(raw: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let key = tidy_key(raw);
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(&key).map_err(|e| e.to_string())
    }
}

/// The model the saved settings describe: the router's default.
pub fn backend() -> Box<dyn Inference> {
    let cfg = load();
    if cfg.is_remote() {
        tracing::info!(target: "flux::agent", url = %cfg.url, model = %cfg.model, "using the model server");
        Box::new(OpenAiBackend::new(
            &cfg.url,
            stored_key(),
            &cfg.model,
            Some(Box::new(OllamaBackend::new())),
        ))
    } else {
        Box::new(OllamaBackend::new())
    }
}

/// The remote server's settings, when one is in use (the agent panel's model
/// menu lists its models instead of Ollama's).
pub fn remote() -> Option<ModelServer> {
    Some(load()).filter(ModelServer::is_remote)
}

/// The models a remote server offers, with the stored key.
pub fn remote_models(cfg: &ModelServer) -> Vec<String> {
    flux_agent::openai::list_models(&cfg.url, stored_key().as_deref()).unwrap_or_default()
}

/// Pick a remote model (the agent panel's menu) and put it to work.
pub fn set_remote_model(model: &str) -> Result<(), String> {
    let mut cfg = load();
    cfg.model = model.to_string();
    save(&cfg)?;
    crate::agent_bridge::router().set_local(backend());
    Ok(())
}

#[tauri::command]
pub async fn model_server_get() -> Result<ModelServerView, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cfg = load();
        ModelServerView {
            kind: if cfg.kind.is_empty() {
                "local".into()
            } else {
                cfg.kind
            },
            url: cfg.url,
            model: cfg.model,
            has_key: stored_key().is_some(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Save the settings and switch the agent over now. `key`: `None` keeps the
/// stored key, `Some("")` removes it.
#[tauri::command]
pub async fn model_server_set(
    kind: String,
    url: String,
    model: String,
    key: Option<String>,
) -> Result<(), String> {
    if kind != "local" && kind != "openai" {
        return Err(format!("unknown model server kind {kind:?}"));
    }
    let url = url.trim().to_string();
    if kind == "openai" && !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("the address starts with http:// (e.g. http://192.168.68.200:8080/v1)".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(k) = key {
            set_key(&k)?;
        }
        let mut model = model.trim().to_string();
        if kind == "openai" && model.is_empty() {
            // llama-server serves one model: use it rather than make the user type its id.
            model = flux_agent::openai::list_models(&url, stored_key().as_deref())
                .ok()
                .and_then(|m| m.into_iter().next())
                .unwrap_or_default();
        }
        save(&ModelServer { kind, url, model })?;
        crate::agent_bridge::router().set_local(backend());
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Test an address (and a key, or the stored one): the models it offers.
#[tauri::command]
pub async fn model_server_models(url: String, key: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key
            .map(|k| tidy_key(&k))
            .filter(|k| !k.is_empty())
            .or_else(stored_key);
        flux_agent::openai::list_models(&url, key.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_header_is_just_the_key() {
        assert_eq!(tidy_key("  sk-abc  "), "sk-abc");
        assert_eq!(tidy_key("Authorization: Bearer sk-abc"), "sk-abc");
        assert_eq!(tidy_key("Bearer \"sk-abc\""), "sk-abc");
        assert_eq!(tidy_key(""), "");
    }

    #[test]
    fn only_a_remote_with_an_address_is_remote() {
        let mut c = ModelServer {
            kind: "openai".into(),
            url: "http://192.168.68.200:8080/v1".into(),
            model: "gemma".into(),
        };
        assert!(c.is_remote());
        c.url = " ".into();
        assert!(!c.is_remote());
        assert!(!ModelServer::default().is_remote());
    }
}
