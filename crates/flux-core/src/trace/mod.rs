//! Browsing provenance spine — "the Trail" (ADR 0011).
//!
//! The foundation of the Research OS: every navigation becomes a **Visit** — a
//! node carrying *why* you got there (the page you came from is a free `Nav`
//! edge, plus the active workspace as the task label). Graph, time-travel,
//! per-page chat, and context search are all read models over this one store;
//! this slice ships just the capture + the store + `forget`, so nothing here
//! depends on the later phases (snapshots, embeddings, entities).
//!
//! Recorded from `dom_publish` **inside its `if !private` guard**, so private
//! windows (#59) leave no Visit — same rule that already excludes them from
//! history. Local-only, persisted as JSON like `history`/`archive`; the spine is
//! never a network source.

mod ambient;
mod chats;
mod drafts;
mod entities;
pub(crate) mod sealed;
mod snapshots;
mod store;

pub use ambient::AmbientHint;
pub use chats::{ChatMsg, TraceChats};
pub use drafts::{Draft, TraceDrafts};
pub use entities::extract_entities;
pub use snapshots::{Snapshot, SnapshotWire, TraceSnapshots, WebDoc};
pub use store::{
    Edge, EdgeKind, Entity, EntityKind, ForgetScope, Provenance, TraceGraph, TraceHistogram,
    TraceStore, Visit, VisitId,
};

use tauri::State;

use crate::state::TabId;
use chats::chat_prompt;
use snapshots::SNAPSHOT_TEXT_CAP;

/// Wall-clock ms since the epoch — the shared timestamp base for every store.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

/// Most-recent visits for the Trail timeline (newest first).
#[tauri::command]
pub fn trace_recent(store: State<'_, TraceStore>, limit: Option<usize>) -> Vec<Visit> {
    store.recent(limit.unwrap_or(200))
}

/// A single visit by id (node detail).
#[tauri::command]
pub fn trace_visit(store: State<'_, TraceStore>, id: VisitId) -> Option<Visit> {
    store.visit(id)
}

/// The provenance graph (optionally time-windowed) for the Trail view. `limit`
/// keeps only the newest visits (and the edges among them), applied before
/// serialization: this runs on the UI thread.
#[tauri::command]
pub fn trace_graph(
    store: State<'_, TraceStore>,
    after_ms: Option<u64>,
    before_ms: Option<u64>,
    task_id: Option<u32>,
    task: Option<String>,
    limit: Option<usize>,
) -> TraceGraph {
    store.graph_newest(after_ms, before_ms, task_id, task.as_deref(), limit)
}

/// Follow a workspace rename so its earlier visits stay in the scoped view.
/// Returns how many visits were retagged.
#[tauri::command]
pub fn trace_rename_task(
    store: State<'_, TraceStore>,
    id: Option<u32>,
    from: String,
    to: String,
) -> usize {
    store.rename_task(id, &from, &to)
}

/// Visit-density histogram for the Trail scrubber's activity backdrop.
#[tauri::command]
pub fn trace_histogram(store: State<'_, TraceStore>, buckets: Option<usize>) -> TraceHistogram {
    store.histogram(buckets.unwrap_or(120))
}

/// A tab reference for branch grouping: its id + current URL (the URL is the
/// visit-resolution fallback for hibernated tabs — see `TraceStore::branches`).
#[derive(serde::Deserialize, specta::Type)]
pub struct BranchTabRef {
    pub id: TabId,
    pub url: String,
}

/// Group open tabs into Trail-connected "rabbit-hole" branches (#46 upgrade:
/// archive a whole solved research branch as one unit, not scattered tabs).
/// Returns the branches largest-first; every input tab appears exactly once
/// (unconnected tabs come back as singletons).
#[tauri::command]
pub fn trace_branches(store: State<'_, TraceStore>, tabs: Vec<BranchTabRef>) -> Vec<Vec<TabId>> {
    let pairs: Vec<(TabId, String)> = tabs.into_iter().map(|t| (t.id, t.url)).collect();
    store.branches(&pairs)
}

/// A dwell snapshot's content (node detail).
#[tauri::command]
pub fn trace_snapshot_get(snaps: State<'_, TraceSnapshots>, id: u64) -> Option<SnapshotWire> {
    snaps.get(id)
}

