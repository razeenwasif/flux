//! Focus sessions that block (Flux Next "time and focus").
//!
//! A session runs for its minutes and stops its chosen sites before they load:
//! on macOS in Flux's own navigation hook (`netfilter.rs`), which knows a page
//! from a frame in it (a frame is stopped quietly, a page gets the shell's
//! cover); elsewhere in wry's navigation handler (`webview.rs`). "Allow 5
//! minutes" lets one site through for a while. Pausing is a break: the sites
//! open until you resume. A session ends by itself when its time is up
//! (`sitetime.rs` runs the clock), and its focused minutes count toward the
//! day's goal.

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Sites a first session offers to block.
const DEFAULT_SITES: &[&str] = &[
    "youtube.com",
    "reddit.com",
    "x.com",
    "instagram.com",
    "tiktok.com",
    "facebook.com",
];

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Session {
    name: String,
    started_ms: u64,
    minutes: u32,
    /// When it was paused, while it is.
    paused_at: Option<u64>,
    /// Time spent paused so far, not counted.
    paused_ms: u64,
    blocks: Vec<String>,
}

impl Session {
    fn length(&self) -> u64 {
        u64::from(self.minutes) * 60_000
    }
    fn elapsed(&self, now: u64) -> u64 {
        let end = self.paused_at.unwrap_or(now);
        end.saturating_sub(self.started_ms)
            .saturating_sub(self.paused_ms)
            .min(self.length())
    }
    fn remaining(&self, now: u64) -> u64 {
        self.length() - self.elapsed(now)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
struct Stored {
    session: Option<Session>,
    /// The sites the next session blocks: the last ones chosen.
    sites: Vec<String>,
    goal_minutes: u32,
    /// Finished sessions: when they ended, and how long they focused.
    done: Vec<(u64, u64)>,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            session: None,
            sites: DEFAULT_SITES.iter().map(|s| s.to_string()).collect(),
            goal_minutes: 120,
            done: Vec::new(),
        }
    }
}

pub struct FocusState {
    data: Mutex<Stored>,
    path: Option<PathBuf>,
    /// Site → until when it's let through ("Allow 5 minutes"). Not kept.
    allowed: Mutex<HashMap<String, u64>>,
}

#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct AllowedSite {
    pub site: String,
    pub until_ms: u64,
}

/// A session as the shell shows it, and the day's focus.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct FocusStatus {
    pub running: bool,
    pub paused: bool,
    pub name: String,
    pub minutes: u32,
    pub elapsed_ms: u64,
    pub remaining_ms: u64,
    /// What the running session blocks.
    pub blocks: Vec<String>,
    /// Sites let through for now.
    pub allowed: Vec<AllowedSite>,
    /// What the next session will block.
    pub sites: Vec<String>,
    pub goal_minutes: u32,
    /// Focused today: finished sessions and the running one.
    pub focused_secs: u32,
}

/// `youtube.com` from what someone typed: a URL, `www.`, capitals.
fn site_name(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase();
    let s = s.split("://").last()?;
    let host = s.split(['/', '?', '#']).next()?.split(':').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (host.contains('.') && !host.contains(' ')).then(|| host.to_string())
}

fn clean_sites(sites: &[String]) -> Vec<String> {
    let mut out: Vec<String> = sites.iter().filter_map(|s| site_name(s)).collect();
    out.sort();
    out.dedup();
    out.truncate(50);
    out
}

