//! Flux Agent IPC — chat (plain + streaming), planning/step execution, model
//! selection, chat-with-tabs, and the semantic omni-search over open tabs.
//!
//! Split out of `commands.rs` (Phase 2 refactor). All model work happens on
//! blocking tasks via `crate::agent_bridge::planner()`; nothing here holds a
//! lock across an await.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dom::cap_utf8;
use crate::state::{AgentStatus, FluxState, TabId, TabKind};

// ─── Flux Agent ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_status(state: State<'_, FluxState>) -> AgentStatus {
    state.agent.read().clone()
}

/// Free-form chat with the local model — no page required. If a page is open,
/// its visible text is passed as context so you can ask *about* the page.
/// Returns the model's text reply.
#[tauri::command]
pub async fn agent_chat(state: State<'_, FluxState>, prompt: String) -> Result<String, String> {
    // Clone the page text out (if any) so the blocking task owns it.
    let page = state.active_snapshot().map(|s| Arc::clone(&s.text));
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().chat(&prompt, page.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Ask the local model to turn a natural-language request into a shell command
/// (e.g. "list the files in my home directory" → `ls ~`), or `None` if it's a
/// conversational request. The frontend proposes the command with a Run/Cancel
/// approval card; nothing executes here.
#[tauri::command]
pub async fn agent_shell_plan(prompt: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_shell(&prompt)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decompose a compound request into an ordered list of single-action sub-commands
/// the frontend routes one at a time (#115 multi-step). One step back = a single
/// action or a plain question.
#[tauri::command]
pub async fn agent_plan_steps(goal: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_steps(&goal)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adaptive goal loop: pick the next command given the goal + history of results so
/// far (#115 follow-up — "run → read the failure → fix → re-run").
#[tauri::command]
pub async fn agent_next_step(
    goal: String,
    history: Vec<String>,
) -> Result<flux_agent::NextStep, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_next_step(&goal, &history)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Plan a file edit (search/replace pairs) from a natural-language instruction. The
/// frontend applies the edits, shows a diff, and writes only after the user approves.
#[tauri::command]
pub async fn agent_edit_plan(
    path: String,
    content: String,
    instruction: String,
) -> Result<flux_agent::EditPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_edit(&path, &content, &instruction)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Map a natural-language Power Platform request to a single `pac` (Power
/// Platform CLI) command (#135 follow-up / deterministic ALM path). Returns the
/// planned command plus a Rust-derived risk classification; nothing runs here —
/// the frontend shows it on the approval-gated shell card and executes only on
/// the user's Run. Pairs with the browser-automation playbooks for the parts of
/// Power Apps/Automate that have no CLI.
#[tauri::command]
pub async fn agent_pac_plan(request: String) -> Result<flux_agent::pac::PacPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .plan_pac(&request)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Preflight for the `pac` tool: is the CLI installed, and is there an active
/// auth profile? Both checks are read-only `pac` invocations. Lets the agent
/// tell the user to install `pac` or run `pac auth create` before proposing ALM
/// commands, instead of failing opaquely at run time.
#[derive(serde::Serialize, specta::Type)]
pub struct PacStatus {
    /// `pac` is on PATH (its `--version` ran).
    pub installed: bool,
    /// `pac auth list` reported at least one profile.
    pub authenticated: bool,
    /// Version string or the first diagnostic line, for display.
    pub detail: String,
}

#[tauri::command]
pub async fn pac_status() -> PacStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let run = |args: &str| crate::exec::run_captured(&format!("pac {args}"));
        match run("--version") {
            Ok(ver) if !ver.trim().is_empty() => {
                // Installed — now probe auth. A profile list mentions the env/URL;
                // "No profiles were found" (any casing) means not signed in.
                let auth = run("auth list").unwrap_or_default();
                let authenticated = !auth.trim().is_empty()
                    && !auth.to_ascii_lowercase().contains("no profiles")
                    && !auth.to_ascii_lowercase().contains("no auth");
                PacStatus {
                    installed: true,
                    authenticated,
                    detail: ver.lines().next().unwrap_or("").trim().to_string(),
                }
            }
            _ => PacStatus {
                installed: false,
                authenticated: false,
                detail: "Power Platform CLI (`pac`) isn't installed or isn't on PATH".into(),
            },
        }
    })
    .await
    .unwrap_or(PacStatus {
        installed: false,
        authenticated: false,
        detail: "preflight failed".into(),
    })
}

/// Structural reading (#41 upgrade): classify the reader-mode document and map
/// its headings onto canonical sections (paper → Abstract/Methods/Results,
/// recipe → Ingredients/Steps, …). One small schema-constrained completion,
/// Rust-validated — hallucinated labels never reach the UI. The reader's
/// deterministic outline works without this; these are the smart chips on top.
#[tauri::command]
pub async fn reader_structure(
    title: String,
    headings: Vec<String>,
) -> Result<flux_agent::ReadingStructure, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner()
            .structure_reading(&title, &headings)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streaming chat (BACKLOG #82): same as [`agent_chat`] but relays each token to
/// the frontend over `on_token` as the model generates it, so the sidebar renders
/// the reply live. Resolves when the completion ends.
#[tauri::command]
pub async fn agent_chat_stream(
    state: State<'_, FluxState>,
    prompt: String,
    on_token: Channel<String>,
) -> Result<(), String> {
    let page = state.active_snapshot().map(|s| Arc::clone(&s.text));
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut sink = |tok: &str| {
            let _ = on_token.send(tok.to_string()); // ignore if the frontend dropped it
        };
        crate::agent_bridge::planner()
            .chat_stream(&prompt, page.as_deref(), &mut sink)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Translate the active page's visible text to `target` with the local model
/// (BACKLOG #40). Private — no cloud translation service.
#[tauri::command]
pub async fn agent_translate(
    state: State<'_, FluxState>,
    target: String,
) -> Result<String, String> {
    let page = state.active_snapshot().ok_or("open a page to translate")?;
    if page.text.trim().is_empty() {
        return Err("this page has no readable text".into());
    }
    let text = Arc::clone(&page.text);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().translate(&target, &text)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// List the models the local Ollama server has pulled (#81).
#[tauri::command]
pub async fn agent_models() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(flux_agent::ollama::list_models)
        .await
        .unwrap_or_default()
}

/// The model the agent is currently using (#81).
#[tauri::command]
pub fn agent_model() -> String {
    flux_agent::ollama::active_model()
}

/// Switch the agent's model (#81); empty reverts to the env/default.
#[tauri::command]
pub fn agent_set_model(name: String) {
    flux_agent::ollama::set_model(&name);
}

/// Chat grounded in the captured text of several tabs (chat-with-tabs). Gathers
/// each tab's cached DOM text (capped per tab), labels it, and asks the local
/// model. Tabs without a snapshot yet are skipped.
///
/// Confidentiality gate (ADR 0013, Pillar 0): reads are limited to `tab_ids` —
/// the tabs the frontend explicitly passed. The model cannot widen this (it emits
/// a text answer or a fixed-vocabulary action, never "read another tab"), so a
/// hostile tab in the set can't make the agent reach a tab outside it. Each tab's
/// body is fenced as untrusted so one tab can't forge another's header.
fn combine_tab_context(state: &FluxState, tab_ids: &[TabId]) -> String {
    const PER_TAB: usize = 4 * 1024;
    let mut combined = String::new();
    let mut unread: Vec<String> = Vec::new();
    for id in tab_ids {
        let Some(snap) = state.dom_cache.get(id) else {
            // A tab with no snapshot was silently dropped, so the model answered
            // from a subset of "all tabs" while believing it had all of them —
            // and confidently said a thing wasn't there when it simply hadn't
            // been read. Name them instead: hibernated and never-focused tabs
            // have nothing captured yet.
            unread.push(
                state
                    .tabs
                    .get(id)
                    .map(|t| {
                        let label = if t.title.trim().is_empty() {
                            t.url.clone()
                        } else {
                            t.title.clone()
                        };
                        label.replace(['\n', '\r'], " ")
                    })
                    .unwrap_or_else(|| format!("tab {id}")),
            );
            continue;
        };
        let title = state
            .tabs
            .get(id)
            .map(|t| t.title.clone())
            .filter(|t| !t.trim().is_empty());
        let label = title.unwrap_or_else(|| snap.url.to_string());
        // One-line, sanitized header so a hostile title can't break the structure
        // or forge a fence; the body is individually fenced as untrusted.
        let label = label.replace(['\n', '\r'], " ");
        let url = snap.url.replace(['\n', '\r'], " ");
        combined.push_str(&format!("--- TAB: {label} ({url}) ---\n"));
        combined.push_str(&flux_agent::wrap_untrusted(&cap_utf8(
            snap.text.to_string(),
            PER_TAB,
        )));
        combined.push_str("\n\n");
    }
    if !unread.is_empty() {
        combined.push_str(&format!(
            "--- NOT READ ({}) ---\nThese tabs are open but have no captured text yet \
             (asleep, or never brought to the front). Say so if the answer might be in \
             one of them; do not claim the information does not exist.\n{}\n\n",
            unread.len(),
            unread.join("\n")
        ));
    }
    combined
}

#[tauri::command]
pub async fn agent_chat_tabs(
    state: State<'_, FluxState>,
    prompt: String,
    tab_ids: Vec<TabId>,
) -> Result<String, String> {
    let combined = combine_tab_context(&state, &tab_ids);
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().chat_pages(&prompt, &combined)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Streaming counterpart of [`agent_chat_tabs`] (BACKLOG #82) — gathers the same
/// per-tab context, then relays the model's tokens live over `on_token`.
#[tauri::command]
pub async fn agent_chat_tabs_stream(
    state: State<'_, FluxState>,
    prompt: String,
    tab_ids: Vec<TabId>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let combined = combine_tab_context(&state, &tab_ids);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut sink = |tok: &str| {
            let _ = on_token.send(tok.to_string());
        };
        crate::agent_bridge::planner()
            .chat_pages_stream(&prompt, &combined, &mut sink)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One unified search result (BACKLOG #66): an open tab, a bookmark, or a
/// history entry, ranked together by embedding similarity to the query.
#[derive(serde::Serialize, specta::Type)]
pub struct OmniHit {
    pub kind: String, // "tab" | "bookmark" | "history"
    pub tab_id: Option<TabId>,
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub score: f32,
}

/// Cosine of two L2-normalized embeddings (flux_embed vectors are unit length).
fn cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// A short context snippet around the first query token in `text`.
fn snippet(text: &str, toks: &[&str]) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lower = text.to_lowercase();
    match toks.iter().filter_map(|t| lower.find(t)).min() {
        Some(p) => {
            let start = text[..p]
                .char_indices()
                .rev()
                .nth(40)
                .map(|(i, _)| i)
                .unwrap_or(0);
            let end = text[p..]
                .char_indices()
                .nth(120)
                .map(|(i, _)| p + i)
                .unwrap_or(text.len());
            format!(
                "…{}…",
                text[start..end]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        }
        None => text
            .split_whitespace()
            .take(18)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Semantic everything-search (BACKLOG #66): one query ranked across open tabs
/// (by title + captured page CONTENT), bookmarks, and history, using the local
/// embedder (#11 will swap in a stronger model). Large corpora (history,
/// bookmarks) are lexically pre-filtered before embedding so this stays cheap
/// per keystroke. NB: the hashing embedder ranks by lexical/topical overlap, not
/// true synonymy — that arrives with #11.
#[tauri::command]
pub fn omni_search(
    state: State<'_, FluxState>,
    history: State<'_, crate::history::HistoryStore>,
    bookmarks: State<'_, crate::bookmarks::BookmarkStore>,
    query: String,
    limit: Option<usize>,
) -> Vec<OmniHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let qe = flux_embed::embed(q);
    let ql = q.to_lowercase();
    let toks: Vec<&str> = ql
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .collect();
    let lex = |s: &str| {
        let s = s.to_lowercase();
        toks.iter().any(|t| s.contains(t))
    };
    let mut hits: Vec<OmniHit> = Vec::new();

    // Open tabs — embed title + cached page text (this is the page-CONTENT search
    // that's weak in other browsers). A title/url lexical hit gets a boost.
    for t in state.tabs.iter() {
        if !matches!(t.kind, TabKind::Browser) {
            continue;
        }
        let text = state
            .dom_cache
            .get(&t.id)
            .map(|s| s.text.to_string())
            .unwrap_or_default();
        let e = flux_embed::embed(&format!("{} {}", t.title, text));
        let mut score = cos(&qe, &e);
        if lex(&t.title) || lex(&t.url) {
            score += 0.3;
        }
        // Skip near-zero matches so the list isn't padded with every open tab.
        if score < 0.08 {
            continue;
        }
        hits.push(OmniHit {
            kind: "tab".into(),
            tab_id: Some(t.id),
            title: t.title.clone(),
            url: t.url.clone(),
            snippet: snippet(&text, &toks),
            score,
        });
    }

    // Bookmarks — lexical pre-filter, then embed (user-curated, lightly favored).
    for b in bookmarks.list() {
        if !lex(&b.title) && !lex(&b.url) && !lex(&b.folder) {
            continue;
        }
        let e = flux_embed::embed(&format!("{} {} {}", b.title, b.folder, b.url));
        let mut score = cos(&qe, &e) + 0.12;
        if lex(&b.title) {
            score += 0.2;
        }
        hits.push(OmniHit {
            kind: "bookmark".into(),
            tab_id: None,
            title: b.title,
            url: b.url,
            snippet: b.folder,
            score,
        });
    }

    // History — `search` already lexical-filters + frecency-ranks; embed the top.
    for h in history.search(q, 60) {
        let e = flux_embed::embed(&format!("{} {}", h.title, h.url));
        hits.push(OmniHit {
            kind: "history".into(),
            tab_id: None,
            title: h.title,
            url: h.url,
            snippet: String::new(),
            score: cos(&qe, &e),
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit.unwrap_or(14));
    hits
}

/// Natural language → planned DOM action → JS injected into the active tab's
/// webview. Async so a 12B model's planning latency never blocks the IPC pool.
#[tauri::command]
pub async fn agent_execute(
    app: AppHandle,
    state: State<'_, FluxState>,
    prompt: String,
) -> Result<flux_agent::AgentAction, String> {
    let snap = state
        .active_snapshot()
        .ok_or("no page context — open a tab first")?;
    let tab = snap.tab;

    // 1. Flip to Thinking — frontend swaps the sidebar to the kinetic gradient.
    *state.agent.write() = AgentStatus::Thinking {
        prompt: prompt.clone(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());

    // 2. Plan on a blocking thread: inference is CPU/GPU-bound and must not
    //    starve the async runtime. `Arc<str>` clone = pointer copy, not text.
    //    The page URL rides along so a domain playbook can guide the model.
    let page_text = Arc::clone(&snap.text);
    let url = snap.url.clone();
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan(&prompt, &page_text, &url)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        *state.agent.write() = AgentStatus::Error {
            message: e.to_string(),
        };
        let _ = app.emit("flux://agent-status", state.agent.read().clone());
        e.to_string()
    })?;

    // 3. Compile to JS and inject into the tab's webview. The compiled script
    //    first paints the magenta highlight, then performs the action.
    *state.agent.write() = AgentStatus::Acting {
        description: action.describe(),
        selector: action.selector().unwrap_or_default().to_owned(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());

    let js = action.to_js();
    let webview = app
        .get_webview(&format!("tab-{tab}"))
        .ok_or_else(|| format!("webview tab-{tab} not found"))?;
    webview.eval(&js).map_err(|e| e.to_string())?;

    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

/// Plan a page action WITHOUT executing it (BACKLOG #8): the frontend previews
/// the proposed action and asks the user to approve before anything touches the
/// page. Returns the planned action; status returns to Idle (we're awaiting
/// confirmation, not acting).
#[tauri::command]
pub async fn agent_plan(
    app: AppHandle,
    state: State<'_, FluxState>,
    prompt: String,
) -> Result<flux_agent::AgentAction, String> {
    let snap = state
        .active_snapshot()
        .ok_or("no page context — open a tab first")?;
    *state.agent.write() = AgentStatus::Thinking {
        prompt: prompt.clone(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let page_text = Arc::clone(&snap.text);
    let url = snap.url.clone();
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan(&prompt, &page_text, &url)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        *state.agent.write() = AgentStatus::Error {
            message: e.to_string(),
        };
        let _ = app.emit("flux://agent-status", state.agent.read().clone());
        e.to_string()
    })?;
    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

/// Plan the **next step** of a multi-step task (BACKLOG #A). The frontend agent
/// loop drives this: it passes the high-level `goal` and the list of steps
/// already taken (`history`), and gets back the single next `AgentAction` —
/// `finish` when done, `refuse` if stuck. Like `agent_plan`, this does NOT touch
/// the page; the frontend previews the step and runs it via `agent_run_action`
/// only after the user approves (or in "run all" mode, after the destructive
/// guard clears). Reads the **live** active-tab snapshot every call, so cross-
/// page tasks work as navigation republishes the DOM.
#[tauri::command]
pub async fn agent_task_step(
    app: AppHandle,
    state: State<'_, FluxState>,
    goal: String,
    history: Vec<String>,
) -> Result<flux_agent::AgentAction, String> {
    let snap = state
        .active_snapshot()
        .ok_or("no page context — open a tab first")?;
    *state.agent.write() = AgentStatus::Thinking {
        prompt: goal.clone(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let page_text = Arc::clone(&snap.text);
    let url = snap.url.clone();
    let action = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().plan_step(&goal, &page_text, &history, &url)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        *state.agent.write() = AgentStatus::Error {
            message: e.to_string(),
        };
        let _ = app.emit("flux://agent-status", state.agent.read().clone());
        e.to_string()
    })?;
    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}

/// Execute a previously-planned action that the user approved (BACKLOG #8).
/// Compiles it to JS (the script paints the magenta highlight, then acts) and
/// injects it into the active tab's webview.
#[tauri::command]
pub async fn agent_run_action(
    app: AppHandle,
    state: State<'_, FluxState>,
    action: flux_agent::AgentAction,
) -> Result<flux_agent::AgentAction, String> {
    let tab = state.active_tab().ok_or("no active tab")?;
    // #104: flag destructive intent for the activity feed. The compiled click
    // JS independently re-checks the element's *live* label and aborts there —
    // this annotation is the user-facing heads-up, not the enforcement point.
    let description = match action.is_destructive() {
        Some(term) => {
            tracing::warn!(target: "flux::agent", term, "destructive action queued — guard will verify the live label");
            format!(
                "⚠ {} (destructive: “{term}” — Flux will block it if the control confirms it)",
                action.describe()
            )
        }
        None => action.describe(),
    };
    *state.agent.write() = AgentStatus::Acting {
        description,
        selector: action.selector().unwrap_or_default().to_owned(),
    };
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    let webview = app
        .get_webview(&format!("tab-{tab}"))
        .ok_or_else(|| format!("webview tab-{tab} not found"))?;
    webview.eval(action.to_js()).map_err(|e| e.to_string())?;
    // Sentinel audit log (ADR 0013, Pillar 0): record every action the agent runs
    // on the user's behalf. `confirmed: true` — this command is only reached after
    // the frontend's approval card.
    if let Some(audit) = app.try_state::<crate::sentinel::SentinelAudit>() {
        audit.record(crate::sentinel::AuditEntry {
            ms: 0,
            tab,
            action: action.describe(),
            destructive: action.is_destructive().map(|t| t.to_string()),
            confirmed: true,
        });
    }
    *state.agent.write() = AgentStatus::Idle;
    let _ = app.emit("flux://agent-status", state.agent.read().clone());
    Ok(action)
}
