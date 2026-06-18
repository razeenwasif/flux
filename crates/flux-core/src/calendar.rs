//! Calendar sync via iCalendar (ICS) feeds (BACKLOG #114) — read-only, no OAuth.
//!
//! Google Calendar (and most others) expose a private **secret ICS address**
//! (Calendar settings → "Secret address in iCal format"). Subscribe Flux to that
//! URL and the home calendar widget shows your real events — entirely via an
//! HTTP GET of a feed you control, nothing phones home to a Google account. Same
//! shape as the RSS reader (#72): subscriptions persist, events are fetched live.
//!
//! The parser is a lean hand-rolled iCalendar scanner (VEVENT, line-unfolding,
//! DATE vs DATE-TIME). To stay timezone-bug-free it keeps each event's date/time
//! in the feed's own calendar terms (a `YYYY-MM-DD` string + `HH:MM`) rather than
//! converting to epoch — which is exactly what a month-grid widget needs.

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_ICS_BYTES: u64 = 4 * 1024 * 1024;
/// Cap events returned to the widget (a busy calendar can have thousands).
const MAX_EVENTS: usize = 500;

/// A subscribed calendar (its ICS URL). Only this is persisted.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct CalFeed {
    pub id: u64,
    pub url: String,
    pub name: String,
}

/// One event, in the feed's own calendar terms (no tz conversion).
#[derive(Serialize, Clone, specta::Type)]
pub struct CalEvent {
    pub calendar: String,
    pub summary: String,
    /// `YYYY-MM-DD` of the start.
    pub date: String,
    /// `HH:MM` start time, or "" for an all-day event.
    pub time: String,
    pub location: String,
    /// `YYYYMMDDHHMM` — monotonic key for sorting / bucketing by calendar date.
    pub sort_key: u64,
}

#[derive(Default)]
pub struct CalStore {
    feeds: RwLock<Vec<CalFeed>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl CalStore {
    pub fn restore(path: PathBuf) -> Self {
        let feeds: Vec<CalFeed> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = feeds.iter().map(|f| f.id).max().unwrap_or(0) + 1;
        Self { feeds: RwLock::new(feeds), next_id: AtomicU64::new(next), path: Some(path) }
    }

    pub fn list(&self) -> Vec<CalFeed> {
        self.feeds.read().clone()
    }

    pub fn add(&self, url: String, name: String) -> CalFeed {
        if let Some(f) = self.feeds.read().iter().find(|f| f.url == url) {
            return f.clone();
        }
        let feed = CalFeed { id: self.next_id.fetch_add(1, Ordering::Relaxed), url, name };
        self.feeds.write().push(feed.clone());
        self.save();
        feed
    }

    pub fn remove(&self, id: u64) {
        self.feeds.write().retain(|f| f.id != id);
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&*self.feeds.read()) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn fetch_ics(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("webcal://")) {
        return Err("calendar url must be http(s) or webcal".into());
    }
    // webcal:// is just http(s) with a different scheme hint.
    let fetch = url.replacen("webcal://", "https://", 1);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(30))
        .build();
    let resp = agent
        .get(&fetch)
        .set("User-Agent", "Mozilla/5.0")
        .call()
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader().take(MAX_ICS_BYTES + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("empty response".into());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url).trim_start_matches("www.").to_string()
}

// ─── iCalendar parsing ───────────────────────────────────────────────────────

/// Unfold RFC 5545 folded lines: a CRLF (or LF) followed by a space/tab is a
/// continuation of the previous line.
fn unfold(ics: &str) -> String {
    ics.replace("\r\n ", "").replace("\r\n\t", "").replace("\n ", "").replace("\n\t", "")
}

/// Parse all VEVENTs into the widget's calendar-term events.
fn parse_events(ics: &str, cal_name: &str) -> Vec<CalEvent> {
    let unfolded = unfold(ics);
    let mut out = Vec::new();
    let mut in_event = false;
    let mut summary = String::new();
    let mut location = String::new();
    let mut date = String::new();
    let mut time = String::new();
    let mut sort_key = 0u64;

    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');
        if line == "BEGIN:VEVENT" {
            in_event = true;
            summary.clear();
            location.clear();
            date.clear();
            time.clear();
            sort_key = 0;
            continue;
        }
        if line == "END:VEVENT" {
            if !date.is_empty() {
                out.push(CalEvent {
                    calendar: cal_name.to_string(),
                    summary: if summary.is_empty() { "(untitled)".into() } else { summary.clone() },
                    date: date.clone(),
                    time: time.clone(),
                    location: location.clone(),
                    sort_key,
                });
            }
            in_event = false;
            continue;
        }
        if !in_event {
            continue;
        }
        // Split "NAME;params:value" into (name+params, value) on the first ':'.
        let Some(colon) = line.find(':') else { continue };
        let (key, value) = (&line[..colon], &line[colon + 1..]);
        let name = key.split(';').next().unwrap_or(key);
        match name {
            "SUMMARY" => summary = decode_text(value),
            "LOCATION" => location = decode_text(value),
            "DTSTART" => {
                let (d, t, k) = parse_dt(value);
                date = d;
                time = t;
                sort_key = k;
            }
            _ => {}
        }
    }
    out
}

