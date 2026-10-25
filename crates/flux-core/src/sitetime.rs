//! Time per site (Flux Next "time and focus"): where the time on the web goes,
//! counted only while Flux's window is in front, by hour, and kept on this Mac.
//!
//! Every [`TICK_SECS`] the active tab's site gets the time, when Flux has the
//! focus, the tab is a web page, and it isn't private. Hours are stored as
//! absolute hours since the epoch; a report takes the shell's offset from UTC
//! (as the calendar does), so "today" and "yesterday" follow local midnight.
//! Two weeks are kept. The same ticker ends a focus session that has run out
//! (`focus.rs`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const TICK_SECS: u64 = 10;
/// Hours kept: two weeks, plus the week before for "this week vs last".
const KEEP_HOURS: u64 = 15 * 24;
/// A change smaller than this reads "About the same".
pub const SAME_SECS: u64 = 5 * 60;

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Where local midnight was, before `now`, in UTC seconds; `off_min` is
/// minutes east of UTC (`-new Date().getTimezoneOffset()`).
pub fn day_start(now: u64, off_min: i32) -> u64 {
    let off = i64::from(off_min.clamp(-14 * 60, 14 * 60)) * 60;
    let local = now as i64 + off;
    (local.div_euclid(86_400) * 86_400 - off).max(0) as u64
}

/// A count per hour (Shields' blocks), for "today" by local midnight.
#[derive(Default)]
pub struct HourTally {
    hours: Mutex<BTreeMap<u64, u64>>,
}

impl HourTally {
    pub fn add(&self, now: u64) {
        let mut h = self.hours.lock();
        *h.entry(now / 3600).or_default() += 1;
        // Two days is all a "today" needs.
        let keep = (now / 3600).saturating_sub(48);
        if h.first_key_value().is_some_and(|(k, _)| *k < keep) {
            h.retain(|k, _| *k >= keep);
        }
    }

    pub fn between(&self, from: u64, to: u64) -> u64 {
        self.hours
            .lock()
            .range(from / 3600..to.div_ceil(3600))
            .map(|(_, n)| n)
            .sum()
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    /// Hour since the epoch → site → seconds.
    hours: BTreeMap<u64, BTreeMap<String, u32>>,
}

pub struct SiteTime {
    data: Mutex<Stored>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
}

/// One bar of the chart: an hour today, or a day of the week.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct TimeBar {
    pub label: String,
    pub secs: u32,
}

/// A site's time in the period, and in the one before it.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct SiteTimeRow {
    pub host: String,
    pub secs: u32,
    pub prev_secs: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct TimeReport {
    pub total_secs: u32,
    pub bars: Vec<TimeBar>,
    /// The busiest sites, most first.
    pub sites: Vec<SiteTimeRow>,
    /// The rest, together.
    pub other_count: u32,
    pub other_secs: u32,
}

/// Sites shown by name; the rest are "N other sites".
const TOP: usize = 6;

