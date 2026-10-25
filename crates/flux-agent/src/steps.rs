//! Agent task steps (Flux Next): what kind each step is, what it may never do,
//! and whether it did what it was for.
//!
//! **Code decides, never the model.** A step's kind comes from its action and
//! from facts about its target that Flux reads from the page itself (in its own
//! JavaScript world, so the page can't answer for it):
//! - **Read**: following a link, scrolling, extracting. Runs without asking.
//! - **Draft**: typing, or a control that changes the page but sends nothing.
//!   Runs without asking.
//! - **Commit**: submitting a form, or a control labelled to pay, send, post,
//!   book, delete and the like. Asks first, with a preview, and runs once.
//!
//! Each step also names its effect, from code: what a fresh look at the page
//! has to show for the step to count as done. Until it does, the step is
//! "applied, unverified", and a task that ends with one says so.
//!
//! Some steps never run: typing into a password, card or one-time-code field,
//! and anything on a banking, password-manager, health or tax site.

use serde::{Deserialize, Serialize};

use crate::AgentAction;

/// What Flux read about a step's target, from its own script in the page.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, specta::Type)]
#[serde(default)]
pub struct TargetFacts {
    pub found: bool,
    /// Lower-case tag of the element the selector names.
    pub tag: String,
    pub role: String,
    /// Its `type` attribute, lower-case.
    pub input_type: String,
    pub autocomplete: String,
    /// Its `name` and `id`.
    pub name: String,
    /// What the control a click would activate is called.
    pub label: String,
    /// Where a link goes (absolute), else empty.
    pub href: String,
    /// A click on it submits a form.
    pub submits: bool,
    /// A field's current text (never a password's).
    pub value: String,
    pub disabled: bool,
    /// ARIA expanded/checked/selected/pressed and `checked`, to see a toggle move.
    pub state: String,
}

/// The page as Flux's script saw it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, specta::Type)]
#[serde(default)]
pub struct PageFacts {
    /// Flux could look (macOS). Elsewhere every field is empty, and steps
    /// fall back to asking and to "unverified".
    pub checked: bool,
    pub url: String,
    /// A visible password field: a sign-in the user has to do.
    pub sign_in: bool,
    pub captcha: bool,
    pub text_len: u32,
    /// A hash of the visible text, to tell whether the page changed.
    pub text_hash: String,
    pub target: Option<TargetFacts>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Read,
    Draft,
    Commit,
}

/// What code makes of a planned step.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
pub struct StepGuard {
    pub kind: StepKind,
    /// Why it's that kind, in a few words.
    pub why: String,
    /// What it's for: what a fresh look at the page has to show.
    pub effect: String,
    /// Set when it may not run at all, saying why.
    pub blocked: Option<String>,
    /// For a commit: what it does, for the approval card.
    pub preview: String,
    /// The target, to tell whether it changed between approval and running.
    pub fingerprint: String,
}

/// Whether the step did what it was for.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
pub struct StepVerdict {
    pub verified: bool,
    /// What the fresh look found.
    pub how: String,
}

// ─── Places and fields the agent never touches ───────────────────────────────