impl FocusState {
    pub fn load(path: Option<PathBuf>) -> Self {
        let data = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            path,
            allowed: Mutex::new(HashMap::new()),
        }
    }

    fn save(&self, d: &Stored) {
        if let Some(path) = &self.path {
            crate::persist::queue_json(path, d, crate::persist::Durability::Barrier);
        }
    }

    /// The blocked site `url` is on, if a running session stops it now.
    pub fn blocks(&self, url: &str) -> Option<String> {
        let host = crate::sitetime::site_of(url)?;
        let now = now_ms();
        let d = self.data.lock();
        let s = d.session.as_ref()?;
        if s.paused_at.is_some() || s.remaining(now) == 0 {
            return None;
        }
        let site = s
            .blocks
            .iter()
            .find(|b| host == **b || host.ends_with(&format!(".{b}")))?;
        if self
            .allowed
            .lock()
            .get(site)
            .is_some_and(|until| *until > now)
        {
            return None;
        }
        Some(site.clone())
    }

    fn finish(&self, d: &mut Stored, now: u64) {
        if let Some(s) = d.session.take() {
            d.done.push((now, s.elapsed(now)));
            // Two weeks of sessions is plenty for "today".
            let keep = now.saturating_sub(14 * 86_400_000);
            d.done.retain(|(end, _)| *end >= keep);
        }
        self.allowed.lock().clear();
    }

    /// End a session whose time is up. True when one ended.
    fn end_if_over(&self, now: u64) -> bool {
        let mut d = self.data.lock();
        let over = d
            .session
            .as_ref()
            .is_some_and(|s| s.paused_at.is_none() && s.remaining(now) == 0);
        if over {
            self.finish(&mut d, now);
            self.save(&d);
        }
        over
    }

    /// The clock: run by the site-time ticker.
    pub fn tick(&self, app: &AppHandle) {
        if self.end_if_over(now_ms()) {
            let _ = app.emit("flux://focus", ());
        }
    }

    /// Focused since `from_ms`, in seconds, and the day's goal in minutes.
    pub fn focused_since(&self, from_ms: u64) -> (u32, u32) {
        let now = now_ms();
        let d = self.data.lock();
        let done: u64 = d
            .done
            .iter()
            .filter(|(end, _)| *end >= from_ms)
            .map(|(_, ms)| ms)
            .sum();
        let running = d.session.as_ref().map(|s| s.elapsed(now)).unwrap_or(0);
        (((done + running) / 1000) as u32, d.goal_minutes)
    }

    fn status(&self, from_ms: u64) -> FocusStatus {
        let now = now_ms();
        let (focused_secs, goal_minutes) = self.focused_since(from_ms);
        let d = self.data.lock();
        let allowed = self
            .allowed
            .lock()
            .iter()
            .filter(|(_, until)| **until > now)
            .map(|(site, until)| AllowedSite {
                site: site.clone(),
                until_ms: *until,
            })
            .collect();
        let s = d.session.as_ref();
        FocusStatus {
            running: s.is_some(),
            paused: s.is_some_and(|s| s.paused_at.is_some()),
            name: s.map(|s| s.name.clone()).unwrap_or_default(),
            minutes: s.map(|s| s.minutes).unwrap_or(0),
            elapsed_ms: s.map(|s| s.elapsed(now)).unwrap_or(0),
            remaining_ms: s.map(|s| s.remaining(now)).unwrap_or(0),
            blocks: s.map(|s| s.blocks.clone()).unwrap_or_default(),
            allowed,
            sites: d.sites.clone(),
            goal_minutes,
            focused_secs,
        }
    }

    fn change(&self, f: impl FnOnce(&mut Stored, u64)) {
        let now = now_ms();
        let mut d = self.data.lock();
        f(&mut d, now);
        self.save(&d);
    }
}

fn day_from(tz_offset_min: i32) -> u64 {
    crate::sitetime::day_start(crate::sitetime::now_secs(), tz_offset_min) * 1000
}

fn changed(app: &AppHandle, state: &FocusState, tz_offset_min: i32) -> FocusStatus {
    let _ = app.emit("flux://focus", ());
    state.status(day_from(tz_offset_min))
}

#[tauri::command]
pub fn focus_status(state: State<'_, FocusState>, tz_offset_min: i32) -> FocusStatus {
    state.end_if_over(now_ms());
    state.status(day_from(tz_offset_min))
}

/// Start a session of `minutes` blocking `blocks` (the sites last chosen when
/// empty); those become the sites the next one offers.
#[tauri::command]
pub fn focus_start(
    app: AppHandle,
    state: State<'_, FocusState>,
    name: String,
    minutes: u32,
    blocks: Vec<String>,
    tz_offset_min: i32,
) -> FocusStatus {
    state.change(|d, now| {
        if d.session.is_some() {
            state.finish(d, now);
        }
        let blocks = if blocks.is_empty() {
            d.sites.clone()
        } else {
            clean_sites(&blocks)
        };
        d.sites = blocks.clone();
        d.session = Some(Session {
            name: name.trim().chars().take(80).collect(),
            started_ms: now,
            minutes: minutes.clamp(1, 8 * 60),
            paused_at: None,
            paused_ms: 0,
            blocks,
        });
    });
    changed(&app, &state, tz_offset_min)
}

/// Pause (a break: the sites open) or resume.
#[tauri::command]
pub fn focus_pause(
    app: AppHandle,
    state: State<'_, FocusState>,
    paused: bool,
    tz_offset_min: i32,
) -> FocusStatus {
    state.change(|d, now| {
        if let Some(s) = d.session.as_mut() {
            match (paused, s.paused_at) {
                (true, None) => s.paused_at = Some(now),
                (false, Some(at)) => {
                    s.paused_ms += now.saturating_sub(at);
                    s.paused_at = None;
                }
                _ => {}
            }
        }
    });
    changed(&app, &state, tz_offset_min)
}

