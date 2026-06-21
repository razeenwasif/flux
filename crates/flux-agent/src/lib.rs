//! Flux Agent: natural language → structured DOM action → injectable JS.
//!
//! The agent NEVER free-writes JavaScript. The model is grammar-constrained
//! (GBNF) to emit one `AgentAction` JSON object; only the Rust compiler in
//! this crate turns that into JS, from a fixed set of audited templates.
//! That is the entire security model: the LLM picks *what* from a menu,
//! Rust decides *how*.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod compile;
pub mod ollama;
#[cfg(feature = "llama")]
pub mod llama;

pub use ollama::OllamaBackend;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("model returned malformed action: {0}")]
    BadAction(#[from] serde_json::Error),
    #[error("action rejected by policy: {0}")]
    Policy(&'static str),
}

/// The closed action vocabulary. Adding a variant = adding a capability;
/// each one must come with a compile template and a policy review.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AgentAction {
    /// "Find the unsubscribe link and click it."
    Click { selector: String, reason: String },
    /// "Extract all pricing data from this table as CSV."
    ExtractTable { selector: String, format: ExtractFormat },
    /// Fill an input (form automation).
    Type { selector: String, text: String },
    /// Scroll an element into view (precursor step for the above).
    Reveal { selector: String },
    /// The model judged the request unfulfillable on this page.
    Refuse { reason: String },
    /// Multi-step task complete (BACKLOG #A / #82) — the agent declares the goal
    /// satisfied and the loop stops. Never touches the page.
    Finish { summary: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractFormat {
    Csv,
    Json,
}

impl AgentAction {
    /// CSS selector this action targets, if any — the UI flash-highlights it
    /// in magenta before execution so the user sees what the agent touches.
    pub fn selector(&self) -> Option<&str> {
        match self {
            Self::Click { selector, .. }
            | Self::ExtractTable { selector, .. }
            | Self::Type { selector, .. }
            | Self::Reveal { selector } => Some(selector),
            Self::Refuse { .. } | Self::Finish { .. } => None,
        }
    }

    /// Human-readable line for the agent activity feed.
    pub fn describe(&self) -> String {
        match self {
            Self::Click { selector, reason } => format!("Click `{selector}` — {reason}"),
            Self::ExtractTable { selector, format } => {
                format!("Extract `{selector}` as {format:?}")
            }
            Self::Type { selector, .. } => format!("Type into `{selector}`"),
            Self::Reveal { selector } => format!("Scroll `{selector}` into view"),
            Self::Refuse { reason } => format!("Refused: {reason}"),
            Self::Finish { summary } => format!("Finished: {summary}"),
        }
    }

    /// Compile to the JS that flux-core injects into the tab webview.
    pub fn to_js(&self) -> String {
        compile::to_js(self)
    }

    /// Does this action target a **destructive** control (BACKLOG #104, arXiv
    /// 2511.19477)? Returns the matched deny-list term. Only `Click` can be
    /// destructive (extract/reveal/type/refuse don't commit state); the verdict
    /// comes from a fixed Rust list — **never** the model, since prompt
    /// injection makes LLM judgment untrustworthy here. This is the *preview*
    /// signal; the injected click JS enforces the same list against the
    /// element's real rendered label at click time (`compile::to_js`).
    pub fn is_destructive(&self) -> Option<&'static str> {
        let Self::Click { selector, reason } = self else { return None };
        let hay = format!("{selector} {reason}").to_lowercase();
        DESTRUCTIVE_TERMS.iter().copied().find(|t| hay.contains(*t))
    }
}

/// Execution-layer destructive-action deny-list (BACKLOG #104). Matched
/// case-insensitively as substrings — in Rust against the action's
/// selector+reason, and in the injected click JS against the resolved element's
/// accessible name (aria-label / text / value / title). One source of truth so
/// the two layers can never drift. Deliberately excludes "unsubscribe" — the
/// canonical *wanted* agent task — and other benign verbs.
pub const DESTRUCTIVE_TERMS: &[&str] = &[
    "delete",
    "permanently",
    "deactivate",
    "close account",
    "remove account",
    "wipe",
    "erase",
    "place order",
    "buy now",
    "pay now",
    "complete purchase",
    "confirm purchase",
    "confirm payment",
    "send money",
    "withdraw",
    "refund",
    "factory reset",
];

/// Backend abstraction: Ollama today, llama.cpp behind a feature, mock in CI.
pub trait Inference: Send + Sync {
    /// Structured completion for DOM actions. `schema` is the JSON Schema the
    /// output must satisfy: Ollama passes it straight to `/api/generate`'s
    /// `format` (token-level grammar), and the llama path converts it to GBNF.
    /// `None` falls back to free JSON.
    fn complete(&self, prompt: &str, schema: Option<&serde_json::Value>) -> Result<String, AgentError>;

    /// Plain conversational completion — no structured-output constraint.
    fn chat(&self, prompt: &str) -> Result<String, AgentError>;

    /// Streaming chat (BACKLOG #82): invoke `on_token` for each chunk as it's
    /// generated, returning the full text. The default forwards to `chat` and
    /// emits the whole reply as one chunk — so non-streaming backends (mock,
    /// the llama scaffold) keep working transparently.
    fn chat_stream(&self, prompt: &str, on_token: &mut dyn FnMut(&str)) -> Result<String, AgentError> {
        let full = self.chat(prompt)?;
        on_token(&full);
        Ok(full)
    }
}

/// JSON Schema for the `AgentAction` vocabulary, as the `oneOf`-of-tagged-objects
/// shape Ollama (and llama.cpp under the hood) compile to a token-level grammar.
/// Passed as `/api/generate`'s `format` so the model is constrained to emit a
/// *well-shaped* action — strictly stronger than the old `format:"json"` (which
/// only guaranteed valid JSON, leaning on the prompt to describe the fields).
/// `include_finish` adds the multi-step `finish` terminal (used by `plan_step`;
/// omitted by single-shot `plan`, which has nothing to finish).
pub fn action_schema(include_finish: bool) -> serde_json::Value {
    use serde_json::json;
    let s = || json!({ "type": "string" });
    let variant = |props: serde_json::Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": false,
        })
    };
    let mut variants = vec![
        variant(
            json!({ "action": { "const": "click" }, "selector": s(), "reason": s() }),
            &["action", "selector", "reason"],
        ),
        variant(
            json!({ "action": { "const": "extract_table" }, "selector": s(), "format": { "enum": ["csv", "json"] } }),
            &["action", "selector", "format"],
        ),
        variant(
            json!({ "action": { "const": "type" }, "selector": s(), "text": s() }),
            &["action", "selector", "text"],
        ),
        variant(
            json!({ "action": { "const": "reveal" }, "selector": s() }),
            &["action", "selector"],
        ),
        variant(
            json!({ "action": { "const": "refuse" }, "reason": s() }),
            &["action", "reason"],
        ),
    ];
    if include_finish {
        variants.push(variant(
            json!({ "action": { "const": "finish" }, "summary": s() }),
            &["action", "summary"],
        ));
    }
    json!({ "oneOf": variants })
}

