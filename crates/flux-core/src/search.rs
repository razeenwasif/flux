//! Search state: the pluggable engine config (`flux-search`), persisted to the
//! app config dir and exposed over IPC. The omnibox calls `search_resolve`;
//! the rest let the user manage engines and pick a default — which is how a
//! custom engine becomes the one Flux searches with (BACKLOG #68).

use std::path::PathBuf;

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
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(&*self.config.read()).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

/// Resolve raw omnibox input → final URL (navigate vs search vs keyword).
#[tauri::command]
pub fn search_resolve(state: State<'_, SearchState>, input: String) -> Resolution {
    state.config.read().resolve(&input)
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
