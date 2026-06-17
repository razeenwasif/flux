//! Site permissions (BACKLOG #38, extending #58).
//!
//! A per-site, per-kind permission store for camera / microphone / geolocation /
//! notifications (+ clipboard, others), plus the legacy global "block all"
//! switch from #58. The native engine still shows its own prompt for the
//! **Ask** (default) case; a remembered **Allow**/**Deny** short-circuits it on
//! WebView2 via `PermissionRequested`. The frontend manager (`flux://permissions`)
//! lists every remembered decision and lets the user change or revoke it.
//!
//! Decisions persist to `permissions.json`. The policy resolution is a pure
//! function ([`PermState::effective`]) so it's unit-tested independent of the
//! Windows COM wiring (which can only run on Windows).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::webview::Webview;
use tauri::{AppHandle, State};

/// The permission kinds Flux surfaces. Anything else from the engine maps to
/// [`PermKind::Other`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PermKind {
    Camera,
    Microphone,
    Geolocation,
    Notifications,
    ClipboardRead,
    Other,
}

/// What the user decided for a (site, kind). `Ask` = no remembered decision, so
/// the engine's own prompt is shown.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum PermDecision {
    #[default]
    Ask,
    Allow,
    Deny,
}

/// The resolved action for a live request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Effective {
    Allow,
    Deny,
    /// Leave it to the engine's native prompt.
    Prompt,
}

/// One remembered decision, for the manager UI + persistence.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct SitePerm {
    pub host: String,
    pub kind: PermKind,
    pub decision: PermDecision,
}

pub struct PermState {
    /// Legacy global hardening (#58): when on, every request is denied.
    block: AtomicBool,
    decisions: RwLock<HashMap<(String, PermKind), PermDecision>>,
    path: Option<PathBuf>,
}

impl Default for PermState {
    fn default() -> Self {
        Self::new()
    }
}

impl PermState {
    pub fn new() -> Self {
        Self { block: AtomicBool::new(false), decisions: RwLock::new(HashMap::new()), path: None }
    }

