//! The privileged extension broker (BACKLOG #94, ADR 0008).
//!
//! The powerful `flux.*` API never lives in the page — content scripts are
//! untrusted. Instead each content script gets a thin JS shim that forwards
//! every call to **this** broker over Tauri IPC, tagged with a per-extension
//! **capability token**. The broker resolves the token → extension, checks the
//! call against the extension's manifest-granted permissions (deny-by-default),
//! and only then dispatches. Tabs/DOM access flows through the existing state +
//! webview paths; storage is a persisted per-extension KV map.
//!
//! Security note (ADR 0008): WebView2 has no isolated worlds, so the shim — and
//! therefore the token — runs in the *page* world and a hostile page on the same
//! load could read it and impersonate the extension's grants. That is the
//! documented WebView2 limitation; WebKitGTK script worlds mitigate it and are
//! the future hardening path. The token still scopes *what* any caller can do to
//! the (usually narrow) set the user granted that extension.

use std::collections::HashMap;
use std::path::PathBuf;

use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::extensions::{json_str, ExtRegistry, Injection};
use crate::state::{FluxState, TabId};

/// Most one extension may keep in `flux.storage` (keys + encoded values). Every
/// `set` rewrites the whole file, so this bounds each write as well as the file.
const STORAGE_QUOTA: usize = 5 * 1024 * 1024;
/// Longest `flux.storage` key accepted.
const MAX_KEY_BYTES: usize = 1024;

type ExtStorage = HashMap<String, HashMap<String, String>>;

/// Per-extension capability tokens + KV storage.
#[derive(Default)]
pub struct BrokerState {
    /// token → extension id.
    tokens: DashMap<String, String>,
    /// extension id → token (stable for the session, so the map stays bounded).
    by_ext: DashMap<String, String>,
    /// extension id → (key → JSON-encoded value).
    storage: RwLock<ExtStorage>,
    storage_path: Option<PathBuf>,
    /// One write at a time, snapshot through rename: calls run on the blocking
    /// pool, so two can overlap, and an older snapshot must never land last.
    persist_lock: Mutex<()>,
}