/// Sites Flux's agent doesn't act on, by registrable domain or a word in the
/// host. Kept to clear cases: a missed bank still meets the commit rules, a
/// wrongly listed site just can't be automated.
const SENSITIVE_DOMAINS: &[(&str, &str)] = &[
    // Banking and payments
    ("commbank.com.au", "banking"),
    ("westpac.com.au", "banking"),
    ("anz.com", "banking"),
    ("anz.com.au", "banking"),
    ("nab.com.au", "banking"),
    ("ing.com.au", "banking"),
    ("macquarie.com.au", "banking"),
    ("bendigobank.com.au", "banking"),
    ("ubank.com.au", "banking"),
    ("stgeorge.com.au", "banking"),
    ("chase.com", "banking"),
    ("bankofamerica.com", "banking"),
    ("wellsfargo.com", "banking"),
    ("citi.com", "banking"),
    ("capitalone.com", "banking"),
    ("hsbc.com", "banking"),
    ("barclays.co.uk", "banking"),
    ("monzo.com", "banking"),
    ("revolut.com", "banking"),
    ("wise.com", "banking"),
    ("paypal.com", "banking"),
    // Password managers
    ("1password.com", "password-manager"),
    ("bitwarden.com", "password-manager"),
    ("lastpass.com", "password-manager"),
    ("dashlane.com", "password-manager"),
    ("keepersecurity.com", "password-manager"),
    ("nordpass.com", "password-manager"),
    ("roboform.com", "password-manager"),
    // Health
    ("mychart.com", "health"),
    ("myhealthrecord.gov.au", "health"),
    ("medicare.gov", "health"),
    ("servicesaustralia.gov.au", "health"),
    ("hotdoc.com.au", "health"),
    ("healthengine.com.au", "health"),
    // Tax and government accounts that hold them
    ("ato.gov.au", "tax"),
    ("my.gov.au", "tax"),
    ("irs.gov", "tax"),
    ("hmrc.gov.uk", "tax"),
    ("turbotax.intuit.com", "tax"),
    ("hrblock.com", "tax"),
    ("taxact.com", "tax"),
];
/// Words that mark a host the same way, matched against each of its labels:
/// at the start of one (`taxact`, `bankofamerica`), or, for banks, at the end
/// too (`netbank`, `commbank`). Not anywhere: "syntax" isn't a tax site.
const SENSITIVE_WORDS: &[(&str, &str, bool)] = &[
    ("bank", "banking", true),
    ("creditunion", "banking", true),
    ("patient", "health", false),
    ("hospital", "health", false),
    ("pharmacy", "health", false),
    ("tax", "tax", false),
];

fn host_of(url: &str) -> Option<String> {
    let after = url.split("://").nth(1)?;
    let host = after.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The kind of sensitive site `url` is on, if it's one the agent stays out of.
pub fn sensitive_site(url: &str) -> Option<&'static str> {
    let host = host_of(url)?;
    let host = host.trim_start_matches("www.");
    for &(domain, kind) in SENSITIVE_DOMAINS {
        if host == domain || host.ends_with(&format!(".{domain}")) {
            return Some(kind);
        }
    }
    let labels: Vec<&str> = host.split('.').collect();
    SENSITIVE_WORDS
        .iter()
        .find(|(word, _, at_end)| {
            labels
                .iter()
                .any(|l| l.starts_with(word) || (*at_end && l.ends_with(word)))
        })
        .map(|&(_, kind, _)| kind)
}

/// What kind of field this is, if the agent may never type into it.
pub fn sensitive_field(t: &TargetFacts) -> Option<&'static str> {
    let auto = t.autocomplete.as_str();
    let words = format!("{} {} {}", t.name, t.label, t.autocomplete).to_ascii_lowercase();
    if t.input_type == "password" || auto.contains("password") {
        return Some("a password field");
    }
    // Whole words, as the in-page guard (compile.rs) matches them: a field
    // called "hotplate" isn't an OTP.
    if auto.contains("one-time-code")
        || ["otp", "2fa", "one-time", "verification code", "totp"]
            .iter()
            .any(|w| word_in(&words, w))
    {
        return Some("a one-time code field");
    }
    if auto.starts_with("cc-") || auto.contains(" cc-") {
        return Some("a card field");
    }
    let card = [
        "card number",
        "cardnumber",
        "card-number",
        "ccnum",
        "cc-num",
        "cvv",
        "cvc",
        "csc",
        "security code",
        "expiry",
    ];
    if card.iter().any(|w| word_in(&words, w)) || words.contains("cardnumber") {
        return Some("a card field");
    }
    None
}

// ─── Kinds ───────────────────────────────────────────────────────────────────

/// Labels that send, buy, book, publish or delete: a click on one is a commit
/// whether or not it sits in a form. Matched as whole words in the label.
const COMMIT_WORDS: &[&str] = &[
    "buy",
    "pay",
    "purchase",
    "checkout",
    "check out",
    "place order",
    "order now",
    "send",
    "post",
    "publish",
    "submit",
    "delete",
    "remove",
    "book",
    "reserve",
    "confirm",
    "subscribe",
    "unsubscribe",
    "sign up",
    "register",
    "transfer",
    "donate",
    "apply",
    "save",
    "upload",
    "share",
    "invite",
    "accept",
    "decline",
    "cancel order",
    "cancel subscription",
    "reply",
    "comment",
    "tweet",
    "merge",
    "approve",
];

fn word_in(label: &str, phrase: &str) -> bool {
    let label = label.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = label[from..].find(phrase) {
        let start = from + at;
        let end = start + phrase.len();
        let before = label[..start].chars().next_back();
        let after = label[end..].chars().next();
        let edge = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        if edge(before) && edge(after) {
            return true;
        }
        from = end;
    }
    false
}

