//! On-disk browsing data: how much the engine is holding, and how to clear it.
//!
//! This exists because of a real gap, found while chasing a renderer crash. A
//! service-worker CacheStorage had grown to **753 MB** without anything ever
//! saying so, and there was no way to clear it from inside Flux — the only cure
//! was deleting folders by hand from PowerShell. Every other browser has this;
//! Flux didn't.
//!
//! **It was not the crash.** That turned out to be two injected page scripts
//! calling the IPC bridge at document-created (see `webview.rs`), and clearing
//! the caches changed nothing. The size was a real problem worth surfacing on its
//! own terms — a browser that sells itself on being light shouldn't quietly sit
//! on a gigabyte — but this is hygiene, not a fix for anything.
//!
//!
//! **Clearing is deferred to the next launch.** The engine holds these files open
//! while it runs, so deleting them live either fails or corrupts the profile
//! further — and the case that matters most is a profile so broken it crashes on
//! load, where "close the browser first" is the only order that works. So
//! `storage_clear` writes a marker and [`apply_pending_clear`] acts on it at boot,
//! before any webview exists.
//!
//! **macOS is the exception** (the `webkit` module below). WKWebView keeps its
//! data in WebKit's own stores under `~/Library`, not in Flux's data folder, so
//! none of the Chromium paths exist there and this page used to report 0 and
//! clear nothing. WebKit clears a live store safely through `WKWebsiteDataStore`,
//! so there the clear is immediate, for the default store and every container's.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// A group of on-disk data the user can reason about and clear independently.
struct Category {
    key: &'static str,
    label: &'static str,
    hint: &'static str,
    /// Paths relative to the profile root. Missing ones simply contribute 0 —
    /// the layout is engine-specific and this must not fail on an unknown one.
    /// Not read on macOS, which measures WebKit's own stores (`webkit`).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    paths: &'static [&'static str],
    /// Above this, the category is called out as abnormal. `None` = never warn.
    warn_over: Option<u64>,
}

const MB: u64 = 1024 * 1024;

/// Chromium's profile layout (WebView2 on Windows). WebKitGTK stores different
/// names in a different root; unknown paths report 0 rather than erroring, so the
/// page degrades to showing less rather than lying.
const CATEGORIES: &[Category] = &[
    Category {
        key: "serviceworkers",
        label: "Service workers",
        hint: "Offline caches sites install. The group most likely to grow without bound — one reached 753 MB here before anything surfaced it.",
        paths: &["Default/Service Worker"],
        // A healthy service-worker store is single-digit MB. A quarter of a
        // gigabyte already means something is not evicting, which is worth saying
        // even though a large store has not been shown to break anything.
        warn_over: Some(250 * MB),
    },
    Category {
        key: "cache",
        label: "Cache",
        hint: "Fetched pages, scripts and images. Safe to clear; the first load of each site is slower afterwards.",
        paths: &["Default/Cache", "Default/Code Cache", "Default/GPUCache"],
        warn_over: Some(1024 * MB),
    },
    Category {
        key: "sitedata",
        label: "Site storage",
        hint: "localStorage, IndexedDB and session storage. Clearing can sign you out of sites that keep their session here.",
        paths: &[
            "Default/Local Storage",
            "Default/IndexedDB",
            "Default/Session Storage",
        ],
        warn_over: Some(512 * MB),
    },
    Category {
        key: "cookies",
        label: "Cookies",
        hint: "Signs you out of everything. Kept separate so the other options don't cost you your logins.",
        paths: &["Default/Network"],
        warn_over: None,
    },
];

/// One row in the storage report.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StorageEntry {
    pub key: String,
    pub label: String,
    pub hint: String,
    pub bytes: u64,
    /// This category is larger than it has any business being.
    pub warn: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StorageReport {
    pub entries: Vec<StorageEntry>,
    pub total_bytes: u64,
    /// Any category is over its threshold, or the profile as a whole is.
    pub warn: bool,
    /// Set once a clear is queued, so the UI can say a restart is needed.
    pub pending: Vec<String>,
    /// Where this was measured, for the "it's not lying, go look" case.
    pub root: String,
    /// Clearing happens at once (macOS, through WebKit) rather than at the next
    /// launch, so the page asks first and says it's done.
    pub clears_now: bool,
}

