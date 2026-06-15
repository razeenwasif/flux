//! Flux mini-extension manifest + loader + registry (BACKLOG #92, ADR 0008).
//!
//! This is the foundation of the extension model: parse + validate a
//! `flux.extension.json`, and keep a persisted registry of installed extensions
//! (enabled/disabled). Content-script *injection* is #93, the `flux.*` API is
//! #94, the manager UI is #95 — all build on what's here.

use std::path::{Path, PathBuf};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{State, Url};

/// The set of permissions an extension may request (ADR 0008 §4). `net:<host>`
/// is checked by prefix; everything else must match exactly.
const KNOWN_PERMISSIONS: &[&str] =
    &["dom:read", "dom:write", "tabs", "storage", "ui:panel", "ui:toolbar"];

const MANIFEST_FILE: &str = "flux.extension.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ContentScript {
    pub matches: Vec<String>,
    #[serde(default)]
    pub js: Vec<String>,
    #[serde(default)]
    pub css: Vec<String>,
    #[serde(default = "default_run_at")]
    pub run_at: String,
}

fn default_run_at() -> String {
    "document_idle".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct UiContrib {
    #[serde(default)]
    pub toolbar_button: Option<ToolbarButton>,
    #[serde(default)]
    pub panel: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolbarButton {
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub content_scripts: Vec<ContentScript>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub ui: Option<UiContrib>,
}

impl Manifest {
    /// Parse + validate manifest JSON. Rejects a bad id, an empty `matches`, or
    /// an unknown permission (the security model is deny-by-default; we don't
    /// silently accept permissions we can't enforce).
    pub fn parse(json: &str) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
        if m.id.trim().is_empty() || m.id.contains(['/', '\\', ' ']) {
            return Err(format!("invalid extension id {:?}", m.id));
        }
        if m.name.trim().is_empty() {
            return Err("extension name is required".into());
        }
        if m.version.trim().is_empty() {
            return Err("extension version is required".into());
        }
        for p in &m.permissions {
            let ok = KNOWN_PERMISSIONS.contains(&p.as_str()) || p.starts_with("net:");
            if !ok {
                return Err(format!("unknown permission {p:?}"));
            }
        }
        for cs in &m.content_scripts {
            if cs.matches.is_empty() {
                return Err("a content_script has no `matches`".into());
            }
        }
        Ok(m)
    }
}

/// One installed extension: its manifest, where it lives on disk, and whether
/// it's enabled.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstalledExt {
    pub manifest: Manifest,
    pub dir: String,
    pub enabled: bool,
}

/// The registry of installed extensions, persisted to `extensions/registry.json`.
#[derive(Default)]
pub struct ExtRegistry {
    entries: RwLock<Vec<InstalledExt>>,
    path: Option<PathBuf>,
}

impl ExtRegistry {
    /// In-memory only (tests / Default).
    pub fn new() -> Self {
        Self::default()
    }

