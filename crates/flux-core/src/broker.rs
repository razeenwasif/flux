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
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use dashmap::DashMap;
use parking_lot::RwLock;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::extensions::{json_str, ExtRegistry, Injection};
use crate::state::{FluxState, TabId};

/// Per-extension capability tokens + KV storage.
#[derive(Default)]
pub struct BrokerState {
    /// token → extension id.
    tokens: DashMap<String, String>,
    /// extension id → token (stable for the session, so the map stays bounded).
    by_ext: DashMap<String, String>,
    /// extension id → (key → JSON-encoded value).
    storage: RwLock<HashMap<String, HashMap<String, String>>>,
    storage_path: Option<PathBuf>,
    seq: AtomicU64,
    nonce: u64,
}

impl BrokerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load persisted storage from `path` and seed the per-session token nonce.
    pub fn restore(path: PathBuf) -> Self {
        let storage = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Seed a per-session nonce so tokens differ across runs (no rand crate;
        // SystemTime is fine here — flux-core isn't a workflow script).
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15);
        Self {
            storage: RwLock::new(storage),
            storage_path: Some(path),
            nonce,
            ..Default::default()
        }
    }

    /// The capability token for an extension (minted once per session).
    pub fn token_for(&self, ext_id: &str) -> String {
        if let Some(t) = self.by_ext.get(ext_id) {
            return t.clone();
        }
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.nonce.hash(&mut h);
        ext_id.hash(&mut h);
        n.hash(&mut h);
        let token = format!(
            "{:016x}{:016x}",
            self.nonce ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15),
            h.finish()
        );
        self.tokens.insert(token.clone(), ext_id.to_string());
        self.by_ext.insert(ext_id.to_string(), token.clone());
        token
    }

    fn persist(&self) {
        let Some(path) = &self.storage_path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(&*self.storage.read()) {
            let _ = std::fs::write(path, s);
        }
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
    fn store_set(&self, ext: &str, key: &str, value: &Value) {
        let enc = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
        self.storage.write().entry(ext.to_string()).or_default().insert(key.to_string(), enc);
        self.persist();
    }
    fn store_remove(&self, ext: &str, key: &str) {
        if let Some(m) = self.storage.write().get_mut(ext) {
            m.remove(key);
        }
        self.persist();
    }
    fn store_keys(&self, ext: &str) -> Vec<String> {
        self.storage.read().get(ext).map(|m| m.keys().cloned().collect()).unwrap_or_default()
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
    pub fn call(&self, app: &AppHandle, token: &str, api: &str, method: &str, args: &Value) -> Result<Value, String> {
        let ext_id = self.tokens.get(token).map(|r| r.value().clone()).ok_or("invalid capability token")?;
        let registry = app.try_state::<ExtRegistry>().ok_or("extension registry unavailable")?;
        let ext = registry
            .list()
            .into_iter()
            .find(|e| e.manifest.id == ext_id)
            .ok_or("extension not installed")?;
        if !ext.enabled {
            return Err("extension is disabled".into());
        }
        if !granted(&ext.manifest.permissions, api, method) {
            return Err(format!("permission denied: {api}.{method} (extension {ext_id})"));
        }
        match (api, method) {
            ("runtime", "id") => Ok(json!(ext_id)),
            ("runtime", "version") => Ok(json!(ext.manifest.version)),
            ("runtime", "permissions") => Ok(json!(ext.manifest.permissions)),

            ("storage", "get") => Ok(self.store_get(&ext_id, arg_str(args, "key")?)),
            ("storage", "set") => {
                self.store_set(&ext_id, arg_str(args, "key")?, args.get("value").unwrap_or(&Value::Null));
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
                let url = arg_str(args, "url")?.to_string();
                // The shell owns webview geometry, so opening is an intent it acts on.
                app.emit("flux://ext-open-tab", url).map_err(|e| e.to_string())?;
                Ok(Value::Bool(true))
            }
            ("tabs", "navigate") => {
                let tab = arg_tab(args)?;
                let url = arg_str(args, "url")?;
                crate::webview::eval(app, tab, &format!("location.assign({})", json_str(url)))?;
                if let Some(mut t) = app.state::<FluxState>().tabs.get_mut(&tab) {
                    t.url = url.to_string();
                }
                Ok(Value::Bool(true))
            }

            ("dom", "read") => {
                let tab = arg_tab(args)?;
                match app.state::<FluxState>().dom_cache.get(&tab) {
                    Some(s) => Ok(json!({ "url": s.url, "text": &*s.text, "html": &*s.html, "capturedAtMs": s.captured_at_ms })),
                    None => Ok(Value::Null),
                }
            }
            ("dom", "inject") => {
                let tab = arg_tab(args)?;
                crate::webview::eval(app, tab, arg_str(args, "js")?)?;
                Ok(Value::Bool(true))
            }

            ("ui", _) => Err("flux.ui lands with the extension manager UI (#95)".into()),
            _ => Err(format!("unknown method {api}.{method}")),
        }
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("missing string arg `{key}`"))
}
fn arg_tab(args: &Value) -> Result<TabId, String> {
    args.get("tabId").and_then(Value::as_u64).ok_or_else(|| "missing tabId".to_string())
}

/// Deny-by-default grant check: the manifest must hold the permission a given
/// `(api, method)` requires. Unknown calls are denied. `flux.runtime` identity
/// is always allowed.
fn granted(perms: &[String], api: &str, method: &str) -> bool {
    let need: &[&str] = match (api, method) {
        ("runtime", "id") | ("runtime", "version") | ("runtime", "permissions") => return true,
        ("storage", "get") | ("storage", "set") | ("storage", "remove") | ("storage", "keys") => &["storage"],
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
#[tauri::command]
pub fn ext_broker_call(
    app: AppHandle,
    broker: State<'_, BrokerState>,
    token: String,
    api: String,
    method: String,
    args: Option<Value>,
) -> Result<Value, String> {
    broker.call(&app, &token, &api, &method, &args.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let all = vec!["tabs".into(), "dom:read".into(), "dom:write".into(), "storage".into(), "ui:panel".into()];
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
        assert_eq!(b.tokens.get(&t1).map(|r| r.value().clone()), Some("com.a".to_string()));
    }

    #[test]
    fn storage_roundtrips_per_extension() {
        let b = BrokerState::new();
        b.store_set("com.a", "k", &json!({ "n": 1 }));
        b.store_set("com.a", "k2", &json!("hi"));
        b.store_set("com.b", "k", &json!(true));
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
    fn api_shim_carries_token_and_targets_broker() {
        let s = api_shim("deadbeef");
        assert!(s.contains("\"deadbeef\""));
        assert!(s.contains("plugin:fluxtab|ext_broker_call"));
        assert!(s.contains("const flux=Object.freeze"));
    }
}