/// Capture the dwell snapshot for a tab's current visit (ADR 0011 step 1). Called
/// by the frontend once the page has been engaged past the dwell threshold. Reads
/// the already-cached DOM text (no new page capture), embeds it off-thread, stores
/// it, and attaches `snapshot_id` to the visit. Idempotent — a visit that already
/// has a snapshot returns it without re-embedding. Returns the snapshot id, or
/// `None` if there's no current visit / no cached text yet / the visit left the
/// Trail while embedding.
#[tauri::command]
pub async fn trace_snapshot(
    trace: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    state: State<'_, crate::state::FluxState>,
    tab_id: TabId,
) -> Result<Option<u64>, String> {
    let Some(visit_id) = trace.current_visit(tab_id) else {
        return Ok(None);
    };
    // The visit must still exist (not evicted/forgotten) — otherwise the snapshot
    // would be an orphan nothing references.
    let Some(visit) = trace.visit(visit_id) else {
        return Ok(None);
    };
    // Already captured for this visit → no re-embed (dwell can fire repeatedly).
    if let Some(existing) = visit.snapshot_id {
        return Ok(Some(existing));
    }
    let title = visit.title;
    // Read the cached DOM text ONCE (then drop the dashmap guard before the await),
    // so what we store is exactly what we embedded even if the tab navigates mid-embed.
    let (url, text) = {
        let Some(snap) = state.dom_cache.get(&tab_id) else {
            return Ok(None);
        };
        (
            snap.url.clone(),
            crate::dom::cap_utf8(snap.text.to_string(), SNAPSHOT_TEXT_CAP),
        )
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    // Resolve the corpus embedder + embed INSIDE the blocking task: both can hit
    // Ollama over HTTP (the first resolution probes it) — never on the async runtime.
    let emb_cell = snaps.embedder_cell();
    let embed_text = text.clone();
    let embedding = tauri::async_runtime::spawn_blocking(move || {
        let embedder = *emb_cell.get_or_init(crate::embedding::current);
        crate::embedding::embed_with(&embed_text, embedder).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())?;
    // Semantic edges (payoff layer): link this page to its nearest already-
    // captured neighbours by snapshot embedding, so topic clusters surface in
    // the Trail across navigation branches. ~1.5k dot products — microseconds.
    const SEM_K: usize = 3;
    const SEM_THRESHOLD: f32 = 0.55;
    let neighbours = snaps.neighbours(&embedding, visit_id, SEM_K, SEM_THRESHOLD);
    // Entities + citation edges (payoff layer): upgrade the nav-time URL-only
    // pass with what the page text mentions, then link shared papers/repos.
    let entities = extract_entities(&url, &text);
    let id = snaps.add(visit_id, url, title, text, embedding);
    match attach_or_discard(&trace, &snaps, visit_id, id) {
        Some(sid) if sid == id => {}
        other => return Ok(other),
    }
    trace.add_semantic_edges(visit_id, &neighbours);
    trace.set_entities(visit_id, entities);
    trace.derive_entity_edges(visit_id);
    Ok(Some(id))
}

/// Attach snapshot `id` (just added) to `visit`, or remove it if the capture
/// lost a race while embedding: the visit was forgotten or evicted (`None`), or
/// a concurrent capture attached first (its id). Kept, ours would be an orphan
/// the KB reindex folds back into `web` (doc_id = visit id). An attach that
/// wins is safe too: trace_forget drops visits before it cascades, so its
/// cascade removes the snapshot. Returns the visit's snapshot id.
fn attach_or_discard(
    trace: &TraceStore,
    snaps: &TraceSnapshots,
    visit: VisitId,
    id: u64,
) -> Option<u64> {
    let attached = trace.attach_snapshot(visit, id);
    if attached != Some(id) {
        snaps.remove(id);
    }
    attached
}

/// Ambient watcher (ADR 0011, local-only): if the tab's current page shows an
/// error signature you've hit before, return the past sightings — flagging any
/// with a chat thread attached ("you may have solved it there"). Empty for
/// pages with no shaped error lines, which is the overwhelmingly common case —
/// the snapshot-store scan only runs when the current page actually has one.
/// Reads only local stores; never the network.
#[tauri::command]
pub async fn trace_ambient(
    app: tauri::AppHandle,
    state: State<'_, crate::state::FluxState>,
    tab_id: TabId,
) -> Result<Vec<AmbientHint>, String> {
    let Some((url, sigs)) = ({
        // Extract from the live DOM cache, dropping the guard before the scan.
        state
            .dom_cache
            .get(&tab_id)
            .map(|snap| (snap.url.clone(), ambient::error_signatures(&snap.text)))
    }) else {
        return Ok(Vec::new());
    };
    if sigs.is_empty() {
        return Ok(Vec::new());
    }
    // The scan can walk up to 1,500 × 20 KiB of snapshot text, and the
    // Connections rail asks on every page publish: never on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        let mut hints = ambient::find_past_sightings(&app.state::<TraceSnapshots>(), &sigs, &url);
        let chats = app.state::<TraceChats>();
        for h in &mut hints {
            h.has_chat = chats.has_thread(h.visit_id);
        }
        hints
    })
    .await
    .map_err(|e| e.to_string())
}