/// Whole-profile ceiling. Independently of any one category, a browsing profile
/// past this is worth a word — Flux's pitch is being light on resources.
const TOTAL_WARN: u64 = 2048 * MB;

/// Root of the engine's on-disk profile.
///
/// WebView2 puts its profile in an `EBWebView` folder under the app's local data
/// dir; WebKitGTK keeps its data directly in the app data dir.
pub fn profile_root(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    if cfg!(windows) {
        Some(base.join("EBWebView"))
    } else {
        Some(base)
    }
}

/// Every engine profile: the default one, then each container's own jar.
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS reads WebKit's stores
fn profile_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = profile_root(app).into_iter().collect();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.extend(container_roots(&dir));
    }
    roots
}

/// The container jars under the app data dir. `webview.rs` gives a container's
/// tabs `<app data>/containers/<n>` as their user-data folder, so on WebView2
/// each one holds a whole `EBWebView` profile of its own.
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS reads WebKit's stores
fn container_roots(app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(app_data.join("containers")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| {
            let jar = e.path();
            if cfg!(windows) {
                jar.join("EBWebView")
            } else {
                jar
            }
        })
        .collect()
}

/// The absolute paths `keys` cover in every profile, keeping only those that
/// exist. On an engine whose layout isn't mapped (WKWebView, WebKitGTK) none of
/// these Chromium paths do, and queuing them reported a clear that never happens.
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS clears live instead
fn clear_targets(roots: &[PathBuf], keys: &[String]) -> Vec<String> {
    CATEGORIES
        .iter()
        .filter(|c| keys.iter().any(|k| k == c.key))
        .flat_map(|c| c.paths.iter())
        .flat_map(|rel| roots.iter().map(move |r| r.join(rel)))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// Total size of a directory tree, following no symlinks.
///
/// Returns what it could read rather than failing: a profile with one unreadable
/// file should still report a number, since the number is the whole point.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // never follow: a loop would hang the walk
        }
        if ft.is_dir() {
            total += dir_size(&e.path());
        } else if let Ok(m) = e.metadata() {
            total += m.len();
        }
    }
    total
}

/// Must match `identifier` in tauri.conf.json — the boot-time pass runs before
/// Tauri exists and so can't ask it where anything is.
const IDENTIFIER: &str = "dev.flux.browser";

/// Where the marker lives, resolved from the environment alone so the same
/// function works before Tauri is built and after.
fn marker_path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
    } else if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        PathBuf::from(x)
    } else {
        PathBuf::from(std::env::var("HOME").ok()?).join(".local/share")
    };
    Some(base.join(IDENTIFIER).join("pending-clear.json"))
}

/// A queued clear. **Absolute paths, resolved when it was queued** — the boot
/// pass deletes exactly what the report measured, instead of recomputing the
/// layout and risking deleting somewhere else entirely.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Pending {
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
}

impl Pending {
    /// Add to the queue (a union): clearing cookies, then the cache, in two
    /// clicks must clear both.
    #[cfg_attr(target_os = "macos", allow(dead_code))] // macOS clears live instead
    fn merge(&mut self, keys: Vec<String>, paths: Vec<String>) {
        for k in keys {
            if !self.keys.contains(&k) {
                self.keys.push(k);
            }
        }
        for p in paths {
            if !self.paths.contains(&p) {
                self.paths.push(p);
            }
        }
    }
}

fn read_pending_file() -> Pending {
    marker_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Pending>(&s).ok())
        .unwrap_or_default()
}

fn read_pending(_app: &AppHandle) -> Vec<String> {
    read_pending_file().keys
}

