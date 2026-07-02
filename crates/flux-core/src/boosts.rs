//! Per-site boosts (BACKLOG #49) — agent-authored CSS/JS injected per host.
//!
//! "Make this site better": describe a change ("hide the cookie banner", "dark
//! mode", "widen the article") and the local agent writes the CSS, saved per
//! host and re-applied on every visit. No extension, no store. CSS is the safe,
//! agent-authored path (it can't execute/exfiltrate); JS boosts are supported in
//! the store for power users to add by hand, but the agent only ever writes CSS.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Boost {
    pub id: u64,
    pub host: String,
    pub name: String,
    #[serde(default)]
    pub css: String,
    #[serde(default)]
    pub js: String,
    pub enabled: bool,
}

pub struct BoostStore {
    path: Option<PathBuf>,
    inner: RwLock<Vec<Boost>>,
    next_id: AtomicU64,
}

/// Normalized host of a URL (`https://www.a.com/x` → `a.com`).
pub fn host_of(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host).split(':').next().unwrap_or("");
    host.strip_prefix("www.").unwrap_or(host).to_string()
}
fn norm(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// Does a boost saved for `pattern` apply to a page on `page_host` (#49 wildcard
/// matching)? A bare host matches itself **and all subdomains** (`github.com` →
/// `gist.github.com`), so a boost authored on a base domain spreads across it; a
/// subdomain-specific boost (`gist.github.com`) stays scoped to that subtree. A
/// leading `*.` is accepted and treated the same as the bare base.
fn host_matches(pattern: &str, page_host: &str) -> bool {
    let base = norm(pattern.strip_prefix("*.").unwrap_or(pattern));
    let page = norm(page_host);
    page == base || page.ends_with(&format!(".{base}"))
}

impl Default for BoostStore {
    fn default() -> Self {
        Self { path: None, inner: RwLock::new(Vec::new()), next_id: AtomicU64::new(1) }
    }
}

impl BoostStore {
    pub fn restore(path: PathBuf) -> Self {
        let boosts: Vec<Boost> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = boosts.iter().map(|b| b.id).max().unwrap_or(0) + 1;
        Self { path: Some(path), inner: RwLock::new(boosts), next_id: AtomicU64::new(next) }
    }

    pub fn list(&self) -> Vec<Boost> {
        self.inner.read().clone()
    }

    pub fn for_host(&self, host: &str) -> Vec<Boost> {
        self.inner.read().iter().filter(|b| host_matches(&b.host, host)).cloned().collect()
    }

    /// Combined CSS + JS to inject for a page host (enabled boosts only).
    pub fn injection_for(&self, host: &str) -> (String, String) {
        let g = self.inner.read();
        let mut css = String::new();
        let mut js = String::new();
        for b in g.iter().filter(|b| b.enabled && host_matches(&b.host, host)) {
            if !b.css.is_empty() {
                css.push_str(&b.css);
                css.push('\n');
            }
            if !b.js.is_empty() {
                js.push_str(&b.js);
                js.push('\n');
            }
        }
        (css, js)
    }

    /// Create (`id = None`) or update a boost; returns it.
    pub fn save(&self, id: Option<u64>, host: String, name: String, css: String, js: String, enabled: bool) -> Boost {
        let host = norm(&host).to_string();
        let mut g = self.inner.write();
        let boost = if let Some(b) = id.and_then(|id| g.iter_mut().find(|b| b.id == id)) {
            b.host = host;
            b.name = name;
            b.css = css;
            b.js = js;
            b.enabled = enabled;
            b.clone()
        } else {
            let b = Boost { id: self.next_id.fetch_add(1, Ordering::Relaxed), host, name, css, js, enabled };
            g.push(b.clone());
            b
        };
        drop(g);
        self.persist();
        boost
    }

    pub fn delete(&self, id: u64) {
        self.inner.write().retain(|b| b.id != id);
        self.persist();
    }

    pub fn set_enabled(&self, id: u64, enabled: bool) {
        if let Some(b) = self.inner.write().iter_mut().find(|b| b.id == id) {
            b.enabled = enabled;
        }
        self.persist();
    }

    fn persist(&self) {
        if let Some(path) = &self.path {
            crate::persist::save_json_pretty(path, &*self.inner.read());
        }
    }
}

/// Re-apply a host's enabled CSS boosts to the active webview now (instant
/// feedback after authoring / toggling, without a reload).
fn reinject_active(app: &AppHandle, host: &str) {
    let Some(state) = app.try_state::<crate::state::FluxState>() else { return };
    let Some(store) = app.try_state::<BoostStore>() else { return };
    let Some(tab) = state.active_tab() else { return };
    let Some(wv) = app.get_webview(&format!("tab-{tab}")) else { return };
    let (css, _js) = store.injection_for(host);
    if let Ok(lit) = serde_json::to_string(&css) {
        let _ = wv.eval(&format!(
            "(function(){{var c={lit};var d=document;var s=d.getElementById('flux-boost');\
             if(!s){{s=d.createElement('style');s.id='flux-boost';}}s.textContent=c;\
             var t=d.head||d.documentElement;if(t&&!s.parentNode)t.appendChild(s);}})()"
        ));
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn boosts_list(store: State<'_, BoostStore>) -> Vec<Boost> {
    store.list()
}

#[tauri::command]
pub fn boosts_for_host(store: State<'_, BoostStore>, host: String) -> Vec<Boost> {
    store.for_host(&host)
}

#[tauri::command]
pub fn boost_save(
    app: AppHandle,
    store: State<'_, BoostStore>,
    id: Option<u64>,
    host: String,
    name: String,
    css: String,
    js: String,
    enabled: bool,
) -> Boost {
    let b = store.save(id, host.clone(), name, css, js, enabled);
    reinject_active(&app, &host);
    b
}

#[tauri::command]
pub fn boost_delete(app: AppHandle, store: State<'_, BoostStore>, id: u64, host: String) {
    store.delete(id);
    reinject_active(&app, &host);
}

#[tauri::command]
pub fn boost_set_enabled(app: AppHandle, store: State<'_, BoostStore>, id: u64, host: String, enabled: bool) {
    store.set_enabled(id, enabled);
    reinject_active(&app, &host);
}

/// Ask the local agent to write a CSS boost for the active page from a
/// natural-language instruction, save it (enabled), and apply it immediately.
#[tauri::command]
pub async fn boost_author(app: AppHandle, instruction: String) -> Result<Boost, String> {
    let state = app.state::<crate::state::FluxState>();
    let snap = state.active_snapshot().ok_or("open a page first")?;
    let host = host_of(&snap.url);
    if host.is_empty() {
        return Err("this page can't be boosted".into());
    }
    let page = std::sync::Arc::clone(&snap.text);
    let instr = instruction.clone();
    let css = tauri::async_runtime::spawn_blocking(move || crate::agent_bridge::planner().author_css(&instr, &page))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if css.trim().is_empty() {
        return Err("the agent didn't produce any CSS — try rephrasing".into());
    }
    let name = instruction.chars().take(60).collect::<String>();
    let store = app.state::<BoostStore>();
    let boost = store.save(None, host.clone(), name, css, String::new(), true);
    reinject_active(&app, &host);
    Ok(boost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_normalization() {
        assert_eq!(host_of("https://www.example.com/x?y"), "example.com");
        assert_eq!(host_of("http://sub.example.com/"), "sub.example.com");
    }

    #[test]
    fn wildcard_subdomain_matching() {
        // A base-domain boost spreads to subdomains…
        assert!(host_matches("github.com", "github.com"));
        assert!(host_matches("github.com", "gist.github.com"));
        assert!(host_matches("github.com", "www.github.com"));
        // …a subdomain-specific boost stays scoped to that subtree…
        assert!(host_matches("gist.github.com", "gist.github.com"));
        assert!(!host_matches("gist.github.com", "github.com"));
        // …unrelated hosts and suffix-spoofs don't match…
        assert!(!host_matches("github.com", "notgithub.com"));
        assert!(!host_matches("github.com", "github.com.evil.com"));
        // a leading "*." is accepted and behaves like the bare base.
        assert!(host_matches("*.github.com", "gist.github.com"));
        assert!(host_matches("*.github.com", "github.com"));
    }

    #[test]
    fn save_for_host_and_injection() {
        let s = BoostStore::default();
        s.save(None, "example.com".into(), "wide".into(), "main{max-width:90%}".into(), String::new(), true);
        s.save(None, "www.example.com".into(), "hide".into(), ".ad{display:none}".into(), String::new(), false);
        assert_eq!(s.for_host("example.com").len(), 2); // www normalized to match
        // Only the enabled one is injected; the www host normalizes to the same key.
        let (css, _) = s.injection_for("www.example.com");
        assert!(css.contains("max-width"));
        assert!(!css.contains("display:none"));
    }

    #[test]
    fn update_and_toggle() {
        let s = BoostStore::default();
        let b = s.save(None, "a.com".into(), "n".into(), "x{}".into(), String::new(), true);
        let b2 = s.save(Some(b.id), "a.com".into(), "n2".into(), "y{}".into(), String::new(), true);
        assert_eq!(b.id, b2.id);
        assert_eq!(s.list().len(), 1);
        s.set_enabled(b.id, false);
        assert_eq!(s.injection_for("a.com").0, "");
    }
}
