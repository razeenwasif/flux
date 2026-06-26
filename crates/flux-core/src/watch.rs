//! Watch a page for *semantic* changes (BACKLOG #128).
//!
//! Pin a URL; a background scheduler re-fetches it on an interval, extracts the
//! readable text, and compares it to the last-seen baseline by **embedding** — so
//! it reports what meaningfully changed (a section added, a claim removed), not a
//! noisy character diff. Reuses `crate::embedding` (Ollama model → hashing
//! fallback) and the reminders-style scheduler/notification pattern. Fully local:
//! the only network is fetching the page you asked Flux to watch.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::embedding;

const MAX_FETCH_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PASSAGES: usize = 220;
const MAX_REPORTED: usize = 12; // cap added/removed lists shown to the user
/// Cosine ≥ this counts a passage as "unchanged" (present on both sides).
const MATCH_THRESHOLD: f32 = 0.86;
const DEFAULT_INTERVAL: u64 = 3600; // 1 hour

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Persisted watch record.
#[derive(Serialize, Deserialize, Clone)]
struct WatchEntry {
    id: u64,
    url: String,
    title: String,
    interval_secs: u64,
    created_ms: u64,
    last_checked_ms: u64,
    last_change_ms: u64,
    /// Last-seen extracted text — the baseline the next check diffs against.
    baseline: String,
    added: Vec<String>,
    removed: Vec<String>,
    error: Option<String>,
    /// False once a change is detected, until the user opens the watch.
    seen: bool,
}

/// UI-facing view (no baseline text — that can be large).
#[derive(Serialize, Clone, specta::Type)]
pub struct WatchItem {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub interval_secs: u64,
    pub last_checked_ms: u64,
    pub last_change_ms: u64,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub error: Option<String>,
    pub seen: bool,
}

impl WatchEntry {
    fn to_item(&self) -> WatchItem {
        WatchItem {
            id: self.id,
            url: self.url.clone(),
            title: self.title.clone(),
            interval_secs: self.interval_secs,
            last_checked_ms: self.last_checked_ms,
            last_change_ms: self.last_change_ms,
            added: self.added.clone(),
            removed: self.removed.clone(),
            error: self.error.clone(),
            seen: self.seen,
        }
    }
}

#[derive(Default)]
struct Inner {
    entries: Vec<WatchEntry>,
    next_id: u64,
}

#[derive(Clone)]
pub struct WatchStore {
    inner: Arc<RwLock<Inner>>,
    path: Arc<Option<PathBuf>>,
}

impl WatchStore {
    pub fn restore(path: PathBuf) -> Self {
        let entries: Vec<WatchEntry> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next_id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        Self { inner: Arc::new(RwLock::new(Inner { entries, next_id })), path: Arc::new(Some(path)) }
    }

    fn save(&self) {
        let Some(path) = self.path.as_ref() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let json = serde_json::to_string(&self.inner.read().entries).ok();
        if let Some(json) = json {
            let _ = std::fs::write(path, json);
        }
    }

    pub fn list(&self) -> Vec<WatchItem> {
        let mut v: Vec<WatchItem> = self.inner.read().entries.iter().map(|e| e.to_item()).collect();
        v.sort_by(|a, b| b.last_change_ms.cmp(&a.last_change_ms).then(b.last_checked_ms.cmp(&a.last_checked_ms)));
        v
    }

    /// Add a watch and capture its initial baseline (best-effort). Idempotent on URL.
    pub fn add(&self, url: String, title: String, interval_secs: Option<u64>) -> WatchItem {
        if let Some(e) = self.inner.read().entries.iter().find(|e| e.url == url) {
            return e.to_item();
        }
        let (baseline, error) = match fetch_text(&url) {
            Ok(t) => (t, None),
            Err(e) => (String::new(), Some(e)),
        };
        let id = {
            let mut inner = self.inner.write();
            let id = inner.next_id;
            inner.next_id += 1;
            inner.entries.push(WatchEntry {
                id,
                url,
                title,
                interval_secs: interval_secs.unwrap_or(DEFAULT_INTERVAL).max(300),
                created_ms: now_ms(),
                last_checked_ms: now_ms(),
                last_change_ms: 0,
                baseline,
                added: Vec::new(),
                removed: Vec::new(),
                error,
                seen: true,
            });
            id
        };
        self.save();
        self.inner.read().entries.iter().find(|e| e.id == id).map(|e| e.to_item()).unwrap()
    }

    pub fn remove(&self, id: u64) {
        self.inner.write().entries.retain(|e| e.id != id);
        self.save();
    }

    pub fn mark_seen(&self, id: u64) {
        if let Some(e) = self.inner.write().entries.iter_mut().find(|e| e.id == id) {
            e.seen = true;
        }
        self.save();
    }

