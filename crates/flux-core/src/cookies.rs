//! Cookie controls (BACKLOG #58): clear cookies for a site or everywhere, and
//! per-site **clear-on-close**, via Tauri's cookie API (WebView2's cookie
//! manager, `WKHTTPCookieStore`, WebKitGTK's cookie manager).
//!
//! **Jars.** The shell, tabs outside containers, web panels and installed web
//! apps share the default jar, cleared through the **main** webview, which is
//! always alive. A container (#59) has a jar the main webview can't reach: its
//! own data dir on WebView2 and WebKitGTK, its own WebKit data store on macOS
//! 14+ (older macOS keeps container tabs in the default store). That jar is
//! cleared through a webview on it: a live tab or peek in the container, else a
//! hidden webview built for the clear and closed after it. Not a clear queued
//! for the container's next open: that would leave the cookies on disk until
//! then (for good, if it never reopens), and the first page would load with
//! them before the clear could run. Private tabs' jars are in memory and go
//! with their webviews.

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};

/// Per-site privacy flags, and the jar each live container webview is on.
#[derive(Default)]
pub struct CookieState {
    /// Hosts whose cookies are wiped when their tab closes.
    clear_on_close: DashMap<String, ()>,
    /// The container each live tab or peek webview was built on, by label (no
    /// entry: the default jar). Recorded at build because `FluxState` can't
    /// tell: a peek isn't a tab, and deleting a container moves its tabs to the
    /// default jar while their live webviews stay on the container's.
    jars: DashMap<String, u32>,
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
            ..Self::default()
        }
    }
    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let mut hosts = self.status().clear_on_close;
        hosts.sort();
        crate::persist::save_json_pretty(path, &hosts, crate::persist::Durability::Barrier);
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
    fn note_jar(&self, label: &str, container: u32) {
        if container == 0 {
            self.jars.remove(label);
        } else {
            self.jars.insert(label.to_string(), container);
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

/// Record the jar a tab or peek webview was just built on: `container` 0 for
/// the default jar or a private webview's own, which need no record.
pub fn note_jar(app: &AppHandle, label: &str, container: u32) {
    if let Some(s) = app.try_state::<CookieState>() {
        s.note_jar(label, container);
    }
}

/// The container a live webview's jar belongs to, if it was built on one.
pub fn jar_of(app: &AppHandle, label: &str) -> Option<u32> {
    app.try_state::<CookieState>()?.jars.get(label).map(|j| *j)
}

/// Drop a closing webview's record, so no clear picks it to work through.
pub fn forget_jar(app: &AppHandle, label: &str) {
    if let Some(s) = app.try_state::<CookieState>() {
        s.jars.remove(label);
    }
}

/// Clear-on-close: delete `host`'s cookies (all schemes) from the jar the
/// closing tab was on (`container` 0: the default jar). `webview_close` calls
/// it after closing the tab's webview, so the page can't set them again.
pub fn clear_for_host(app: &AppHandle, host: &str, container: u32) {
    if let Err(e) = clear(app, Some(host.to_string()), Jars::One(container)) {
        tracing::warn!(target: "flux::cookies", "clear-on-close for {host} failed: {e}");
    }
}

/// Clear one host's cookies (all schemes), in every jar.
#[tauri::command]
pub fn cookies_clear_site(app: AppHandle, host: String) -> Result<(), String> {
    clear(&app, Some(host), Jars::All)
}

/// Clear every cookie, in every jar.
#[tauri::command]
pub fn cookies_clear_all(app: AppHandle) -> Result<(), String> {
    clear(&app, None, Jars::All)
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

/// The jars a clear covers.
#[derive(Clone, Copy)]
enum Jars {
    /// The default jar and every container's.
    All,
    /// One jar: a container's, or the default jar (0).
    One(u32),
}

fn clear(app: &AppHandle, host: Option<String>, jars: Jars) -> Result<(), String> {
    // The shell ("main") webview is always alive and on the default jar.
    let main = app.get_webview("main").ok_or("no main window")?;
    let app = app.clone();
    // Off the UI thread: enumerating waits on the engine, which deadlocks
    // WebView2 there (wry#583), and so does building a webview on a jar.
    std::thread::spawn(move || {
        let host = host.as_deref();
        let mut cleared = 0usize;
        if matches!(jars, Jars::All | Jars::One(0)) {
            match clear_jar(&main, host) {
                Ok(n) => cleared += n,
                Err(e) => {
                    tracing::warn!(target: "flux::cookies", "cookie enumeration failed: {e}")
                }
            }
        }
        cleared += clear_containers(&app, jars, host);
        let host = host.unwrap_or("*");
        tracing::info!(target: "flux::cookies", host, cleared, "cookies cleared");
    });
    Ok(())
}

/// Delete `host`'s cookies (every cookie, for `None`) from the jar `wv` is on,
/// returning how many. Enumerate, then delete cookie by cookie, the same on
/// every engine: WebView2's `DeleteCookies` needs a cookie name (the empty one
/// this used matched nothing), and a per-URL lookup would miss other paths and
/// subdomains.
fn clear_jar(wv: &Webview, host: Option<&str>) -> Result<usize, String> {
    let mut cleared = 0;
    for c in wv.cookies().map_err(|e| e.to_string())? {
        let hit = match (host, c.domain()) {
            (None, _) => true,
            (Some(h), Some(d)) => cookie_for_host(h, d),
            (Some(_), None) => false,
        };
        if hit && wv.delete_cookie(c).is_ok() {
            cleared += 1;
        }
    }
    Ok(cleared)
}

#[cfg(desktop)]
use containers::clear_containers;

/// No container jars on mobile: every tab is on the main webview's (ADR 0012).
#[cfg(not(desktop))]
fn clear_containers(_app: &AppHandle, _jars: Jars, _host: Option<&str>) -> usize {
    0
}

/// Container jars (#59): finding them, and a webview to clear each through.
#[cfg(desktop)]
mod containers {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use tauri::webview::WebviewBuilder;
    use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

    use super::{clear_jar, CookieState, Jars};

    impl CookieState {
        /// The jars live webviews are on, dropping the records of closed ones.
        fn live_jars(&self, alive: impl Fn(&str) -> bool) -> Vec<u32> {
            self.jars.retain(|label, _| alive(label));
            self.jars.iter().map(|j| *j.value()).collect()
        }

        /// A live webview on `container`'s jar, if there is one.
        fn conduit(&self, container: u32, alive: impl Fn(&str) -> bool) -> Option<String> {
            self.jars
                .iter()
                .find(|j| *j.value() == container && alive(j.key().as_str()))
                .map(|j| j.key().clone())
        }
    }

    /// Delete `host`'s cookies (every cookie, for `None`) from the container
    /// jars `jars` covers, returning how many.
    pub(super) fn clear_containers(app: &AppHandle, jars: Jars, host: Option<&str>) -> usize {
        let Some(state) = app.try_state::<CookieState>() else {
            return 0;
        };
        let alive = |label: &str| app.get_webview(label).is_some();
        let containers = match jars {
            Jars::One(0) => return 0,
            Jars::One(container) => vec![container],
            Jars::All => to_clear(stored(app), || known(app), state.live_jars(alive)),
        };
        containers
            .into_iter()
            .map(|container| clear_container(app, &state, container, host))
            .sum()
    }

    /// Clear one container's jar: through a live webview on it if there is
    /// one, else through a hidden one.
    fn clear_container(
        app: &AppHandle,
        state: &CookieState,
        container: u32,
        host: Option<&str>,
    ) -> usize {
        let alive = |label: &str| app.get_webview(label).is_some();
        let live = state
            .conduit(container, alive)
            .and_then(|label| app.get_webview(&label));
        if let Some(wv) = live {
            match clear_jar_checked(&wv, host) {
                Ok(n) => return n,
                // It closed during the clear; the hidden webview finishes it.
                Err(e) => tracing::debug!(target: "flux::cookies", container, "{e}"),
            }
        }
        match HiddenJar::open(app, container).and_then(|jar| clear_jar_checked(&jar.0, host)) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(target: "flux::cookies", container, "container clear failed: {e}");
                0
            }
        }
    }

    /// [`clear_jar`], then one more enumeration. Tauri runs a webview's calls
    /// in order, so it's answered after the deletes, and only if the webview
    /// outlived them: deletes sent to a webview that closed in between are
    /// dropped without an error, and a tab or peek can close at any moment.
    fn clear_jar_checked(wv: &Webview, host: Option<&str>) -> Result<usize, String> {
        let cleared = clear_jar(wv, host)?;
        wv.cookies()
            .map_err(|e| format!("{} closed during the clear: {e}", wv.label()))?;
        Ok(cleared)
    }

    /// A hidden webview on a container's jar, to clear it while no tab or peek
    /// is open there. It gets a container tab's jar settings (data dir, data
    /// store, proxy), since WebView2 refuses a second webview on a data dir with
    /// different options. Never leaves `about:blank`; closed when dropped.
    struct HiddenJar(Webview);

    impl HiddenJar {
        fn open(app: &AppHandle, container: u32) -> Result<Self, String> {
            static SEQ: AtomicU64 = AtomicU64::new(1);
            let window = app.get_window("main").ok_or("no main window")?;
            let label = format!("jar-{container}-{}", SEQ.fetch_add(1, Ordering::Relaxed));
            let blank: tauri::Url = "about:blank".parse().map_err(|e| format!("{e}"))?;
            let mut builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
                .focused(false)
                .on_navigation(|u| u.as_str() == "about:blank")
                .data_store_identifier(crate::webview::container_store_id(container));
            if let Some(dir) = crate::webview::container_data_dir(app, container) {
                builder = builder.data_directory(dir);
            }
            // Where a proxy can't apply (macOS) tabs refuse to load at all, but
            // this webview loads nothing and has no environment to match.
            if let Ok(Some(proxy)) = crate::proxy::for_webview(app) {
                builder = builder.proxy_url(proxy);
            }
            let wv = window
                .add_child(
                    builder,
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(0.0, 0.0),
                )
                .map_err(|e| e.to_string())?;
            let _ = wv.hide();
            Ok(Self(wv))
        }
    }

    impl Drop for HiddenJar {
        fn drop(&mut self) {
            // Queued behind the clear's own calls, so it lands after them.
            let _ = self.0.close();
        }
    }

    /// The containers that may hold cookies: those with a data dir, which Tauri
    /// creates before building any webview in one. `None` if it can't be read.
    fn stored(app: &AppHandle) -> Option<Vec<u32>> {
        jars_in(&crate::webview::containers_dir(app)?)
    }

    /// The containers among the data dirs in `dir`.
    fn jars_in(dir: &Path) -> Option<Vec<u32>> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            // No container has been opened yet.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
            Err(_) => return None,
        };
        Some(
            entries
                .flatten()
                .filter_map(|e| e.file_name().to_str()?.parse().ok())
                .filter(|&c| c != 0)
                .collect(),
        )
    }

    /// Every container Flux knows of: tried when the data dirs can't be read.
    fn known(app: &AppHandle) -> Vec<u32> {
        app.try_state::<crate::state::FluxState>()
            .map(|s| s.containers_list().into_iter().map(|c| c.id).collect())
            .unwrap_or_default()
    }

    /// The container jars a clear of every jar covers, each once: those that
    /// may hold cookies (every known container, if that can't be told), and
    /// those live webviews are on.
    fn to_clear(
        stored: Option<Vec<u32>>,
        known: impl FnOnce() -> Vec<u32>,
        live: Vec<u32>,
    ) -> Vec<u32> {
        let mut jars = stored.unwrap_or_else(known);
        jars.extend(live);
        jars.retain(|&c| c != 0);
        jars.sort_unstable();
        jars.dedup();
        jars
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_container_clear_goes_through_a_live_webview_on_its_jar() {
            let s = CookieState::new();
            s.note_jar("tab-1", 2);
            s.note_jar("peek-3", 2);
            s.note_jar("tab-4", 5);
            s.note_jar("tab-6", 0); // the default jar: nothing to record
            let alive = |label: &str| label != "tab-1";
            assert_eq!(s.conduit(2, alive).as_deref(), Some("peek-3"));
            assert_eq!(s.conduit(3, alive), None, "none live: a hidden webview");
            let mut live = s.live_jars(alive);
            live.sort_unstable();
            assert_eq!(live, [2, 5]);
            assert!(
                !s.jars.contains_key("tab-1"),
                "a closed webview's record goes"
            );
            // Rebuilt after its container was deleted: on the default jar now.
            s.note_jar("tab-4", 0);
            assert_eq!(s.conduit(5, |_| true), None);
        }

        #[test]
        fn clearing_every_jar_covers_each_container_jar_once() {
            assert_eq!(
                to_clear(Some(vec![3, 1]), Vec::new, vec![1, 4, 0]),
                [1, 3, 4]
            );
            // A container nothing has opened in has no jar to clear...
            assert!(to_clear(Some(vec![]), || vec![1, 2], vec![]).is_empty());
            // ...unless that can't be told: then every known one is tried.
            assert_eq!(to_clear(None, || vec![2, 1], vec![]), [1, 2]);
        }

        #[test]
        fn container_jars_are_found_by_their_data_dirs() {
            let dir = std::env::temp_dir().join(format!("flux-cookie-jars-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!(jars_in(&dir), Some(vec![]), "no container opened yet");
            for name in ["1", "7", "0", "notes"] {
                std::fs::create_dir_all(dir.join(name)).unwrap();
            }
            let mut jars = jars_in(&dir).unwrap();
            jars.sort_unstable();
            assert_eq!(jars, [1, 7]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
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
