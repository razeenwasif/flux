//! Scriptable automation / macros (BACKLOG #67).
//!
//! Record a browsing flow — navigations, clicks, typing — into a named macro,
//! then replay it. Recording: the injected `macro-record.js` reports clicks +
//! input changes (with a generated selector) here while a recording is active,
//! and navigations are captured from `dom_publish`. Replay walks the steps
//! against the active tab with waits between them. Best-effort by nature (sites
//! change; selectors can drift) — the honest limit of record/replay.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// One recorded action. Tagged enum → clean JSON for the UI + persistence.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    Navigate { url: String },
    Click { selector: String },
    Type { selector: String, text: String },
    Wait { ms: u64 },
}

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Macro {
    pub id: u64,
    pub name: String,
    pub steps: Vec<Step>,
}

pub struct MacroState {
    path: Option<PathBuf>,
    macros: RwLock<Vec<Macro>>,
    next_id: AtomicU64,
    /// `Some` while recording — the in-progress step buffer.
    recording: RwLock<Option<Vec<Step>>>,
    /// Mirror of `recording.is_some()` for cheap reads (init-script stamp).
    active: AtomicBool,
}

#[derive(Serialize, specta::Type)]
pub struct MacroStatus {
    pub recording: bool,
    pub step_count: usize,
}

impl Default for MacroState {
    fn default() -> Self {
        Self { path: None, macros: RwLock::new(Vec::new()), next_id: AtomicU64::new(1), recording: RwLock::new(None), active: AtomicBool::new(false) }
    }
}

impl MacroState {
    pub fn restore(path: PathBuf) -> Self {
        let macros: Vec<Macro> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = macros.iter().map(|m| m.id).max().unwrap_or(0) + 1;
        Self { path: Some(path), macros: RwLock::new(macros), next_id: AtomicU64::new(next), recording: RwLock::new(None), active: AtomicBool::new(false) }
    }