#[tauri::command]
pub fn focus_end(app: AppHandle, state: State<'_, FocusState>, tz_offset_min: i32) -> FocusStatus {
    state.change(|d, now| state.finish(d, now));
    changed(&app, &state, tz_offset_min)
}

/// Let `site` through for `minutes` ("Allow 5 minutes").
#[tauri::command]
pub fn focus_allow(
    app: AppHandle,
    state: State<'_, FocusState>,
    site: String,
    minutes: u32,
    tz_offset_min: i32,
) -> FocusStatus {
    if let Some(site) = site_name(&site) {
        let until = now_ms() + u64::from(minutes.clamp(1, 60)) * 60_000;
        state.allowed.lock().insert(site, until);
    }
    changed(&app, &state, tz_offset_min)
}

/// The sites the next session offers, and the day's goal.
#[tauri::command]
pub fn focus_set(
    app: AppHandle,
    state: State<'_, FocusState>,
    sites: Option<Vec<String>>,
    goal_minutes: Option<u32>,
    tz_offset_min: i32,
) -> FocusStatus {
    state.change(|d, _| {
        if let Some(s) = sites {
            d.sites = clean_sites(&s);
        }
        if let Some(g) = goal_minutes {
            d.goal_minutes = g.clamp(5, 16 * 60);
        }
    });
    changed(&app, &state, tz_offset_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_session(blocks: &[&str], started_ago_ms: u64, minutes: u32) -> FocusState {
        let f = FocusState::load(None);
        f.data.lock().session = Some(Session {
            name: "Assignment 2".into(),
            started_ms: now_ms() - started_ago_ms,
            minutes,
            paused_at: None,
            paused_ms: 0,
            blocks: blocks.iter().map(|s| s.to_string()).collect(),
        });
        f
    }

    #[test]
    fn a_running_session_blocks_its_sites_and_their_subdomains() {
        let f = with_session(&["youtube.com", "x.com"], 60_000, 25);
        assert_eq!(
            f.blocks("https://www.youtube.com/watch?v=1").as_deref(),
            Some("youtube.com")
        );
        assert_eq!(
            f.blocks("https://m.youtube.com/").as_deref(),
            Some("youtube.com")
        );
        assert_eq!(f.blocks("https://x.com/home").as_deref(), Some("x.com"));
        // Not a subdomain, just a similar name.
        assert_eq!(f.blocks("https://notyoutube.com/"), None);
        assert_eq!(f.blocks("https://gitlab.anu.edu.au/"), None);
        assert_eq!(f.blocks("flux://tasks"), None);
    }

    #[test]
    fn allow_pause_and_the_end_open_the_sites() {
        let f = with_session(&["youtube.com"], 60_000, 25);
        f.allowed
            .lock()
            .insert("youtube.com".into(), now_ms() + 300_000);
        assert_eq!(f.blocks("https://youtube.com/"), None);
        f.allowed.lock().insert("youtube.com".into(), now_ms() - 1);
        assert!(
            f.blocks("https://youtube.com/").is_some(),
            "an allowance runs out"
        );

        f.data.lock().session.as_mut().unwrap().paused_at = Some(now_ms());
        assert_eq!(f.blocks("https://youtube.com/"), None, "a break opens them");

        // A session past its time blocks nothing, and the clock ends it.
        let f = with_session(&["youtube.com"], 26 * 60_000, 25);
        assert_eq!(f.blocks("https://youtube.com/"), None);
        assert!(f.end_if_over(now_ms()));
        assert!(f.data.lock().session.is_none());
        let (secs, goal) = f.focused_since(0);
        assert_eq!(
            (secs, goal),
            (25 * 60, 120),
            "a finished session counts its length"
        );
    }

    #[test]
    fn paused_time_isnt_focus() {
        let f = with_session(&["youtube.com"], 10 * 60_000, 25);
        {
            let mut d = f.data.lock();
            let s = d.session.as_mut().unwrap();
            s.paused_ms = 4 * 60_000;
        }
        let st = f.status(0);
        assert!(st.running && !st.paused);
        // Ten minutes in, four of them paused: six focused, nineteen to go.
        assert_eq!(st.elapsed_ms / 60_000, 6);
        assert_eq!(st.elapsed_ms + st.remaining_ms, 25 * 60_000);
        assert_eq!(st.focused_secs / 60, 6);
    }

    #[test]
    fn typed_sites_are_tidied() {
        assert_eq!(
            clean_sites(&[
                "https://www.YouTube.com/feed".into(),
                "reddit.com".into(),
                "reddit.com".into(),
                "not a site".into(),
                "localhost".into(),
            ]),
            vec!["reddit.com", "youtube.com"]
        );
    }
}
