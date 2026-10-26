//! Form help (Settings → Form help, off by default): the general half of
//! Ghostfill, built in. Click or Tab into an empty field and the local model
//! suggests what goes in it: a short field shows the answer as ghost text that
//! Tab accepts, a long one (a textarea, a rich-text editor) gets it copied to
//! the clipboard to paste.
//!
//! The page script (`assets/formhelp.js`) asks [`formhelp_page_config`] once
//! per document and attaches nothing when the answer is no. Both page commands
//! live in the `fluxtab` plugin, so any page can call them, which shapes what
//! they do:
//! - Whether Flux helps on a page is decided here, from the tab's own URL: not
//!   when it's off, off for the site, or on a banking, password-manager,
//!   health or tax site ([`flux_agent::steps::sensitive_site`]).
//! - Password, card, one-time-code and (by default) personal-detail fields are
//!   refused here too ([`flux_agent::formhelp::refuses`]), whatever the page
//!   script decided.
//! - The model is the local one (this Mac's Ollama or the Model server),
//!   never the cloud switch: a page's text goes nowhere else on its own.
//! - Rust never touches the clipboard. The page script copies through
//!   WebKit's clipboard API inside your click or keypress, so a page gets no
//!   clipboard power it doesn't already have.
//! - One answer at a time per tab, and at most [`MAX_PER_MINUTE`] a minute.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use flux_agent::formhelp::FormField;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::TabId;

/// Answers a page may ask for in a minute: about one field every two seconds.
pub const MAX_PER_MINUTE: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[serde(default)]
pub struct FormHelpPrefs {
    pub enabled: bool,
    /// `focus`: when you click or Tab into an empty field. `hotkey`: only on ⌃Space.
    pub trigger: String,
    /// How long a field stays focused before Flux asks.
    pub delay_ms: u32,
    /// Leave name, email, phone, address and ID fields alone.
    pub skip_personal: bool,
    /// Send the form's other answers along, so this one agrees with them.
    pub use_other_answers: bool,
    /// How answers should sound, in your words.
    pub voice: String,
    /// Sites where it's off (a host also covers its subdomains).
    pub sites_off: Vec<String>,
}

impl Default for FormHelpPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            trigger: "focus".into(),
            delay_ms: 350,
            skip_personal: true,
            use_other_answers: true,
            voice: String::new(),
            sites_off: Vec::new(),
        }
    }
}

impl FormHelpPrefs {
    /// What a page's settings write can be, whatever was sent.
    fn normalized(mut self) -> Self {
        if self.trigger != "hotkey" {
            self.trigger = "focus".into();
        }
        self.delay_ms = self.delay_ms.min(3000);
        self.voice = self.voice.trim().chars().take(2000).collect();
        let mut sites: Vec<String> = self
            .sites_off
            .iter()
            .filter_map(|s| host_of(s.trim()))
            .collect();
        sites.sort();
        sites.dedup();
        self.sites_off = sites;
        self
    }

    fn off_for(&self, host: &str) -> bool {
        self.sites_off
            .iter()
            .any(|s| host == s || host.ends_with(&format!(".{s}")))
    }
}

/// `example.com` from `https://www.example.com/x`, `example.com` or `Example.com`.
fn host_of(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase();
    let s = s.split("://").last()?;
    let host = s.split(['/', '?', '#']).next()?.split(':').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty() && host.contains('.') || host == "localhost").then(|| host.to_string())
}

/// What the page script needs, when Flux helps on its page.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FormHelpPage {
    pub trigger: String,
    pub delay_ms: u32,
    pub skip_personal: bool,
    pub use_other_answers: bool,
}

/// An answer, or why there isn't one: `ok` (with `text`), `none` (the model
/// couldn't tell), `off`, `refused`, `busy`, `stale` (a newer request for the
/// tab replaced it) or `error`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FormHelpReply {
    pub status: &'static str,
    pub text: String,
}

impl FormHelpReply {
    fn of(status: &'static str) -> Self {
        Self {
            status,
            text: String::new(),
        }
    }
}

