//! Power Platform CLI (`pac`) harness — the *deterministic* ALM path that
//! complements the browser-automation playbooks (`playbooks.rs`).
//!
//! Driving the maker portal by DOM is brittle; the reliable way to move
//! solutions, canvas apps, and cloud-flow definitions around is the `pac` CLI.
//! This module grounds the local model with a curated command cheatsheet so it
//! maps a natural-language request to ONE correct `pac` invocation, then
//! classifies that command's risk **in Rust** (never trusting the model) so the
//! UI can warn before an irreversible, environment-mutating operation runs.
//!
//! The command still executes through the existing approval-gated shell path —
//! nothing here runs anything. `pac` produces the invocation; the user approves.

use serde::{Deserialize, Serialize};

use crate::AgentError;

/// A planned `pac` invocation for the approval card. `command` may be empty when
/// the request doesn't map to a `pac` operation (`explanation` says why).
/// `danger`/`read_only` are derived in Rust from `command`, not the model.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PacPlan {
    /// The single `pac …` command to run (or empty if not applicable).
    pub command: String,
    /// One line on what it does — shown above the approval card.
    pub explanation: String,
    /// A heads-up reason when the command mutates a remote environment or needs
    /// interactive sign-in; `None` for read-only/local operations.
    pub danger: Option<String>,
    /// True when the command only reads/exports and can't change a remote env.
    pub read_only: bool,
}

/// Curated `pac` reference injected into the planner prompt. Focused on the ALM
/// operations that matter for Power Apps + Power Automate; dense on purpose.
pub const PAC_CHEATSHEET: &str = "\
AUTH & ENVIRONMENTS\n\
  pac auth list                                   # saved auth profiles\n\
  pac auth create --environment <url|id>          # sign in to an environment (INTERACTIVE browser)\n\
  pac auth select --index <n>                     # switch the active profile\n\
  pac env list                                    # list environments\n\
SOLUTIONS (the unit of ALM)\n\
  pac solution list                               # solutions in the active env\n\
  pac solution export --name <unique> --path <out.zip> [--managed]   # download a solution\n\
  pac solution import --path <in.zip> [--publish-changes]            # import into the env (WRITES)\n\
  pac solution unpack --zipfile <f.zip> --folder <dir>               # zip -> source files\n\
  pac solution pack --folder <dir> --zipfile <f.zip>                 # source files -> zip\n\
  pac solution clone --name <unique>              # export + unpack into a project\n\
  pac solution check --path <f.zip>               # run Power Apps Checker (analysis only)\n\
CANVAS APPS\n\
  pac canvas list                                 # canvas apps in the env\n\
  pac canvas download --name <app> --file <f.msapp>                  # download an app\n\
  pac canvas unpack --msapp <f.msapp> --sources <dir>                # .msapp -> *.pa.yaml source\n\
  pac canvas pack --sources <dir> --msapp <f.msapp>                  # source -> .msapp\n\
DATAVERSE DATA\n\
  pac data export --schemaFile <s.xml> --dataFile <d.zip>            # export data\n\
  pac data import --data <d.zip>                                     # import data (WRITES)\n\
CLOUD FLOWS (Power Automate): flows live INSIDE a solution as JSON — there is no\n\
  `pac flow` authoring command. To change a flow via CLI: export the solution,\n\
  unpack it, edit the flow definition JSON, pack, and import.";

/// Environment-mutating / interactive `pac` verbs, classified in Rust so a
/// prompt-injected or mistaken model can't downgrade the warning. Returns a
/// human reason (shown on the card), or `None` for safe/local operations.
pub fn pac_danger(command: &str) -> Option<String> {
    let toks: Vec<String> = command
        .to_ascii_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    let has = |t: &str| toks.iter().any(|x| x == t);
    let both = |a: &str, b: &str| has(a) && has(b);

    if has("import") {
        return Some(
            "imports into the target environment — can overwrite existing customizations or data"
                .into(),
        );
    }
    if has("delete") {
        return Some("deletes a component from the environment — this is irreversible".into());
    }
    if has("reset") {
        return Some("resets the environment — destroys its data".into());
    }
    if has("upgrade") || has("apply") {
        return Some("upgrades a managed solution in place in the environment".into());
    }
    if has("publish") || command.to_ascii_lowercase().contains("--publish-changes") {
        return Some("publishes changes live in the environment".into());
    }
    if has("deploy") {
        return Some("deploys to the target environment".into());
    }
    if both("auth", "create") {
        return Some("opens an interactive browser sign-in — complete it yourself; the agent can't authenticate for you".into());
    }
    if both("auth", "clear") {
        return Some("removes your saved auth profiles".into());
    }
    None
}

