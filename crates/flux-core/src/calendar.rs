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
const MAX_EVENTS: usize = 1500;

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
    /// `HH:MM` end time (same day), or "" if unknown/all-day.
    pub end: String,
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

/// Past/future window (in days from today) we expand events into. Recurring
/// events are expanded across this range; one-off events outside it are dropped
/// so the cap keeps what's relevant (an upcoming calendar, not ancient history).
const WINDOW_BACK_DAYS: i64 = 14;
const WINDOW_FWD_DAYS: i64 = 180;
/// Hard cap on occurrences per recurring series (defensive against runaway rules).
const MAX_OCCURRENCES: usize = 400;

/// Parse all VEVENTs into the widget's events, expanding RRULE recurrences within
/// the window. Handles FREQ=DAILY/WEEKLY/MONTHLY with INTERVAL/COUNT/UNTIL,
/// BYDAY (weekly), and EXDATE — which covers essentially all Google-Calendar
/// recurring events.
fn parse_events(ics: &str, cal_name: &str) -> Vec<CalEvent> {
    parse_events_at(ics, cal_name, today_epoch_days())
}

fn parse_events_at(ics: &str, cal_name: &str, today: i64) -> Vec<CalEvent> {
    let unfolded = unfold(ics);
    let lo = today - WINDOW_BACK_DAYS;
    let hi = today + WINDOW_FWD_DAYS;
    let mut out = Vec::new();

    let mut in_event = false;
    let mut summary = String::new();
    let mut location = String::new();
    let mut start: Option<DtParts> = None;
    let mut end_time = String::new();
    let mut rrule = String::new();
    let mut exdates: Vec<i64> = Vec::new();

    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');
        if line == "BEGIN:VEVENT" {
            in_event = true;
            summary.clear();
            location.clear();
            end_time.clear();
            rrule.clear();
            exdates.clear();
            start = None;
            continue;
        }
        if line == "END:VEVENT" {
            if let Some(s) = start.take() {
                let title = if summary.is_empty() { "(untitled)".into() } else { summary.clone() };
                emit_occurrences(&title, &location, &end_time, &s, &rrule, &exdates, cal_name, lo, hi, &mut out);
            }
            in_event = false;
            continue;
        }
        if !in_event {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let (key, value) = (&line[..colon], &line[colon + 1..]);
        let name = key.split(';').next().unwrap_or(key);
        match name {
            "SUMMARY" => summary = decode_text(value),
            "LOCATION" => location = decode_text(value),
            "DTSTART" => start = parse_dt(value),
            "DTEND" => end_time = parse_dt(value).map(|p| p.time).unwrap_or_default(),
            "RRULE" => rrule = value.to_string(),
            "EXDATE" => {
                for part in value.split(',') {
                    if let Some(p) = parse_dt(part) {
                        exdates.push(p.days);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A parsed DTSTART: calendar date pieces + the time-of-day + epoch-day index.
#[derive(Clone)]
struct DtParts {
    days: i64,     // days since 1970-01-01
    time: String,  // "HH:MM" or "" (all-day)
    hhmm: u64,     // HHMM as a number for the sort key (0 for all-day)
}

/// `DTSTART`/`EXDATE` value → DtParts. Handles `20260619`, `20260619T100000Z`,
/// `20260619T100000`. `None` if it isn't a date.
fn parse_dt(value: &str) -> Option<DtParts> {
    let v: String = value.chars().take_while(|c| c.is_ascii_digit() || *c == 'T').collect();
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let y: i64 = digits[0..4].parse().ok()?;
    let m: u32 = digits[4..6].parse().ok()?;
    let d: u32 = digits[6..8].parse().ok()?;
    let has_time = v.contains('T') && digits.len() >= 12;
    let (time, hhmm) = if has_time {
        (format!("{}:{}", &digits[8..10], &digits[10..12]), digits[8..12].parse().unwrap_or(0))
    } else {
        (String::new(), 0)
    };
    Some(DtParts { days: days_from_civil(y, m, d), time, hhmm })
}

/// Build a CalEvent for a single occurrence on `day`.
fn make_event(day: i64, s: &DtParts, title: &str, location: &str, end: &str, cal: &str) -> CalEvent {
    let (y, m, d) = civil_from_days(day);
    CalEvent {
        calendar: cal.to_string(),
        summary: title.to_string(),
        date: format!("{y:04}-{m:02}-{d:02}"),
        time: s.time.clone(),
        end: end.to_string(),
        location: location.to_string(),
        sort_key: (y as u64) * 100_000_000 + (m as u64) * 1_000_000 + (d as u64) * 10_000 + s.hhmm,
    }
}

/// Expand a (possibly recurring) event into its in-window occurrences.
#[allow(clippy::too_many_arguments)]
fn emit_occurrences(
    title: &str,
    location: &str,
    end: &str,
    s: &DtParts,
    rrule: &str,
    exdates: &[i64],
    cal: &str,
    lo: i64,
    hi: i64,
    out: &mut Vec<CalEvent>,
) {
    let push = |day: i64, out: &mut Vec<CalEvent>| {
        if day >= lo && day <= hi && !exdates.contains(&day) {
            out.push(make_event(day, s, title, location, end, cal));
        }
    };
    if rrule.is_empty() {
        push(s.days, out);
        return;
    }
    // Parse the rule.
    let mut freq = "";
    let mut interval: i64 = 1;
    let mut count: Option<usize> = None;
    let mut until: Option<i64> = None;
    let mut bydays: Vec<i64> = Vec::new();
    for part in rrule.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => freq = match v.to_ascii_uppercase().as_str() {
                "DAILY" => "DAILY",
                "WEEKLY" => "WEEKLY",
                "MONTHLY" => "MONTHLY",
                "YEARLY" => "YEARLY",
                _ => "",
            },
            "INTERVAL" => interval = v.parse().unwrap_or(1).max(1),
            "COUNT" => count = v.parse().ok(),
            "UNTIL" => until = parse_dt(v).map(|p| p.days),
            "BYDAY" => bydays = v.split(',').filter_map(parse_weekday).collect(),
            _ => {}
        }
    }
    let until = until.unwrap_or(hi).min(hi);
    let mut emitted = 0usize;
    let mut cap = MAX_OCCURRENCES;
    let mut bump = |day: i64, out: &mut Vec<CalEvent>| -> bool {
        // Returns false to stop (COUNT reached). Counts every real occurrence from
        // the series start, but only pushes those inside the window.
        if count.is_some_and(|c| emitted >= c) {
            return false;
        }
        emitted += 1;
        push(day, out);
        true
    };

    // Without a COUNT we don't need to track occurrences from the series start, so
    // fast-forward to near the window — otherwise a daily-since-2020 rule would burn
    // the occurrence cap before ever reaching today.
    let ff = count.is_none();
    match freq {
        "DAILY" => {
            let mut day = s.days;
            if ff && day < lo {
                day += ((lo - day + interval - 1) / interval) * interval;
            }
            while day <= until && cap > 0 {
                if !bump(day, out) {
                    break;
                }
                day += interval;
                cap -= 1;
            }
        }
        "WEEKLY" => {
            let week_days: Vec<i64> = if bydays.is_empty() { vec![weekday(s.days)] } else { bydays.clone() };
            let mut week_start = s.days - weekday(s.days); // Sunday of the start week
            if ff && week_start < lo - 7 {
                week_start += ((lo - 7 - week_start) / (7 * interval)) * 7 * interval;
            }
            'weeks: while week_start <= until && cap > 0 {
                for &wd in &week_days {
                    let day = week_start + wd;
                    if day < s.days {
                        continue; // earlier in the first week, before DTSTART
                    }
                    if day > until {
                        continue;
                    }
                    if !bump(day, out) {
                        break 'weeks;
                    }
                    cap -= 1;
                    if cap == 0 {
                        break 'weeks;
                    }
                }
                week_start += 7 * interval;
            }
        }
        "MONTHLY" => {
            let (y, m, d) = civil_from_days(s.days);
            let mut i: i64 = 0;
            if ff {
                let (ly, lm, _) = civil_from_days(lo);
                let start_month = y * 12 + (m as i64 - 1);
                let lo_month = ly * 12 + (lm as i64 - 1);
                if lo_month > start_month {
                    i = (lo_month - start_month) / interval;
                }
            }
            loop {
                let total = (y * 12 + (m as i64 - 1)) + i * interval;
                let (yy, mm) = (total.div_euclid(12), (total.rem_euclid(12) + 1) as u32);
                let dd = d.min(days_in_month(yy, mm));
                let day = days_from_civil(yy, mm, dd);
                if day > until || cap == 0 {
                    break;
                }
                if !bump(day, out) {
                    break;
                }
                i += 1;
                cap -= 1;
            }
        }
        "YEARLY" => {
            let (y, m, d) = civil_from_days(s.days);
            for i in 0..MAX_OCCURRENCES as i64 {
                let day = days_from_civil(y + i * interval, m, d.min(days_in_month(y + i * interval, m)));
                if day > until {
                    break;
                }
                if !bump(day, out) {
                    break;
                }
            }
        }
        _ => push(s.days, out), // unknown FREQ → at least the first instance
    }
}

/// ICS BYDAY token (SU,MO,…; an optional ±N prefix is ignored) → weekday 0=Sun..6=Sat.
fn parse_weekday(tok: &str) -> Option<i64> {
    let day = tok.trim().trim_start_matches(|c: char| c == '+' || c == '-' || c.is_ascii_digit());
    Some(match day.to_ascii_uppercase().as_str() {
        "SU" => 0, "MO" => 1, "TU" => 2, "WE" => 3, "TH" => 4, "FR" => 5, "SA" => 6,
        _ => return None,
    })
}

/// Weekday of an epoch-day index, 0=Sunday..6=Saturday.
fn weekday(days: i64) -> i64 {
    (days.rem_euclid(7) + 4).rem_euclid(7)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap(y) { 29 } else { 28 },
        _ => 30,
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (if m > 2 { m - 3 } else { m + 9 }) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of `days_from_civil` → (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Today as an epoch-day index (UTC — good enough for an at-a-glance calendar).
fn today_epoch_days() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
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

    fn day(y: i64, m: u32, d: u32) -> i64 {
        days_from_civil(y, m, d)
    }

    #[test]
    fn parses_timed_and_all_day() {
        let ev = parse_events_at(ICS, "Work", day(2026, 6, 15));
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
        let folded = "BEGIN:VEVENT\r\nSUMMARY:Long title that\r\n wraps\r\nDTSTART:20260101\r\nEND:VEVENT";
        let ev = parse_events_at(folded, "C", day(2026, 1, 1));
        assert_eq!(ev[0].summary, "Long title thatwraps");
    }

    #[test]
    fn civil_date_roundtrips() {
        assert_eq!(civil_from_days(days_from_civil(2026, 6, 25)), (2026, 6, 25));
        assert_eq!(weekday(days_from_civil(1970, 1, 1)), 4); // 1970-01-01 was a Thursday
        assert_eq!(days_in_month(2024, 2), 29); // leap
        assert_eq!(days_in_month(2026, 2), 28);
    }

    #[test]
    fn expands_daily_rrule_count() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Standup\r\nDTSTART:20260610T090000\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT";
        let ev = parse_events_at(ics, "W", day(2026, 6, 10));
        assert_eq!(ev.len(), 5);
        assert_eq!(ev[0].date, "2026-06-10");
        assert_eq!(ev[4].date, "2026-06-14");
        assert!(ev.iter().all(|e| e.time == "09:00" && e.summary == "Standup"));
    }

    #[test]
    fn expands_weekly_byday_and_honours_exdate() {
        // Mon+Wed weekly from 2026-06-01, with one Wednesday excluded.
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Class\r\nDTSTART:20260601T140000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE:20260603T140000\r\nEND:VEVENT";
        let ev = parse_events_at(ics, "W", day(2026, 6, 1));
        assert_eq!(ev.len(), 5); // 6 occurrences minus the excluded Wed
        assert!(ev.iter().all(|e| e.summary == "Class" && e.date != "2026-06-03"));
    }

    #[test]
    fn windows_infinite_recurrence_to_upcoming_only() {
        // Daily since 2020, forever — viewed in 2026 we get the window, not 6 years.
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Daily\r\nDTSTART:20200101T080000\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT";
        let ev = parse_events_at(ics, "D", day(2026, 6, 15));
        assert!(ev.len() > 150 && ev.len() < 220, "got {}", ev.len()); // ~195-day window
        assert!(ev.iter().all(|e| e.date.as_str() >= "2026-06-01")); // nothing from 2020
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