    pub fn is_watched(&self, url: &str) -> bool {
        self.inner.read().entries.iter().any(|e| e.url == url)
    }

    /// IDs whose next check is due.
    fn due_ids(&self) -> Vec<u64> {
        let now = now_ms();
        self.inner
            .read()
            .entries
            .iter()
            .filter(|e| now >= e.last_checked_ms + e.interval_secs * 1000)
            .map(|e| e.id)
            .collect()
    }

    fn url_and_baseline(&self, id: u64) -> Option<(String, String)> {
        self.inner.read().entries.iter().find(|e| e.id == id).map(|e| (e.url.clone(), e.baseline.clone()))
    }

    /// Apply a completed check. Returns the item if a change was detected.
    fn apply(&self, id: u64, result: Result<(String, Vec<String>, Vec<String>), String>) -> Option<WatchItem> {
        let mut changed_item = None;
        {
            let mut inner = self.inner.write();
            let Some(e) = inner.entries.iter_mut().find(|e| e.id == id) else { return None };
            e.last_checked_ms = now_ms();
            match result {
                Ok((new_text, added, removed)) => {
                    e.error = None;
                    if !added.is_empty() || !removed.is_empty() {
                        e.baseline = new_text;
                        e.added = added;
                        e.removed = removed;
                        e.last_change_ms = now_ms();
                        e.seen = false;
                        changed_item = Some(e.to_item());
                    } else if e.baseline.is_empty() {
                        // First successful fetch after an error → seed baseline silently.
                        e.baseline = new_text;
                    }
                }
                Err(err) => e.error = Some(err),
            }
        }
        self.save();
        changed_item
    }
}

/// Fetch a URL and reduce it to readable text (best-effort; consistent extraction
/// matters more than perfect readability for change detection).
fn fetch_text(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("can only watch http(s) pages".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(25))
        .build();
    let resp = agent.get(url).set("User-Agent", "Mozilla/5.0 (Flux page-watch)").call().map_err(|e| e.to_string())?;
    let ctype = resp.header("content-type").unwrap_or("").to_ascii_lowercase();
    if !ctype.is_empty() && !ctype.contains("html") && !ctype.contains("text") && !ctype.contains("xml") {
        return Err(format!("not a text page ({ctype})"));
    }
    let mut buf = Vec::new();
    resp.into_reader().take(MAX_FETCH_BYTES).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("empty response".into());
    }
    Ok(html_to_text(&String::from_utf8_lossy(&buf)))
}

/// Strip HTML to whitespace-collapsed text (drops script/style/comments).
fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        rest = &rest[lt..];
        let head = rest[..rest.len().min(9)].to_ascii_lowercase();
        if head.starts_with("<script") {
            rest = skip_to(rest, "</script>");
        } else if head.starts_with("<style") {
            rest = skip_to(rest, "</style>");
        } else if rest.starts_with("<!--") {
            rest = rest.find("-->").map(|e| &rest[e + 3..]).unwrap_or("");
        } else if let Some(gt) = rest.find('>') {
            out.push(' '); // a tag boundary is a word boundary
            rest = &rest[gt + 1..];
        } else {
            rest = "";
        }
    }
    out.push_str(rest);
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn skip_to<'a>(rest: &'a str, end_lower: &str) -> &'a str {
    let low = rest.to_ascii_lowercase();
    match low.find(end_lower) {
        Some(i) => &rest[i + end_lower.len()..],
        None => "",
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
}

