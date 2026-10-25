//! Cited answers about the open page (Flux Next "cited answers"; the rules are
//! in `flux_agent::cited`). The page's captured text is cut into numbered
//! passages, the answer streams back citing them, and a citation clicked in
//! the agent panel scrolls the page to its passage and highlights it
//! (`assets/cite.js`, run in Flux's own JavaScript world).

use std::sync::Arc;
use std::time::Duration;

use flux_agent::cited::{self, CitedAnswer};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::state::{FluxState, TabId};

/// One frame of a cited answer: its tokens as they come, then the answer
/// worked out, with the tab and page it's about.
#[derive(Serialize, Clone, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PageAnswerEvent {
    Token {
        text: String,
    },
    Done {
        answer: CitedAnswer,
        tab: TabId,
        url: String,
        title: String,
    },
}

/// Answer `prompt` from the active page, citing its passages.
#[tauri::command]
pub async fn agent_page_answer(
    app: AppHandle,
    state: State<'_, FluxState>,
    prompt: String,
    on_event: Channel<PageAnswerEvent>,
) -> Result<(), String> {
    let snap = crate::dom::active_fresh(&app, &state)
        .await
        .filter(|s| !s.text.trim().is_empty())
        .ok_or("open a page with some text first")?;
    let tab = snap.tab;
    let url = snap.url.clone();
    let title = state
        .tabs
        .get(&tab)
        .map(|t| t.title.clone())
        .unwrap_or_default();
    let text = Arc::clone(&snap.text);
    let t = title.clone();
    let tx = on_event.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let passages = cited::passages(&text, flux_agent::PAGE_BUDGET_CHAT);
        let mut sink = |tok: &str| {
            let _ = tx.send(PageAnswerEvent::Token {
                text: tok.to_string(),
            });
        };
        crate::agent_bridge::planner().cited_answer_stream(&prompt, &passages, &t, &mut sink)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let _ = on_event.send(PageAnswerEvent::Done {
        answer,
        tab,
        url,
        title,
    });
    Ok(())
}

const CITE_JS: &str = include_str!("../assets/cite.js");

/// The URL without its fragment: a page that scrolled to an anchor is the same page.
fn same_page(a: &str, b: &str) -> bool {
    let strip = |u: &str| {
        u.split('#')
            .next()
            .unwrap_or(u)
            .trim_end_matches('/')
            .to_string()
    };
    strip(a) == strip(b)
}

/// Show passage `n` (`text`) on `tab`, if it still shows `url`. Returns
/// `shown`, `not_found`, `moved` (the tab went elsewhere) or `unavailable`
/// (no page access here).
#[tauri::command]
pub async fn agent_cite_show(
    app: AppHandle,
    tab: TabId,
    url: String,
    text: String,
    n: u32,
) -> Result<String, String> {
    let current = app
        .get_webview(&format!("tab-{tab}"))
        .and_then(|w| w.url().ok())
        .ok_or("that tab is closed")?;
    if !same_page(current.as_str(), &url) {
        return Ok("moved".into());
    }
    let args = serde_json::json!({ "text": text, "n": n }).to_string();
    let body = CITE_JS.replace("__ARGS__", &args);
    Ok(
        crate::pagejs::run_isolated(&app, tab, "flux-cite", body, Duration::from_secs(3))
            .await
            .unwrap_or_else(|| "unavailable".into()),
    )
}

/// Take a shown citation's highlight off `tab`.
#[tauri::command]
pub async fn agent_cite_clear(app: AppHandle, tab: TabId) {
    let body = CITE_JS.replace("__ARGS__", r#"{"clear":true}"#);
    let _ = crate::pagejs::run_isolated(&app, tab, "flux-cite", body, Duration::from_secs(2)).await;
}

/// An answer's to-do list, for Make tasks: up to six lines, none when there's
/// nothing to do.
#[tauri::command]
pub async fn agent_tasks_from(text: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::agent_bridge::planner().tasks_from(&text))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_anchor_is_the_same_page() {
        assert!(same_page("https://a.org/x#sec-3", "https://a.org/x"));
        assert!(same_page("https://a.org/x/", "https://a.org/x"));
        assert!(!same_page("https://a.org/y", "https://a.org/x"));
    }

    #[test]
    fn the_cite_script_takes_its_arguments_as_json() {
        // Once, as the value of ARGS: the page's text arrives as a JSON string.
        assert_eq!(CITE_JS.matches("__ARGS__").count(), 1);
        assert!(CITE_JS.contains("const ARGS = __ARGS__;"));
        let args = serde_json::json!({ "text": "a \"quoted\" passage", "n": 2 }).to_string();
        let body = CITE_JS.replace("__ARGS__", &args);
        assert!(
            body.contains(r#""text":"a \"quoted\" passage""#),
            "{}",
            &body[..400]
        );
    }
}
