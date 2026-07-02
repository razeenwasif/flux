//! Search state: the pluggable engine config (`flux-search`), persisted to the
//! app config dir and exposed over IPC. The omnibox calls `search_resolve`;
//! the rest let the user manage engines and pick a default — which is how a
//! custom engine becomes the one Flux searches with (BACKLOG #68).

use std::path::PathBuf;
use std::time::Duration;

use parking_lot::RwLock;
use tauri::{AppHandle, Manager, State};

use flux_search::{Resolution, SearchConfig, SearchEngine};

/// Managed search configuration + where it persists.
pub struct SearchState {
    config: RwLock<SearchConfig>,
    path: PathBuf,
}

impl SearchState {
    /// Load `search.json` from the app config dir, or seed the built-in
    /// defaults on first run.
    pub fn load(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("search.json");

        let config = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SearchConfig>(&bytes).ok())
            .unwrap_or_default();

        Self { config: RwLock::new(config), path }
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(&*self.config.read()).map_err(|e| e.to_string())?;
        crate::persist::write_atomic(&self.path, &json).map_err(|e| e.to_string())
    }

    /// Origin of the Omni engine (`scheme://host[:port]`) for the `flux://omni`
    /// dashboard. Follows the default search engine so it tracks wherever the
    /// user pointed Omni; `FLUX_OMNI_URL` overrides; defaults to localhost:8080.
    pub fn omni_base(&self) -> String {
        if let Ok(u) = std::env::var("FLUX_OMNI_URL") {
            return http_for_loopback(u.trim_end_matches('/').to_string());
        }
        let cfg = self.config.read();
        let base = cfg
            .engine(&cfg.default_id)
            .and_then(|e| origin_of(&e.search_template))
            .unwrap_or_else(|| "http://localhost:8080".into());
        http_for_loopback(base)
    }

    /// The default engine's suggestions endpoint for `query`, if it defines one.
    pub fn suggest_url(&self, query: &str) -> Option<String> {
        let cfg = self.config.read();
        cfg.engine(&cfg.default_id).and_then(|e| e.suggest_url(query))
    }
}

/// Parse an OpenSearch suggestions response (`[query, [completions], …]`) —
/// the format DuckDuckGo, Google, and Bing all return.
fn parse_opensearch(body: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get(1).and_then(|a| a.as_array()).cloned())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).take(8).collect())
        .unwrap_or_default()
}

/// A local Omni serves plain HTTP — never TLS — so downgrade an `https://`
/// loopback origin to `http://` (the default search-engine template the Omni base
/// is derived from may be https, which would make every Omni API call refuse/fail).
fn http_for_loopback(base: String) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        let host = rest.split([':', '/']).next().unwrap_or("");
        if matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]" | "::1") {
            return format!("http://{rest}");
        }
    }
    base
}

/// `"http://host:port/search?q={query}"` → `"http://host:port"`.
fn origin_of(template: &str) -> Option<String> {
    let scheme_end = template.find("://")? + 3;
    let rest = template.get(scheme_end..)?;
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{}{}", &template[..scheme_end], &rest[..host_end]))
}

/// Resolve raw omnibox input → final URL (navigate vs search vs keyword).
#[tauri::command]
pub fn search_resolve(state: State<'_, SearchState>, input: String) -> Resolution {
    state.config.read().resolve(&input)
}

/// Live omnibox suggestions for `query` from the default engine's suggest
/// endpoint (#32). Empty if the engine has none. Note: this sends the query to
/// the engine — the chrome only calls it when the user enabled suggestions.
#[tauri::command]
pub async fn search_suggest(state: State<'_, SearchState>, query: String) -> Result<Vec<String>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let Some(url) = state.suggest_url(q) else {
        return Ok(vec![]);
    };
    let body = tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url).timeout(Duration::from_secs(4)).call().ok()?.into_string().ok()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(body.map(|b| parse_opensearch(&b)).unwrap_or_default())
}

#[tauri::command]
pub fn search_engines(state: State<'_, SearchState>) -> Vec<SearchEngine> {
    state.config.read().engines.clone()
}

#[tauri::command]
pub fn search_default(state: State<'_, SearchState>) -> String {
    state.config.read().default_id.clone()
}

/// Make `id` the default engine (this is how the user's own engine takes over).
#[tauri::command]
pub fn search_set_default(state: State<'_, SearchState>, id: String) -> Result<(), String> {
    {
        let mut cfg = state.config.write();
        if cfg.engine(&id).is_none() {
            return Err(format!("no engine with id {id:?}"));
        }
        cfg.default_id = id;
    }
    state.persist()
}

/// Add (or replace, by id) an engine — e.g. register your own search backend.
#[tauri::command]
pub fn search_add_engine(state: State<'_, SearchState>, engine: SearchEngine) -> Result<(), String> {
    {
        let mut cfg = state.config.write();
        cfg.engines.retain(|e| e.id != engine.id);
        cfg.engines.push(engine);
    }
    state.persist()
}

#[tauri::command]
pub fn search_remove_engine(state: State<'_, SearchState>, id: String) -> Result<(), String> {
    {
        let mut cfg = state.config.write();
        if cfg.default_id == id {
            return Err("cannot remove the default engine; set another default first".into());
        }
        cfg.engines.retain(|e| e.id != id);
    }
    state.persist()
}

#[cfg(test)]
mod omni_base_tests {
    use super::http_for_loopback;

    #[test]
    fn downgrades_loopback_https_to_http_only() {
        assert_eq!(http_for_loopback("https://localhost:8080".into()), "http://localhost:8080");
        assert_eq!(http_for_loopback("https://127.0.0.1:8080".into()), "http://127.0.0.1:8080");
        // http stays http; a real remote https host is left alone.
        assert_eq!(http_for_loopback("http://localhost:8080".into()), "http://localhost:8080");
        assert_eq!(http_for_loopback("https://omni.example.com".into()), "https://omni.example.com");
    }
}