/// True when the command only reads or exports and cannot change a remote
/// environment (used for a reassuring "read-only" badge). Conservative: unknown
/// verbs are treated as *not* read-only.
pub fn pac_read_only(command: &str) -> bool {
    if pac_danger(command).is_some() {
        return false;
    }
    let low = command.to_ascii_lowercase();
    const READ_VERBS: &[&str] = &[
        "list", "who", "show", "help", "export", "download", "unpack", "check",
    ];
    low.contains("--version")
        || READ_VERBS
            .iter()
            .any(|v| low.split_whitespace().any(|t| t == *v))
}

impl crate::AgentPlanner {
    /// Map a natural-language ALM request to a single `pac` command, grounded by
    /// [`PAC_CHEATSHEET`]. The returned [`PacPlan`] carries a Rust-derived risk
    /// classification; execution happens later through the approval-gated shell
    /// path, so this method never runs anything.
    pub fn plan_pac(&self, request: &str) -> Result<PacPlan, AgentError> {
        let prompt = format!(
            "You translate a natural-language Power Platform request into ONE Microsoft \
             Power Platform CLI (`pac`) command, using ONLY the reference below. Reply \
             with EXACTLY ONE JSON object: {{\"command\":\"<the full pac command, or empty \
             if the request isn't a pac operation>\",\"explanation\":\"<one short line on \
             what it does>\"}}. Use placeholder tokens like <url>, <unique>, <out.zip> when \
             the request doesn't specify a concrete value — do NOT invent names. Never \
             chain commands or add shell operators; a single `pac …` command only.\n\n\
             REFERENCE:\n{PAC_CHEATSHEET}\n\n\
             REQUEST: {request}"
        );
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "explanation": { "type": "string" }
            },
            "required": ["command", "explanation"]
        });
        let raw = self.backend.complete(&prompt, Some(&schema))?;
        let v: serde_json::Value = serde_json::from_str(raw.trim())?;
        let command = v
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let explanation = v
            .get("explanation")
            .and_then(|e| e.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        // Risk is decided here, from the command text — not by the model.
        let (danger, read_only) = if command.is_empty() {
            (None, false)
        } else {
            (pac_danger(&command), pac_read_only(&command))
        };
        Ok(PacPlan {
            command,
            explanation,
            danger,
            read_only,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentPlanner, MockBackend};

    #[test]
    fn danger_flags_env_mutations() {
        assert!(pac_danger("pac solution import --path app.zip").is_some());
        assert!(pac_danger("pac solution delete --solution-name Foo").is_some());
        assert!(pac_danger("pac admin reset --environment x").is_some());
        assert!(pac_danger("pac solution import --path a.zip --publish-changes").is_some());
        assert!(pac_danger("pac auth create --environment https://x.crm.dynamics.com").is_some());
    }

    #[test]
    fn safe_and_local_ops_are_not_flagged() {
        for c in [
            "pac solution list",
            "pac solution export --name Foo --path foo.zip",
            "pac canvas unpack --msapp a.msapp --sources src",
            "pac solution check --path foo.zip",
            "pac env list",
        ] {
            assert!(pac_danger(c).is_none(), "should be safe: {c}");
        }
    }

    #[test]
    fn read_only_classification() {
        assert!(pac_read_only("pac solution list"));
        assert!(pac_read_only(
            "pac solution export --name Foo --path foo.zip"
        ));
        assert!(pac_read_only("pac --version"));
        // Writes/local-writes/imports are not "read-only".
        assert!(!pac_read_only("pac solution import --path foo.zip"));
        assert!(!pac_read_only(
            "pac canvas pack --sources src --msapp a.msapp"
        ));
    }

    #[test]
    fn substring_verbs_dont_false_trigger() {
        // "important" must not read as the "import" verb (token match, not substring).
        assert!(pac_danger("pac solution export --name Important --path i.zip").is_none());
    }

    #[test]
    fn plan_pac_wraps_and_classifies_via_mock() {
        // MockBackend echoes structured JSON generically; drive it through the real
        // JSON extraction + Rust classification. The mock returns a refuse-shaped
        // object for unknown intents, so command comes back empty and safe.
        let planner = AgentPlanner::new(Box::new(MockBackend));
        let plan = planner
            .plan_pac("export my solution called Contoso")
            .unwrap();
        // Whatever the (mock) model said, classification is derived, never panics,
        // and an empty command is never marked read-only or dangerous.
        if plan.command.is_empty() {
            assert!(plan.danger.is_none() && !plan.read_only);
        }
    }
}
