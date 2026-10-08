//! Cookie controls (BACKLOG #58): clear cookies for a site or everywhere, and
//! per-site **clear-on-close**, via Tauri's cookie API (WebView2's cookie
//! manager, `WKHTTPCookieStore`, WebKitGTK's cookie manager).
//!
//! All tab webviews + the shell share one cookie store (container tabs aside:
//! each has its own data directory), so we run cookie ops through the **main**
//! webview — it's always alive, which avoids a race with a closing tab during
//! clear-on-close.

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Per-site privacy flags.
#[derive(Default)]
pub struct CookieState {
    /// Hosts whose cookies are wiped when their tab closes.
    clear_on_close: DashMap<String, ()>,
    /// Where the flags are saved (`None` = in-memory only; tests).
    path: Option<std::path::PathBuf>,
}

impl CookieState {
    pub fn new() -> Self {
        Self::default()
    }
    /// Load the saved flags. In memory only, they silently stopped clearing
    /// anything after a restart.
    pub fn restore(path: std::path::PathBuf) -> Self {
        let hosts: Vec<String> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            clear_on_close: hosts.into_iter().map(|h| (h, ())).collect(),
            path: Some(path),
        }
    }
    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let mut hosts = self.status().clear_on_close;
        hosts.sort();
        crate::persist::save_json_pretty(path, &hosts);
    }
    pub fn should_clear_on_close(&self, host: &str) -> bool {
        self.clear_on_close.contains_key(host)
    }
    fn status(&self) -> CookieStatus {
        CookieStatus {
            clear_on_close: self
                .clear_on_close
                .iter()
                .map(|e| e.key().clone())
                .collect(),
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct CookieStatus {
    pub clear_on_close: Vec<String>,
}

/// Host of a URL (`https://a.b.com/x` → `a.b.com`).
pub fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1)?;
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    Some(host.split(':').next().unwrap_or(host))
}

/// Clear cookies for `host` (all schemes) through the main webview. Called by
/// the clear-on-close hook in `webview_close`.
pub fn clear_for_host(app: &AppHandle, host: &str) {
    if let Err(e) = clear(app, Some(host.to_string())) {
        tracing::warn!(target: "flux::cookies", "clear-on-close for {host} failed: {e}");
    }
}

/// Clear cookies for one host (all schemes).
#[tauri::command]
pub fn cookies_clear_site(app: AppHandle, host: String) -> Result<(), String> {
    clear(&app, Some(host))
}

/// Clear every cookie in the store.
#[tauri::command]
pub fn cookies_clear_all(app: AppHandle) -> Result<(), String> {
    clear(&app, None)
}

/// Flag (or unflag) a host to clear its cookies when its tab closes.
#[tauri::command]
pub fn cookies_set_clear_on_close(state: tauri::State<'_, CookieState>, host: String, on: bool) {
    if on {
        state.clear_on_close.insert(host, ());
    } else {
        state.clear_on_close.remove(&host);
    }
    state.persist();
}

#[tauri::command]
pub fn cookies_status(state: tauri::State<'_, CookieState>) -> CookieStatus {
    state.status()
}

fn clear(app: &AppHandle, host: Option<String>) -> Result<(), String> {
    // The shell ("main") webview is always alive and shares the cookie store.
    let main = app.get_webview_window("main").ok_or("no main window")?;
    // Enumerate, then delete cookie by cookie, the same on every engine.
    // WebView2's `DeleteCookies` needs a cookie name (the empty one this used
    // matched nothing), and a per-URL lookup would miss other paths and
    // subdomains. Off the UI thread: enumerating waits on the engine, which
    // deadlocks WebView2 there (wry#583).
    std::thread::spawn(move || {
        let cookies = match main.cookies() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "flux::cookies", "cookie enumeration failed: {e}");
                return;
            }
        };
        let mut cleared = 0usize;
        for c in cookies {
            let hit = match (&host, c.domain()) {
                (None, _) => true,
                (Some(h), Some(d)) => cookie_for_host(h, d),
                (Some(_), None) => false,
            };
            if hit && main.delete_cookie(c).is_ok() {
                cleared += 1;
            }
        }
        let host = host.as_deref().unwrap_or("*");
        tracing::info!(target: "flux::cookies", host, cleared, "cookies cleared");
    });
    Ok(())
}

/// Does a cookie on `domain` belong to `host`? Host-only and subdomain cookies,
/// plus parent-domain ones (`.example.com` for `www.example.com`), which the
/// site reads as its own.
fn cookie_for_host(host: &str, domain: &str) -> bool {
    let d = domain.trim_start_matches('.').to_ascii_lowercase();
    let h = host.to_ascii_lowercase();
    d == h || h.ends_with(&format!(".{d}")) || d.ends_with(&format!(".{h}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_domains_match_the_site() {
        assert!(cookie_for_host("bank.example", "bank.example")); // host-only
        assert!(cookie_for_host("bank.example", ".bank.example"));
        assert!(cookie_for_host("www.bank.example", ".bank.example")); // parent domain
        assert!(cookie_for_host("bank.example", "login.bank.example")); // subdomain
        assert!(cookie_for_host("Bank.Example", ".bank.example"));
        assert!(!cookie_for_host("bank.example", "notbank.example"));
        assert!(!cookie_for_host("bank.example", "bank.example.evil"));
        assert!(!cookie_for_host("www.bank.example", "other.bank.example"));
    }

    #[test]
    fn clear_on_close_flags_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("flux-cookies-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("clear-on-close.json");
        let s = CookieState::restore(path.clone());
        s.clear_on_close.insert("bank.example".into(), ());
        s.persist();
        assert!(CookieState::restore(path).should_clear_on_close("bank.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
