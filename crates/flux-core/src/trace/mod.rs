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
mod entities;
mod snapshots;
mod store;

pub use ambient::AmbientHint;
pub use chats::{ChatMsg, TraceChats};
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

/// The provenance graph (optionally time-windowed) for the Trail view.
#[tauri::command]
pub fn trace_graph(
    store: State<'_, TraceStore>,
    after_ms: Option<u64>,
    before_ms: Option<u64>,
) -> TraceGraph {
    store.graph(after_ms, before_ms)
}

/// Visit-density histogram for the Trail scrubber's activity backdrop.
#[tauri::command]
pub fn trace_histogram(store: State<'_, TraceStore>, buckets: Option<usize>) -> TraceHistogram {
    store.histogram(buckets.unwrap_or(120))
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
/// `None` if there's no current visit / no cached text yet.
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
    trace.attach_snapshot(visit_id, id);
    trace.add_semantic_edges(visit_id, &neighbours);
    trace.set_entities(visit_id, entities);
    trace.derive_entity_edges(visit_id);
    Ok(Some(id))
}

/// Ambient watcher (ADR 0011, local-only): if the tab's current page shows an
/// error signature you've hit before, return the past sightings — flagging any
/// with a chat thread attached ("you may have solved it there"). Empty for
/// pages with no shaped error lines, which is the overwhelmingly common case —
/// the snapshot-store scan only runs when the current page actually has one.
/// Reads only local stores; never the network.
#[tauri::command]
pub fn trace_ambient(
    snaps: State<'_, TraceSnapshots>,
    chats: State<'_, TraceChats>,
    state: State<'_, crate::state::FluxState>,
    tab_id: TabId,
) -> Vec<AmbientHint> {
    let Some((url, sigs)) = ({
        // Extract from the live DOM cache, dropping the guard before the scan.
        state
            .dom_cache
            .get(&tab_id)
            .map(|snap| (snap.url.clone(), ambient::error_signatures(&snap.text)))
    }) else {
        return Vec::new();
    };
    if sigs.is_empty() {
        return Vec::new();
    }
    let mut hints = ambient::find_past_sightings(&snaps, &sigs, &url);
    for h in &mut hints {
        h.has_chat = chats.has_thread(h.visit_id);
    }
    hints
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
    Ok(())
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
    kb: State<'_, crate::kb::KbStore>,
    scope: ForgetScope,
) -> Result<(), String> {
    let removed: std::collections::HashSet<VisitId> = store.forget(&scope).into_iter().collect();
    snaps.forget_visits(&removed);
    chats.forget_visits(&removed);
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
