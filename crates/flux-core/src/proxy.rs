//! Optional outbound proxy (BACKLOG #63): route page webviews through a
//! user-supplied **HTTP** or **SOCKS5** proxy — e.g. an SSH `-D` tunnel, Cloudflare
//! WARP's local proxy, a self-hosted Shadowsocks/Dante, or Tor (`socks5://127.0.0.1:9150`).
//!
//! Bring-your-own: Flux doesn't run a VPN, it just points WebView2 at the endpoint
//! you give it. Persisted to a small file in app data and applied when a webview is
//! created, so a change takes effect on new / reloaded tabs. Opt-in — empty = direct.
//!
//! wry only supports `http://` and `socks5://`; a value that isn't one of those is
//! never passed to the builder (it would fail webview creation), so a bad setting
//! degrades to a direct connection rather than breaking browsing.
//!
//! Windows and Linux only (see [`SUPPORTED`]). Elsewhere a saved proxy makes page
//! webviews refuse to open instead of quietly connecting directly.

use parking_lot::RwLock;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Url};

/// Whether a webview's `proxy_url` takes effect in this build. WKWebView applies
/// it only with tauri's `macos-proxy` feature (macOS 14+), which Flux doesn't
/// enable, and Android/iOS ignore it: the page would silently connect directly.
pub const SUPPORTED: bool = !cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "android"
));

#[derive(Default)]
pub struct ProxyState {
    url: RwLock<Option<String>>,
    path: Option<PathBuf>,
}

impl ProxyState {
    pub fn restore(path: PathBuf) -> Self {
        let url = std::fs::read_to_string(&path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            url: RwLock::new(url),
            path: Some(path),
        }
    }

    pub fn get(&self) -> Option<String> {
        self.url.read().clone()
    }

    fn store(&self, url: Option<String>) {
        *self.url.write() = url.clone();
        if let Some(p) = &self.path {
            let _ = std::fs::write(p, url.unwrap_or_default());
        }
    }

    /// The proxy as a `Url` the webview builder accepts — `None` (→ direct) unless
    /// it's a valid `http://` or `socks5://` endpoint with a host and port.
    pub fn parsed(&self) -> Option<Url> {
        let u = Url::parse(&self.get()?).ok()?;
        (matches!(u.scheme(), "http" | "socks5") && u.host_str().is_some() && u.port().is_some())
            .then_some(u)
    }

    /// `parsed()`, or `Err` when there is a proxy this build can't apply.
    fn to_apply(&self) -> Result<Option<Url>, String> {
        match self.parsed() {
            Some(_) if !SUPPORTED => Err(
                "a proxy is set but this platform can't apply it, so the page isn't loaded \
                 (it would connect directly); clear it in Settings"
                    .into(),
            ),
            proxy => Ok(proxy),
        }
    }
}

/// The proxy to build a page webview (tab, panel, peek, installed app) with:
/// `None` is direct. `Err` means one is configured that this platform can't
/// apply, and the caller must not open the page: a Tor user would otherwise
/// browse with their real IP, believing they're proxied.
pub fn for_webview(app: &AppHandle) -> Result<Option<Url>, String> {
    app.try_state::<ProxyState>()
        .map_or(Ok(None), |s| s.to_apply())
}

/// Validate a user-supplied proxy URL the way `parsed()` will accept it.
fn validate(url: &str) -> Result<(), String> {
    let u = Url::parse(url).map_err(|e| format!("not a valid URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "socks5") {
        return Err("proxy must start with http:// or socks5://".into());
    }
    if u.host_str().is_none() || u.port().is_none() {
        return Err("include a host and port, e.g. socks5://127.0.0.1:1080".into());
    }
    Ok(())
}

#[tauri::command]
pub fn proxy_get(state: State<'_, ProxyState>) -> Option<String> {
    state.get()
}

#[tauri::command]
pub fn proxy_set(state: State<'_, ProxyState>, url: Option<String>) -> Result<(), String> {
    let cleaned = url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(u) = &cleaned {
        validate(u)?;
        if !SUPPORTED {
            return Err(
                "proxies aren't supported on this platform yet; pages would connect directly"
                    .into(),
            );
        }
    }
    state.store(cleaned);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_socks5_only() {
        let s = ProxyState::default();
        s.store(Some("socks5://127.0.0.1:1080".into()));
        assert!(s.parsed().is_some());
        s.store(Some("http://10.0.0.1:8080".into()));
        assert!(s.parsed().is_some());
        // Unsupported scheme / missing port → no proxy applied (direct), never an error.
        s.store(Some("https://example.com:443".into()));
        assert!(s.parsed().is_none());
        s.store(Some("socks5://127.0.0.1".into()));
        assert!(s.parsed().is_none());
        s.store(Some("garbage".into()));
        assert!(s.parsed().is_none());
        assert!(validate("ftp://x:1").is_err());
        assert!(validate("socks5://127.0.0.1:1080").is_ok());
    }

    #[test]
    fn a_proxy_this_build_cannot_apply_blocks_the_page() {
        let s = ProxyState::default();
        assert_eq!(s.to_apply(), Ok(None));
        s.store(Some("garbage".into()));
        assert_eq!(s.to_apply(), Ok(None), "an unusable value stays direct");
        s.store(Some("socks5://127.0.0.1:9150".into()));
        if SUPPORTED {
            assert_eq!(s.to_apply(), Ok(s.parsed()));
        } else {
            assert!(s.to_apply().is_err(), "must not silently go direct");
        }
    }
}
