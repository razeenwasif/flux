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
            Self::Refuse { .. } => None,
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
        }
    }

    /// Compile to the JS that flux-core injects into the tab webview.
    pub fn to_js(&self) -> String {
        compile::to_js(self)
    }
}

/// Backend abstraction: Ollama today, llama.cpp behind a feature, mock in CI.
pub trait Inference: Send + Sync {
    /// Structured completion for DOM actions (`grammar` is GBNF for the llama
    /// path; Ollama uses JSON-format constraints instead).
    fn complete(&self, prompt: &str, grammar: Option<&str>) -> Result<String, AgentError>;

    /// Plain conversational completion — no structured-output constraint.
    fn chat(&self, prompt: &str) -> Result<String, AgentError>;
}

/// GBNF grammar pinning generation to the AgentAction schema.
/// llama.cpp applies this at the logit level: the model *cannot* emit
/// anything that doesn't parse into `AgentAction`.
pub const ACTION_GRAMMAR: &str = r#"
root        ::= "{" ws "\"action\"" ws ":" ws action-body "}"
action-body ::= click | extract | type-act | reveal | refuse
click       ::= "\"click\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"reason\"" ws ":" ws string ws
extract     ::= "\"extract_table\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"format\"" ws ":" ws ("\"csv\"" | "\"json\"") ws
type-act    ::= "\"type\"" ws "," ws "\"selector\"" ws ":" ws string ws "," ws "\"text\"" ws ":" ws string ws
reveal      ::= "\"reveal\"" ws "," ws "\"selector\"" ws ":" ws string ws
refuse      ::= "\"refuse\"" ws "," ws "\"reason\"" ws ":" ws string ws
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

        let raw = self.backend.complete(&prompt, Some(ACTION_GRAMMAR))?;
        let action: AgentAction = serde_json::from_str(raw.trim())?;
        policy_check(&action)?;
        tracing::info!(target: "flux::agent", action = %action.describe(), "planned");
        Ok(action)
    }

    /// Free-form chat. If `page_text` is given, it's included as context so the
    /// user can ask *about* the current page (summaries, questions) without the
    /// agent trying to act on it.
    pub fn chat(&self, user_prompt: &str, page_text: Option<&str>) -> Result<String, AgentError> {
        const PAGE_BUDGET: usize = 6 * 1024;
        let prompt = match page_text {
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
        };
        self.backend.chat(&prompt)
    }

    /// Chat grounded in the text of several open tabs (BACKLOG: chat-with-tabs).
    /// `pages` is the pre-joined, per-tab-labelled text; here we just frame it and
    /// cap the total.
    pub fn chat_pages(&self, user_prompt: &str, pages: &str) -> Result<String, AgentError> {
        const PAGES_BUDGET: usize = 12 * 1024;
        if pages.trim().is_empty() {
            return self.chat(user_prompt, None);
        }
        let prompt = format!(
            "You are Flux, a helpful AI assistant built into a web browser. The user \
             is asking about several open tabs; each tab's visible text is provided \
             below. Answer using this context and say which tab when it matters.\n\n\
             {}\n\nUSER: {user_prompt}",
            truncate_utf8(pages, PAGES_BUDGET)
        );
        self.backend.chat(&prompt)
    }
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
    fn complete(&self, prompt: &str, _grammar: Option<&str>) -> Result<String, AgentError> {
        let p = prompt.to_ascii_lowercase();
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
    fn truncate_respects_char_boundaries() {
        let s = "aé".repeat(100); // multi-byte chars
        let t = truncate_utf8(&s, 7);
        assert!(t.len() <= 7);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
    }
}