impl BrokerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load persisted storage from `path`.
    pub fn restore(path: PathBuf) -> Self {
        let (storage, storage_path) = load_storage(path);
        Self {
            storage: RwLock::new(storage),
            storage_path,
            ..Default::default()
        }
    }

    /// The capability token for an extension (minted once per session).
    ///
    /// 128 bits from the OS-seeded CSPRNG and nothing else, so one token says
    /// nothing about another. ADR 0008 accepts that a page can read its own
    /// extension's token under WebView2, contained by that token carrying only
    /// that extension's grants. Tokens derived from a session nonce (the first
    /// one minted *was* the nonce) let such a page compute every other
    /// extension's token. `entry` also mints just once under concurrent loads.
    pub fn token_for(&self, ext_id: &str) -> String {
        if let Some(t) = self.by_ext.get(ext_id) {
            return t.clone();
        }
        self.by_ext
            .entry(ext_id.to_string())
            .or_insert_with(|| {
                let bytes: [u8; 16] = rand::random();
                let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                self.tokens.insert(token.clone(), ext_id.to_string());
                token
            })
            .value()
            .clone()
    }

    fn persist(&self) {
        let Some(path) = &self.storage_path else {
            return;
        };
        // Temp file + rename (crate::persist): a crash mid `fs::write` left a
        // torn file, which the next launch read as empty and the next `set`
        // then saved over every extension's data.
        let _writing = self.persist_lock.lock();
        crate::persist::save_json_pretty(path, &*self.storage.read());
    }

    // ── storage (flux.storage) ──────────────────────────────────────────────
    fn store_get(&self, ext: &str, key: &str) -> Value {
        self.storage
            .read()
            .get(ext)
            .and_then(|m| m.get(key))
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null)
    }
    fn store_set(&self, ext: &str, key: &str, value: &Value) -> Result<(), String> {
        if key.len() > MAX_KEY_BYTES {
            return Err(format!("storage key longer than {MAX_KEY_BYTES} bytes"));
        }
        let enc = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
        {
            let mut all = self.storage.write();
            // The value this replaces doesn't count against the new one.
            let used: usize = all.get(ext).map_or(0, |m| {
                m.iter()
                    .filter(|(k, _)| k.as_str() != key)
                    .map(|(k, v)| k.len() + v.len())
                    .sum()
            });
            if used + key.len() + enc.len() > STORAGE_QUOTA {
                return Err(format!(
                    "storage quota exceeded ({} MiB per extension)",
                    STORAGE_QUOTA >> 20
                ));
            }
            all.entry(ext.to_string())
                .or_default()
                .insert(key.to_string(), enc);
        }
        self.persist();
        Ok(())
    }
    fn store_remove(&self, ext: &str, key: &str) {
        if let Some(m) = self.storage.write().get_mut(ext) {
            m.remove(key);
        }
        self.persist();
    }
    fn store_keys(&self, ext: &str) -> Vec<String> {
        self.storage
            .read()
            .get(ext)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Build the page injection with the *broker* shim: each enabled extension's
    /// content-script JS is wrapped in an IIFE that defines a callable `flux`
    /// object forwarding to [`ext_broker_call`] with the extension's token (#94).
    pub fn build_injection(&self, registry: &ExtRegistry, url: &str, at_start: bool) -> Injection {
        let mut css = String::new();
        let mut js = String::new();
        for p in registry.pieces_for(url, at_start) {
            css.push_str(&p.css);
            if p.js.is_empty() {
                continue;
            }
            let token = self.token_for(&p.id);
            let id = json_str(&p.id);
            let user = &p.js;
            js.push_str(&format!(
                ";(function(){{\n{shim}\ntry{{\n{user}\n}}catch(e){{console.error('[flux ext '+{id}+']',e);}}\n}})();\n",
                shim = api_shim(&token)
            ));
        }
        Injection { css, js }
    }

    /// Resolve + authorize + dispatch one `flux.*` call.
    pub fn call(
        &self,
        app: &AppHandle,
        token: &str,
        api: &str,
        method: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let ext_id = self
            .tokens
            .get(token)
            .map(|r| r.value().clone())
            .ok_or("invalid capability token")?;
        let registry = app
            .try_state::<ExtRegistry>()
            .ok_or("extension registry unavailable")?;
        let ext = registry
            .list()
            .into_iter()
            .find(|e| e.manifest.id == ext_id)
            .ok_or("extension not installed")?;
        if !ext.enabled {
            return Err("extension is disabled".into());
        }
        if !granted(&ext.manifest.permissions, api, method) {
            return Err(format!(
                "permission denied: {api}.{method} (extension {ext_id})"
            ));
        }
        // ADR 0008 §6: a content script is confined to the pages its `matches`
        // cover, so a tab-targeting call may only act on such a page — or one
        // token (readable by its page under WebView2) reaches every tab. Checked
        // against the tab webview's live URL, as `dom_publish` does: `TabMeta.url`
        // only catches up on load-finish. Tabs with no webview are never in scope.
        let not_here =
            |tab: TabId| format!("permission denied: extension {ext_id} doesn't run on tab {tab}");
        let in_scope = |tab: TabId| -> Result<(), String> {
            let url = app
                .get_webview(&format!("tab-{tab}"))
                .ok_or("no such tab webview")?
                .url()
                .map_err(|e| e.to_string())?;
            if registry.matches_url(&ext_id, url.as_str()) {
                Ok(())
            } else {
                Err(not_here(tab))
            }
        };
        match (api, method) {
            ("runtime", "id") => Ok(json!(ext_id)),
            ("runtime", "version") => Ok(json!(ext.manifest.version)),
            ("runtime", "permissions") => Ok(json!(ext.manifest.permissions)),

            ("storage", "get") => Ok(self.store_get(&ext_id, arg_str(args, "key")?)),
            ("storage", "set") => {
                self.store_set(
                    &ext_id,
                    arg_str(args, "key")?,
                    args.get("value").unwrap_or(&Value::Null),
                )?;
                Ok(Value::Bool(true))
            }
            ("storage", "remove") => {
                self.store_remove(&ext_id, arg_str(args, "key")?);
                Ok(Value::Bool(true))
            }
            ("storage", "keys") => Ok(json!(self.store_keys(&ext_id))),

            ("tabs", "query") => {
                let st = app.state::<FluxState>();
                let mut tabs: Vec<Value> = st
                    .tabs
                    .iter()
                    .filter_map(|e| serde_json::to_value(e.value()).ok())
                    .collect();
                tabs.sort_by_key(|t| t.get("id").and_then(Value::as_u64).unwrap_or(0));
                Ok(Value::Array(tabs))
            }
            ("tabs", "open") => {
                let url = arg_web_url(args)?;
                // The shell owns webview geometry, so opening is an intent it acts on.
                app.emit("flux://ext-open-tab", url)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Bool(true))
            }
            ("tabs", "navigate") => {
                let tab = arg_tab(args)?;
                in_scope(tab)?;
                let url = arg_web_url(args)?;
                crate::webview::eval(app, tab, &format!("location.assign({})", json_str(&url)))?;
                if let Some(mut t) = app.state::<FluxState>().tabs.get_mut(&tab) {
                    t.url = url;
                }
                Ok(Value::Bool(true))
            }

            ("dom", "read") => {
                let tab = arg_tab(args)?;
                in_scope(tab)?;
                match app.state::<FluxState>().dom_cache.get(&tab) {
                    // The snapshot can predate the page now loaded, so its own
                    // URL has to be in scope too.
                    Some(s) if registry.matches_url(&ext_id, &s.url) => Ok(
                        json!({ "url": s.url, "text": &*s.text, "html": &*s.html, "capturedAtMs": s.captured_at_ms }),
                    ),
                    Some(_) => Err(not_here(tab)),
                    None => Ok(Value::Null),
                }
            }
            ("dom", "inject") => {
                let tab = arg_tab(args)?;
                in_scope(tab)?;
                crate::webview::eval(app, tab, arg_str(args, "js")?)?;
                Ok(Value::Bool(true))
            }

            ("ui", _) => Err("flux.ui lands with the extension manager UI (#95)".into()),
            _ => Err(format!("unknown method {api}.{method}")),
        }
    }
}