/// ~45-word passages (verbatim slices) for embedding-based diffing.
fn passages(text: &str) -> Vec<String> {
    const WORDS_PER: usize = 45;
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut words = 0usize;
    let mut in_word = false;
    let mut i = 0usize;
    for c in text.chars() {
        if !c.is_whitespace() {
            in_word = true;
        } else if in_word {
            in_word = false;
            words += 1;
            if words >= WORDS_PER {
                let seg = text[start..i].trim();
                if seg.split_whitespace().count() >= 5 {
                    out.push(seg.to_string());
                    if out.len() >= MAX_PASSAGES {
                        return out;
                    }
                }
                start = i;
                words = 0;
            }
        }
        i += c.len_utf8();
    }
    let seg = text[start..].trim();
    if seg.split_whitespace().count() >= 5 {
        out.push(seg.to_string());
    }
    out
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn max_cos(v: &[f32], set: &[Vec<f32>]) -> f32 {
    set.iter().map(|w| cosine(v, w)).fold(0.0_f32, f32::max)
}

/// Semantic diff: passages in `current` not in `baseline` (added) and vice-versa
/// (removed). Blocking (embeds passages) — call off-thread.
fn diff(baseline: &str, current: &str) -> (Vec<String>, Vec<String>) {
    let old_p = passages(baseline);
    let new_p = passages(current);
    if new_p.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let kind = embedding::current();
    let old_v = embedding::embed_batch(&old_p, kind).unwrap_or_default();
    let new_v = embedding::embed_batch(&new_p, kind).unwrap_or_default();
    if new_v.len() != new_p.len() {
        return (Vec::new(), Vec::new()); // embedding failed; report nothing rather than noise
    }
    let added: Vec<String> = new_p
        .iter()
        .enumerate()
        .filter(|(i, _)| max_cos(&new_v[*i], &old_v) < MATCH_THRESHOLD)
        .map(|(_, p)| p.clone())
        .take(MAX_REPORTED)
        .collect();
    let removed: Vec<String> = if old_v.len() == old_p.len() {
        old_p
            .iter()
            .enumerate()
            .filter(|(i, _)| max_cos(&old_v[*i], &new_v) < MATCH_THRESHOLD)
            .map(|(_, p)| p.clone())
            .take(MAX_REPORTED)
            .collect()
    } else {
        Vec::new()
    };
    (added, removed)
}

/// One check: fetch + diff against the baseline.
fn check_one(url: &str, baseline: &str) -> Result<(String, Vec<String>, Vec<String>), String> {
    let current = fetch_text(url)?;
    if baseline.is_empty() {
        return Ok((current, Vec::new(), Vec::new())); // seed baseline, no change
    }
    let (added, removed) = diff(baseline, &current);
    Ok((current, added, removed))
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn watch_list(store: State<'_, WatchStore>) -> Vec<WatchItem> {
    store.list()
}

#[tauri::command]
pub fn watch_is_watched(store: State<'_, WatchStore>, url: String) -> bool {
    store.is_watched(&url)
}

#[tauri::command]
pub async fn watch_add(
    store: State<'_, WatchStore>,
    url: String,
    title: String,
    interval_secs: Option<u64>,
) -> Result<WatchItem, String> {
    let store = (*store).clone();
    tauri::async_runtime::spawn_blocking(move || store.add(url, title, interval_secs)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watch_remove(store: State<'_, WatchStore>, id: u64) {
    store.remove(id);
}

#[tauri::command]
pub fn watch_mark_seen(store: State<'_, WatchStore>, id: u64) {
    store.mark_seen(id);
}

/// Force an immediate check (the ↻ button). Returns the updated item.
#[tauri::command]
pub async fn watch_check_now(store: State<'_, WatchStore>, id: u64) -> Result<Option<WatchItem>, String> {
    let store = (*store).clone();
    let Some((url, baseline)) = store.url_and_baseline(id) else { return Ok(None) };
    let result = tauri::async_runtime::spawn_blocking(move || check_one(&url, &baseline)).await.map_err(|e| e.to_string())?;
    store.apply(id, result);
    Ok(store.list().into_iter().find(|i| i.id == id))
}

/// Background scheduler: every minute, check any watch that's due; on a real
/// change, emit `flux://watch-changed` + an OS notification (mirrors reminders).
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(store) = app.try_state::<WatchStore>().map(|s| (*s).clone()) else { continue };
            for id in store.due_ids() {
                let Some((url, baseline)) = store.url_and_baseline(id) else { continue };
                let result = match tauri::async_runtime::spawn_blocking(move || check_one(&url, &baseline)).await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(item) = store.apply(id, result) {
                    let _ = app.emit("flux://watch-changed", &item);
                    let n_add = item.added.len();
                    let n_rem = item.removed.len();
                    let _ = app
                        .notification()
                        .builder()
                        .title("Flux — page changed")
                        .body(&format!("{} updated (+{n_add} / −{n_rem})", item.title))
                        .show();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_to_text_strips_tags_and_scripts() {
        let html = "<html><head><style>.a{color:red}</style></head><body><h1>Hi</h1>\
                    <script>alert('x')</script><p>Hello&nbsp;world &amp; more</p></body></html>";
        let t = html_to_text(html);
        assert!(t.contains("Hi"));
        assert!(t.contains("Hello world & more"));
        assert!(!t.contains("alert"));
        assert!(!t.contains("color:red"));
    }

    #[test]
    fn diff_detects_added_and_removed_sections() {
        let base = "The pricing is ten dollars per month for the basic plan with email support included. \
                    Our refund policy allows cancellation within thirty days for a full refund no questions asked.";
        let new = "The pricing is ten dollars per month for the basic plan with email support included. \
                   We have launched a brand new enterprise tier with single sign on audit logs and priority phone support.";
        let (added, removed) = diff(base, new);
        assert!(added.iter().any(|p| p.to_lowercase().contains("enterprise")), "added: {added:?}");
        assert!(removed.iter().any(|p| p.to_lowercase().contains("refund")), "removed: {removed:?}");
    }
}
