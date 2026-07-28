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
    /// Local-event id (`0` for read-only ICS events). Editable rows carry their
    /// `LocalEventStore` id so the UI/agent can move/edit/delete them.
    pub id: u64,
    /// True for Flux-local events (add/edit/delete/drag); false for ICS feeds.
    pub editable: bool,
    /// Free-text notes (local events only; "" for ICS).
    pub notes: String,
    /// The series' RRULE for a local recurring event ("" otherwise) — so the
    /// editor can pre-fill the repeat control. ICS occurrences leave this ""
    /// (they're read-only).
    #[serde(default)]
    pub rrule: String,
}

/// A Flux-local calendar event (on-device, fully editable). Distinct from a
/// read-only ICS `CalEvent` — these are what the grid editor and Gemma write to.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct LocalEvent {
    pub id: u64,
    pub title: String,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// `HH:MM` start, or "" for an all-day event.
    pub start: String,
    /// `HH:MM` end, or "".
    pub end: String,
    pub location: String,
    pub notes: String,
    /// iCalendar RRULE (e.g. `FREQ=WEEKLY`), or "" for a one-off event. Same
    /// grammar the ICS path already expands (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY
    /// with INTERVAL/COUNT/UNTIL/BYDAY). `#[serde(default)]` so events saved
    /// before recurrence existed load as one-off.
    #[serde(default)]
    pub rrule: String,
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
        Self {
            feeds: RwLock::new(feeds),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<CalFeed> {
        self.feeds.read().clone()
    }

    pub fn add(&self, url: String, name: String) -> CalFeed {
        if let Some(f) = self.feeds.read().iter().find(|f| f.url == url) {
            return f.clone();
        }
        let feed = CalFeed {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            url,
            name,
        };
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
        crate::persist::save_json(path, &*self.feeds.read());
    }
}