    /// Load remembered decisions from disk (missing/corrupt → empty).
    pub fn restore(path: PathBuf) -> Self {
        let decisions = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<SitePerm>>(&s).ok())
            .map(|v| v.into_iter().map(|p| ((p.host, p.kind), p.decision)).collect())
            .unwrap_or_default();
        Self { block: AtomicBool::new(false), decisions: RwLock::new(decisions), path: Some(path) }
    }

    pub fn blocking(&self) -> bool {
        self.block.load(Ordering::Relaxed)
    }

    /// The remembered decision for a (host, kind), or `Ask`.
    pub fn decision_for(&self, host: &str, kind: PermKind) -> PermDecision {
        self.decisions.read().get(&(host.to_string(), kind)).copied().unwrap_or_default()
    }

    /// Resolve what to actually do with a request. Global block wins; otherwise
    /// the remembered decision; otherwise prompt. Pure — unit-tested.
    pub fn effective(&self, host: &str, kind: PermKind) -> Effective {
        if self.blocking() {
            return Effective::Deny;
        }
        match self.decision_for(host, kind) {
            PermDecision::Allow => Effective::Allow,
            PermDecision::Deny => Effective::Deny,
            PermDecision::Ask => Effective::Prompt,
        }
    }

    /// Remember a decision (or forget it when set back to `Ask`), then persist.
    pub fn set(&self, host: String, kind: PermKind, decision: PermDecision) {
        {
            let mut d = self.decisions.write();
            if decision == PermDecision::Ask {
                d.remove(&(host, kind));
            } else {
                d.insert((host, kind), decision);
            }
        }
        self.persist();
    }

    /// Forget every decision for a host.
    pub fn clear_host(&self, host: &str) {
        self.decisions.write().retain(|(h, _), _| h != host);
        self.persist();
    }

    pub fn clear_all(&self) {
        self.decisions.write().clear();
        self.persist();
    }

    /// All remembered decisions, host-then-kind sorted (stable UI order).
    pub fn list(&self) -> Vec<SitePerm> {
        let mut v: Vec<SitePerm> = self
            .decisions
            .read()
            .iter()
            .map(|((host, kind), decision)| SitePerm { host: host.clone(), kind: *kind, decision: *decision })
            .collect();
        v.sort_by(|a, b| a.host.cmp(&b.host).then_with(|| format!("{:?}", a.kind).cmp(&format!("{:?}", b.kind))));
        v
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        if let Ok(json) = serde_json::to_string_pretty(&self.list()) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Install the PermissionRequested handler on a freshly-created tab webview.
pub fn install(app: &AppHandle, webview: &Webview) {
    #[cfg(windows)]
    win::install(app.clone(), webview);
    #[cfg(not(windows))]
    {
        let _ = (app, webview);
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn permissions_status(state: State<'_, PermState>) -> bool {
    state.blocking()
}

#[tauri::command]
pub fn permissions_set_block(state: State<'_, PermState>, on: bool) {
    state.block.store(on, Ordering::Relaxed);
}

/// Every remembered per-site decision (for the manager UI).
#[tauri::command]
pub fn permissions_list(state: State<'_, PermState>) -> Vec<SitePerm> {
    state.list()
}

#[tauri::command]
pub fn permissions_set(state: State<'_, PermState>, host: String, kind: PermKind, decision: PermDecision) {
    state.set(host, kind, decision);
}

#[tauri::command]
pub fn permissions_clear_host(state: State<'_, PermState>, host: String) {
    state.clear_host(&host);
}

#[tauri::command]
pub fn permissions_clear_all(state: State<'_, PermState>) {
    state.clear_all();
}

/// Host of a URL (`https://a.b/c` → `a.b`), dependency-free.
pub fn host_of(url: &str) -> Option<&str> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next().unwrap_or("");
    (!host.is_empty()).then_some(host)
}

#[cfg(windows)]
mod win {
    use tauri::webview::Webview;
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::PermissionRequestedEventHandler;
    use windows::core::PWSTR;

    use super::{Effective, PermKind, PermState};

    fn map_kind(k: i32) -> PermKind {
        match k {
            x if x == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE.0 => PermKind::Microphone,
            x if x == COREWEBVIEW2_PERMISSION_KIND_CAMERA.0 => PermKind::Camera,
            x if x == COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION.0 => PermKind::Geolocation,
            x if x == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS.0 => PermKind::Notifications,
            x if x == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ.0 => PermKind::ClipboardRead,
            _ => PermKind::Other,
        }
    }

    pub fn install(app: AppHandle, webview: &Webview) {
        let _ = webview.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| unsafe {
                let Some(args) = args else { return Ok(()) };
                let Some(state) = app.try_state::<PermState>() else { return Ok(()) };

                let mut uri = PWSTR::null();
                let host = if args.Uri(&mut uri).is_ok() {
                    let u = webview2_com::take_pwstr(uri);
                    super::host_of(&u).map(str::to_string).unwrap_or_default()
                } else {
                    String::new()
                };
                let kind = args.PermissionKind().map(|k| map_kind(k.0)).unwrap_or(PermKind::Other);

                // Allow/Deny per the store; leave default so WebView2 prompts on Ask.
                match state.effective(&host, kind) {
                    Effective::Allow => { let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW); }
                    Effective::Deny => { let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY); }
                    Effective::Prompt => {}
                }
                Ok(())
            }));
            let mut token: i64 = 0;
            let _ = core.add_PermissionRequested(&handler, &mut token);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_prompt() {
        let s = PermState::new();
        assert_eq!(s.decision_for("a.com", PermKind::Camera), PermDecision::Ask);
        assert_eq!(s.effective("a.com", PermKind::Camera), Effective::Prompt);
    }

    #[test]
    fn remembered_allow_and_deny() {
        let s = PermState::new();
        s.set("a.com".into(), PermKind::Camera, PermDecision::Allow);
        s.set("a.com".into(), PermKind::Microphone, PermDecision::Deny);
        assert_eq!(s.effective("a.com", PermKind::Camera), Effective::Allow);
        assert_eq!(s.effective("a.com", PermKind::Microphone), Effective::Deny);
        // A different host is unaffected.
        assert_eq!(s.effective("b.com", PermKind::Camera), Effective::Prompt);
    }

    #[test]
    fn global_block_overrides_allow() {
        let s = PermState::new();
        s.set("a.com".into(), PermKind::Camera, PermDecision::Allow);
        s.block.store(true, Ordering::Relaxed);
        assert_eq!(s.effective("a.com", PermKind::Camera), Effective::Deny);
    }

    #[test]
    fn setting_ask_forgets_the_decision() {
        let s = PermState::new();
        s.set("a.com".into(), PermKind::Geolocation, PermDecision::Deny);
        assert_eq!(s.list().len(), 1);
        s.set("a.com".into(), PermKind::Geolocation, PermDecision::Ask);
        assert!(s.list().is_empty());
    }

    #[test]
    fn clear_host_and_all() {
        let s = PermState::new();
        s.set("a.com".into(), PermKind::Camera, PermDecision::Allow);
        s.set("a.com".into(), PermKind::Microphone, PermDecision::Deny);
        s.set("b.com".into(), PermKind::Notifications, PermDecision::Allow);
        s.clear_host("a.com");
        assert_eq!(s.list().len(), 1);
        assert_eq!(s.list()[0].host, "b.com");
        s.clear_all();
        assert!(s.list().is_empty());
    }

    #[test]
    fn list_is_sorted() {
        let s = PermState::new();
        s.set("z.com".into(), PermKind::Camera, PermDecision::Allow);
        s.set("a.com".into(), PermKind::Microphone, PermDecision::Deny);
        let l = s.list();
        assert_eq!(l[0].host, "a.com");
        assert_eq!(l[1].host, "z.com");
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.com/x?y"), Some("a.b.com"));
        assert_eq!(host_of("http://u@h.com:8443/p"), Some("h.com"));
        assert_eq!(host_of(""), None);
    }
}