/// GBNF grammar pinning generation to the AgentAction schema — the equivalent of
/// [`action_schema`] for the llama.cpp logit-level sampler (the Ollama path uses
/// the JSON Schema instead). The model *cannot* emit anything that doesn't parse
/// into `AgentAction`.
pub const ACTION_GRAMMAR: &str = r#"
root        ::= "{" ws "\"action\"" ws ":" ws action-body "}"
action-body ::= click | extract | type-act | reveal | refuse | finish
click       ::= "\"click\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"reason\"" ws ":" ws string ws
extract     ::= "\"extract_table\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"format\"" ws ":" ws ("\"csv\"" | "\"json\"") ws
type-act    ::= "\"type\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"text\"" ws ":" ws string ws
reveal      ::= "\"reveal\"" ws "," ws "\"selector\"" ws ":" ws string ws
refuse      ::= "\"refuse\"" ws "," ws "\"reason\"" ws ":" ws string ws
finish      ::= "\"finish\"" ws "," ws "\"summary\"" ws ":" ws string ws
string      ::= "\"" ([^"\\] | "\\" .)* "\""
ws          ::= [ \t\n]*
"#;

/// Planner: owns a backend, turns (user prompt, page text) into an action.
pub struct AgentPlanner {
    backend: Box<dyn Inference>,
}

impl AgentPlanner {
    pub fn new(backend: Box<dyn Inference>) -> Self {
        Self { backend }
    }

    pub fn plan(&self, user_prompt: &str, page_text: &str) -> Result<AgentAction, AgentError> {
        // Cap page context: a 12B model's quality degrades long before its
        // window fills, and prompt-eval time is linear in tokens. 6 KB of
        // visible text covers the vast majority of action targets.
        const PAGE_BUDGET: usize = 6 * 1024;
        let page = truncate_utf8(page_text, PAGE_BUDGET);

        // Plain prompt — Ollama applies the model's chat template. The exact
        // JSON shapes are spelled out since `format:"json"` only guarantees
        // valid JSON, not the right fields.
        let prompt = format!(
            "You are the Flux browser agent. Given the visible text of the current \
             page and a user request, respond with EXACTLY ONE JSON object and \
             nothing else, one of these shapes:\n\
             {{\"action\":\"click\",\"selector\":\"<css>\",\"reason\":\"<why>\"}}\n\
             {{\"action\":\"extract_table\",\"selector\":\"<css>\",\"format\":\"csv\"}}\n\
             {{\"action\":\"type\",\"selector\":\"<css>\",\"text\":\"<text>\"}}\n\
             {{\"action\":\"reveal\",\"selector\":\"<css>\"}}\n\
             {{\"action\":\"refuse\",\"reason\":\"<why>\"}}\n\
             Prefer stable selectors (ids, aria-labels, data attributes). If the \
             request cannot be satisfied on this page, use \"refuse\".\n\n\
             PAGE:\n{page}\n\nREQUEST: {user_prompt}"
        );

        // Single-shot plan: no `finish` (there's no multi-step task to conclude).
        let raw = self.backend.complete(&prompt, Some(&action_schema(false)))?;
        let action: AgentAction = serde_json::from_str(raw.trim())?;
        policy_check(&action)?;
        tracing::info!(target: "flux::agent", action = %action.describe(), "planned");
        Ok(action)
    }

    /// Translate a natural-language request into a single shell command when it asks
    /// to do or inspect something on the user's own machine; `None` for purely
    /// conversational requests. The user approves the command before it runs (and
    /// rm/destructive commands are blocked downstream), so this only has to produce
    /// the command — it doesn't gate execution.
    pub fn plan_shell(&self, request: &str) -> Result<Option<String>, AgentError> {
        let prompt = format!(
            "You can run ONE shell command on the user's own computer; they approve it \
             before it runs (bash syntax). If the request asks to DO or INSPECT \
             something on their machine — list files/folders, the current directory, \
             disk usage, running processes, environment, launch a program, read a \
             file, etc. — reply with {{\"command\":\"<the command>\"}}. If it's \
             conversational or answerable in words, reply with {{\"command\":\"\"}}. \
             Never use rm or other destructive commands. Reply with EXACTLY ONE JSON \
             object and nothing else.\n\nREQUEST: {request}"
        );
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "command": { "type": "string" } },
            "required": ["command"]
        });
        let raw = self.backend.complete(&prompt, Some(&schema))?;
        let v: serde_json::Value = serde_json::from_str(raw.trim())?;
        let cmd = v.get("command").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
        Ok(if cmd.is_empty() { None } else { Some(cmd) })
    }

    /// Plan the **single next step** of a multi-step task (BACKLOG #A). The agent
    /// loop calls this repeatedly: each call sees the *live* page and the steps
    /// already taken, and returns one `AgentAction` — or `Finish` when the goal is
    /// met, or `Refuse` if it can't proceed. Re-planning per step (rather than
    /// emitting a fixed N-step plan up front) is what lets a task cross pages:
    /// the selectors for page 2 aren't knowable while still on page 1.
    pub fn plan_step(&self, goal: &str, page_text: &str, history: &[String]) -> Result<AgentAction, AgentError> {
        const PAGE_BUDGET: usize = 6 * 1024;
        let page = truncate_utf8(page_text, PAGE_BUDGET);
        let steps = if history.is_empty() {
            "(none yet)".to_string()
        } else {
            history.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")
        };
        let prompt = format!(
            "You are the Flux browser agent executing a MULTI-STEP task. Look at the \
             current page and the steps already done, then respond with EXACTLY ONE \
             JSON object — the SINGLE NEXT action — and nothing else. Shapes:\n\
             {{\"action\":\"click\",\"selector\":\"<css>\",\"reason\":\"<why>\"}}\n\
             {{\"action\":\"type\",\"selector\":\"<css>\",\"text\":\"<text>\"}}\n\
             {{\"action\":\"extract_table\",\"selector\":\"<css>\",\"format\":\"csv\"}}\n\
             {{\"action\":\"reveal\",\"selector\":\"<css>\"}}\n\
             {{\"action\":\"finish\",\"summary\":\"<what was accomplished>\"}}\n\
             {{\"action\":\"refuse\",\"reason\":\"<why impossible>\"}}\n\
             Do ONE concrete step that makes progress; you'll be called again with \
             the updated page. Use \"finish\" when the goal is already satisfied, and \
             \"refuse\" if it cannot be done here. Don't repeat a step already done. \
             Prefer stable selectors (ids, aria-labels, data attributes).\n\n\
             TASK GOAL: {goal}\n\nSTEPS DONE:\n{steps}\n\nPAGE:\n{page}"
        );
        // Multi-step: `finish` is allowed so the loop can declare the goal met.
        let raw = self.backend.complete(&prompt, Some(&action_schema(true)))?;
        let action: AgentAction = serde_json::from_str(raw.trim())?;
        policy_check(&action)?;
        tracing::info!(target: "flux::agent", step = %action.describe(), "task step planned");
        Ok(action)
    }

    /// Build the chat prompt (active-page context optional). Shared by the
    /// blocking and streaming chat paths so they never drift.
    fn chat_prompt(user_prompt: &str, page_text: Option<&str>) -> String {
        const PAGE_BUDGET: usize = 6 * 1024;
        match page_text {
            Some(p) if !p.trim().is_empty() => format!(
                "You are Flux, a helpful AI assistant built into a web browser. The \
                 user is viewing a page; its visible text is provided for context. \
                 Answer their message conversationally.\n\n\
                 PAGE:\n{}\n\nUSER: {user_prompt}",
                truncate_utf8(p, PAGE_BUDGET)
            ),
            _ => format!(
                "You are Flux, a helpful AI assistant built into a web browser. \
                 Answer the user's message conversationally.\n\nUSER: {user_prompt}"
            ),
        }
    }

    /// Build the multi-tab chat prompt; `None` when `pages` is empty (caller
    /// should fall back to plain chat).
    fn chat_pages_prompt(user_prompt: &str, pages: &str) -> Option<String> {
        const PAGES_BUDGET: usize = 12 * 1024;
        if pages.trim().is_empty() {
            return None;
        }
        Some(format!(
            "You are Flux, a helpful AI assistant built into a web browser. The user \
             is asking about several open tabs; each tab's visible text is provided \
             below. Answer using this context and say which tab when it matters.\n\n\
             {}\n\nUSER: {user_prompt}",
            truncate_utf8(pages, PAGES_BUDGET)
        ))
    }

    /// Free-form chat. If `page_text` is given, it's included as context so the
    /// user can ask *about* the current page (summaries, questions) without the
    /// agent trying to act on it.
    pub fn chat(&self, user_prompt: &str, page_text: Option<&str>) -> Result<String, AgentError> {
        self.backend.chat(&Self::chat_prompt(user_prompt, page_text))
    }

    /// Streaming counterpart of [`chat`](Self::chat) (BACKLOG #82) — relays each
    /// token to `on_token` as the model generates it, so the sidebar renders the
    /// reply live instead of waiting for the whole completion.
    pub fn chat_stream(
        &self,
        user_prompt: &str,
        page_text: Option<&str>,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        self.backend.chat_stream(&Self::chat_prompt(user_prompt, page_text), on_token)
    }

    /// Chat grounded in the text of several open tabs (BACKLOG: chat-with-tabs).
    /// `pages` is the pre-joined, per-tab-labelled text; here we just frame it and
    /// cap the total.
    pub fn chat_pages(&self, user_prompt: &str, pages: &str) -> Result<String, AgentError> {
        match Self::chat_pages_prompt(user_prompt, pages) {
            Some(prompt) => self.backend.chat(&prompt),
            None => self.chat(user_prompt, None),
        }
    }

    /// Streaming counterpart of [`chat_pages`](Self::chat_pages) (BACKLOG #82).
    pub fn chat_pages_stream(
        &self,
        user_prompt: &str,
        pages: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        match Self::chat_pages_prompt(user_prompt, pages) {
            Some(prompt) => self.backend.chat_stream(&prompt, on_token),
            None => self.chat_stream(user_prompt, None, on_token),
        }
    }

    /// Author a CSS "boost" for the current site from a natural-language request
    /// (BACKLOG #49) — e.g. "hide the cookie banner", "dark mode", "widen the
    /// article". Returns raw CSS (markdown fences / `<style>` wrappers stripped).
    /// CSS only by design: it's injected into the page and CSS can't execute or
    /// exfiltrate, so an LLM (potentially prompt-injected by page text) can't do
    /// harm — unlike generated JS.
    pub fn author_css(&self, instruction: &str, page_text: &str) -> Result<String, AgentError> {
        const PAGE_BUDGET: usize = 6 * 1024;
        let prompt = format!(
            "You are a CSS expert customizing a web page in the Flux browser. The user \
             wants: \"{instruction}\". Using the page's visible text for context, write \
             a concise CSS snippet that achieves it (hiding elements, recoloring, \
             widening content, dark mode, etc). Output ONLY raw CSS — no prose, no \
             markdown code fences, no <style> tags. Prefer robust, specific selectors.\
             \n\nPAGE:\n{}",
            truncate_utf8(page_text, PAGE_BUDGET)
        );
        Ok(strip_css(&self.backend.chat(&prompt)?))
    }
}