/// Read persisted storage, and where to save it this run.
///
/// A file that exists but can't be loaded must never come back as "no data":
/// the next `storage.set` would write that over every extension's keys. An
/// unparseable one is moved aside to `<name>.unreadable-<ms>`; one that can't be
/// read (perhaps only right now) is left alone and not saved this run.
fn load_storage(path: PathBuf) -> (ExtStorage, Option<PathBuf>) {
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (HashMap::new(), Some(path)),
        Err(e) => {
            tracing::error!(
                target: "flux::ext",
                path = %path.display(),
                "extension storage unreadable ({e}); left untouched and not saved this run"
            );
            return (HashMap::new(), None);
        }
    };
    let err = match serde_json::from_slice(&bytes) {
        Ok(storage) => return (storage, Some(path)),
        Err(e) => e,
    };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".unreadable-{ms}"));
    let aside = path.with_file_name(name);
    match std::fs::rename(&path, &aside) {
        Ok(()) => {
            tracing::error!(
                target: "flux::ext",
                aside = %aside.display(),
                "extension storage unparseable ({err}); moved aside, starting empty"
            );
            (HashMap::new(), Some(path))
        }
        Err(e) => {
            tracing::error!(
                target: "flux::ext",
                path = %path.display(),
                "extension storage unparseable ({err}) and couldn't be moved aside ({e}); not saved this run"
            );
            (HashMap::new(), None)
        }
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string arg `{key}`"))
}
/// The `url` arg, accepted only as an absolute http(s) URL. A `tabs` grant is
/// navigation, not script: `location.assign("javascript:…")` would run code in
/// the target tab's origin (what `dom:write` gates), and `tabs.open` with a
/// `file:` or `flux:` URL would open local files or internal pages.
fn arg_web_url(args: &Value) -> Result<String, String> {
    let raw = arg_str(args, "url")?;
    let url = tauri::Url::parse(raw).map_err(|_| format!("invalid url {raw:?}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url.to_string()),
        scheme => Err(format!("permission denied: {scheme}: URLs")),
    }
}
fn arg_tab(args: &Value) -> Result<TabId, String> {
    args.get("tabId")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing tabId".to_string())
}

/// Deny-by-default grant check: the manifest must hold the permission a given
/// `(api, method)` requires. Unknown calls are denied. `flux.runtime` identity
/// is always allowed.
fn granted(perms: &[String], api: &str, method: &str) -> bool {
    let need: &[&str] = match (api, method) {
        ("runtime", "id") | ("runtime", "version") | ("runtime", "permissions") => return true,
        ("storage", "get") | ("storage", "set") | ("storage", "remove") | ("storage", "keys") => {
            &["storage"]
        }
        ("tabs", "query") | ("tabs", "open") | ("tabs", "navigate") => &["tabs"],
        ("dom", "read") => &["dom:read"],
        ("dom", "inject") => &["dom:write"],
        ("ui", "openPanel") => &["ui:panel"],
        ("ui", "addToolbarButton") => &["ui:toolbar"],
        _ => return false,
    };
    need.iter().any(|n| perms.iter().any(|p| p == n))
}

/// The JS injected ahead of an extension's content script: a frozen `flux`
/// object whose methods forward to the broker (`plugin:fluxtab|ext_broker_call`)
/// carrying this extension's capability token.
fn api_shim(token: &str) -> String {
    let t = json_str(token);
    format!(
        r#"const __ft={t};
const __fc=(api,method,args)=>{{const inv=window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke;if(!inv)return Promise.reject(new Error("flux: ipc unavailable"));return inv("plugin:fluxtab|ext_broker_call",{{token:__ft,api,method,args:args||{{}}}});}};
const flux=Object.freeze({{
runtime:Object.freeze({{id:()=>__fc("runtime","id"),version:()=>__fc("runtime","version"),permissions:()=>__fc("runtime","permissions")}}),
storage:Object.freeze({{get:(key)=>__fc("storage","get",{{key}}),set:(key,value)=>__fc("storage","set",{{key,value}}),remove:(key)=>__fc("storage","remove",{{key}}),keys:()=>__fc("storage","keys")}}),
tabs:Object.freeze({{query:()=>__fc("tabs","query"),open:(url)=>__fc("tabs","open",{{url}}),navigate:(tabId,url)=>__fc("tabs","navigate",{{tabId,url}})}}),
dom:Object.freeze({{read:(tabId)=>__fc("dom","read",{{tabId}}),inject:(tabId,js)=>__fc("dom","inject",{{tabId,js}})}})
}});"#
    )
}

/// The single command remote content scripts call (via the `fluxtab` plugin).
///
/// Async, with the work on the blocking pool: a sync command runs on the main
/// thread, and every `storage.set`/`remove` rewrites and fsyncs the store.
#[tauri::command]
pub async fn ext_broker_call(
    app: AppHandle,
    token: String,
    api: String,
    method: String,
    args: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let broker = app
            .try_state::<BrokerState>()
            .ok_or("extension broker unavailable")?;
        broker.call(&app, &token, &api, &method, &args.unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_urls_must_be_web_urls() {
        let ok = |u: &str| arg_web_url(&json!({ "url": u }));
        assert_eq!(
            ok("https://example.com/a").unwrap(),
            "https://example.com/a"
        );
        assert!(ok("http://localhost:3000").is_ok());
        for bad in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///etc/passwd",
            "flux://passwords",
            "data:text/html,<script>x</script>",
            "not a url",
        ] {
            assert!(ok(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn grant_model_is_deny_by_default() {
        let none: Vec<String> = vec![];
        // runtime identity always allowed.
        assert!(granted(&none, "runtime", "id"));
        // everything else requires the matching grant.
        assert!(!granted(&none, "storage", "get"));
        assert!(!granted(&none, "tabs", "query"));
        assert!(!granted(&none, "dom", "inject"));
        let p = vec!["storage".to_string(), "dom:read".to_string()];
        assert!(granted(&p, "storage", "set"));
        assert!(granted(&p, "dom", "read"));
        assert!(!granted(&p, "dom", "inject")); // only dom:read granted
        assert!(!granted(&p, "tabs", "open"));
        // unknown calls denied even with broad grants.
        let all = vec![
            "tabs".into(),
            "dom:read".into(),
            "dom:write".into(),
            "storage".into(),
            "ui:panel".into(),
        ];
        assert!(!granted(&all, "fs", "read"));
        assert!(!granted(&all, "tabs", "evil"));
    }

    #[test]
    fn tokens_are_stable_per_extension_and_resolve() {
        let b = BrokerState::new();
        let t1 = b.token_for("com.a");
        let t2 = b.token_for("com.a");
        let tb = b.token_for("com.b");
        assert_eq!(t1, t2); // stable
        assert_ne!(t1, tb); // distinct per extension
        assert_eq!(
            b.tokens.get(&t1).map(|r| r.value().clone()),
            Some("com.a".to_string())
        );
    }

    #[test]
    fn tokens_are_random_not_derived_from_each_other() {
        let b = BrokerState::new();
        let ta = b.token_for("com.a");
        let tb = b.token_for("com.b");
        for t in [&ta, &tb] {
            assert_eq!(t.len(), 32);
            assert!(t.bytes().all(|c| c.is_ascii_hexdigit()));
        }
        // The old scheme's first halves were `nonce ^ n·φ` for n = 0, 1, …, so
        // two consecutive tokens' first halves XORed to φ: one leaked token
        // gave away the nonce, and with it every other token.
        let half = |t: &str| u64::from_str_radix(&t[..16], 16).unwrap();
        assert_ne!(half(&ta) ^ half(&tb), 0x9E37_79B9_7F4A_7C15);
        // Nor does a session's token repeat in the next one.
        assert_ne!(BrokerState::new().token_for("com.a"), ta);
    }

    #[test]
    fn concurrent_first_calls_mint_one_token() {
        let b = BrokerState::new();
        let got: Vec<String> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..8).map(|_| s.spawn(|| b.token_for("com.a"))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(got.iter().all(|t| t == &got[0]));
        assert_eq!(b.tokens.len(), 1, "no orphaned second token");
    }

    #[test]
    fn storage_roundtrips_per_extension() {
        let b = BrokerState::new();
        b.store_set("com.a", "k", &json!({ "n": 1 })).unwrap();
        b.store_set("com.a", "k2", &json!("hi")).unwrap();
        b.store_set("com.b", "k", &json!(true)).unwrap();
        assert_eq!(b.store_get("com.a", "k"), json!({ "n": 1 }));
        assert_eq!(b.store_get("com.b", "k"), json!(true));
        assert_eq!(b.store_get("com.a", "missing"), Value::Null);
        let mut keys = b.store_keys("com.a");
        keys.sort();
        assert_eq!(keys, vec!["k".to_string(), "k2".to_string()]);
        b.store_remove("com.a", "k");
        assert_eq!(b.store_get("com.a", "k"), Value::Null);
        assert_eq!(b.store_keys("com.b"), vec!["k".to_string()]);
    }

    #[test]
    fn storage_is_quota_capped_per_extension() {
        let b = BrokerState::new();
        let half = json!("x".repeat(STORAGE_QUOTA / 2));
        b.store_set("com.a", "k1", &half).unwrap();
        // A second value that size doesn't fit beside the first…
        assert!(b.store_set("com.a", "k2", &half).is_err());
        assert_eq!(b.store_get("com.a", "k2"), Value::Null);
        // …but replacing the first does: the value it replaces stops counting.
        b.store_set("com.a", "k1", &half).unwrap();
        // Each extension has its own quota.
        b.store_set("com.b", "k1", &half).unwrap();
        let long_key = "k".repeat(MAX_KEY_BYTES + 1);
        assert!(b.store_set("com.a", &long_key, &json!(1)).is_err());
    }

    #[test]
    fn unparseable_storage_is_moved_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("flux-broker-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("storage.json");
        // What a crash mid `fs::write` used to leave behind.
        let torn = r#"{"com.a":{"k":"#;
        std::fs::write(&path, torn).unwrap();

        let b = BrokerState::restore(path.clone());
        assert_eq!(b.store_get("com.a", "k"), Value::Null);
        // The next set must not erase the only copy of everyone's data.
        b.store_set("com.b", "k", &json!(1)).unwrap();
        let aside: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("storage.json.unreadable-")
            })
            .collect();
        assert_eq!(aside.len(), 1, "the torn file is kept aside");
        assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), torn);
        // And the new store reads back.
        assert_eq!(BrokerState::restore(path).store_get("com.b", "k"), json!(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_shim_carries_token_and_targets_broker() {
        let s = api_shim("deadbeef");
        assert!(s.contains("\"deadbeef\""));
        assert!(s.contains("plugin:fluxtab|ext_broker_call"));
        assert!(s.contains("const flux=Object.freeze"));
    }
}