pub struct FormHelpState {
    prefs: RwLock<FormHelpPrefs>,
    path: Option<PathBuf>,
    seq: AtomicU64,
    /// Per tab: the request whose answer still counts.
    latest: DashMap<TabId, u64>,
    /// Per tab: when its recent requests came.
    recent: DashMap<TabId, VecDeque<Instant>>,
}

impl FormHelpState {
    /// Whether form help is on: its page script goes only into pages loaded
    /// while it is (webview.rs).
    pub fn enabled(&self) -> bool {
        self.prefs.read().enabled
    }

    /// Restore the settings from `path` (missing or unreadable → defaults, off)
    /// and save every change back there.
    pub fn load(path: Option<PathBuf>) -> Self {
        let prefs = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<FormHelpPrefs>(&s).ok())
            .map(FormHelpPrefs::normalized)
            .unwrap_or_default();
        Self {
            prefs: RwLock::new(prefs),
            path,
            seq: AtomicU64::new(0),
            latest: DashMap::new(),
            recent: DashMap::new(),
        }
    }

    /// The page's settings, if Flux helps on `url` at all.
    pub fn page(&self, url: &str) -> Option<FormHelpPage> {
        let p = self.prefs.read();
        if !p.enabled || !(url.starts_with("https://") || url.starts_with("http://")) {
            return None;
        }
        let host = host_of(url)?;
        if p.off_for(&host) || flux_agent::steps::sensitive_site(url).is_some() {
            return None;
        }
        Some(FormHelpPage {
            trigger: p.trigger.clone(),
            delay_ms: p.delay_ms,
            skip_personal: p.skip_personal,
            use_other_answers: p.use_other_answers,
        })
    }

    /// Count a request against the tab's minute; false when it's used up.
    fn admit(&self, tab: TabId, now: Instant) -> bool {
        let mut q = self.recent.entry(tab).or_default();
        while q
            .front()
            .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
        {
            q.pop_front();
        }
        if q.len() >= MAX_PER_MINUTE {
            return false;
        }
        q.push_back(now);
        true
    }

    /// Start a request for `tab`, replacing any still running.
    fn begin(&self, tab: TabId) -> u64 {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.latest.insert(tab, n);
        n
    }

    fn is_latest(&self, tab: TabId, n: u64) -> bool {
        self.latest.get(&tab).is_some_and(|l| *l == n)
    }

    pub fn forget_tab(&self, tab: TabId) {
        self.latest.remove(&tab);
        self.recent.remove(&tab);
    }
}

/// Page → Rust, once per document: whether to help here, and how.
#[tauri::command]
pub fn formhelp_page_config(
    webview: tauri::Webview,
    state: State<'_, FormHelpState>,
) -> Option<FormHelpPage> {
    crate::dom::caller_tab(&webview).ok()?;
    state.page(webview.url().ok()?.as_str())
}

/// Page → Rust: the text for one field. `avoid` is the suggestion ⌃Space asked
/// to replace.
#[tauri::command]
pub async fn formhelp_suggest(
    webview: tauri::Webview,
    state: State<'_, FormHelpState>,
    field: FormField,
    avoid: Option<String>,
) -> Result<FormHelpReply, String> {
    let tab = crate::dom::caller_tab(&webview)?;
    let Some(url) = webview.url().ok() else {
        return Ok(FormHelpReply::of("off"));
    };
    let Some(page) = state.page(url.as_str()) else {
        return Ok(FormHelpReply::of("off"));
    };
    if let Some(why) = flux_agent::formhelp::refuses(&field, page.skip_personal) {
        tracing::debug!(target: "flux::formhelp", tab, why, "field refused");
        return Ok(FormHelpReply::of("refused"));
    }
    if !state.admit(tab, Instant::now()) {
        return Ok(FormHelpReply::of("busy"));
    }
    let mut field = field;
    if !page.use_other_answers {
        field.siblings.clear();
    }
    // The host is the tab's, not the page's say-so.
    field.host = url.host_str().unwrap_or_default().to_string();
    let n = state.begin(tab);
    let voice = state.prefs.read().voice.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let local = crate::agent_bridge::router().local();
        flux_agent::formhelp::suggest(local.as_ref(), &field, avoid.as_deref(), &voice)
    })
    .await
    .map_err(|e| e.to_string())?;
    if !state.is_latest(tab, n) {
        return Ok(FormHelpReply::of("stale"));
    }
    Ok(match answer {
        Ok(Some(text)) => FormHelpReply { status: "ok", text },
        Ok(None) => FormHelpReply::of("none"),
        Err(e) => {
            tracing::warn!(target: "flux::formhelp", tab, error = %e, "no answer");
            FormHelpReply {
                status: "error",
                text: "the model didn't answer".into(),
            }
        }
    })
}