    pub fn is_recording(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    pub fn start(&self, initial: Option<Step>) {
        let mut buf = Vec::new();
        if let Some(s) = initial {
            buf.push(s);
        }
        *self.recording.write() = Some(buf);
        self.active.store(true, Ordering::Relaxed);
    }

    /// Append a step if recording, collapsing redundant consecutive entries:
    /// duplicate navigations, and repeated types into the same field (keep last).
    pub fn push(&self, step: Step) {
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        let mut g = self.recording.write();
        let Some(buf) = g.as_mut() else { return };
        match (&step, buf.last_mut()) {
            (Step::Navigate { url }, Some(Step::Navigate { url: prev })) if url == prev => {}
            (Step::Type { selector, text }, Some(Step::Type { selector: ps, .. })) if selector == ps => {
                if let Some(Step::Type { text: pt, .. }) = buf.last_mut() {
                    *pt = text.clone();
                }
            }
            _ => buf.push(step),
        }
    }

    pub fn recording_len(&self) -> usize {
        self.recording.read().as_ref().map(|b| b.len()).unwrap_or(0)
    }

    /// Finish recording; save as a named macro if it has steps. Returns it.
    pub fn stop(&self, name: String) -> Option<Macro> {
        self.active.store(false, Ordering::Relaxed);
        let buf = self.recording.write().take()?;
        if buf.is_empty() {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let name = if name.trim().is_empty() { format!("Macro {id}") } else { name };
        let m = Macro { id, name, steps: buf };
        self.macros.write().push(m.clone());
        self.persist();
        Some(m)
    }

    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
        *self.recording.write() = None;
    }

    pub fn list(&self) -> Vec<Macro> {
        self.macros.read().clone()
    }
    pub fn get(&self, id: u64) -> Option<Macro> {
        self.macros.read().iter().find(|m| m.id == id).cloned()
    }
    pub fn delete(&self, id: u64) {
        self.macros.write().retain(|m| m.id != id);
        self.persist();
    }
    pub fn rename(&self, id: u64, name: String) {
        if let Some(m) = self.macros.write().iter_mut().find(|m| m.id == id) {
            if !name.trim().is_empty() {
                m.name = name;
            }
        }
        self.persist();
    }

    fn persist(&self) {
        if let Some(path) = &self.path {
            crate::persist::save_json_pretty(path, &*self.macros.read());
        }
    }
}

/// JSON-encode for safe embedding in a JS string literal.
fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Flip the recording flag in the active tab live, so the recorder starts/stops
/// without a reload (new pages stamp it from backend state at init).
fn set_page_flag(app: &AppHandle, on: bool) {
    let Some(tab) = app.state::<crate::state::FluxState>().active_tab() else { return };
    if let Some(wv) = app.get_webview(&format!("tab-{tab}")) {
        let _ = wv.eval(&format!("window.__FLUX_MACRO_REC__ = {on};"));
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn macros_list(state: State<'_, MacroState>) -> Vec<Macro> {
    state.list()
}

#[tauri::command]
pub fn macros_status(state: State<'_, MacroState>) -> MacroStatus {
    MacroStatus { recording: state.is_recording(), step_count: state.recording_len() }
}

/// Begin recording. Seeds the flow with a Navigate to the current page so replay
/// starts from the right place.
#[tauri::command]
pub fn macro_start_record(app: AppHandle, state: State<'_, MacroState>) {
    let initial = app
        .state::<crate::state::FluxState>()
        .active_snapshot()
        .filter(|s| s.url.starts_with("http"))
        .map(|s| Step::Navigate { url: s.url.clone() });
    state.start(initial);
    set_page_flag(&app, true);
}

#[tauri::command]
pub fn macro_stop_record(app: AppHandle, state: State<'_, MacroState>, name: String) -> Option<Macro> {
    set_page_flag(&app, false);
    state.stop(name)
}

#[tauri::command]
pub fn macro_cancel_record(app: AppHandle, state: State<'_, MacroState>) {
    set_page_flag(&app, false);
    state.cancel();
}

/// Page → Rust: a recorded click/type from `macro-record.js` (a `fluxtab` plugin
/// command, like `dom_publish`). Ignored unless a recording is active.
#[tauri::command]
pub fn macro_record_step(state: State<'_, MacroState>, kind: String, selector: String, text: String) {
    let step = match kind.as_str() {
        "click" => Step::Click { selector },
        "type" => Step::Type { selector, text },
        _ => return,
    };
    state.push(step);
}

#[tauri::command]
pub fn macro_delete(state: State<'_, MacroState>, id: u64) {
    state.delete(id);
}

#[tauri::command]
pub fn macro_rename(state: State<'_, MacroState>, id: u64, name: String) {
    state.rename(id, name);
}

/// Replay a macro against the active tab: navigate / click / type with waits
/// between steps. Best-effort (selectors can drift on changed pages).
#[tauri::command]
pub async fn macro_run(app: AppHandle, state: State<'_, MacroState>, id: u64) -> Result<(), String> {
    let m = state.get(id).ok_or("macro not found")?;
    let tab = app.state::<crate::state::FluxState>().active_tab().ok_or("no active tab")?;
    let label = format!("tab-{tab}");
    for step in &m.steps {
        let Some(wv) = app.get_webview(&label) else { return Err("active tab closed".into()) };
        match step {
            Step::Navigate { url } => {
                let _ = wv.eval(&format!("location.assign({})", js(url)));
                tokio::time::sleep(Duration::from_millis(1500)).await; // let the page load
            }
            Step::Click { selector } => {
                let _ = wv.eval(&format!(
                    "(()=>{{const e=document.querySelector({});if(e){{e.scrollIntoView({{block:'center'}});e.click();}}}})()",
                    js(selector)
                ));
                tokio::time::sleep(Duration::from_millis(700)).await;
            }
            Step::Type { selector, text } => {
                let _ = wv.eval(&format!(
                    "(()=>{{const e=document.querySelector({});if(e){{e.focus();const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set;if(s)s.call(e,{t});else e.value={t};e.dispatchEvent(new Event('input',{{bubbles:true}}));}}}})()",
                    js(selector), t = js(text)
                ));
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
            Step::Wait { ms } => tokio::time::sleep(Duration::from_millis((*ms).min(10_000))).await,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_collapses_steps() {
        let s = MacroState::default();
        s.start(Some(Step::Navigate { url: "https://a.com".into() }));
        s.push(Step::Navigate { url: "https://a.com".into() }); // dup → collapsed
        s.push(Step::Click { selector: "#go".into() });
        s.push(Step::Type { selector: "#q".into(), text: "he".into() });
        s.push(Step::Type { selector: "#q".into(), text: "hello".into() }); // same field → keep last
        assert_eq!(s.recording_len(), 3);
        let m = s.stop("search".into()).unwrap();
        assert_eq!(m.name, "search");
        assert_eq!(m.steps.len(), 3);
        assert_eq!(m.steps[2], Step::Type { selector: "#q".into(), text: "hello".into() });
        assert!(!s.is_recording());
    }

    #[test]
    fn push_ignored_when_not_recording() {
        let s = MacroState::default();
        s.push(Step::Click { selector: "#x".into() });
        assert_eq!(s.recording_len(), 0);
    }

    #[test]
    fn empty_recording_saves_nothing() {
        let s = MacroState::default();
        s.start(None);
        assert!(s.stop("empty".into()).is_none());
        assert!(s.list().is_empty());
    }

    #[test]
    fn list_delete_rename() {
        let s = MacroState::default();
        s.start(Some(Step::Click { selector: "#a".into() }));
        let m = s.stop("m1".into()).unwrap();
        s.rename(m.id, "renamed".into());
        assert_eq!(s.get(m.id).unwrap().name, "renamed");
        s.delete(m.id);
        assert!(s.list().is_empty());
    }
}