/// `DTSTART` value → (`YYYY-MM-DD`, `HH:MM` or "", sort key `YYYYMMDDHHMM`).
/// Handles `20260619`, `20260619T100000Z`, `20260619T100000`.
fn parse_dt(value: &str) -> (String, String, u64) {
    let v: String = value.chars().take_while(|c| c.is_ascii_digit() || *c == 'T').collect();
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return (String::new(), String::new(), 0);
    }
    let (y, m, d) = (&digits[0..4], &digits[4..6], &digits[6..8]);
    let date = format!("{y}-{m}-{d}");
    let has_time = v.contains('T') && digits.len() >= 12;
    let (hh, mm) = if has_time { (&digits[8..10], &digits[10..12]) } else { ("", "") };
    let time = if has_time { format!("{hh}:{mm}") } else { String::new() };
    let key: u64 = format!("{y}{m}{d}{}{}", if has_time { hh } else { "00" }, if has_time { mm } else { "00" })
        .parse()
        .unwrap_or(0);
    (date, time, key)
}

/// Decode the iCalendar text escapes (`\n`, `\,`, `\;`, `\\`).
fn decode_text(s: &str) -> String {
    s.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cal_list(store: State<'_, CalStore>) -> Vec<CalFeed> {
    store.list()
}

#[tauri::command]
pub async fn cal_add(store: State<'_, CalStore>, url: String, name: Option<String>) -> Result<CalFeed, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".into());
    }
    if let Some(f) = store.list().into_iter().find(|f| f.url == url) {
        return Ok(f);
    }
    // Validate it parses as a calendar before subscribing.
    let probe = url.clone();
    let ics = tauri::async_runtime::spawn_blocking(move || fetch_ics(&probe)).await.map_err(|e| e.to_string())??;
    if !ics.contains("VCALENDAR") && !ics.contains("VEVENT") {
        return Err("that URL isn't an iCalendar (.ics) feed".into());
    }
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| host_of(&url));
    Ok(store.add(url, name))
}

#[tauri::command]
pub fn cal_remove(store: State<'_, CalStore>, id: u64) {
    store.remove(id);
}

/// Fetch + parse every subscribed calendar; returns events sorted by date. A
/// failing feed is skipped (one dead URL doesn't blank the widget).
#[tauri::command]
pub async fn cal_events(store: State<'_, CalStore>) -> Result<Vec<CalEvent>, String> {
    let feeds = store.list();
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = Vec::new();
        for f in &feeds {
            if let Ok(ics) = fetch_ics(&f.url) {
                all.extend(parse_events(&ics, &f.name));
            }
        }
        all.sort_by_key(|e| e.sort_key);
        all.truncate(MAX_EVENTS);
        Ok(all)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICS: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Team sync\r\nDTSTART:20260619T100000Z\r\nLOCATION:Room 4\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:All day off\r\nDTSTART;VALUE=DATE:20260620\r\nEND:VEVENT\r\nEND:VCALENDAR";

    #[test]
    fn parses_timed_and_all_day() {
        let ev = parse_events(ICS, "Work");
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].summary, "Team sync");
        assert_eq!(ev[0].date, "2026-06-19");
        assert_eq!(ev[0].time, "10:00");
        assert_eq!(ev[0].location, "Room 4");
        assert_eq!(ev[0].sort_key, 202606191000);
        assert_eq!(ev[1].date, "2026-06-20");
        assert_eq!(ev[1].time, ""); // all-day
        assert_eq!(ev[1].calendar, "Work");
    }

    #[test]
    fn unfolds_continuation_lines() {
        // RFC 5545 folds with a single leading space on the continuation line.
        let folded = "BEGIN:VEVENT\r\nSUMMARY:Long title that\r\n wraps\r\nDTSTART:20260101\r\nEND:VEVENT";
        let ev = parse_events(folded, "C");
        assert_eq!(ev[0].summary, "Long title thatwraps");
    }

    #[test]
    fn store_dedupes() {
        let s = CalStore::default();
        let a = s.add("https://cal/x.ics".into(), "X".into());
        let b = s.add("https://cal/x.ics".into(), "Y".into());
        assert_eq!(a.id, b.id);
        assert_eq!(s.list().len(), 1);
    }
}