#[tauri::command]
pub fn formhelp_settings(state: State<'_, FormHelpState>) -> FormHelpPrefs {
    state.prefs.read().clone()
}

/// Save the settings; returns them as stored (normalized).
#[tauri::command]
pub fn formhelp_set_settings(
    state: State<'_, FormHelpState>,
    prefs: FormHelpPrefs,
) -> FormHelpPrefs {
    let prefs = prefs.normalized();
    *state.prefs.write() = prefs.clone();
    if let Some(path) = &state.path {
        crate::persist::queue_json_pretty(path, &prefs, crate::persist::Durability::Barrier);
    }
    prefs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> FormHelpState {
        let s = FormHelpState::load(None);
        s.prefs.write().enabled = true;
        s
    }

    #[test]
    fn off_by_default_and_off_where_it_should_be() {
        let s = FormHelpState::load(None);
        assert_eq!(s.page("https://forms.example.com/a"), None);

        let s = on();
        assert!(s.page("https://forms.example.com/a").is_some());
        assert_eq!(s.page("flux://settings"), None);
        assert_eq!(s.page("file:///Users/x/form.html"), None);
        // Banking, health and tax sites: never.
        assert_eq!(s.page("https://www.commbank.com.au/netbank"), None);
        assert_eq!(s.page("https://www.ato.gov.au/"), None);

        s.prefs.write().sites_off = vec!["example.com".into()];
        assert_eq!(s.page("https://forms.example.com/a"), None);
        assert!(s.page("https://notexample.com/a").is_some());
    }

    #[test]
    fn settings_are_normalized() {
        let p = FormHelpPrefs {
            trigger: "sometimes".into(),
            delay_ms: 99_999,
            voice: "x".repeat(5000),
            sites_off: vec![
                "https://www.Example.com/forms?x=1".into(),
                "example.com".into(),
                "nonsense".into(),
                " docs.google.com ".into(),
            ],
            ..Default::default()
        }
        .normalized();
        assert_eq!(p.trigger, "focus");
        assert_eq!(p.delay_ms, 3000);
        assert_eq!(p.voice.chars().count(), 2000);
        assert_eq!(p.sites_off, vec!["docs.google.com", "example.com"]);
    }

    #[test]
    fn a_tab_gets_a_minute_of_answers_and_only_its_latest_counts() {
        let s = on();
        let t0 = Instant::now();
        for _ in 0..MAX_PER_MINUTE {
            assert!(s.admit(7, t0));
        }
        assert!(!s.admit(7, t0));
        assert!(s.admit(8, t0), "another tab has its own minute");
        assert!(s.admit(7, t0 + Duration::from_secs(61)));

        let a = s.begin(7);
        let b = s.begin(7);
        assert!(!s.is_latest(7, a));
        assert!(s.is_latest(7, b));
        s.forget_tab(7);
        assert!(!s.is_latest(7, b));
    }

    #[test]
    fn settings_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("flux-formhelp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("formhelp.json");
        let p = FormHelpPrefs {
            enabled: true,
            voice: "Plain and brief".into(),
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_string(&p).unwrap()).unwrap();
        let s = FormHelpState::load(Some(path.clone()));
        assert!(s.prefs.read().enabled);
        assert_eq!(s.prefs.read().voice, "Plain and brief");
        std::fs::write(&path, "{not json").unwrap();
        assert!(!FormHelpState::load(Some(path)).prefs.read().enabled);
        let _ = std::fs::remove_dir_all(dir);
    }
}
