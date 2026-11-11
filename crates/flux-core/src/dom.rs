//! DOM snapshot ingestion + the context-aware terminal bridge.
//!
//! Split out of `commands.rs` (Phase 2 refactor): everything a tab's injected
//! JS publishes back to Rust (DOM snapshots, reader blocks, find results,
//! chrome key/url intents) and the env bridge that makes spawned shells born
//! knowing the browser's state. Hot-path rule (ADR 0001) still applies:
//! multi-KB payloads travel as raw bytes, JSON is for small control messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{DomSnapshot, FluxState, TabId};

/// Process-wide monotonic clock origin for snapshot staleness stamps.
static BOOT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
pub(crate) fn now_ms() -> u64 {
    BOOT.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// ─── DOM snapshot ingestion (tab webview → Rust) ────────────────────────────
//
// Plain JSON args, NOT a raw ArrayBuffer body. Real pages set restrictive CSPs
// (e.g. DuckDuckGo's `connect-src`), which block Tauri's fetch-based IPC and
// force the `postMessage` fallback — and that path does not carry a raw body.
// JSON args survive both paths. (The zero-copy raw-body idea from ADR 0001
// only worked from the local chrome origin; it can't work from arbitrary
// remote pages.)

/// Per-tab DOM snapshot caps (BACKLOG #79 — RAM). A page's outerHTML is often
/// several MB; cached for every open tab that dominates Flux's heap and is the
/// main memory cost we control (the rest is the native webviews themselves).
/// These bounds are generous for the actual consumers — the agent, the embedder
/// (which truncates anyway), and `flux extract-json` — so the cap is invisible
/// in practice but turns unbounded growth into O(tabs × cap).
const MAX_SNAPSHOT_HTML: usize = 1024 * 1024; // 1 MiB
const MAX_SNAPSHOT_TEXT: usize = 256 * 1024; //  256 KiB
/// The page-reported title lands in TabMeta (the session file), history and the
/// Trail. 4 KiB matches the native title callback's cap in webview.rs.
const MAX_SNAPSHOT_TITLE: usize = 4 * 1024;
/// Hard ceiling on a reported URL (Chromium's own URL length limit): no real
/// page is at a longer one, and it bounds the per-tab snapshot like html/text.
const MAX_SNAPSHOT_URL: usize = 2 * 1024 * 1024;
/// History and the Trail keep a record per distinct URL, and a page can mint
/// same-origin URLs at will (pushState), so only URLs of a size a server would
/// accept are recorded there. A longer one (app state in a fragment) still gets
/// its snapshot; it just isn't recorded as a visit.
const MAX_RECORDED_URL: usize = 8 * 1024;

/// Truncate to at most `max` bytes on a UTF-8 boundary (no realloc when short).
pub(crate) fn cap_utf8(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// The longest prefix of `s` that fits in `max` bytes and ends on a UTF-8
/// boundary. `&s[..max]` panics when byte `max` is mid-character, and the
/// release profile is `panic = "abort"`, so a page's text would crash Flux.
pub(crate) fn utf8_prefix(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Longest we'll wait for a page to answer a refresh request.
///
/// A page that doesn't answer isn't broken — it may have no capture script
/// (flux:// pages), be hibernated, or simply have nothing new — so this bounds
/// the wait rather than reporting a failure. Half a second is well past a
/// same-process eval-and-publish round trip and short enough not to be felt in
/// front of an agent turn.
const REFRESH_WAIT: Duration = Duration::from_millis(500);
const REFRESH_POLL: Duration = Duration::from_millis(20);

/// Ask a tab to snapshot itself *now*, and wait for the result to land.
///
/// The capture script publishes on load, on history navigation, and on DOM
/// mutations — but the agent reads a cache, and a cache can be stale for
/// reasons the observer can't see. The case that prompted this: a page showing
/// "loading…" that reveals its content by flipping a class. `innerText`
/// respects CSS visibility, so the text genuinely changes, while the mutation
/// the observer was watching for never happens. Widening the observer fixes
/// that specific shape; asking the page directly fixes the whole class of them,
/// including the plain race where rendering finishes a moment after the last
/// mutation.
///
/// Returns the freshest snapshot available — the new one if it arrived, the old
/// one if it didn't. Never an error: a stale answer beats no answer.
pub async fn refresh(app: &AppHandle, state: &FluxState, tab: TabId) -> Option<Arc<DomSnapshot>> {
    let before = state.dom_cache.get(&tab).map(|s| s.captured_at_ms);
    // `__FLUX__` is absent on internal pages and on a webview that hasn't run
    // the init script yet; the guard makes that a no-op rather than an error in
    // the page console.
    let _ = crate::webview::eval(
        app,
        tab,
        "window.__FLUX__&&window.__FLUX__.recapture&&window.__FLUX__.recapture()",
    );
    let deadline = std::time::Instant::now() + REFRESH_WAIT;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(REFRESH_POLL).await;
        let now = state.dom_cache.get(&tab).map(|s| s.captured_at_ms);
        // A *newer* timestamp, not merely a present one: a tab whose first
        // capture never arrives would otherwise return on its own absence.
        if now != before && now.is_some() {
            break;
        }
    }
    state.dom_cache.get(&tab).map(|e| Arc::clone(e.value()))
}

/// The active tab's snapshot, refreshed first. What every agent read should use.
pub async fn active_fresh(app: &AppHandle, state: &FluxState) -> Option<Arc<DomSnapshot>> {
    let tab = state.active_tab()?;
    refresh(app, state, tab).await
}

pub(crate) fn caller_tab(webview: &tauri::Webview) -> Result<TabId, String> {
    webview
        .label()
        .strip_prefix("tab-")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "not a tab webview".into())
}

/// The page's own `<title>`, capped like the native title callback's, else the
/// tab's stored one. Uncapped, a page could write megabytes into the session,
/// history and the Trail for every distinct URL it reports.
fn page_title(reported: Option<String>, stored: String) -> String {
    reported
        .map(|t| cap_utf8(t, MAX_SNAPSHOT_TITLE))
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(stored)
}

fn validate_reported_url(actual: &tauri::Url, reported: &str) -> Result<(), String> {
    let rep = match tauri::Url::parse(reported) {
        Ok(u) => u,
        Err(_) => return Err("invalid reported URL".into()),
    };
    if actual.scheme() != rep.scheme()
        || actual.host_str() != rep.host_str()
        || actual.port() != rep.port()
    {
        // Not the actual URL: a frame calling as its tab would learn the
        // top page's address from the error (audit S24).
        tracing::debug!(target: "flux::dom", %actual, reported, "reported URL doesn't match the page");
        return Err("reported URL does not match the page's origin".into());
    }
    Ok(())
}

#[tauri::command]
pub fn dom_publish(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, FluxState>,
    tab_id: TabId,
    url: String,
    html: String,
    text: String,
    title: Option<String>,
) -> Result<(), String> {
    let caller = caller_tab(&webview)?;
    if caller != tab_id {
        return Err("that isn't this tab".to_string());
    }
    if url.len() > MAX_SNAPSHOT_URL {
        return Err("reported URL too long".into());
    }
    // The committed document, not a pending navigation's target (audit S8):
    // a page must not publish a snapshot under the next site's URL.
    let actual_url = crate::committed::url_of(&webview)?;
    validate_reported_url(&actual_url, &url)?;
    let (tab_title, private, ws_id) = {
        let tab = state.tabs.get(&tab_id).ok_or("unknown tab")?;
        (tab.title.clone(), tab.private, tab.workspace)
    };

    // Bound per-tab memory before anything holds onto these strings (#79).
    let html = cap_utf8(html, MAX_SNAPSHOT_HTML);
    let text = cap_utf8(text, MAX_SNAPSHOT_TEXT);
    let title = page_title(title, tab_title);

    // Keep the tab's stored title fresh (so omni_search + the session show the
    // live title, not the creation-time one). In-memory only — not worth a disk
    // write every capture.
    if let Some(mut t) = state.tabs.get_mut(&tab_id) {
        if !title.trim().is_empty() && t.title != title {
            t.title = title.clone();
        }
    }

    if !private && url.len() <= MAX_RECORDED_URL {
        // Record the visit in browsing history (#39) and in the provenance spine,
        // "the Trail" (ADR 0011), on the ordered writer thread: either may still
        // be loading, and this runs on the main thread. Same non-private guard
        // for both; the task label is the tab's active workspace name, and the
        // nav edge is drawn from the tab's prior visit.
        let task = state
            .workspaces_list()
            .into_iter()
            .find(|w| w.id == ws_id)
            .map(|w| w.name);
        let (visit_url, visit_title) = (url.clone(), title.clone());
        crate::trace::write_later(&app, move |app| {
            // History skips non-http(s) internally.
            if let Some(h) = app.try_state::<crate::history::HistoryStore>() {
                h.record(&visit_url, &visit_title);
            }
            // Stamp the id too: the name is what the user sees, but it can be
            // renamed, and a scoped view must not lose old research when it is.
            if let Some(tr) = app.try_state::<crate::trace::TraceStore>() {
                tr.record(tab_id, &visit_url, &visit_title, task, Some(ws_id));
            }
        });
        // Live ingest into Omni (no-op unless the user enabled auto-ingest). Done
        // before the snapshot is built so the page text is still owned here.
        crate::omni::maybe_auto_ingest(&app, &url, &title, &text);
    }

    let snapshot = Arc::new(DomSnapshot {
        tab: tab_id,
        url,
        html: Arc::from(html),
        text: Arc::from(text),
        captured_at_ms: now_ms(),
    });
    state.dom_cache.insert(tab_id, snapshot);

    // Refresh the terminal's page-context file if this is the active tab (#65/#4).
    if state.active_tab() == Some(tab_id) {
        crate::rpc::publish_active(&app);
    }

    // Capture navigations into an in-progress macro recording (#67), from the
    // tab being recorded only: every open tab re-publishes on its own DOM
    // mutations, and a background tab's page isn't a step of this flow.
    if let Some(m) = app.try_state::<crate::macros::MacroState>() {
        if m.is_recording_tab(tab_id) {
            if let Some(snap) = state.dom_cache.get(&tab_id) {
                if snap.url.starts_with("http") {
                    m.push(crate::macros::Step::Navigate {
                        url: snap.url.clone(),
                    });
                }
            }
        }
    }

    // Nudge interested panes (terminal env bar, agent sidebar).
    app.emit("flux://dom-updated", tab_id)
        .map_err(|e| e.to_string())
}

/// Publish a **Flux-owned** page's visible text (the Notebook, the Trail…).
///
/// A `flux://` page is a Solid component in the chrome's own DOM, not a native
/// webview — so nothing injects `dom.js` into it and it never published a
/// snapshot. That made every internal page invisible to the things that read
/// snapshots: "All tabs" in the agent skipped them, the connections rail had no
/// page to relate anything to, and `/note` had no context. Silently, in each
/// case, because a missing snapshot is indistinguishable from a page that hasn't
/// loaded yet.
///
/// A separate command from [`dom_publish`] rather than reusing it: that one is a
/// `fluxtab` **plugin** command so remote pages may call it, and the chrome
/// window isn't granted `fluxtab:default` — calling it from here would have been
/// denied. This is an app command, callable only by the chrome, which is also
/// the honest boundary: nothing here is untrusted content.
///
/// No history, no Trail, no Omni: browsing your own notes isn't browsing, and
/// recording it would fill the provenance spine with `flux://` noise.
#[tauri::command]
pub fn dom_publish_internal(
    state: State<'_, FluxState>,
    tab_id: TabId,
    url: String,
    text: String,
) -> Result<(), String> {
    let text = cap_utf8(text, MAX_SNAPSHOT_TEXT);
    state.dom_cache.insert(
        tab_id,
        std::sync::Arc::new(crate::state::DomSnapshot {
            tab: tab_id,
            url,
            // Internal pages have no serialized HTML to keep; every consumer
            // that matters reads `text`.
            html: std::sync::Arc::from(""),
            text: std::sync::Arc::from(text.as_str()),
            captured_at_ms: now_ms(),
        }),
    );
    Ok(())
}

/// Whether a page may forward this command (audit S35). Not the microphone:
/// "Ask out loud" is a system-wide hotkey (hud.rs), so the key never needs a
/// page to pass it on, and a page calling this with no keypress would start
/// listening. On macOS the menu bar takes ⌘ chords before the page sees them,
/// so these never need forwarding there either, and a page could otherwise
/// bookmark itself, add itself to Omni (and every later answer) or open the
/// inspector without a key being pressed.
fn page_forwardable(action: &str) -> bool {
    if action == crate::hud::COMMAND {
        return false;
    }
    #[cfg(target_os = "macos")]
    if matches!(action, "bookmark-page" | "save-to-omni" | "devtools") {
        return false;
    }
    true
}

/// App keyboard shortcuts forwarded from a focused tab webview (#18). A native
/// child webview eats key events when focused, so the injected `shortcuts.js`
/// detects Flux's chord set and calls this; we re-emit it to the chrome, which
/// dispatches the same action it would for a chrome-focused keypress. Like
/// `dom_publish`, this is a `fluxtab` plugin command so remote pages may call it.
///
/// Any page can call it directly, with no keypress, so only commands a key is
/// bound to get through (keys.rs: what `shortcuts.js` forwards), and the
/// caller's label travels with the event: the chrome, which knows what's on
/// screen, drops chords from background tabs and closed panels (a hidden page
/// could otherwise close tab after tab).
#[tauri::command]
pub fn chrome_key(app: AppHandle, webview: tauri::Webview, action: String) -> Result<(), String> {
    if !page_forwardable(&action) {
        return Err("not a shortcut a page forwards".into());
    }
    let bound = app
        .try_state::<crate::keys::KeyStore>()
        .is_some_and(|k| k.is_bound(&action));
    if !bound {
        return Err("not a Flux shortcut".into());
    }
    app.emit(
        "flux://page-shortcut",
        (webview.label().to_string(), action),
    )
    .map_err(|e| e.to_string())
}

/// A page-initiated new window (window.open / target="_blank" / modified click),
/// forwarded by the injected `newtab.js`. Native child webviews ignore these, so
/// the page asks the chrome to open a real Flux tab. `background` keeps focus on
/// the current tab (middle-click / Ctrl-click). Like `chrome_key`, this is a
/// `fluxtab` plugin command so remote pages may call it.
///
/// A page can call it directly, with no click, so (audit S1):
/// - only a tab or a web panel may ask;
/// - the opener's tab id travels with the event, so the chrome opens the child
///   as private, Tor or in a container when the opener is (a Tor page could
///   otherwise open a clearnet tab from the real address);
/// - each caller gets at most `OPEN_BURST` new tabs per `OPEN_WINDOW_MS` (a real
///   user never opens tabs that fast; a page looping on this used to).
#[tauri::command]
pub fn chrome_open_url(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
    background: bool,
) -> Result<(), String> {
    let label = webview.label();
    let opener = label
        .strip_prefix("tab-")
        .and_then(|s| s.parse::<crate::state::TabId>().ok());
    if opener.is_none() && !label.starts_with("panel-") {
        return Err("only a page can open a tab".into());
    }
    // `newtab.js` only forwards web URLs, but a page can call this directly.
    let url = page_openable_url(&url)?;
    if !claim_open(&OPEN_CLAIMS, label, now_ms()) {
        return Err("too many new tabs at once".into());
    }
    app.emit("flux://open-url", (url, background, opener))
        .map_err(|e| e.to_string())
}

const OPEN_BURST: u32 = 6;
const OPEN_WINDOW_MS: u64 = 10_000;
/// Per caller label: when its current window started and how many tabs it has
/// opened in it.
static OPEN_CLAIMS: std::sync::LazyLock<dashmap::DashMap<String, (u64, u32)>> =
    std::sync::LazyLock::new(dashmap::DashMap::new);

/// One more new tab for `label` at `now` (ms), unless it has had its burst in
/// the current window.
fn claim_open(claims: &dashmap::DashMap<String, (u64, u32)>, label: &str, now: u64) -> bool {
    let mut e = claims.entry(label.to_string()).or_insert((now, 0));
    if now.saturating_sub(e.0) >= OPEN_WINDOW_MS {
        *e = (now, 0);
    }
    if e.1 >= OPEN_BURST {
        return false;
    }
    e.1 += 1;
    true
}

/// A URL a page may have the chrome open as a tab: http(s) only (never `file:`,
/// a `flux://` internal page, `javascript:` or `data:`), never Flux's own
/// origin, and normalized, so the chrome opens exactly the URL that was checked
/// (pdf.rs, for one, routes on a case-sensitive `http` prefix). Shared with
/// `peek_promote`, the other page-callable way into `flux://open-url`.
pub(crate) fn page_openable_url(url: &str) -> Result<String, String> {
    match url.parse::<tauri::Url>() {
        Ok(u) if matches!(u.scheme(), "http" | "https") && !crate::webview::is_app_origin(&u) => {
            Ok(u.to_string())
        }
        _ => Err("a page can only open web pages in a tab".into()),
    }
}

/// Pull OS keyboard focus back to the chrome window. A focused native tab
/// webview is a separate OS child window that holds the keyboard, so focusing a
/// chrome DOM element (e.g. the omnibox on Ctrl+T / Ctrl+L) does nothing until
/// the chrome window itself is focused. The frontend calls this first.
#[tauri::command]
pub fn chrome_focus(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

/// Find-in-page result reported by the page (#33): match count + whether the
/// current step landed on a match. Re-emitted to the chrome's find bar. A
/// `fluxtab` plugin command so the (remote) page may call it, like `dom_publish`.
#[tauri::command]
pub fn find_result(
    app: AppHandle,
    webview: tauri::Webview,
    tab_id: TabId,
    count: usize,
    found: bool,
) -> Result<(), String> {
    // Like `dom_publish`, a page reports for its own tab only.
    let caller = caller_tab(&webview)?;
    if caller != tab_id {
        return Err("that isn't this tab".to_string());
    }
    app.emit("flux://find-result", (tab_id, count, found))
        .map_err(|e| e.to_string())
}

/// Largest extract payload passed on to the chrome; a page builds it, so bound it.
const MAX_AGENT_PAYLOAD: usize = 1024 * 1024;

/// Outcome of a compiled agent action (flux-agent `compile.rs`), reported by the
/// page: `clicked`, `typed`, `not_found`, `bad_selector`, `blocked_destructive`,
/// `refused`, or `extract` with its `format` + `payload`. Re-emitted to the agent
/// panel, which only accepts a report from a tab it just ran an action on: this
/// is a `fluxtab` plugin command, so any page can call it. The tab comes from
/// the calling webview's label, never from the page.
#[tauri::command]
pub fn agent_report(
    app: AppHandle,
    webview: tauri::Webview,
    kind: String,
    detail: String,
    format: String,
    payload: String,
) -> Result<(), String> {
    let tab = caller_tab(&webview)?;
    emit_agent_report(&app, tab, kind, detail, format, payload)
}

/// Hand a step's outcome to the agent panel, whichever world it came from.
pub(crate) fn emit_agent_report(
    app: &AppHandle,
    tab: TabId,
    kind: String,
    detail: String,
    format: String,
    payload: String,
) -> Result<(), String> {
    app.emit(
        "flux://agent-report",
        (
            tab,
            cap_utf8(kind, 64),
            cap_utf8(detail, 1024),
            cap_utf8(format, 16),
            cap_utf8(payload, MAX_AGENT_PAYLOAD),
        ),
    )
    .map_err(|e| e.to_string())
}

/// One structured block of a reader-mode extraction (#41): a heading, paragraph,
/// list item, quote, preformatted block, image caption, or image.
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
pub struct ReaderBlock {
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub src: String,
}

/// Reader-mode result posted by the injected extractor (#41). Re-emitted to the
/// chrome, which renders the blocks safely (text + img src, never raw HTML). A
/// `fluxtab` plugin command so the (remote) page may call it, like `dom_publish`.
#[tauri::command]
pub fn reader_publish(
    app: AppHandle,
    webview: tauri::Webview,
    tab_id: TabId,
    title: String,
    blocks: Vec<ReaderBlock>,
) -> Result<(), String> {
    // Like `dom_publish`, a page reports for its own tab only: any tab, panel
    // or peek can call this, and the chrome opens its overlay on the result.
    let caller = caller_tab(&webview)?;
    if caller != tab_id {
        return Err("that isn't this tab".to_string());
    }
    // Only an answer Flux asked for (audit S4): a page could otherwise post a
    // "reader result" unasked, and the chrome would open its overlay on it.
    if !take_reader_request(&READER_ASKED, tab_id, now_ms()) {
        return Err("no reader view was asked for".into());
    }
    let (private, tor) = app
        .try_state::<FluxState>()
        .and_then(|s| s.tabs.get(&tab_id).map(|t| (t.private, t.tor)))
        .unwrap_or((false, false));
    let blocks = clean_reader_blocks(blocks, private || tor);
    let title: String = title.chars().take(300).collect();
    app.emit("flux://reader", (tab_id, title, blocks))
        .map_err(|e| e.to_string())
}

/// Tabs a reader view was asked of, and when (ms). One answer per ask.
pub(crate) static READER_ASKED: std::sync::LazyLock<dashmap::DashMap<TabId, u64>> =
    std::sync::LazyLock::new(dashmap::DashMap::new);
const READER_ASK_TTL_MS: u64 = 30_000;

/// Note that Flux asked `tab` for its reader view (webview_extract_reader).
pub(crate) fn note_reader_request(tab: TabId) {
    READER_ASKED.insert(tab, now_ms());
}

fn take_reader_request(asked: &dashmap::DashMap<TabId, u64>, tab: TabId, now: u64) -> bool {
    asked
        .remove(&tab)
        .is_some_and(|(_, at)| now.saturating_sub(at) <= READER_ASK_TTL_MS)
}

const READER_MAX_BLOCKS: usize = 2_000;
const READER_MAX_TEXT: usize = 20_000;

/// Bound what a page hands the chrome, and keep remote images out of a private
/// or Tor tab's reader: the chrome window would load them itself, from the real
/// address and outside the tab's proxy (audit S4). Elsewhere only http(s)
/// images, which the page had already loaded.
fn clean_reader_blocks(blocks: Vec<ReaderBlock>, no_images: bool) -> Vec<ReaderBlock> {
    blocks
        .into_iter()
        .filter(|b| {
            b.kind != "img"
                || (!no_images && (b.src.starts_with("https://") || b.src.starts_with("http://")))
        })
        .take(READER_MAX_BLOCKS)
        .map(|mut b| {
            if b.text.len() > READER_MAX_TEXT {
                b.text = b.text.chars().take(READER_MAX_TEXT).collect();
            }
            b.src.truncate(2_048);
            b.level = b.level.min(6);
            b
        })
        .collect()
}

/// Per-tab captured-DOM payload size in bytes (BACKLOG #70) — html + text of the
/// cached snapshot, a proxy for page weight in the resource view. Tabs without a
/// snapshot (never loaded / hibernated) are omitted.
#[tauri::command]
pub fn tab_dom_sizes(state: State<'_, FluxState>) -> Vec<(TabId, usize)> {
    state
        .dom_cache
        .iter()
        .map(|e| (*e.key(), e.html.len() + e.text.len()))
        .collect()
}

/// Hand the active tab's DOM to the frontend (e.g. terminal running
/// `flux extract-json`) as an ArrayBuffer — `Response` skips JSON entirely.
#[tauri::command]
pub fn dom_active_bytes(state: State<'_, FluxState>) -> Result<Response, String> {
    let snap = state.active_snapshot().ok_or("no active tab snapshot")?;
    Ok(Response::new(snap.html.as_bytes().to_vec()))
}

// ─── Context-Aware Terminal bridge ───────────────────────────────────────────

/// Environment the embedded terminal injects into every spawned shell.
/// This is what makes `cd $FLUX_TAB_DIR` / `flux extract-json` work: the
/// shell session is *born* knowing the browser's state.
#[tauri::command]
pub fn terminal_env(state: State<'_, FluxState>) -> HashMap<String, String> {
    let mut env = HashMap::with_capacity(6);
    if let Some(id) = state.active_tab() {
        if let Some(tab) = state.tabs.get(&id) {
            env.insert("FLUX_TAB_ID".into(), id.to_string());
            env.insert("FLUX_TAB_URL".into(), tab.url.clone());
            env.insert("FLUX_TAB_TITLE".into(), tab.title.clone());
            // Per-site downloaded-assets dir, e.g. `cd $FLUX_TAB_DIR`.
            if let Some(host) = tab.url.split('/').nth(2) {
                env.insert(
                    "FLUX_TAB_DIR".into(),
                    format!("{}/flux/{}", dirs_download(), host),
                );
            }
        }
        if let Some(snap) = state.dom_cache.get(&id) {
            env.insert(
                "FLUX_DOM_AGE_MS".into(),
                (now_ms() - snap.captured_at_ms).to_string(),
            );
        }
    }
    env
}

pub(crate) fn dirs_download() -> String {
    // Real impl: `dirs::download_dir()`. Kept dependency-free in the scaffold.
    std::env::var("HOME")
        .map(|h| format!("{h}/Downloads"))
        .unwrap_or_else(|_| ".".into())
}

#[cfg(test)]
mod tests {

    #[test]
    fn pages_cannot_forward_the_microphone() {
        assert!(!page_forwardable("indexer-listen"));
        assert!(page_forwardable("close-tab"));
        #[cfg(target_os = "macos")]
        assert!(!page_forwardable("save-to-omni"));
    }


    #[test]
    fn reader_results_need_an_ask_and_lose_images_in_tor() {
        let asked = dashmap::DashMap::new();
        assert!(!super::take_reader_request(&asked, 7, 1_000), "unasked is refused");
        asked.insert(7, 1_000);
        assert!(super::take_reader_request(&asked, 7, 2_000));
        assert!(!super::take_reader_request(&asked, 7, 2_100), "one answer per ask");
        asked.insert(7, 1_000);
        assert!(!super::take_reader_request(&asked, 7, 1_000 + super::READER_ASK_TTL_MS + 1), "stale");

        let img = |src: &str| super::ReaderBlock { kind: "img".into(), text: String::new(), level: 0, src: src.into() };
        let p = super::ReaderBlock { kind: "p".into(), text: "x".repeat(50_000), level: 9, src: String::new() };
        let out = super::clean_reader_blocks(vec![img("https://a/x.png"), img("data:x"), p.clone()], false);
        assert_eq!(out.len(), 2, "only http(s) images");
        assert_eq!(out[1].text.len(), super::READER_MAX_TEXT);
        assert_eq!(out[1].level, 6);
        let tor = super::clean_reader_blocks(vec![img("https://a/x.png"), p], true);
        assert!(tor.iter().all(|b| b.kind != "img"), "no images for a Tor tab");
    }


    #[test]
    fn page_opened_tabs_are_rate_limited_per_caller() {
        let claims = dashmap::DashMap::new();
        for _ in 0..super::OPEN_BURST {
            assert!(super::claim_open(&claims, "tab-1", 1_000));
        }
        assert!(!super::claim_open(&claims, "tab-1", 1_500), "a seventh at once is refused");
        assert!(super::claim_open(&claims, "tab-2", 1_500), "another tab has its own budget");
        assert!(super::claim_open(&claims, "tab-1", 1_000 + super::OPEN_WINDOW_MS), "the window resets");
    }

    use super::*;
    use crate::state::{FluxState, TabKind, TabMeta};

    #[test]
    fn tab_metadata_read_does_not_deadlock_with_mutation() {
        let state = FluxState::default();
        state.tabs.insert(
            42,
            TabMeta {
                id: 42,
                kind: TabKind::Browser,
                url: "https://example.com".into(),
                title: "Old Title".into(),
                pinned: false,
                cluster: None,
                group: None,
                folder: None,
                custom_title: None,
                workspace: 1,
                private: false,
                tor: false,
                container: 0,
            },
        );

        // Pattern used in dom_publish: read guard must be released before get_mut
        let (tab_title, private, _ws_id) = {
            let tab = state.tabs.get(&42).expect("tab should exist");
            (tab.title.clone(), tab.private, tab.workspace)
        };
        assert_eq!(tab_title, "Old Title");
        assert!(!private);

        let new_title = "New Title".to_string();
        if let Some(mut t) = state.tabs.get_mut(&42) {
            t.title = new_title.clone();
        }

        assert_eq!(state.tabs.get(&42).unwrap().title, "New Title");
    }

    #[test]
    fn pages_can_only_open_web_urls() {
        assert_eq!(
            page_openable_url("https://example.com/a?b=1").unwrap(),
            "https://example.com/a?b=1"
        );
        // What's emitted is the parsed form, not the page's spelling of it.
        assert_eq!(
            page_openable_url("HTTPS://Example.com/x.pdf").unwrap(),
            "https://example.com/x.pdf"
        );
        for bad in [
            "file:///Users/me/.ssh/id_rsa",
            "flux://pdf?src=file:///etc/hosts",
            "flux://settings",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "http://tauri.localhost/",
            "tauri://localhost/",
            "/etc/hosts",
            "not a url",
        ] {
            assert!(page_openable_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn page_reported_titles_are_capped() {
        // Two bytes a char, so twice the cap, and the cut lands mid-run.
        let huge = "é".repeat(MAX_SNAPSHOT_TITLE);
        let t = page_title(Some(huge), "stored".into());
        assert!(t.len() <= MAX_SNAPSHOT_TITLE && t.starts_with('é'));
        assert_eq!(page_title(Some("Inbox".into()), "stored".into()), "Inbox");
        assert_eq!(page_title(Some("  ".into()), "stored".into()), "stored");
        assert_eq!(page_title(None, "stored".into()), "stored");
    }

    #[test]
    fn validate_reported_url_matches_same_origin() {
        let actual = tauri::Url::parse("https://login.example.com/oauth/authorize?foo=bar").unwrap();
        assert!(validate_reported_url(&actual, "https://login.example.com/oauth/authorize").is_ok());
        assert!(validate_reported_url(&actual, "https://login.example.com/callback").is_ok());

        assert!(validate_reported_url(&actual, "https://attacker.com/steal").is_err());
        assert!(validate_reported_url(&actual, "http://login.example.com/oauth").is_err());
    }
}