impl SiteTime {
    pub fn load(path: Option<PathBuf>) -> Self {
        let data = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            path,
            dirty: AtomicBool::new(false),
        }
    }

    pub fn add(&self, now: u64, host: &str, secs: u32) {
        let hour = now / 3600;
        let mut d = self.data.lock();
        *d.hours
            .entry(hour)
            .or_default()
            .entry(host.to_string())
            .or_default() += secs;
        let keep = hour.saturating_sub(KEEP_HOURS);
        if d.hours.first_key_value().is_some_and(|(k, _)| *k < keep) {
            d.hours.retain(|k, _| *k >= keep);
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn save_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        if let Some(path) = &self.path {
            crate::persist::queue_json(
                path,
                &*self.data.lock(),
                crate::persist::Durability::Barrier,
            );
        }
    }

    pub fn forget(&self) {
        self.data.lock().hours.clear();
        self.dirty.store(true, Ordering::Relaxed);
        self.save_if_dirty();
    }

    /// Seconds per site in `[from, to)`.
    fn sites_between(&self, from: u64, to: u64) -> BTreeMap<String, u32> {
        let mut out = BTreeMap::new();
        for (_, sites) in self.data.lock().hours.range(from / 3600..to.div_ceil(3600)) {
            for (h, s) in sites {
                *out.entry(h.clone()).or_default() += s;
            }
        }
        out
    }

    fn secs_between(&self, from: u64, to: u64) -> u32 {
        self.sites_between(from, to).values().sum()
    }

    /// Today by hour against yesterday, or this week by day against last week.
    pub fn report(&self, week: bool, now: u64, off_min: i32) -> TimeReport {
        let today = day_start(now, off_min);
        let (from, to, len) = if week {
            (today - 6 * 86_400, today + 86_400, 7 * 86_400)
        } else {
            (today, today + 86_400, 86_400)
        };
        let bars = if week {
            (0..7)
                .map(|i| {
                    let d = from + i * 86_400;
                    TimeBar {
                        label: ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][(((d as i64
                            + i64::from(off_min) * 60)
                            .div_euclid(86_400))
                            % 7)
                            as usize]
                            .to_string(),
                        secs: self.secs_between(d, d + 86_400),
                    }
                })
                .collect()
        } else {
            (0..24)
                .map(|h| TimeBar {
                    label: format!("{h:02}"),
                    secs: self.secs_between(today + h * 3600, today + (h + 1) * 3600),
                })
                .collect()
        };
        let now_sites = self.sites_between(from, to);
        let before = self.sites_between(from - len, from);
        let mut rows: Vec<SiteTimeRow> = now_sites
            .iter()
            .map(|(host, secs)| SiteTimeRow {
                host: host.clone(),
                secs: *secs,
                prev_secs: before.get(host).copied().unwrap_or(0),
            })
            .collect();
        rows.sort_by(|a, b| b.secs.cmp(&a.secs).then_with(|| a.host.cmp(&b.host)));
        let rest = rows.split_off(rows.len().min(TOP));
        TimeReport {
            total_secs: now_sites.values().sum(),
            bars,
            sites: rows,
            other_count: rest.len() as u32,
            other_secs: rest.iter().map(|r| r.secs).sum(),
        }
    }
}

/// The site of a web page, `None` for anything else (Flux's own pages, files).
pub fn site_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?;
    let host = host.strip_prefix("www.").unwrap_or(host).to_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Count the active tab's site, end a focus session that's run out, and save
/// now and then. Runs for the life of the app.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("flux-sitetime".into())
        .spawn(move || {
            let mut n = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(TICK_SECS));
                n += 1;
                if let Some(focus) = app.try_state::<crate::focus::FocusState>() {
                    focus.tick(&app);
                }
                if let Some(st) = app.try_state::<SiteTime>() {
                    if let Some(host) = counted_site(&app) {
                        st.add(now_secs(), &host, TICK_SECS as u32);
                    }
                    if n % 6 == 0 {
                        st.save_if_dirty();
                    }
                }
            }
        })
        .ok();
}

/// The site to count now: the active tab's, when Flux is in front and the tab
/// is a web page that isn't private or closed for a focus session.
fn counted_site(app: &AppHandle) -> Option<String> {
    let win = app.get_window("main")?;
    if !win.is_focused().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return None;
    }
    let state = app.try_state::<crate::state::FluxState>()?;
    let tab = state.tabs.get(&state.active_tab()?)?;
    if tab.private {
        return None;
    }
    // A site under its focus cover isn't being used.
    if app
        .try_state::<crate::focus::FocusState>()
        .is_some_and(|f| f.blocks(&tab.url).is_some())
    {
        return None;
    }
    site_of(&tab.url)
}

/// Today by hour (or this week by day), each site against the period before.
#[tauri::command]
pub fn time_report(store: State<'_, SiteTime>, week: bool, tz_offset_min: i32) -> TimeReport {
    store.report(week, now_secs(), tz_offset_min)
}

/// Forget every hour counted.
#[tauri::command]
pub fn time_forget(store: State<'_, SiteTime>) {
    store.forget();
}

/// The new tab's strip: requests Shields blocked today, focus today against
/// the goal, tasks due today.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct TodayStrip {
    pub blocked: u32,
    pub focused_secs: u32,
    pub goal_minutes: u32,
    pub due: u32,
}