    /// Load the persisted registry from `path` (best-effort).
    pub fn restore(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<InstalledExt>>(&s).ok())
            .unwrap_or_default();
        Self { entries: RwLock::new(entries), path: Some(path) }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&*self.entries.read()) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Install the extension whose folder is `dir` (must hold `flux.extension.json`).
    /// Re-installing the same id replaces it (keeping it enabled).
    pub fn install(&self, dir: &Path) -> Result<Manifest, String> {
        let json = std::fs::read_to_string(dir.join(MANIFEST_FILE))
            .map_err(|e| format!("no {MANIFEST_FILE} in {}: {e}", dir.display()))?;
        let manifest = Manifest::parse(&json)?;
        // Content-script files must exist (catch typos at install).
        for cs in &manifest.content_scripts {
            for f in cs.js.iter().chain(cs.css.iter()) {
                if !dir.join(f).is_file() {
                    return Err(format!("content_script file not found: {f}"));
                }
            }
        }
        let entry = InstalledExt { manifest: manifest.clone(), dir: dir.to_string_lossy().into_owned(), enabled: true };
        {
            let mut e = self.entries.write();
            e.retain(|x| x.manifest.id != manifest.id);
            e.push(entry);
        }
        self.persist();
        Ok(manifest)
    }

    pub fn set_enabled(&self, id: &str, on: bool) {
        {
            let mut e = self.entries.write();
            if let Some(x) = e.iter_mut().find(|x| x.manifest.id == id) {
                x.enabled = on;
            }
        }
        self.persist();
    }

    pub fn remove(&self, id: &str) {
        self.entries.write().retain(|x| x.manifest.id != id);
        self.persist();
    }

    pub fn list(&self) -> Vec<InstalledExt> {
        self.entries.read().clone()
    }

    /// The raw per-extension content-script payloads that apply to `url` at this
    /// load phase (`at_start` = `document_start`, else `document_end`/idle) — the
    /// content scripts of every *enabled* extension whose `@match` patterns hit
    /// (#93). File contents are read here; the caller decides how to wrap the JS
    /// (identity shim vs the #94 broker API shim).
    pub fn pieces_for(&self, url: &str, at_start: bool) -> Vec<ExtPiece> {
        let mut out = Vec::new();
        for ext in self.entries.read().iter().filter(|e| e.enabled) {
            let dir = Path::new(&ext.dir);
            let (mut css, mut js) = (String::new(), String::new());
            for cs in &ext.manifest.content_scripts {
                if (cs.run_at == "document_start") != at_start {
                    continue;
                }
                if !cs.matches.iter().any(|m| pattern_matches(m, url)) {
                    continue;
                }
                for f in &cs.css {
                    if let Ok(s) = std::fs::read_to_string(dir.join(f)) {
                        css.push_str(&s);
                        css.push('\n');
                    }
                }
                for f in &cs.js {
                    if let Ok(s) = std::fs::read_to_string(dir.join(f)) {
                        js.push_str(&s);
                        js.push('\n');
                    }
                }
            }
            if !css.is_empty() || !js.is_empty() {
                out.push(ExtPiece {
                    id: ext.manifest.id.clone(),
                    version: ext.manifest.version.clone(),
                    permissions: ext.manifest.permissions.clone(),
                    css,
                    js,
                });
            }
        }
        out
    }

    /// Assemble the injectable CSS + JS for `url` at this load phase, wrapping
    /// each extension's JS in its own IIFE scope guard (WebView2 has no isolated
    /// worlds, ADR 0008) carrying a frozen `flux` *identity* object. This is the
    /// no-broker fallback; with a [`crate::broker::BrokerState`] present, the
    /// broker builds a richer shim that exposes the callable `flux.*` API (#94).
    pub fn injection_for(&self, url: &str, at_start: bool) -> Injection {
        let mut css = String::new();
        let mut js = String::new();
        for p in self.pieces_for(url, at_start) {
            css.push_str(&p.css);
            if p.js.is_empty() {
                continue;
            }
            let id = json_str(&p.id);
            let ver = json_str(&p.version);
            let perms = serde_json::to_string(&p.permissions).unwrap_or_else(|_| "[]".into());
            let user = &p.js;
            js.push_str(&format!(
                ";(function(){{\nconst flux=Object.freeze({{id:{id},version:{ver},permissions:Object.freeze({perms})}});\ntry{{\n{user}\n}}catch(e){{console.error('[flux ext '+{id}+']',e);}}\n}})();\n"
            ));
        }
        Injection { css, js }
    }
}

/// One enabled extension's content-script payload for a page (raw file text).
#[derive(Debug, Clone)]
pub struct ExtPiece {
    pub id: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub css: String,
    pub js: String,
}

/// The CSS + JS to inject into a page for one load phase.
#[derive(Default, Debug)]
pub struct Injection {
    pub css: String,
    pub js: String,
}