/// The commit word a label carries, if any.
pub fn commit_word(label: &str) -> Option<&'static str> {
    COMMIT_WORDS
        .iter()
        .chain(crate::DESTRUCTIVE_TERMS)
        .copied()
        .find(|w| word_in(label, w))
}

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// Where a URL goes, readably: host and path.
fn place(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    short(
        after
            .split(['?', '#'])
            .next()
            .unwrap_or(after)
            .trim_end_matches('/'),
        60,
    )
}

fn fingerprint(t: Option<&TargetFacts>) -> String {
    match t {
        Some(t) => format!(
            "{}|{}|{}|{}|{}|{}",
            t.tag,
            t.input_type,
            t.role,
            short(&t.label, 80),
            t.href,
            t.submits
        ),
        None => String::new(),
    }
}

/// What a planned step is, on a page at `page_url`, given what Flux read about
/// its target (`None` when it couldn't look: then every click asks).
pub fn classify(action: &AgentAction, page_url: &str, facts: Option<&TargetFacts>) -> StepGuard {
    let mut g = StepGuard {
        kind: StepKind::Read,
        why: String::new(),
        effect: String::new(),
        blocked: None,
        preview: String::new(),
        fingerprint: fingerprint(facts),
    };
    if matches!(
        action,
        AgentAction::Finish { .. } | AgentAction::Refuse { .. }
    ) {
        return g;
    }
    if let Some(kind) = sensitive_site(page_url) {
        g.blocked = Some(format!("Flux's agent doesn't act on {kind} sites"));
        return g;
    }
    if let Some(t) = facts {
        if !t.found {
            g.blocked = Some("that isn't on the page".into());
            return g;
        }
    }
    match action {
        AgentAction::Reveal { .. } => {
            g.why = "scrolls".into();
            g.effect = "it's on the page".into();
        }
        AgentAction::ExtractTable { .. } => {
            g.why = "reads".into();
            g.effect = "the table's data comes back".into();
        }
        AgentAction::Type { text, .. } => {
            if let Some(field) = facts.and_then(sensitive_field) {
                g.blocked = Some(format!("Flux's agent never types into {field}"));
                return g;
            }
            g.kind = StepKind::Draft;
            g.why = "fills in a field".into();
            g.effect = format!("the field holds “{}”", short(text, 40));
        }
        AgentAction::Click { reason, .. } => {
            let Some(t) = facts else {
                g.kind = StepKind::Commit;
                g.why = "Flux couldn't look at what it clicks".into();
                g.effect = "the page changes".into();
                g.preview = format!("Click: {}", short(reason, 80));
                return g;
            };
            if !t.href.is_empty() {
                if let Some(kind) = sensitive_site(&t.href) {
                    g.blocked = Some(format!("it leads to a {kind} site"));
                    return g;
                }
            }
            // Orders, payments and deletions Flux never clicks, asked or not
            // (#104: the click script refuses them too, on the live label).
            let lower = t.label.to_lowercase();
            if let Some(term) = crate::DESTRUCTIVE_TERMS.iter().find(|w| lower.contains(*w)) {
                g.blocked = Some(format!("“{term}” is yours to do: Flux never clicks it"));
                return g;
            }
            let host = host_of(page_url).unwrap_or_default();
            let named = if t.label.is_empty() {
                short(reason, 60)
            } else {
                short(&t.label, 60)
            };
            if t.submits || commit_word(&t.label).is_some() {
                g.kind = StepKind::Commit;
                g.why = match commit_word(&t.label) {
                    Some(w) => format!("labelled “{w}”"),
                    None => "sends a form".into(),
                };
                g.effect = "the page changes".into();
                g.preview = format!(
                    "Click “{named}” on {host}{}",
                    if t.submits { " (sends the form)" } else { "" }
                );
            } else if !t.href.is_empty() {
                g.why = "follows a link".into();
                g.effect = format!("the page moves to {}", place(&t.href));
            } else {
                g.kind = StepKind::Draft;
                g.why = "a control that sends nothing".into();
                g.effect = "the page changes".into();
            }
        }
        AgentAction::Finish { .. } | AgentAction::Refuse { .. } => {}
    }
    g
}