/// On-device store of Flux-local calendar events (add/edit/delete/drag, and the
/// surface Gemma writes to). Persisted as JSON; same shape as `TodoStore`.
#[derive(Default)]
pub struct LocalEventStore {
    items: RwLock<Vec<LocalEvent>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl LocalEventStore {
    pub fn restore(path: PathBuf) -> Self {
        let items: Vec<LocalEvent> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = items.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        Self {
            items: RwLock::new(items),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<LocalEvent> {
        self.items.read().clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &self,
        title: String,
        date: String,
        start: String,
        end: String,
        location: String,
        notes: String,
        rrule: String,
    ) -> LocalEvent {
        let ev = LocalEvent {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            title,
            date,
            start,
            end,
            location,
            notes,
            rrule,
        };
        self.items.write().push(ev.clone());
        self.save();
        ev
    }

    /// Overwrite only the fields that are `Some` (so a drag can move just date/time).
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        id: u64,
        title: Option<String>,
        date: Option<String>,
        start: Option<String>,
        end: Option<String>,
        location: Option<String>,
        notes: Option<String>,
        rrule: Option<String>,
    ) -> Option<LocalEvent> {
        let out = {
            let mut items = self.items.write();
            let e = items.iter_mut().find(|e| e.id == id)?;
            if let Some(v) = title {
                e.title = v;
            }
            if let Some(v) = date {
                e.date = v;
            }
            if let Some(v) = start {
                e.start = v;
            }
            if let Some(v) = end {
                e.end = v;
            }
            if let Some(v) = location {
                e.location = v;
            }
            if let Some(v) = notes {
                e.notes = v;
            }
            if let Some(v) = rrule {
                e.rrule = v;
            }
            e.clone()
        };
        self.save();
        Some(out)
    }

    pub fn remove(&self, id: u64) {
        self.items.write().retain(|e| e.id != id);
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        crate::persist::save_json(path, &*self.items.read());
    }
}

fn fetch_ics(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("webcal://"))
    {
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
    resp.into_reader()
        .take(MAX_ICS_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("empty response".into());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .trim_start_matches("www.")
        .to_string()
}

// ─── iCalendar parsing ───────────────────────────────────────────────────────

/// Unfold RFC 5545 folded lines: a CRLF (or LF) followed by a space/tab is a
/// continuation of the previous line.
fn unfold(ics: &str) -> String {
    ics.replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace("\n ", "")
        .replace("\n\t", "")
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
    let lo = today - WINDOW_BACK_DAYS;
    let hi = today + WINDOW_FWD_DAYS;
    let mut out = Vec::new();
    for_each_vevent(ics, |v| {
        let Vevent {
            title,
            location,
            end_time,
            start,
            rrule,
            exdates,
        } = v;
        emit_occurrences(
            &title, &location, &end_time, &start, &rrule, &exdates, cal_name, lo, hi, &mut out,
        );
    });
    out
}

/// One VEVENT as written in the file — *not* expanded into occurrences. This is
/// the form a recurring event has to be read in to be copied faithfully: one
/// series carrying its RRULE, rather than N separate dated copies.
struct Vevent {
    title: String,
    location: String,
    end_time: String,
    start: DtParts,
    rrule: String,
    exdates: Vec<i64>,
}

/// Scan an ICS document and hand each complete VEVENT to `f`. Shared by the
/// occurrence expander (the calendar grid) and the importer (feed → editable
/// local events), so both read exactly the same fields the same way.
fn for_each_vevent(ics: &str, mut f: impl FnMut(Vevent)) {
    let unfolded = unfold(ics);

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
                f(Vevent {
                    title: if summary.is_empty() {
                        "(untitled)".into()
                    } else {
                        summary.clone()
                    },
                    location: location.clone(),
                    end_time: end_time.clone(),
                    start: s,
                    rrule: rrule.clone(),
                    exdates: exdates.clone(),
                });
            }
            in_event = false;
            continue;
        }
        if !in_event {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
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
}

/// Turn a subscribed feed's ICS into **editable local events** — one per VEVENT,
/// keeping its RRULE so a weekly lecture stays a single recurring series rather
/// than dozens of unlinked copies.
///
/// This is a **copy, not a link**: the source calendar's later edits won't follow.
/// EXDATEs are dropped (LocalEvent has no exception list), so a cancelled
/// occurrence of a recurring series reappears — worth knowing before importing a
/// calendar full of exceptions.
fn ics_to_local_events(ics: &str) -> Vec<LocalEvent> {
    let mut out = Vec::new();
    for_each_vevent(ics, |v| {
        let (y, m, d) = civil_from_days(v.start.days);
        out.push(LocalEvent {
            id: 0, // assigned by the store on insert
            title: v.title,
            date: format!("{y:04}-{m:02}-{d:02}"),
            start: v.start.time,
            end: v.end_time,
            location: v.location,
            notes: String::new(),
            rrule: v.rrule,
        });
    });
    out
}

/// A parsed DTSTART: calendar date pieces + the time-of-day + epoch-day index.
#[derive(Clone)]
struct DtParts {
    days: i64,    // days since 1970-01-01
    time: String, // "HH:MM" or "" (all-day)
    hhmm: u64,    // HHMM as a number for the sort key (0 for all-day)
}

/// `DTSTART`/`EXDATE` value → DtParts. Handles `20260619`, `20260619T100000Z`,
/// `20260619T100000`. `None` if it isn't a date.
fn parse_dt(value: &str) -> Option<DtParts> {
    let v: String = value
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == 'T')
        .collect();
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let y: i64 = digits[0..4].parse().ok()?;
    let m: u32 = digits[4..6].parse().ok()?;
    let d: u32 = digits[6..8].parse().ok()?;
    let has_time = v.contains('T') && digits.len() >= 12;
    let (time, hhmm) = if has_time {
        (
            format!("{}:{}", &digits[8..10], &digits[10..12]),
            digits[8..12].parse().unwrap_or(0),
        )
    } else {
        (String::new(), 0)
    };
    Some(DtParts {
        days: days_from_civil(y, m, d),
        time,
        hhmm,
    })
}

/// Build a CalEvent for a single occurrence on `day`.
fn make_event(
    day: i64,
    s: &DtParts,
    title: &str,
    location: &str,
    end: &str,
    cal: &str,
) -> CalEvent {
    let (y, m, d) = civil_from_days(day);
    CalEvent {
        calendar: cal.to_string(),
        summary: title.to_string(),
        date: format!("{y:04}-{m:02}-{d:02}"),
        time: s.time.clone(),
        end: end.to_string(),
        location: location.to_string(),
        sort_key: (y as u64) * 100_000_000 + (m as u64) * 1_000_000 + (d as u64) * 10_000 + s.hhmm,
        id: 0,
        editable: false,
        notes: String::new(),
        rrule: String::new(),
    }
}

/// `YYYY-MM-DD` + `HH:MM` → the same `YYYYMMDDHHMM` sort key `make_event` produces.
fn sort_key_of(date: &str, time: &str) -> u64 {
    let d: u64 = date
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    let t: String = time.chars().filter(|c| c.is_ascii_digit()).collect();
    let hhmm: u64 = if t.len() >= 4 {
        t[..4].parse().unwrap_or(0)
    } else {
        0
    };
    d * 10_000 + hhmm
}

/// A Flux-local event rendered as a (editable) `CalEvent` for the unified grid.
fn local_to_cal(e: &LocalEvent) -> CalEvent {
    CalEvent {
        calendar: "Flux".to_string(),
        summary: e.title.clone(),
        date: e.date.clone(),
        time: e.start.clone(),
        end: e.end.clone(),
        location: e.location.clone(),
        sort_key: sort_key_of(&e.date, &e.start),
        id: e.id,
        editable: true,
        notes: e.notes.clone(),
        rrule: e.rrule.clone(),
    }
}

/// `DtParts` for a local event's `YYYY-MM-DD` date + `HH:MM` start (or "").
fn local_dtparts(date: &str, start: &str) -> Option<DtParts> {
    let digits: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let y: i64 = digits[0..4].parse().ok()?;
    let m: u32 = digits[4..6].parse().ok()?;
    let d: u32 = digits[6..8].parse().ok()?;
    let t: String = start.chars().filter(|c| c.is_ascii_digit()).collect();
    let hhmm: u64 = if t.len() >= 4 {
        t[..4].parse().unwrap_or(0)
    } else {
        0
    };
    Some(DtParts {
        days: days_from_civil(y, m, d),
        time: start.to_string(),
        hhmm,
    })
}

/// Expand a local event into the grid's occurrences. A one-off event (no rrule)
/// is emitted as-is regardless of the window — local events shouldn't vanish
/// just because they're far out. A recurring one reuses the same `emit_occurrences`
/// engine as ICS feeds, then re-stamps each occurrence with the local event's
/// identity (id/editable/notes) that `make_event` zeroes.
fn expand_local(e: &LocalEvent, lo: i64, hi: i64, out: &mut Vec<CalEvent>) {
    let rrule = e.rrule.trim();
    let dt = local_dtparts(&e.date, &e.start);
    if rrule.is_empty() || dt.is_none() {
        out.push(local_to_cal(e));
        return;
    }
    let start = out.len();
    emit_occurrences(
        &e.title,
        &e.location,
        &e.end,
        &dt.unwrap(),
        rrule,
        &[],
        "Flux",
        lo,
        hi,
        out,
    );
    if out.len() == start {
        // The series produced nothing in-window (e.g. it has already ended);
        // still show the base event so it's editable, matching the one-off path.
        out.push(local_to_cal(e));
        return;
    }
    for ev in out[start..].iter_mut() {
        ev.id = e.id;
        ev.editable = true;
        ev.notes = e.notes.clone();
        ev.rrule = e.rrule.clone();
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
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = match v.to_ascii_uppercase().as_str() {
                    "DAILY" => "DAILY",
                    "WEEKLY" => "WEEKLY",
                    "MONTHLY" => "MONTHLY",
                    "YEARLY" => "YEARLY",
                    _ => "",
                }
            }
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
            let week_days: Vec<i64> = if bydays.is_empty() {
                vec![weekday(s.days)]
            } else {
                bydays.clone()
            };
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
                let day = days_from_civil(
                    y + i * interval,
                    m,
                    d.min(days_in_month(y + i * interval, m)),
                );
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
    let day = tok
        .trim()
        .trim_start_matches(|c: char| c == '+' || c == '-' || c.is_ascii_digit());
    Some(match day.to_ascii_uppercase().as_str() {
        "SU" => 0,
        "MO" => 1,
        "TU" => 2,
        "WE" => 3,
        "TH" => 4,
        "FR" => 5,
        "SA" => 6,
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
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
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
    s.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cal_list(store: State<'_, CalStore>) -> Vec<CalFeed> {
    store.list()
}

#[tauri::command]
pub async fn cal_add(
    store: State<'_, CalStore>,
    url: String,
    name: Option<String>,
) -> Result<CalFeed, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".into());
    }
    if let Some(f) = store.list().into_iter().find(|f| f.url == url) {
        return Ok(f);
    }
    // Validate it parses as a calendar before subscribing.
    let probe = url.clone();
    let ics = tauri::async_runtime::spawn_blocking(move || fetch_ics(&probe))
        .await
        .map_err(|e| e.to_string())??;
    if !ics.contains("VCALENDAR") && !ics.contains("VEVENT") {
        return Err("that URL isn't an iCalendar (.ics) feed".into());
    }
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| host_of(&url));
    Ok(store.add(url, name))
}

#[tauri::command]
pub fn cal_remove(store: State<'_, CalStore>, id: u64) {
    store.remove(id);
}

/// Copy a subscribed feed's events into Flux's own **editable** events, so they
/// can be moved, retitled and deleted (a subscribed ICS is read-only by nature —
/// it's re-fetched from the source every time).
///
/// Recurring events import as **one series with its RRULE**, not as dozens of
/// dated copies. Re-running is safe: an event matching an existing local one on
/// title + date + start time is skipped, so a second import adds only what's new.
/// Returns `(imported, skipped_as_duplicates)`.
///
/// This is a copy, not a live link — later changes in the source calendar do not
/// follow. Removing the subscription afterwards (`cal_remove`) is what stops the
/// same events appearing twice.
#[tauri::command]
pub async fn cal_import_feed(
    store: State<'_, CalStore>,
    local: State<'_, LocalEventStore>,
    id: u64,
) -> Result<(u32, u32), String> {
    let feed = store
        .list()
        .into_iter()
        .find(|f| f.id == id)
        .ok_or("no such calendar")?;
    let url = feed.url.clone();
    let ics = tauri::async_runtime::spawn_blocking(move || fetch_ics(&url))
        .await
        .map_err(|e| e.to_string())??;
    let candidates = ics_to_local_events(&ics);
    if candidates.is_empty() {
        return Err("no events found in that calendar".into());
    }
    // Dedupe against what's already local, so importing twice doesn't double up.
    let existing: std::collections::HashSet<(String, String, String)> = local
        .list()
        .into_iter()
        .map(|e| (e.title, e.date, e.start))
        .collect();
    let (mut imported, mut skipped) = (0u32, 0u32);
    for ev in candidates {
        if existing.contains(&(ev.title.clone(), ev.date.clone(), ev.start.clone())) {
            skipped += 1;
            continue;
        }
        let LocalEvent {
            title,
            date,
            start,
            end,
            location,
            notes,
            rrule,
            ..
        } = ev;
        local.add(title, date, start, end, location, notes, rrule);
        imported += 1;
    }
    Ok((imported, skipped))
}

/// Fetch + parse every subscribed calendar; returns events sorted by date. A
/// failing feed is skipped (one dead URL doesn't blank the widget).
#[tauri::command]
pub async fn cal_events(
    store: State<'_, CalStore>,
    local: State<'_, LocalEventStore>,
) -> Result<Vec<CalEvent>, String> {
    let feeds = store.list();
    let locals = local.list();
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = Vec::new();
        for f in &feeds {
            if let Ok(ics) = fetch_ics(&f.url) {
                all.extend(parse_events(&ics, &f.name));
            }
        }
        // Cap the (potentially huge) ICS set first, then always keep local events
        // (expanding any recurring ones over the same window as the ICS feeds).
        all.sort_by_key(|e| e.sort_key);
        all.truncate(MAX_EVENTS);
        let today = today_epoch_days();
        let (lo, hi) = (today - WINDOW_BACK_DAYS, today + WINDOW_FWD_DAYS);
        for e in &locals {
            expand_local(e, lo, hi, &mut all);
        }
        all.sort_by_key(|e| e.sort_key);
        Ok(all)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List the Flux-local events (without the ICS overlay) — for the agent.
#[tauri::command]
pub fn cal_local_events(local: State<'_, LocalEventStore>) -> Vec<LocalEvent> {
    local.list()
}

/// Sanitize an RRULE from the UI/agent: trim, drop a leading `RRULE:`, upcase,
/// and accept only rules carrying a FREQ we can actually expand — anything else
/// collapses to "" (a one-off) so a typo can't create a silently-dead series.
fn normalize_rrule(rrule: Option<&str>) -> String {
    let raw = rrule.unwrap_or("").trim();
    let raw = raw.strip_prefix("RRULE:").unwrap_or(raw).trim();
    if raw.is_empty() {
        return String::new();
    }
    let up = raw.to_ascii_uppercase();
    let has_freq = up.split(';').any(|p| {
        matches!(
            p.trim(),
            "FREQ=DAILY" | "FREQ=WEEKLY" | "FREQ=MONTHLY" | "FREQ=YEARLY"
        )
    });
    if has_freq {
        up
    } else {
        String::new()
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn cal_event_add(
    local: State<'_, LocalEventStore>,
    title: String,
    date: String,
    start: Option<String>,
    end: Option<String>,
    location: Option<String>,
    notes: Option<String>,
    rrule: Option<String>,
) -> Result<LocalEvent, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("event needs a title".into());
    }
    if date.len() != 10 || date.as_bytes()[4] != b'-' {
        return Err("date must be YYYY-MM-DD".into());
    }
    Ok(local.add(
        title,
        date,
        start.unwrap_or_default(),
        end.unwrap_or_default(),
        location.unwrap_or_default(),
        notes.unwrap_or_default(),
        normalize_rrule(rrule.as_deref()),
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn cal_event_update(
    local: State<'_, LocalEventStore>,
    id: u64,
    title: Option<String>,
    date: Option<String>,
    start: Option<String>,
    end: Option<String>,
    location: Option<String>,
    notes: Option<String>,
    rrule: Option<String>,
) -> Result<LocalEvent, String> {
    // `None` leaves recurrence untouched; `Some` (incl. "" to clear) sets it.
    let rrule = rrule.map(|r| normalize_rrule(Some(&r)));
    local
        .update(id, title, date, start, end, location, notes, rrule)
        .ok_or_else(|| "no such event".to_string())
}

#[tauri::command]
pub fn cal_event_delete(local: State<'_, LocalEventStore>, id: u64) {
    local.remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICS: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Team sync\r\nDTSTART:20260619T100000Z\r\nLOCATION:Room 4\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:All day off\r\nDTSTART;VALUE=DATE:20260620\r\nEND:VEVENT\r\nEND:VCALENDAR";

    fn day(y: i64, m: u32, d: u32) -> i64 {
        days_from_civil(y, m, d)
    }

    #[test]
    fn import_keeps_recurrence_as_one_series_not_many_copies() {
        // A weekly lecture + a one-off. The grid expands the weekly one into
        // dozens of occurrences; the importer must NOT — it should stay a single
        // editable series carrying its RRULE.
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\nSUMMARY:Optimization lecture\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T110000Z\r\n\
LOCATION:Hall A\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nSUMMARY:Careers fair\r\nDTSTART;VALUE=DATE:20260310\r\nEND:VEVENT\r\n\
END:VCALENDAR";
        let evs = ics_to_local_events(ics);
        assert_eq!(evs.len(), 2, "one event per VEVENT");

        let lecture = evs.iter().find(|e| e.title.starts_with("Optim")).unwrap();
        assert_eq!(lecture.date, "2026-03-02");
        assert_eq!(lecture.start, "09:00");
        assert_eq!(lecture.end, "11:00");
        assert_eq!(lecture.location, "Hall A");
        assert_eq!(lecture.rrule, "FREQ=WEEKLY;BYDAY=MO;COUNT=12");

        // All-day events keep an empty time, the shape LocalEvent uses for them.
        let fair = evs.iter().find(|e| e.title == "Careers fair").unwrap();
        assert_eq!(fair.date, "2026-03-10");
        assert!(fair.start.is_empty() && fair.rrule.is_empty());

        // And the imported series still expands the same way the feed did, so the
        // grid shows the same 12 Mondays after conversion.
        let store = LocalEventStore::default();
        let saved = store.add(
            lecture.title.clone(),
            lecture.date.clone(),
            lecture.start.clone(),
            lecture.end.clone(),
            lecture.location.clone(),
            String::new(),
            lecture.rrule.clone(),
        );
        let mut out = Vec::new();
        expand_local(&saved, day(2026, 3, 1), day(2026, 6, 1), &mut out);
        assert_eq!(out.len(), 12, "recurrence survives the round-trip");
        assert!(out.iter().all(|e| e.editable), "must be editable");
    }

    #[test]
    fn local_store_crud_and_partial_update() {
        let store = LocalEventStore::default(); // no path → in-memory
        let e = store.add(
            "Dentist".into(),
            "2026-06-26".into(),
            "09:00".into(),
            "09:30".into(),
            "Clinic".into(),
            "".into(),
            String::new(),
        );
        assert_eq!(store.list().len(), 1);
        // A drag = move date+time only; other fields untouched.
        let moved = store
            .update(
                e.id,
                None,
                Some("2026-06-27".into()),
                Some("10:00".into()),
                Some("10:30".into()),
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(moved.title, "Dentist");
        assert_eq!(moved.date, "2026-06-27");
        assert_eq!(moved.start, "10:00");
        assert_eq!(moved.location, "Clinic"); // preserved
        store.remove(e.id);
        assert!(store.list().is_empty());
    }

    #[test]
    fn local_event_sort_key_matches_ics() {
        // A 10:00 local event must sort exactly like the equivalent ICS occurrence.
        let cal = local_to_cal(&LocalEvent {
            id: 7,
            title: "Sync".into(),
            date: "2026-06-19".into(),
            start: "10:00".into(),
            end: "11:00".into(),
            location: String::new(),
            notes: String::new(),
            rrule: String::new(),
        });
        assert_eq!(cal.sort_key, 202606191000);
        assert!(cal.editable);
        assert_eq!(cal.id, 7);
    }

    #[test]
    fn recurring_local_event_expands_and_keeps_identity() {
        let store = LocalEventStore::default();
        let e = store.add(
            "Standup".into(),
            "2026-06-01".into(),
            "09:00".into(),
            "09:15".into(),
            String::new(),
            "daily".into(),
            "FREQ=WEEKLY;BYDAY=MO".into(),
        );
        // Expand over a 5-week window starting mid-series.
        let (lo, hi) = (day(2026, 6, 15), day(2026, 7, 13));
        let mut out = Vec::new();
        expand_local(&store.list()[0], lo, hi, &mut out);
        // Mondays 6/15, 6/22, 6/29, 7/6, 7/13 → 5 occurrences, all editable + same id.
        assert_eq!(out.len(), 5, "weekly Mondays in window");
        assert!(out
            .iter()
            .all(|c| c.editable && c.id == e.id && c.notes == "daily"));
        assert_eq!(out[0].date, "2026-06-15");
        assert_eq!(out[0].time, "09:00");
        assert_eq!(out[4].date, "2026-07-13");
        assert!(out.windows(2).all(|w| w[0].sort_key < w[1].sort_key));
    }

    #[test]
    fn one_off_local_event_shows_outside_window() {
        // A non-recurring local event must appear even far past the ICS window,
        // unchanged from the pre-recurrence behavior.
        let e = LocalEvent {
            id: 3,
            title: "Wedding".into(),
            date: "2027-09-01".into(),
            start: "14:00".into(),
            end: String::new(),
            location: String::new(),
            notes: String::new(),
            rrule: String::new(),
        };
        let (lo, hi) = (day(2026, 6, 1), day(2026, 12, 1));
        let mut out = Vec::new();
        expand_local(&e, lo, hi, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].date, "2027-09-01");
    }

    #[test]
    fn normalize_rrule_accepts_known_freqs_only() {
        assert_eq!(normalize_rrule(Some("FREQ=WEEKLY")), "FREQ=WEEKLY");
        assert_eq!(
            normalize_rrule(Some("freq=daily;interval=2")),
            "FREQ=DAILY;INTERVAL=2"
        );
        assert_eq!(normalize_rrule(Some("RRULE:FREQ=MONTHLY")), "FREQ=MONTHLY"); // prefix stripped
        assert_eq!(normalize_rrule(Some("")), "");
        assert_eq!(normalize_rrule(None), "");
        assert_eq!(normalize_rrule(Some("FREQ=HOURLY")), ""); // unsupported → one-off
        assert_eq!(normalize_rrule(Some("garbage")), "");
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
        let folded =
            "BEGIN:VEVENT\r\nSUMMARY:Long title that\r\n wraps\r\nDTSTART:20260101\r\nEND:VEVENT";
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
        assert!(ev
            .iter()
            .all(|e| e.time == "09:00" && e.summary == "Standup"));
    }

    #[test]
    fn expands_weekly_byday_and_honours_exdate() {
        // Mon+Wed weekly from 2026-06-01, with one Wednesday excluded.
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Class\r\nDTSTART:20260601T140000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE:20260603T140000\r\nEND:VEVENT";
        let ev = parse_events_at(ics, "W", day(2026, 6, 1));
        assert_eq!(ev.len(), 5); // 6 occurrences minus the excluded Wed
        assert!(ev
            .iter()
            .all(|e| e.summary == "Class" && e.date != "2026-06-03"));
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
