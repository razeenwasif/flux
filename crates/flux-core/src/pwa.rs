//! Install-site-as-app / PWAs (BACKLOG #42).
//!
//! "Install this site as an app" opens it in its own OS window — just the page,
//! no Flux tab chrome — so Discord/WhatsApp/Figma/etc. feel like native apps.
//! Each installed app is a separate Tauri `WebviewWindow` (label `pwa-<id>`);
//! re-launching focuses the existing window instead of opening a duplicate.
//! Installed apps persist so you can relaunch them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct PwaApp {
    pub id: u64,
    pub name: String,
    pub url: String,
}

#[derive(Default)]
pub struct PwaStore {
    apps: RwLock<Vec<PwaApp>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl PwaStore {
    pub fn restore(path: PathBuf) -> Self {
        let apps: Vec<PwaApp> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = apps.iter().map(|a| a.id).max().map(|m| m + 1).unwrap_or(1);
        Self { apps: RwLock::new(apps), next_id: AtomicU64::new(next), path: Some(path) }
    }

    pub fn list(&self) -> Vec<PwaApp> {
        self.apps.read().clone()
    }
    pub fn get(&self, id: u64) -> Option<PwaApp> {
        self.apps.read().iter().find(|a| a.id == id).cloned()
    }

    /// Install (or update the name of an existing same-URL app). Returns it.
    pub fn install(&self, url: String, name: String) -> PwaApp {
        let mut apps = self.apps.write();
        let app = if let Some(a) = apps.iter_mut().find(|a| a.url == url) {
            if !name.trim().is_empty() {
                a.name = name;
            }
            a.clone()
        } else {
            let a = PwaApp {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                name: if name.trim().is_empty() { url.clone() } else { name },
                url,
            };
            apps.push(a.clone());
            a
        };
        drop(apps);
        self.persist();
        app
    }

    pub fn remove(&self, id: u64) {
        self.apps.write().retain(|a| a.id != id);
        self.persist();
    }

    fn persist(&self) {
        if let Some(path) = &self.path {
            crate::persist::save_json_pretty(path, &*self.apps.read());
        }
    }
}

/// Open (or focus, if already open) an app's own window.
fn open_window(app: &AppHandle, pwa: &PwaApp) -> Result<(), String> {
    let label = format!("pwa-{}", pwa.id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }
    let url: tauri::Url = pwa.url.parse().map_err(|_| format!("invalid URL: {}", pwa.url))?;
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(&pwa.name)
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|e| format!("open app window: {e}"))?;
    Ok(())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn pwa_list(store: State<'_, PwaStore>) -> Vec<PwaApp> {
    store.list()
}

#[tauri::command]
pub fn pwa_install(app: AppHandle, store: State<'_, PwaStore>, url: String, name: String) -> Result<PwaApp, String> {
    if !url.starts_with("http") {
        return Err("only web pages can be installed as apps".into());
    }
    let pwa = store.install(url, name);
    open_window(&app, &pwa)?;
    Ok(pwa)
}

#[tauri::command]
pub fn pwa_launch(app: AppHandle, store: State<'_, PwaStore>, id: u64) -> Result<(), String> {
    let pwa = store.get(id).ok_or("app not found")?;
    open_window(&app, &pwa)
}

#[tauri::command]
pub fn pwa_remove(store: State<'_, PwaStore>, id: u64) {
    store.remove(id);
}
