//! Domain playbooks — procedural "harnesses" injected into the planner prompt
//! when the agent is working inside a known, hard-to-navigate web app.
//!
//! Flux's agent is a *local* model (Gemma via Ollama), not a frontier model, so
//! it doesn't carry deep first-party knowledge of a surface like the Microsoft
//! Power Platform maker portal. A playbook transfers that knowledge as an
//! explicit, step-by-step recipe the small model can *follow* rather than
//! *recall*: the landmarks to click, the order of operations, the selector
//! strategy, the verification gates, and — critically — the STOP list of things
//! it must hand back to the user instead of attempting.
//!
//! A playbook changes only *what the model is told*; it never widens the action
//! vocabulary (`AgentAction`) or the compile templates. The security model
//! (Rust decides *how*, the model only picks *what* from a fixed menu) is
//! unchanged. Guidance is embedded (const strings) — no file IO, works offline.

/// A domain harness: matched by page host, injected as prompt guidance.
pub struct Playbook {
    /// Human label (activity feed / tests).
    pub name: &'static str,
    /// Host suffixes this playbook applies to (matched case-insensitively as a
    /// suffix of the page host, so `powerautomate.com` covers `make.` etc.).
    pub hosts: &'static [&'static str],
    /// The recipe injected into the planner prompt. Kept dense: it shares a
    /// bounded context window with the live page text.
    pub guidance: &'static str,
}

/// Registry. Order matters only if hosts overlap (first match wins); these don't.
pub static PLAYBOOKS: &[Playbook] = &[POWER_AUTOMATE, POWER_APPS];

/// Return the playbook whose host list matches `url`, if any.
pub fn playbook_for(url: &str) -> Option<&'static Playbook> {
    let host = host_of(url)?;
    let host = host.to_ascii_lowercase();
    // Match at a registrable-domain boundary only: the host must equal the
    // pattern or be a subdomain of it (`.pattern`). A bare `ends_with(pattern)`
    // would let `evilpowerautomate.com` match `powerautomate.com` — a phishing
    // hole — so it is deliberately NOT used.
    PLAYBOOKS.iter().find(|p| {
        p.hosts
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    })
}

/// The guidance block to splice into a planner prompt for `url`, already framed
/// with a header, or an empty string when no playbook applies. Callers insert
/// this verbatim; an empty string is a no-op so generic pages are unaffected.
pub fn guidance_block(url: &str) -> String {
    match playbook_for(url) {
        Some(p) => format!(
            "DOMAIN PLAYBOOK — {} (follow this; it overrides guesswork):\n{}\n\n",
            p.name, p.guidance
        ),
        None => String::new(),
    }
}