/// Is draft capture on? Asked once by the injected `drafts.js` at page load —
/// when off (the default) the script attaches no listeners at all. A `fluxtab`
/// plugin command so remote pages may call it (it leaks one boolean).
#[tauri::command]
pub fn trace_drafts_enabled(drafts: State<'_, TraceDrafts>) -> bool {
    drafts.enabled()
}

/// Toggle draft capture (Settings → Privacy; applies to newly-loaded pages).
#[tauri::command]
pub fn trace_drafts_set(drafts: State<'_, TraceDrafts>, on: bool) {
    drafts.set_enabled(on);
}

/// A visit's captured drafts, for the Trail detail panel.
#[tauri::command]
pub fn trace_drafts(drafts: State<'_, TraceDrafts>, visit_id: VisitId) -> Vec<Draft> {
    drafts.get(visit_id)
}

/// Store a typed draft against the tab's current Visit (ADR 0011 final phase).
/// Page-callable (`fluxtab`), so every gate re-runs here regardless of what the
/// page sent: the opt-in toggle, the private-tab exclusion, and the structural
/// redaction (sensitive field names, Luhn card filter — see `drafts::redact`).
/// The ADR's login-form rule is enforced upstream in `drafts.js` (any form
/// containing a password input is skipped wholesale); a host-wide vault gate was
/// considered and rejected — it would disable drafting on every site you hold
/// credentials for (e.g. writing a GitHub issue), which is the feature's point.
#[tauri::command]
pub fn draft_publish(
    webview: tauri::Webview,
    trace: State<'_, TraceStore>,
    drafts: State<'_, TraceDrafts>,
    state: State<'_, crate::state::FluxState>,
    tab_id: TabId,
    field: String,
    text: String,
) -> Result<(), String> {
    // Bind the claimed tab to the calling webview, as dom_publish does: the
    // label is Flux's own (`tab-{id}`), so a page can't plant, overwrite or
    // evict drafts on another tab's visit by sending its id.
    let caller = webview
        .label()
        .strip_prefix("tab-")
        .and_then(|s| s.parse::<TabId>().ok());
    if caller != Some(tab_id) {
        return Err("tab_id does not match the calling tab".into());
    }
    if !drafts.enabled() {
        return Ok(()); // toggled off after page load — drop silently
    }
    // Private tabs leave no trace, drafts included.
    if state.tabs.get(&tab_id).map(|t| t.private).unwrap_or(true) {
        return Ok(());
    }
    let Some(visit_id) = trace.current_visit(tab_id) else {
        return Ok(());
    };
    if let Some((field, text)) = drafts::redact(&field, &text) {
        drafts.put(visit_id, field, text);
    }
    Ok(())
}

/// A visit's chat thread (ADR 0011 step d) — empty if none yet.
#[tauri::command]
pub fn trace_chat(chats: State<'_, TraceChats>, visit_id: VisitId) -> Vec<ChatMsg> {
    chats.get(visit_id)
}

/// The active page's persistent thread, re-attached by visit (ADR 0011
/// follow-up): the agent sidebar shows a "💬 Page thread" scope when the tab
/// has a current Visit, so the conversation you started on this page — in the
/// sidebar or the Trail — continues in either place. `None` when the tab has
/// no Visit (internal pages, private tabs).
#[derive(serde::Serialize, specta::Type)]
pub struct TabThread {
    pub visit_id: VisitId,
    pub msgs: Vec<ChatMsg>,
}