/// Measure the profile. Walks the tree, so callers run it off the UI thread.
#[tauri::command]
pub async fn storage_usage(app: AppHandle) -> Result<StorageReport, String> {
    let pending = read_pending(&app);
    #[cfg(not(target_os = "macos"))]
    let (root, roots) = (
        profile_root(&app).ok_or("no app data directory")?,
        profile_roots(&app),
    );
    #[cfg(target_os = "macos")]
    let (root, stores) = (webkit::data_root(), webkit::stores());
    let report = tauri::async_runtime::spawn_blocking(move || {
        let entries: Vec<StorageEntry> = CATEGORIES
            .iter()
            .map(|c| {
                #[cfg(target_os = "macos")]
                let bytes: u64 = stores.iter().map(|s| s.bytes(c.key)).sum();
                #[cfg(not(target_os = "macos"))]
                let bytes: u64 = c
                    .paths
                    .iter()
                    .flat_map(|p| roots.iter().map(move |r| dir_size(&r.join(p))))
                    .sum();
                StorageEntry {
                    key: c.key.to_string(),
                    label: c.label.to_string(),
                    hint: c.hint.to_string(),
                    bytes,
                    warn: c.warn_over.is_some_and(|limit| bytes > limit),
                }
            })
            .collect();
        let total_bytes = entries.iter().map(|e| e.bytes).sum();
        StorageReport {
            warn: total_bytes > TOTAL_WARN || entries.iter().any(|e| e.warn),
            entries,
            total_bytes,
            pending,
            root: root.to_string_lossy().to_string(),
            clears_now: cfg!(target_os = "macos"),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    // Cache it so the resource monitor can warn without walking the tree again.
    if let Some(cache) = app.try_state::<StorageWarn>() {
        *cache.0.lock() = Some(report.clone());
    }
    Ok(report)
}

/// Clear categories of browsing data. Returns the message to show.
///
/// On macOS WebKit clears them now, live. Elsewhere they're queued for deletion
/// at next launch: see the module docs on why.
#[tauri::command]
pub async fn storage_clear(app: AppHandle, keys: Vec<String>) -> Result<String, String> {
    let known: Vec<String> = keys
        .into_iter()
        .filter(|k| CATEGORIES.iter().any(|c| c.key == k))
        .collect();
    if known.is_empty() {
        return Err("nothing selected to clear".into());
    }
    #[cfg(target_os = "macos")]
    {
        let labels: Vec<&str> = CATEGORIES
            .iter()
            .filter(|c| known.iter().any(|k| k == c.key))
            .map(|c| c.label)
            .collect();
        webkit::clear(&app, &known).await?;
        Ok(format!("Cleared: {}.", labels.join(", ")))
    }
    #[cfg(not(target_os = "macos"))]
    queue_clear(&app, known)
}

/// Queue `known` categories for the boot-time pass.
#[cfg(not(target_os = "macos"))]
fn queue_clear(app: &AppHandle, known: Vec<String>) -> Result<String, String> {
    let roots = profile_roots(app);
    if roots.is_empty() {
        return Err("no app data directory".into());
    }
    let paths = clear_targets(&roots, &known);
    if paths.is_empty() {
        return Err(if cfg!(windows) {
            "none of that is stored yet — nothing was queued".into()
        } else {
            "this engine keeps that data somewhere Flux can't clear yet — nothing was queued".into()
        });
    }
    let p = marker_path().ok_or("no app data directory")?;
    // Merge, don't replace: a second clear used to silently cancel the first.
    // Atomic, so the boot pass never reads a torn marker as "nothing queued";
    // fully flushed, since a clear the user was told is queued must not
    // quietly vanish in a power cut.
    let mut pending = read_pending_file();
    pending.merge(known, paths);
    let json = serde_json::to_string(&pending).map_err(|e| e.to_string())?;
    crate::persist::write_atomic_with(&p, json.as_bytes(), crate::persist::Durability::Full)
        .map_err(|e| format!("couldn't queue the clear: {e}"))?;
    Ok(format!(
        "{} queued — deleted next time Flux starts.",
        pending.keys.len()
    ))
}

/// Forget a queued clear.
#[tauri::command]
pub fn storage_clear_cancel() -> Result<(), String> {
    if let Some(p) = marker_path() {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Delete anything queued by a previous run.
///
/// **Call before Tauri builds the app**, while the engine holds nothing open: on
/// Windows a live WebView2 keeps profile files locked, so a delete would either
/// fail or half-succeed and leave the profile worse than it found it.
pub fn apply_pending_clear_early() {
    let pending = read_pending_file();
    if pending.paths.is_empty() {
        return;
    }
    // Drop the marker first: a path that somehow kills the process must not make
    // every future launch retry it forever.
    if let Some(p) = marker_path() {
        let _ = std::fs::remove_file(p);
    }
    for path in &pending.paths {
        let target = Path::new(path);
        if !target.exists() {
            continue;
        }
        let freed = dir_size(target);
        match std::fs::remove_dir_all(target) {
            Ok(()) => {
                tracing::info!(target: "flux::storage", path, freed, "cleared browsing data")
            }
            Err(e) => {
                tracing::warn!(target: "flux::storage", path, error = %e, "couldn't clear")
            }
        }
    }
}

/// WKWebView's stores (macOS): where each category lives on disk, and clearing
/// through `WKWebsiteDataStore`.
#[cfg(target_os = "macos")]
mod webkit {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::AppHandle;

    use super::{dir_size, IDENTIFIER};

    /// One WebKit data store's folders: the default store, or a container's.
    pub(super) struct Store {
        /// Per-site storage and the store's own databases.
        data: PathBuf,
        /// The HTTP cache and CacheStorage.
        cache: PathBuf,
        /// Cookie files or folders.
        cookies: Vec<PathBuf>,
    }

    fn library() -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library")
    }

    /// Where the default store keeps per-site data, for the report's "go look".
    pub(super) fn data_root() -> PathBuf {
        library()
            .join("WebKit")
            .join(IDENTIFIER)
            .join("WebsiteData")
    }

    /// The default store, then each container's (macOS 14+ keeps one per
    /// identifier, laid out like the default; a missing folder measures 0).
    pub(super) fn stores() -> Vec<Store> {
        let lib = library();
        let cache = lib.join("Caches").join(IDENTIFIER).join("WebKit");
        let mut out = vec![Store {
            data: data_root(),
            cache: cache.clone(),
            cookies: vec![lib
                .join("HTTPStorages")
                .join(format!("{IDENTIFIER}.binarycookies"))],
        }];
        let by_id = lib.join("WebKit").join(IDENTIFIER).join("WebsiteDataStore");
        if let Ok(entries) = std::fs::read_dir(by_id) {
            for e in entries.flatten() {
                let data = e.path();
                out.push(Store {
                    cache: cache.join("WebsiteDataStore").join(e.file_name()),
                    cookies: vec![data.join("Cookies")],
                    data,
                });
            }
        }
        out
    }

    /// Per-site folders of these kinds: `Default/<top site>/<frame site>/<kind>`.
    fn per_site(root: &Path, kinds: &[&str]) -> u64 {
        let Ok(tops) = std::fs::read_dir(root) else {
            return 0;
        };
        let mut total = 0;
        for top in tops.flatten() {
            let Ok(frames) = std::fs::read_dir(top.path()) else {
                continue;
            };
            for frame in frames.flatten() {
                let frame = frame.path();
                total += kinds.iter().map(|k| dir_size(&frame.join(k))).sum::<u64>();
            }
        }
        total
    }

    fn path_size(p: &Path) -> u64 {
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => dir_size(p),
            Ok(m) if m.is_file() => m.len(),
            _ => 0,
        }
    }

    impl Store {
        #[cfg(test)]
        pub(super) fn at(data: PathBuf, cache: PathBuf, cookies: Vec<PathBuf>) -> Self {
            Store {
                data,
                cache,
                cookies,
            }
        }

        /// Bytes this store holds for a category key.
        pub(super) fn bytes(&self, key: &str) -> u64 {
            let default = self.data.join("Default");
            match key {
                "serviceworkers" => {
                    per_site(&default, &["CacheStorage", "ServiceWorkers"])
                        + dir_size(&self.cache.join("CacheStorage"))
                }
                "cache" => dir_size(&self.cache.join("NetworkCache")),
                "sitedata" => {
                    let kinds = ["LocalStorage", "IndexedDB", "SessionStorage", "FileSystem"];
                    per_site(&default, &kinds)
                        + dir_size(&self.data.join("LocalStorage"))
                        + dir_size(&self.data.join("IndexedDB"))
                }
                "cookies" => self.cookies.iter().map(|p| path_size(p)).sum(),
                _ => 0,
            }
        }
    }

    /// WebKit's data types for a category key. Their values are their names,
    /// and WebKit ignores a type it doesn't know, so older macOS is fine.
    fn types(key: &str) -> &'static [&'static str] {
        match key {
            "serviceworkers" => &[
                "WKWebsiteDataTypeServiceWorkerRegistrations",
                "WKWebsiteDataTypeFetchCache",
            ],
            "cache" => &[
                "WKWebsiteDataTypeDiskCache",
                "WKWebsiteDataTypeMemoryCache",
                "WKWebsiteDataTypeOfflineWebApplicationCache",
            ],
            "sitedata" => &[
                "WKWebsiteDataTypeLocalStorage",
                "WKWebsiteDataTypeSessionStorage",
                "WKWebsiteDataTypeIndexedDBDatabases",
                "WKWebsiteDataTypeWebSQLDatabases",
                "WKWebsiteDataTypeFileSystem",
            ],
            "cookies" => &["WKWebsiteDataTypeCookies"],
            _ => &[],
        }
    }

    /// The containers that have a WebKit store: each has a folder under
    /// `containers/` once any of its tabs has opened (webview.rs).
    fn container_ids(app: &AppHandle) -> Vec<u32> {
        let Some(dir) = crate::webview::containers_dir(app) else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect()
    }

    /// Clear `keys` from the default store and every container's, waiting for
    /// WebKit to report each done. Live stores are fine: WebKit coordinates the
    /// removal with its own processes.
    pub(super) async fn clear(app: &AppHandle, keys: &[String]) -> Result<(), String> {
        let types: Vec<&'static str> = keys.iter().flat_map(|k| types(k)).copied().collect();
        let ids: Vec<[u8; 16]> = container_ids(app)
            .into_iter()
            .map(crate::webview::container_store_id)
            .collect();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        // WebKit's API is main-thread only.
        app.run_on_main_thread(move || unsafe { remove(&types, &ids, tx) })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(30))
                .map_err(|_| "WebKit didn't finish clearing in time".to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Start the removal on each store; `done` gets one message after the last
    /// store reports back.
    unsafe fn remove(types: &[&str], ids: &[[u8; 16]], done: std::sync::mpsc::Sender<()>) {
        let set: *mut Object = msg_send![class!(NSMutableSet), set];
        for t in types {
            let Ok(name) = std::ffi::CString::new(*t) else {
                continue;
            };
            let ns: *mut Object = msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()];
            let _: () = msg_send![set, addObject: ns];
        }
        let default: *mut Object = msg_send![class!(WKWebsiteDataStore), defaultDataStore];
        let mut stores = vec![default];
        // Containers' own stores exist on macOS 14 and later.
        let by_id = sel!(dataStoreForIdentifier:);
        let has_ids: bool = msg_send![class!(WKWebsiteDataStore), respondsToSelector: by_id];
        if has_ids {
            for id in ids {
                let uuid: *mut Object = msg_send![class!(NSUUID), alloc];
                let uuid: *mut Object = msg_send![uuid, initWithUUIDBytes: id.as_ptr()];
                let store: *mut Object =
                    msg_send![class!(WKWebsiteDataStore), dataStoreForIdentifier: uuid];
                let _: () = msg_send![uuid, release];
                if !store.is_null() {
                    stores.push(store);
                }
            }
        }
        let since: *mut Object = msg_send![class!(NSDate), distantPast];
        let remaining = Arc::new(Mutex::new(stores.len()));
        for store in stores {
            let remaining = remaining.clone();
            let done = done.clone();
            let block = ConcreteBlock::new(move || {
                let mut left = remaining.lock().unwrap_or_else(|e| e.into_inner());
                *left = left.saturating_sub(1);
                if *left == 0 {
                    let _ = done.send(());
                }
            })
            .copy();
            let _: () = msg_send![store,
                removeDataOfTypes: set
                modifiedSince: since
                completionHandler: &*block];
        }
    }
}

/// Cached snapshot so the chrome can warn without re-walking the profile.
#[derive(Default)]
pub struct StorageWarn(pub parking_lot::Mutex<Option<StorageReport>>);

/// The last measured report, if one has been taken this session. Cheap — used by
/// the resource monitor to show a warning without walking the tree again.
#[tauri::command]
pub fn storage_last(state: State<'_, StorageWarn>) -> Option<StorageReport> {
    state.0.lock().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn webkit_stores_are_measured_by_category() {
        let root = std::env::temp_dir().join(format!("flux-wk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, cache) = (root.join("WebsiteData"), root.join("WebKit"));
        let put = |p: PathBuf, n: usize| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, vec![0u8; n]).unwrap();
        };
        // Default/<top site>/<frame site>/<kind>/…, as WebKit lays it out.
        let site = data.join("Default/top/frame");
        put(site.join("LocalStorage/localstorage.sqlite3"), 300);
        put(site.join("IndexedDB/db"), 200);
        put(site.join("CacheStorage/c"), 50);
        put(site.join("ServiceWorkers/sw"), 7);
        put(cache.join("NetworkCache/blob"), 1000);
        put(cache.join("CacheStorage/x"), 3);
        let cookies = root.join("flux.binarycookies");
        put(cookies.clone(), 11);

        let store = webkit::Store::at(data, cache, vec![cookies]);
        assert_eq!(store.bytes("sitedata"), 500);
        assert_eq!(store.bytes("serviceworkers"), 60);
        assert_eq!(store.bytes("cache"), 1000);
        assert_eq!(store.bytes("cookies"), 11);
        assert_eq!(store.bytes("unknown"), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn categories_are_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for c in CATEGORIES {
            assert!(seen.insert(c.key), "duplicate key {}", c.key);
            assert!(!c.paths.is_empty(), "{} has no paths", c.key);
            assert!(!c.hint.is_empty(), "{} has no hint", c.key);
        }
        // Cookies must never be swept up by a "clear the junk" click — it's the
        // one category that costs the user their logins.
        let cookies = CATEGORIES.iter().find(|c| c.key == "cookies").unwrap();
        assert!(
            cookies.warn_over.is_none(),
            "cookies must not be flagged as excessive; size isn't the problem there"
        );
    }

    #[test]
    fn dir_size_walks_and_survives_a_bad_entry() {
        let dir = std::env::temp_dir().join(format!("flux-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("sub/b.bin"), vec![0u8; 2000]).unwrap();
        std::fs::write(dir.join("sub/deeper/c.bin"), vec![0u8; 3000]).unwrap();
        assert_eq!(dir_size(&dir), 6000, "recurses into every level");

        // A path that doesn't exist is 0, not a panic — the layout differs per
        // engine and a missing directory is the normal case, not an error.
        assert_eq!(dir_size(&dir.join("nope")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn warn_thresholds() {
        let sw = CATEGORIES
            .iter()
            .find(|c| c.key == "serviceworkers")
            .unwrap();
        let limit = sw.warn_over.unwrap();
        // The size actually observed in the wild must trip the warning.
        assert!(
            753 * MB > limit,
            "753 MB is the size that went unnoticed; it has to be flagged"
        );
        // A healthy store must not.
        assert!(8 * MB < limit, "a normal service-worker store stays quiet");
    }

    #[test]
    fn clear_covers_container_jars_and_skips_what_isnt_there() {
        let dir = std::env::temp_dir().join(format!("flux-storage-jars-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let default = dir.join("local").join("EBWebView");
        let app_data = dir.join("roaming");
        assert!(container_roots(&app_data).is_empty(), "no containers yet");
        std::fs::create_dir_all(app_data.join("containers").join("1")).unwrap();
        let jar = container_roots(&app_data).remove(0);
        for root in [&default, &jar] {
            std::fs::create_dir_all(root.join("Default/Network")).unwrap();
        }
        std::fs::create_dir_all(jar.join("Default/Cache")).unwrap();
        let roots = vec![default.clone(), jar.clone()];
        let s = |p: PathBuf| p.to_string_lossy().to_string();

        // Cookies are cleared from the container's jar too, not just the default.
        assert_eq!(
            clear_targets(&roots, &["cookies".into()]),
            [
                s(default.join("Default/Network")),
                s(jar.join("Default/Network"))
            ]
        );
        // Only the cache directories that exist are queued.
        assert_eq!(
            clear_targets(&roots, &["cache".into()]),
            [s(jar.join("Default/Cache"))]
        );
        // A profile without this layout (WebKit) leaves nothing to queue.
        assert!(clear_targets(&[dir.join("webkit")], &["cookies".into()]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queued_clears_accumulate() {
        // Clear cookies, then (the picks reset) service workers: both stay queued.
        let mut p = Pending::default();
        p.merge(vec!["cookies".into()], vec!["/p/Default/Network".into()]);
        p.merge(
            vec!["serviceworkers".into(), "cookies".into()],
            vec![
                "/p/Default/Service Worker".into(),
                "/p/Default/Network".into(),
            ],
        );
        assert_eq!(p.keys, ["cookies", "serviceworkers"]);
        assert_eq!(p.paths, ["/p/Default/Network", "/p/Default/Service Worker"]);
    }
}