/// The URL without its fragment: an in-page jump isn't a move.
fn base(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

/// Whether a step did what it was for, from fresh looks before and after.
pub fn verify(action: &AgentAction, before: &PageFacts, after: &PageFacts) -> StepVerdict {
    let v = |verified: bool, how: &str| StepVerdict {
        verified,
        how: how.into(),
    };
    if !after.checked {
        return v(false, "Flux couldn't look at the page afterwards");
    }
    let moved = !before.url.is_empty() && base(&before.url) != base(&after.url);
    let changed = before.text_hash != after.text_hash;
    let target_after = after.target.as_ref();
    match action {
        AgentAction::Type { text, .. } => match target_after {
            Some(t) if t.found && t.value.trim() == text.trim() => v(true, "the field holds it"),
            Some(t) if t.found && t.value.contains(text.trim()) => v(true, "the field holds it"),
            _ if moved => v(false, "the page moved away before the field could be read"),
            _ => v(false, "the field doesn't hold the text"),
        },
        AgentAction::Click { .. } => {
            let link = before.target.as_ref().is_some_and(|t| !t.href.is_empty());
            if moved {
                return v(true, "the page moved");
            }
            if link {
                return v(false, "the page didn't move");
            }
            let before_t = before.target.as_ref();
            let gone = before_t.is_some_and(|b| b.found) && !target_after.is_some_and(|t| t.found);
            let toggled = matches!((before_t, target_after), (Some(b), Some(a)) if a.found && (b.state != a.state || b.disabled != a.disabled || b.label != a.label));
            if changed || gone || toggled {
                v(true, "the page changed")
            } else {
                v(false, "nothing on the page changed")
            }
        }
        AgentAction::Reveal { .. } => {
            if target_after.is_some_and(|t| t.found) {
                v(true, "it's on the page")
            } else {
                v(false, "it isn't on the page")
            }
        }
        // The data arriving is the check (the panel sees it land).
        AgentAction::ExtractTable { .. } => v(true, "read"),
        AgentAction::Finish { .. } | AgentAction::Refuse { .. } => v(true, ""),
    }
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/// Prefixes of credentials that turn up pasted into pages: API keys and
/// tokens. A word starting with one, and long enough, is a secret.
const SECRET_PREFIXES: &[(&str, usize)] = &[
    ("sk-", 20),
    ("sk_live_", 16),
    ("sk_test_", 16),
    ("rk_live_", 16),
    ("pk_live_", 16),
    ("ghp_", 30),
    ("gho_", 30),
    ("ghu_", 30),
    ("ghs_", 30),
    ("ghr_", 30),
    ("github_pat_", 30),
    ("glpat-", 20),
    ("xoxb-", 20),
    ("xoxp-", 20),
    ("xoxa-", 20),
    ("xoxs-", 20),
    ("AKIA", 20),
    ("ASIA", 20),
    ("AIza", 35),
    ("npm_", 30),
    ("shpat_", 30),
    ("hf_", 30),
];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '/' | '+')
}

fn looks_like_jwt(w: &str) -> bool {
    let parts: Vec<&str> = w.split('.').collect();
    parts.len() == 3
        && w.starts_with("eyJ")
        && w.len() >= 40
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

fn is_secret_word(w: &str) -> bool {
    let w = w.trim_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '"' | '\'' | ')' | '('));
    SECRET_PREFIXES.iter().any(|(p, min)| {
        w.starts_with(p) && w.len() >= *min && w[p.len()..].chars().all(is_token_char)
    }) || looks_like_jwt(w)
}

/// Luhn check, for the digits of a possible card number.
fn luhn(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (i, d) in digits.iter().rev().enumerate() {
        let mut d = u32::from(*d);
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum.is_multiple_of(10)
}

/// Card numbers: 13–19 digits, in groups split by spaces or dashes, that pass
/// the Luhn check. Byte ranges into `text`.
fn card_spans(text: &str) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() || (i > 0 && b[i - 1].is_ascii_alphanumeric()) {
            i += 1;
            continue;
        }
        let start = i;
        let mut digits = Vec::new();
        let mut end = i;
        let mut j = i;
        while j < b.len() && digits.len() < 19 {
            if b[j].is_ascii_digit() {
                digits.push(b[j] - b'0');
                end = j + 1;
                j += 1;
            } else if (b[j] == b' ' || b[j] == b'-') && j + 1 < b.len() && b[j + 1].is_ascii_digit()
            {
                j += 1;
            } else {
                break;
            }
        }
        let clean_end = end >= b.len() || !b[end].is_ascii_alphanumeric();
        if (13..=19).contains(&digits.len()) && clean_end && luhn(&digits) {
            out.push((start, end));
            i = end;
        } else {
            i = start + 1;
        }
    }
    out
}