#[tauri::command]
pub fn trace_tab_thread(
    trace: State<'_, TraceStore>,
    chats: State<'_, TraceChats>,
    tab_id: TabId,
) -> Option<TabThread> {
    let visit_id = trace.current_visit(tab_id)?;
    Some(TabThread {
        visit_id,
        msgs: chats.get(visit_id),
    })
}

/// Send a message to a visit's chat (ADR 0011 step d): grounded in the visit's
/// dwell-snapshot text, streamed token-by-token over `on_token` (JSON events
/// `{kind:"token",text}` / `{kind:"done"}`, like `kb_answer`). Both sides of the
/// exchange are appended to the thread, which persists — return to the page (or
/// its Trail node) months later and the conversation is still attached.
#[tauri::command]
pub async fn trace_chat_send(
    trace: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    chats: State<'_, TraceChats>,
    visit_id: VisitId,
    message: String,
    on_token: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("empty message".into());
    }
    let Some(visit) = trace.visit(visit_id) else {
        return Err("that page is no longer in the Trail".into());
    };
    let snapshot_text = visit
        .snapshot_id
        .and_then(|sid| snaps.get(sid))
        .map(|s| s.text);
    let thread = chats.get(visit_id);
    let prompt = chat_prompt(&visit, snapshot_text.as_deref(), &thread, &message);
    // Record the user side before inference so a crash mid-stream can't lose it.
    chats.append(visit_id, "user", &message);
    if drop_if_forgotten(&trace, &chats, visit_id) {
        return Err("that page is no longer in the Trail".into());
    }

    // Inference on a blocking thread (CPU/GPU-bound), streaming frames out.
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let mut sink = |tok: &str| {
            let _ = on_token.send(serde_json::json!({ "kind": "token", "text": tok }).to_string());
        };
        let r = crate::agent_bridge::planner().chat_stream(&prompt, None, &mut sink);
        let _ = on_token.send(serde_json::json!({ "kind": "done" }).to_string());
        r
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    chats.append(visit_id, "assistant", &reply);
    // If a forget ran during inference, its cascade has passed and this append
    // re-created the thread.
    if drop_if_forgotten(&trace, &chats, visit_id) {
        return Err("that page was forgotten while answering".into());
    }
    Ok(())
}

/// Append-then-recheck for a page chat: if `visit` left the Trail, drop the
/// thread our append (re)created. trace_forget drops visits before it cascades,
/// so either the visit is gone by now or its cascade runs after our append.
/// Returns whether the thread was dropped.
fn drop_if_forgotten(trace: &TraceStore, chats: &TraceChats, visit: VisitId) -> bool {
    if trace.visit(visit).is_some() {
        return false;
    }
    chats.forget_visits(&std::collections::HashSet::from([visit]));
    true
}

/// Forget part (or all) of the Trail — the day-one privacy control (ADR 0011).
/// Cascades to the visits' dwell snapshots, their chat threads, AND the KB's
/// `web` corpus: a forgotten page must leave everything immediately, not linger
/// until the next manual reindex.
#[tauri::command]
pub async fn trace_forget(
    store: State<'_, TraceStore>,
    snaps: State<'_, TraceSnapshots>,
    chats: State<'_, TraceChats>,
    drafts: State<'_, TraceDrafts>,
    kb: State<'_, crate::kb::KbStore>,
    scope: ForgetScope,
) -> Result<(), String> {
    let removed = forget_and_sweep(&store, &snaps, &chats, &drafts, &scope);
    if removed.is_empty() {
        return Ok(());
    }
    // KB doc_id for a web doc = the visit id. Purge on a blocking task — the KB
    // may hydrate from disk here, and the retain pass walks every chunk.
    let doc_ids: Vec<String> = removed.iter().map(|v| v.to_string()).collect();
    let kb = (*kb).clone();
    tauri::async_runtime::spawn_blocking(move || kb.remove_docs("web", &doc_ids))
        .await
        .map_err(|e| e.to_string())
}