#[tauri::command]
pub fn today_strip(app: AppHandle, tz_offset_min: i32, today: String) -> TodayStrip {
    let now = now_secs();
    let from = day_start(now, tz_offset_min);
    let blocked = app
        .try_state::<crate::shields::ShieldsState>()
        .map(|s| s.blocked_between(from, now + 1))
        .unwrap_or(0);
    let (focused_secs, goal_minutes) = app
        .try_state::<crate::focus::FocusState>()
        .map(|f| f.focused_since(from * 1000))
        .unwrap_or((0, 120));
    let due = app
        .try_state::<crate::todos::TodoStore>()
        .map(|t| {
            t.list()
                .iter()
                .filter(|x| !x.done && x.due == today)
                .count()
        })
        .unwrap_or(0);
    TodayStrip {
        blocked: blocked.min(u32::MAX as u64) as u32,
        focused_secs,
        goal_minutes,
        due: due as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Monday 26 October 2026, 10:30 in Canberra (UTC+11): 23:30 UTC on the 25th.
    const NOW: u64 = 1_792_971_000;
    const AEDT: i32 = 11 * 60;

    #[test]
    fn days_start_at_local_midnight() {
        let start = day_start(NOW, AEDT);
        // 26 Oct 00:00 AEDT is 25 Oct 13:00 UTC.
        assert_eq!(start, NOW - (10 * 3600 + 30 * 60));
        assert_eq!(day_start(NOW, 0), NOW - (23 * 3600 + 30 * 60));
    }

    #[test]
    fn today_against_yesterday() {
        let st = SiteTime::load(None);
        let today = day_start(NOW, AEDT);
        // Today: github at 9 am, youtube at 10.
        st.add(today + 9 * 3600 + 60, "github.com", 3000);
        st.add(today + 10 * 3600 + 60, "youtube.com", 600);
        // Yesterday: github a little less, youtube about the same.
        st.add(today - 3600, "github.com", 1800);
        st.add(today - 7200, "youtube.com", 700);
        let r = st.report(false, NOW, AEDT);
        assert_eq!(r.total_secs, 3600);
        assert_eq!(r.bars.len(), 24);
        assert_eq!(r.bars[9].secs, 3000);
        assert_eq!(r.bars[10].secs, 600);
        assert_eq!(
            r.sites,
            vec![
                SiteTimeRow {
                    host: "github.com".into(),
                    secs: 3000,
                    prev_secs: 1800
                },
                SiteTimeRow {
                    host: "youtube.com".into(),
                    secs: 600,
                    prev_secs: 700
                },
            ]
        );
        assert_eq!(r.other_count, 0);
    }

    #[test]
    fn a_long_tail_is_summed() {
        let st = SiteTime::load(None);
        for i in 0..10 {
            st.add(NOW - 60, &format!("site{i}.com"), 100 + i);
        }
        let r = st.report(false, NOW, AEDT);
        assert_eq!(r.sites.len(), TOP);
        assert_eq!(r.other_count, 4);
        assert_eq!(r.other_secs, 100 + 101 + 102 + 103);
    }

    #[test]
    fn a_week_has_seven_days_ending_today() {
        let st = SiteTime::load(None);
        let today = day_start(NOW, AEDT);
        st.add(today + 60, "a.com", 60);
        st.add(today - 6 * 86_400 + 60, "a.com", 120);
        st.add(today - 7 * 86_400 + 60, "a.com", 999); // last week
        let r = st.report(true, NOW, AEDT);
        assert_eq!(r.bars.len(), 7);
        assert_eq!(r.bars[6].label, "Mon");
        assert_eq!(r.bars[6].secs, 60);
        assert_eq!(r.bars[0].label, "Tue");
        assert_eq!(r.bars[0].secs, 120);
        assert_eq!(r.sites[0].prev_secs, 999);
    }

    #[test]
    fn only_web_pages_are_counted() {
        assert_eq!(
            site_of("https://www.GitHub.com/x?y").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            site_of("http://localhost:3000/").as_deref(),
            Some("localhost")
        );
        assert_eq!(site_of("flux://tasks"), None);
        assert_eq!(site_of("/Users/me/notes"), None);
    }

    #[test]
    fn a_tally_counts_today() {
        let t = HourTally::default();
        let today = day_start(NOW, AEDT);
        t.add(today - 60); // yesterday
        t.add(today + 60);
        t.add(NOW);
        assert_eq!(t.between(today, NOW + 1), 2);
    }
}