/// Page text with secret-shaped strings replaced by `[redacted]`: API keys and
/// tokens, JWTs, private-key blocks and card numbers. It's what reaches the
/// model, so a page (or a pasted log) can't hand it someone's credentials.
pub fn redact_secrets(text: &str) -> String {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    // Private key blocks, whole.
    let mut from = 0;
    while let Some(at) = text[from..].find("-----BEGIN ") {
        let start = from + at;
        let header_end = text[start..].find('\n').map_or(text.len(), |n| start + n);
        if !text[start..header_end].contains("PRIVATE KEY") {
            from = header_end;
            continue;
        }
        let end = text[start..]
            .find("-----END ")
            .and_then(|e| {
                text[start + e..]
                    .find("-----\n")
                    .or(Some(text.len() - start - e))
                    .map(|t| start + e + t + 5)
            })
            .unwrap_or(text.len())
            .min(text.len());
        spans.push((start, end));
        from = end;
        if from >= text.len() {
            break;
        }
    }
    // Words that are tokens.
    let mut i = 0;
    for w in text
        .split_inclusive(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
    {
        let word = w.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`')
        });
        if !word.is_empty() && is_secret_word(word) {
            spans.push((i, i + word.len()));
        }
        i += w.len();
    }
    spans.extend(card_spans(text));
    if spans.is_empty() {
        return text.to_string();
    }
    spans.sort();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (s, e) in spans {
        if s < at {
            at = at.max(e);
            continue;
        }
        out.push_str(&text[at..s]);
        out.push_str("[redacted]");
        at = e;
    }
    out.push_str(&text[at.min(text.len())..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(label: &str) -> (AgentAction, TargetFacts) {
        (
            AgentAction::Click {
                selector: "#x".into(),
                reason: "go on".into(),
            },
            TargetFacts {
                found: true,
                tag: "button".into(),
                label: label.into(),
                ..Default::default()
            },
        )
    }

    #[test]
    fn kinds_come_from_the_target_not_the_model() {
        let page = "https://shop.example/cart";
        let (a, t) = click("Send message");
        let g = classify(&a, page, Some(&t));
        assert_eq!(g.kind, StepKind::Commit);
        assert!(
            g.preview.contains("Send message") && g.preview.contains("shop.example"),
            "{}",
            g.preview
        );

        // What the click script never clicks isn't offered for approval.
        let mut order = t.clone();
        order.label = "Place order".into();
        let g = classify(&a, page, Some(&order));
        assert_eq!(
            g.blocked.as_deref(),
            Some("“place order” is yours to do: Flux never clicks it")
        );

        let mut form = t.clone();
        form.label = "Continue".into();
        form.submits = true;
        assert_eq!(classify(&a, page, Some(&form)).kind, StepKind::Commit);

        let mut link = t.clone();
        link.tag = "a".into();
        link.label = "Rooms".into();
        link.href = "https://shop.example/rooms?x=1".into();
        let g = classify(&a, page, Some(&link));
        assert_eq!(g.kind, StepKind::Read);
        assert_eq!(g.effect, "the page moves to shop.example/rooms");

        let mut tab = t.clone();
        tab.label = "Filters".into();
        assert_eq!(classify(&a, page, Some(&tab)).kind, StepKind::Draft);

        // A word inside another isn't one: "Bookmarks" isn't "book".
        let mut marks = t;
        marks.label = "Bookmarks".into();
        assert_eq!(classify(&a, page, Some(&marks)).kind, StepKind::Draft);
    }

    #[test]
    fn a_click_flux_couldnt_look_at_asks() {
        let (a, _) = click("x");
        let g = classify(&a, "https://example.com", None);
        assert_eq!(g.kind, StepKind::Commit);
    }

    #[test]
    fn some_steps_never_run() {
        let ty = AgentAction::Type {
            selector: "#p".into(),
            text: "hunter2".into(),
        };
        let field = |input_type: &str, autocomplete: &str, name: &str| TargetFacts {
            found: true,
            tag: "input".into(),
            input_type: input_type.into(),
            autocomplete: autocomplete.into(),
            name: name.into(),
            ..Default::default()
        };
        for (t, what) in [
            (field("password", "", ""), "password"),
            (field("text", "one-time-code", ""), "one-time code"),
            (field("tel", "cc-number", ""), "card"),
            (field("text", "", "cvc"), "card"),
        ] {
            let g = classify(&ty, "https://example.com", Some(&t));
            assert!(
                g.blocked.as_deref().is_some_and(|b| b.contains(what)),
                "{what}: {g:?}"
            );
        }
        let ok = classify(&ty, "https://example.com", Some(&field("search", "", "q")));
        assert_eq!(
            classify(
                &ty,
                "https://example.com",
                Some(&field("text", "", "hotplate"))
            )
            .blocked,
            None
        );
        assert_eq!((ok.kind, ok.blocked), (StepKind::Draft, None));

        let (a, t) = click("Statements");
        assert!(
            classify(&a, "https://www.commbank.com.au/netbank", Some(&t))
                .blocked
                .is_some()
        );
        assert!(classify(&a, "https://my.netbank.example", Some(&t))
            .blocked
            .is_some());
        assert!(
            classify(&a, "https://vault.bitwarden.com/#/vault", Some(&t))
                .blocked
                .is_some()
        );
        assert_eq!(sensitive_site("https://syntax.fm/show/1"), None);
        assert_eq!(sensitive_site("https://www.taxslayer.com/"), Some("tax"));
        assert_eq!(sensitive_site("https://github.com/rust-lang"), None);
        let mut to_bank = t.clone();
        to_bank.href = "https://www.paypal.com/signin".into();
        assert!(classify(&a, "https://shop.example", Some(&to_bank))
            .blocked
            .is_some_and(|b| b.contains("banking")));
        let mut gone = t;
        gone.found = false;
        assert!(classify(&a, "https://shop.example", Some(&gone))
            .blocked
            .is_some());
    }

    #[test]
    fn a_step_counts_only_when_a_fresh_look_shows_it() {
        let ty = AgentAction::Type {
            selector: "#q".into(),
            text: "rust".into(),
        };
        let page = |url: &str, hash: &str, value: &str| PageFacts {
            checked: true,
            url: url.into(),
            text_hash: hash.into(),
            target: Some(TargetFacts {
                found: true,
                value: value.into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(verify(&ty, &page("u", "1", ""), &page("u", "1", "rust")).verified);
        assert!(!verify(&ty, &page("u", "1", ""), &page("u", "1", "")).verified);

        let (cl, _) = click("x");
        assert!(
            verify(
                &cl,
                &page("https://a/x", "1", ""),
                &page("https://a/y", "1", "")
            )
            .verified
        );
        assert!(
            verify(
                &cl,
                &page("https://a/x", "1", ""),
                &page("https://a/x", "2", "")
            )
            .verified
        );
        let same = verify(
            &cl,
            &page("https://a/x", "1", ""),
            &page("https://a/x#top", "1", ""),
        );
        assert!(
            !same.verified,
            "an in-page jump with nothing changed isn't done"
        );
        assert_eq!(same.how, "nothing on the page changed");

        let blind = PageFacts::default();
        assert!(!verify(&cl, &blind, &blind).verified);
    }

    #[test]
    fn secrets_never_reach_the_model() {
        let text = "key sk-proj-AbCdEf0123456789xyzABCD and ghp_0123456789abcdefghijABCDEFGHIJ012345 \
                    token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U \
                    card 4111 1111 1111 1111 order 1234-5678-9012 phone 0412 345 678.";
        let out = redact_secrets(text);
        for gone in ["sk-proj", "ghp_", "eyJhbGci", "4111"] {
            assert!(!out.contains(gone), "{gone} in {out}");
        }
        assert!(out.contains("order 1234-5678-9012"), "not a card: {out}");
        assert!(out.contains("phone 0412 345 678"), "{out}");
        assert_eq!(out.matches("[redacted]").count(), 4, "{out}");

        let pem =
            "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nafter";
        let out = redact_secrets(pem);
        assert!(
            out.starts_with("before\n[redacted]") && out.ends_with("after"),
            "{out}"
        );
        assert_eq!(redact_secrets("nothing secret here"), "nothing secret here");
    }
}
