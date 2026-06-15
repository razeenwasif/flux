//! `flux://omni` — the Omni index dashboard data source.
//!
//! The dashboard is a native Flux page (velvet/glass), but its numbers come from
//! the user's Omni search engine over HTTP (`/stats`). We fetch it from Rust,
//! not the webview: the shell's CSP only allows `'self'` + `https:`, so a direct
//! `fetch("http://localhost:8080/stats")` from the page would be blocked — the
//! Rust process has no such restriction. The raw JSON body is handed straight to
//! the frontend, which parses + renders it (no Rust-side schema to keep in sync).

use std::time::Duration;

use tauri::State;

use crate::search::SearchState;

/// Fetch the Omni engine's `/stats` JSON (live index health). The base URL
/// follows the configured default search engine, so it tracks wherever the user
/// pointed Omni; `FLUX_OMNI_URL` overrides; falls back to `localhost:8080`.
#[tauri::command]
pub async fn omni_stats(search: State<'_, SearchState>) -> Result<String, String> {
    let url = format!("{}/stats", search.omni_base());
    tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url)
            .timeout(Duration::from_secs(5))
            .call()
            .map_err(|e| format!("{url}: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