impl AgentPlanner {
    /// Translate a page's visible text to `target` (a language name) with the
    /// local model (BACKLOG #40) — private, no cloud translation service. Text is
    /// capped, so long pages translate their leading content (a v1 limitation).
    pub fn translate(&self, target: &str, page_text: &str) -> Result<String, AgentError> {
        const PAGE_BUDGET: usize = 8 * 1024;
        let prompt = format!(
            "Translate the following web page text into {target}. Preserve paragraph \
             breaks. Output ONLY the translation — no preamble, no notes, no \
             transliteration.\n\n{}",
            truncate_utf8(page_text, PAGE_BUDGET)
        );
        self.backend.chat(&prompt)
    }
}

/// Strip markdown code fences and `<style>` wrappers an LLM may add around CSS.
fn strip_css(raw: &str) -> String {
    let mut s = raw.trim();
    // Pull out the body of a ``` fenced block if present.
    if let Some(start) = s.find("```") {
        let after = &s[start + 3..];
        let after = after.strip_prefix("css").unwrap_or(after);
        let after = after.trim_start_matches('\n');
        s = after.split("```").next().unwrap_or(after);
    }
    s.trim()
        .replace("<style>", "")
        .replace("</style>", "")
        .trim()
        .to_string()
}

/// Last-line policy gate, applied AFTER parsing — defense in depth even
/// though the grammar already constrains the shape.
fn policy_check(action: &AgentAction) -> Result<(), AgentError> {
    if let Some(sel) = action.selector() {
        if sel.len() > 512 {
            return Err(AgentError::Policy("selector too long"));
        }
        // Selectors are data, never code: reject anything that could escape
        // the JSON-string embedding in the compile templates.
        if sel.contains('\u{0}') {
            return Err(AgentError::Policy("NUL in selector"));
        }
    }
    Ok(())
}

