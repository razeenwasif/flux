//! Flux mini-extension manifest + loader + registry (BACKLOG #92, ADR 0008).
//!
//! This is the foundation of the extension model: parse + validate a
//! `flux.extension.json`, and keep a persisted registry of installed extensions
//! (enabled/disabled). Content-script *injection* is #93, the `flux.*` API is
//! #94, the manager UI is #95 — all build on what's here.

use std::path::{Path, PathBuf};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

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
