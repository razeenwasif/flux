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
//!
//! Or Gemini through the Antigravity CLI, signed in with your Google account
//! (ADR 0020). That one leaves the machine, so it isn't the default model: it's
//! the router's cloud route, switched on for as long as it's chosen here, which
//! the agent panel shows as cloud. What must stay on this machine (form help,
//! Sentinel) keeps using the default model.

use std::path::PathBuf;
use std::sync::OnceLock;

use flux_agent::{Inference, OllamaBackend, OpenAiBackend};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "flux.modelserver";
const ACCOUNT: &str = "api-key";

/// What's saved. `kind` is "local" (this machine's Ollama), "openai" (another
/// machine), or "antigravity" (Gemini through the Antigravity CLI).
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

/// The settings' location is known (startup has run `init`).
pub fn ready() -> bool {
    PATH.get().is_some()
}

/// Gemini through the Antigravity CLI is chosen.
pub fn uses_antigravity() -> bool {
    load().kind == "antigravity"
}

/// The Antigravity CLI. A Dock-launched app doesn't see the shell's PATH, so the
/// places its installer uses come first, then the login shell's answer.
fn find_agy() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let known = [
        home.join(".local/bin/agy"),
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
    ];
    if let Some(p) = known.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    #[cfg(unix)]
    {
        crate::exec::login_shell_which("agy").map(PathBuf::from)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The folder `agy` runs in: private, holding the hook that refuses it every
/// tool but the one that returns an answer (flux_agent::antigravity).
fn agy_workdir() -> Result<PathBuf, String> {
    let base = PATH
        .get()
        .and_then(|p| p.parent())
        .ok_or("settings aren't ready yet")?;
    let dir = base.join("antigravity");
    let hooks = dir.join(".agents");
    std::fs::create_dir_all(&hooks).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::fs::write(
        hooks.join("hooks.json"),
        flux_agent::antigravity::hooks_json(&exe),
    )
    .map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Whether the cloud route holds the Antigravity backend (rather than a Gemini
/// key's, or nothing).
static AGY_INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Put the router's cloud route in line with what's chosen: Antigravity on while
/// it's the model server, and taken down when it stops being.
pub fn apply_cloud(router: &flux_agent::RoutingBackend) {
    use std::sync::atomic::Ordering;
    let cfg = load();
    if cfg.kind != "antigravity" {
        if AGY_INSTALLED.swap(false, Ordering::SeqCst) {
            router.set_cloud(None);
        }
        return;
    }
    match agy_workdir() {
        Ok(dir) => {
            let model = if cfg.model.is_empty() {
                DEFAULT_AGY_MODEL.to_string()
            } else {
                cfg.model
            };
            router.set_cloud(Some(Box::new(
                flux_agent::antigravity::AntigravityBackend::new(Box::new(find_agy), &model, dir),
            )));
            flux_agent::route::request_cloud(true);
            AGY_INSTALLED.store(true, Ordering::SeqCst);
            tracing::warn!(target: "flux::agent", model, "Gemini through the Antigravity CLI — agent prompts (page text, notes, terminal output) leave this machine");
        }
        Err(e) => {
            tracing::error!(target: "flux::agent", error = %e, "couldn't set up the Antigravity CLI; the agent stays local");
            if AGY_INSTALLED.swap(false, Ordering::SeqCst) {
                router.set_cloud(None);
            }
        }
    }
}

const DEFAULT_AGY_MODEL: &str = "gemini-3.8-flash-medium";

/// The models the Antigravity CLI offers this account. Fails when it isn't
/// installed or isn't signed in, which is also how Settings checks it.
#[tauri::command]
pub async fn model_server_agy_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin =
            find_agy().ok_or("the Antigravity CLI (agy) isn't installed, or Flux can't find it")?;
        let out = std::process::Command::new(bin)
            .arg("models")
            .output()
            .map_err(|e| e.to_string())?;
        let models = flux_agent::antigravity::parse_models(&String::from_utf8_lossy(&out.stdout));
        if models.is_empty() {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if why.is_empty() {
                "agy lists no models: open it once in a terminal to sign in".to_string()
            } else {
                why
            });
        }
        Ok(models)
    })
    .await
    .map_err(|e| e.to_string())?
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
    if !matches!(kind.as_str(), "local" | "openai" | "antigravity") {
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
        if kind == "antigravity" && model.is_empty() {
            model = DEFAULT_AGY_MODEL.to_string();
        }
        save(&ModelServer { kind, url, model })?;
        let router = crate::agent_bridge::router();
        router.set_local(backend());
        apply_cloud(router);
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