pub(crate) fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Match a content-script `@match` pattern (`<scheme>://<host><path>`, or the
/// special `<all_urls>`) against a concrete URL. Scheme `*` = http/https; a host
/// of `*` is any, `*.foo.com` matches `foo.com` and its subdomains; the path is
/// a `*`-glob. Unparseable URLs never match.
fn pattern_matches(pattern: &str, url: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    let scheme = u.scheme();
    let host = u.host_str().unwrap_or("");
    let path = u.path();

    if pattern == "<all_urls>" {
        return matches!(scheme, "http" | "https" | "file" | "ftp");
    }
    let Some((ps, rest)) = pattern.split_once("://") else { return false };
    let (ph, pp) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/*"),
    };

    let scheme_ok = ps == "*" && matches!(scheme, "http" | "https") || ps == scheme;
    let host_ok = if ph == "*" {
        true
    } else if let Some(suffix) = ph.strip_prefix("*.") {
        host == suffix || host.ends_with(&format!(".{suffix}"))
    } else {
        host == ph
    };
    scheme_ok && host_ok && glob_match(pp, path)
}

/// Classic linear wildcard match supporting only `*` (matches any run, incl.
/// empty). No `?`. Used for content-script path globs.
fn glob_match(pat: &str, text: &str) -> bool {
    let (p, t) = (pat.as_bytes(), text.as_bytes());
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn ext_install(registry: State<'_, ExtRegistry>, dir: String) -> Result<Manifest, String> {
    registry.install(Path::new(&dir))
}

#[tauri::command]
pub fn ext_list(registry: State<'_, ExtRegistry>) -> Vec<InstalledExt> {
    registry.list()
}

#[tauri::command]
pub fn ext_set_enabled(registry: State<'_, ExtRegistry>, id: String, on: bool) {
    registry.set_enabled(&id, on);
}

#[tauri::command]
pub fn ext_remove(registry: State<'_, ExtRegistry>, id: String) {
    registry.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
        "id": "com.example.reader", "name": "Reader", "version": "1.0.0",
        "permissions": ["dom:read", "ui:panel", "net:example.com"],
        "content_scripts": [{ "matches": ["https://*/*"], "js": ["r.js"] }]
    }"#;

    #[test]
    fn parses_valid_manifest() {
        let m = Manifest::parse(VALID).unwrap();
        assert_eq!(m.id, "com.example.reader");
        assert_eq!(m.content_scripts[0].run_at, "document_idle"); // default
        assert_eq!(m.content_scripts[0].matches, vec!["https://*/*"]);
    }

    #[test]
    fn rejects_unknown_permission() {
        let bad = VALID.replace("net:example.com", "filesystem");
        assert!(Manifest::parse(&bad).is_err());
    }

    #[test]
    fn rejects_bad_id_and_empty_matches() {
        assert!(Manifest::parse(&VALID.replace("com.example.reader", "bad id/slash")).is_err());
        assert!(Manifest::parse(&VALID.replace(r#"["https://*/*"]"#, "[]")).is_err());
    }

    #[test]
    fn bundled_example_installs() {
        // The shipped example must always pass the loader + file checks.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/extensions/hello");
        let reg = ExtRegistry::new();
        let m = reg.install(&dir).unwrap();
        assert_eq!(m.id, "com.flux.hello");
        assert_eq!(m.content_scripts[0].js, vec!["hello.js"]);
    }

    #[test]
    fn match_patterns() {
        assert!(pattern_matches("https://*/*", "https://example.com/a/b"));
        assert!(pattern_matches("http://*/*", "http://x.org/"));
        assert!(pattern_matches("<all_urls>", "https://anything.example/"));
        // scheme `*` is http/https only.
        assert!(pattern_matches("*://*/*", "http://x/"));
        assert!(!pattern_matches("*://*/*", "ftp://x/"));
        // subdomain wildcard.
        assert!(pattern_matches("https://*.example.com/*", "https://www.example.com/x"));
        assert!(pattern_matches("https://*.example.com/*", "https://example.com/x"));
        assert!(!pattern_matches("https://*.example.com/*", "https://example.org/x"));
        // path glob.
        assert!(pattern_matches("https://site.com/docs/*", "https://site.com/docs/intro"));
        assert!(!pattern_matches("https://site.com/docs/*", "https://site.com/blog/x"));
        // scheme mismatch + garbage url.
        assert!(!pattern_matches("https://x/*", "http://x/"));
        assert!(!pattern_matches("https://*/*", "not a url"));
    }

    #[test]
    fn injection_assembles_for_matching_url() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/extensions/hello");
        let reg = ExtRegistry::new();
        reg.install(&dir).unwrap();

        // The example runs at document_idle → present at Finished, absent at Started.
        let at_end = reg.injection_for("https://example.com/", false);
        assert!(at_end.js.contains("Hello from a Flux extension"));
        assert!(at_end.js.contains("const flux=Object.freeze")); // identity shim
        assert!(at_end.css.contains("#flux-hello-badge"));

        let at_start = reg.injection_for("https://example.com/", true);
        assert!(at_start.js.is_empty() && at_start.css.is_empty());

        // Disabled extensions inject nothing.
        reg.set_enabled("com.flux.hello", false);
        assert!(reg.injection_for("https://example.com/", false).js.is_empty());
    }

    #[test]
    fn registry_install_toggle_remove() {
        let dir = std::env::temp_dir().join(format!("flux-ext-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), VALID).unwrap();
        std::fs::write(dir.join("r.js"), "// content script").unwrap();

        let reg = ExtRegistry::new();
        let m = reg.install(&dir).unwrap();
        assert_eq!(m.id, "com.example.reader");
        assert_eq!(reg.list().len(), 1);
        assert!(reg.list()[0].enabled);

        reg.set_enabled("com.example.reader", false);
        assert!(!reg.list()[0].enabled);

        // Re-install replaces (no duplicate).
        reg.install(&dir).unwrap();
        assert_eq!(reg.list().len(), 1);

        reg.remove("com.example.reader");
        assert!(reg.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