/// `trace_forget` short of the KB purge: drop the visits in `scope`, then sweep
/// snapshots, threads and drafts against the visits still live, not just the
/// removed ones. Eviction past MAX_VISITS cascades to nothing, so even "Forget
/// the whole Trail" would leave those visits' data on disk (and their snapshots
/// in the KB). Returns the visit ids whose KB `web` docs must go.
fn forget_and_sweep(
    store: &TraceStore,
    snaps: &TraceSnapshots,
    chats: &TraceChats,
    drafts: &TraceDrafts,
    scope: &ForgetScope,
) -> std::collections::HashSet<VisitId> {
    // Visits before the sweep: an in-flight capture or chat reply adds, then
    // re-checks its visit (see `attach_or_discard`, `drop_if_forgotten`).
    let mut removed: std::collections::HashSet<VisitId> = store.forget(scope).into_iter().collect();
    let live = store.live_ids();
    removed.extend(snaps.retain_live(&live));
    chats.retain_live(&live);
    drafts.retain_live(&live);
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn a_capture_that_loses_a_race_leaves_no_snapshot() {
        let trace = TraceStore::default();
        let snaps = TraceSnapshots::empty_for_tests();
        let snap =
            |v: VisitId| snaps.add(v, format!("https://{v}/"), "T".into(), "t".into(), vec![]);

        // Two captures of one visit both embedded: the one attaching second
        // backs out, so the visit keeps one snapshot (one KB `web` doc).
        let v = trace.record(1, "https://a.com/", "A", None, None).unwrap();
        let (first, second) = (snap(v), snap(v));
        assert_eq!(attach_or_discard(&trace, &snaps, v, first), Some(first));
        assert_eq!(attach_or_discard(&trace, &snaps, v, second), Some(first));
        assert!(snaps.get(second).is_none());
        assert_eq!(snaps.web_docs().len(), 1);

        // trace_forget lands mid-embed: the visit and its (still empty) cascade
        // are done before the capture stores anything.
        let w = trace.record(2, "https://b.com/", "B", None, None).unwrap();
        let gone: HashSet<VisitId> = trace.forget(&ForgetScope::All).into_iter().collect();
        snaps.forget_visits(&gone);
        let id = snap(w);
        let generation = snaps.generation();
        assert_eq!(attach_or_discard(&trace, &snaps, w, id), None);
        assert!(snaps.get(id).is_none(), "no orphan for the KB reindex");
        assert!(
            snaps.generation() > generation,
            "a reindex since the add re-syncs"
        );
    }

    #[test]
    fn a_reply_for_a_forgotten_page_is_not_kept() {
        let trace = TraceStore::default();
        let chats = TraceChats::default();
        let v = trace.record(1, "https://a.com/", "A", None, None).unwrap();
        chats.append(v, "user", "what is this page about?");
        assert!(!drop_if_forgotten(&trace, &chats, v));
        // Forgotten during inference: the cascade drops the thread, then the
        // reply re-creates it for a visit that's gone.
        let gone: HashSet<VisitId> = trace.forget(&ForgetScope::All).into_iter().collect();
        chats.forget_visits(&gone);
        chats.append(v, "assistant", "it is about lifetimes");
        assert!(drop_if_forgotten(&trace, &chats, v));
        assert!(!chats.has_thread(v));
    }

    #[test]
    fn forget_sweeps_data_the_trail_no_longer_reaches() {
        let trace = TraceStore::default();
        let snaps = TraceSnapshots::empty_for_tests();
        let chats = TraceChats::default();
        let drafts = TraceDrafts::default();
        let kept = trace
            .record(1, "https://kept.com/", "K", None, None)
            .unwrap();
        let gone = trace
            .record(2, "https://gone.com/", "G", None, None)
            .unwrap();
        // A visit evicted past MAX_VISITS: eviction cascades to nothing, so its
        // snapshot, thread and drafts outlive it, under an id the Trail lost.
        let evicted: VisitId = 999;
        for v in [kept, gone, evicted] {
            snaps.add(v, format!("https://{v}/"), "T".into(), "t".into(), vec![]);
            chats.append(v, "user", "what was this page about?");
            drafts.put(v, "comment".into(), "a half-written reply".into());
        }
        let scope = ForgetScope::Url {
            url: "https://gone.com/".into(),
        };
        let removed = forget_and_sweep(&trace, &snaps, &chats, &drafts, &scope);
        assert_eq!(removed, HashSet::from([gone, evicted]), "both leave the KB");
        for v in [gone, evicted] {
            assert!(!chats.has_thread(v) && drafts.get(v).is_empty(), "{v}");
        }
        let docs: Vec<String> = snaps.web_docs().into_iter().map(|d| d.doc_id).collect();
        assert_eq!(docs, vec![kept.to_string()]);
        assert!(chats.has_thread(kept) && !drafts.get(kept).is_empty());
    }
}