/// Truncate to a byte budget without splitting a UTF-8 codepoint.
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ─── Mock backend (dev / CI) ────────────────────────────────────────────────

/// Keyword-routing stand-in so the whole plan→compile→inject pipeline runs
/// without model weights. Deliberately dumb; never ships in release builds.
pub struct MockBackend;

impl Inference for MockBackend {
    fn complete(&self, prompt: &str, _schema: Option<&serde_json::Value>) -> Result<String, AgentError> {
        let p = prompt.to_ascii_lowercase();
        // Multi-step task loop (plan_step): do one step, then finish on the next
        // call (once a step appears under "STEPS DONE:"). Keeps the dev/CI loop
        // terminating without a model.
        if p.contains("task goal:") {
            let json = if p.contains("steps done:\n-") {
                r#"{"action":"finish","summary":"mock task complete"}"#
            } else {
                r#"{"action":"reveal","selector":"body"}"#
            };
            return Ok(json.to_owned());
        }
        let json = if p.contains("unsubscribe") {
            r#"{"action":"click","selector":"a[href*='unsubscribe']","reason":"unsubscribe link"}"#
        } else if p.contains("csv") || p.contains("table") || p.contains("pricing") {
            r#"{"action":"extract_table","selector":"table","format":"csv"}"#
        } else {
            r#"{"action":"refuse","reason":"mock backend only handles demo intents"}"#
        };
        Ok(json.to_owned())
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        let last = prompt.lines().last().unwrap_or(prompt);
        Ok(format!("(mock agent — no model running) You said: {}", last.trim_start_matches("USER: ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_pipeline_end_to_end() {
        let planner = AgentPlanner::new(Box::new(MockBackend));
        let action = planner
            .plan("Find the unsubscribe link on this page and click it", "…page text…")
            .unwrap();
        assert!(matches!(action, AgentAction::Click { .. }));
        let js = action.to_js();
        assert!(js.contains("querySelector"));
        // The compiled JS must embed the selector as JSON, never raw.
        assert!(js.contains(r#""a[href*='unsubscribe']""#));
    }

    #[test]
    fn task_loop_steps_then_finishes() {
        let planner = AgentPlanner::new(Box::new(MockBackend));
        // First call (no history) → a concrete step.
        let s1 = planner.plan_step("download the report", "…page…", &[]).unwrap();
        assert!(matches!(s1, AgentAction::Reveal { .. }));
        // Once a step is in the history, the loop terminates with Finish.
        let s2 = planner
            .plan_step("download the report", "…page…", &[s1.describe()])
            .unwrap();
        assert!(matches!(s2, AgentAction::Finish { .. }));
        // Finish never targets the page.
        assert_eq!(s2.selector(), None);
        assert!(s2.is_destructive().is_none());
    }

    #[test]
    fn action_schema_includes_finish_only_when_asked() {
        let plan = action_schema(false);
        let step = action_schema(true);
        let plan_variants = plan["oneOf"].as_array().unwrap();
        let step_variants = step["oneOf"].as_array().unwrap();
        assert_eq!(plan_variants.len(), 5, "single-shot plan has no finish");
        assert_eq!(step_variants.len(), 6, "multi-step adds finish");
        // Every variant pins the tag with a const/enum and forbids stray keys.
        for v in step_variants {
            assert!(v["properties"]["action"].get("const").is_some());
            assert_eq!(v["additionalProperties"], false);
        }
        let has_finish = |vs: &[serde_json::Value]| {
            vs.iter().any(|v| v["properties"]["action"]["const"] == "finish")
        };
        assert!(!has_finish(plan_variants));
        assert!(has_finish(step_variants));
    }

    #[test]
    fn default_chat_stream_emits_full_reply_once() {
        // Backends without native streaming (mock, llama scaffold) fall back to
        // one chunk via the trait default — the sidebar still works.
        let planner = AgentPlanner::new(Box::new(MockBackend));
        let mut chunks: Vec<String> = Vec::new();
        let full = planner
            .chat_stream("hello there", None, &mut |t| chunks.push(t.to_string()))
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], full);
        assert!(full.contains("hello there"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let s = "aé".repeat(100); // multi-byte chars
        let t = truncate_utf8(&s, 7);
        assert!(t.len() <= 7);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
    }

    #[test]
    fn destructive_classification() {
        let del = AgentAction::Click {
            selector: "button#delete-account".into(),
            reason: "remove the user".into(),
        };
        assert_eq!(del.is_destructive(), Some("delete"));

        let pay = AgentAction::Click {
            selector: ".btn".into(),
            reason: "Place order to complete checkout".into(),
        };
        assert_eq!(pay.is_destructive(), Some("place order"));

        // The headline use case must NOT be flagged.
        let unsub = AgentAction::Click {
            selector: "a[href*='unsubscribe']".into(),
            reason: "unsubscribe link".into(),
        };
        assert_eq!(unsub.is_destructive(), None);

        // Read-only actions are never destructive, even with scary text.
        let read = AgentAction::ExtractTable { selector: "#delete table".into(), format: ExtractFormat::Csv };
        assert_eq!(read.is_destructive(), None);
    }
}