/// Extract the host from a URL without pulling in a URL-parsing crate. Returns
/// the authority between `://` and the next `/`, `?`, or `#`, minus any userinfo
/// or `:port`. `None` for input with no scheme separator.
fn host_of(url: &str) -> Option<&str> {
    let after = url.split_once("://")?.1;
    let authority = after.split(['/', '?', '#']).next().unwrap_or(after);
    // Drop userinfo (user:pass@host) and any :port.
    let host = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

// ─── Power Automate ──────────────────────────────────────────────────────────
// Cloud-flow authoring in the modern designer. The portal is a React app with
// stable `aria-label`s and `data-automation-id`s; anchor on those, never on
// position. The single biggest failure mode for a small model here is inventing
// UI that isn't on screen — so the recipe leans on "search, then pick from what
// the page shows", and hands back anything needing credentials or a connection.

const POWER_AUTOMATE: Playbook = Playbook {
    name: "Power Automate (cloud flows)",
    hosts: &["powerautomate.com", "flow.microsoft.com"],
    guidance: "\
You are building/editing a CLOUD FLOW in the Power Automate designer. Do ONE UI \
step per turn and re-read the page before the next.\n\
BUILD RECIPE (skip steps already done — check STEPS DONE):\n\
1. New flow: click \"Create\" (left nav), then the flow type (\"Automated cloud \
flow\", \"Instant cloud flow\", or \"Scheduled cloud flow\"). Give it a name, pick \
the trigger, click \"Create\".\n\
2. Add an action: click the \"+\" between two cards, or the card's \"New step\" / \
\"Insert a new step\" button (aria-label). This opens the action picker.\n\
3. In the action picker, TYPE the connector/action name into the search box \
(placeholder \"Search connectors and actions\"), then CLICK the matching result \
that the page actually shows — do not invent an action name.\n\
4. Configure the action: click a field, then either type a literal value or open \
\"Dynamic content\" / the fx expression editor to reference a prior step's output \
(e.g. outputs, body, items). Fill EVERY field with a red asterisk.\n\
5. Save: click \"Save\" (top bar). Then verify — see GATES.\n\
6. Test: \"Test\" → \"Manually\" → run, only if asked to test.\n\
SELECTORS: prefer [aria-label=...], visible button text, and [data-automation-id]. \
The action search box, the \"+\"/\"New step\" buttons, and \"Save\"/\"Test\" all have \
stable aria-labels. Avoid nth-child/positional selectors — the designer re-renders.\n\
SCOPE: to add an action INSIDE a loop (\"Apply to each\") or a Condition branch \
(\"If yes\"/\"If no\"), click the \"+\" WITHIN that container, not the top-level one.\n\
EXPRESSIONS: the fx editor takes Workflow Definition Language, e.g. \
triggerBody(), outputs('Compose'), items('Apply_to_each'), utcNow(), \
concat(a,b). Keep them syntactically valid; don't paste Power Fx here.\n\
GATES (verify before moving on): after Save, expect a \"saved\" confirmation and \
NO red error banner on any card; if a card shows a red dot, open it and fix the \
missing field before continuing. Before Test, confirm no required field is empty.\n\
STOP — refuse and hand back to the user (do NOT type into these) if the task \
requires: signing in / creating a connection / an OAuth or consent dialog, \
entering credentials or an API key, publishing or turning a flow ON in \
production, or deleting a flow/action. For bulk Dataverse record work, refuse \
and tell the user the Dataverse MCP or `pac` CLI is the reliable path.",
};

// ─── Power Apps ──────────────────────────────────────────────────────────────
// The maker home + Studio. Canvas Studio is a live-canvas editor that is very
// hostile to DOM automation, so the recipe steers structured work toward the
// deterministic CLI/solution path and keeps the agent to the navigable maker
// surfaces (lists, tables, the formula bar) it can actually drive.

const POWER_APPS: Playbook = Playbook {
    name: "Power Apps (maker portal)",
    hosts: &["powerapps.com"],
    guidance: "\
You are in the Power Apps maker portal. Do ONE UI step per turn and re-read the \
page each time.\n\
NAVIGATION: the left nav has \"Create\", \"Apps\", \"Tables\", \"Flows\", \
\"Solutions\". Use \"Solutions\" for anything meant to be deployed — unmanaged \
solutions are the unit of ALM.\n\
TABLES (Dataverse): \"Tables\" → \"New table\" to define a table; open a table → \
\"Columns\" → \"New column\" to add fields; \"Data\" to edit rows. Fill required \
(red-asterisk) fields, then \"Save\".\n\
CANVAS APP STUDIO is a live design canvas: it is UNRELIABLE to drive control-by-\
control via the DOM. Prefer it only for small, explicit edits (e.g. a formula in \
the formula bar — Power Fx there starts with \"=\"). For building/altering an app \
structurally, refuse and tell the user the `pac canvas` CLI (unpack → edit \
*.pa.yaml → pack) or solution import is the reliable path.\n\
SELECTORS: prefer [aria-label=...] and visible button/menu text; the maker portal \
uses stable aria-labels. Avoid positional selectors.\n\
GATES: after \"Save\", expect a saved/published confirmation and no error banner; \
a model-driven/canvas app change isn't live until \"Publish\".\n\
STOP — refuse and hand back if the task needs: signing in / creating a \
connection / OAuth or consent, entering credentials or keys, publishing to \
production, or deleting an app/table/column. For querying or bulk-editing \
Dataverse records, refuse and point the user to the Dataverse MCP or `pac` CLI.",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_power_automate_hosts() {
        for u in [
            "https://make.powerautomate.com/environments/Default/flows",
            "https://US.make.powerautomate.com/",
            "https://flow.microsoft.com/en-us/",
            "https://make.powerautomate.com", // no trailing slash
        ] {
            let p = playbook_for(u).unwrap_or_else(|| panic!("no playbook for {u}"));
            assert_eq!(p.name, "Power Automate (cloud flows)", "url={u}");
        }
    }

    #[test]
    fn matches_power_apps_host() {
        let p = playbook_for("https://make.powerapps.com/environments/x/solutions").unwrap();
        assert_eq!(p.name, "Power Apps (maker portal)");
    }

    #[test]
    fn no_playbook_for_generic_or_lookalike_hosts() {
        // Ordinary pages get nothing (empty guidance = no behavior change).
        assert!(playbook_for("https://example.com/foo").is_none());
        assert!(guidance_block("https://example.com/foo").is_empty());
        // A lookalike host that merely contains the term as a substring, but is a
        // different registrable domain, must NOT match (boundary match, not contains).
        assert!(playbook_for("https://powerautomate.com.evil.example/").is_none());
        assert!(playbook_for("https://notpowerapps.com.attacker.test/").is_none());
        // The dangerous case a bare suffix match would let through:
        assert!(playbook_for("https://evilpowerautomate.com/").is_none());
        assert!(playbook_for("https://mypowerapps.com/").is_none());
    }

    #[test]
    fn guidance_block_is_framed_and_nonempty_when_matched() {
        let g = guidance_block("https://make.powerautomate.com/");
        assert!(g.contains("DOMAIN PLAYBOOK"));
        assert!(g.contains("CLOUD FLOW"));
        assert!(g.contains("STOP"), "must carry the refuse/hand-back list");
    }

    #[test]
    fn host_of_strips_userinfo_port_and_path() {
        assert_eq!(
            host_of("https://user:pw@make.powerautomate.com:443/x?y#z"),
            Some("make.powerautomate.com")
        );
        assert_eq!(host_of("http://localhost:1234/"), Some("localhost"));
        assert_eq!(host_of("not a url"), None);
        assert_eq!(host_of("https:///nohost"), None);
    }
}
