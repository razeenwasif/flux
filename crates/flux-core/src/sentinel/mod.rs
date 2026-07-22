//! Sentinel — the AI-assisted security layer (ADR 0013).
//!
//! This first module is Pillar 0's **action audit log**: an append-only,
//! **sealed (AES-256-GCM, reusing the trace key ladder)** record of what the
//! agent did on the user's behalf — a security control *and* a trust/debug
//! surface. Detectors + the phishing verdict cache (Pillars 1–3) land beside it
//! later, hence the module dir.

mod audit;
pub mod explain;
pub mod oauth;
pub mod phishing;
pub mod sensitive;

pub use audit::{AuditEntry, SentinelAudit};

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::state::FluxState;

/// Host portion of a URL (scheme-agnostic, no port/path).
fn host_of(url: &str) -> String {
    let after = url.split("://").nth(1).unwrap_or(url);
    after
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// How long a computed brand set stays warm. The set moves only when you save a
/// credential or revisit a host enough to matter, so a short TTL costs nothing
/// in accuracy — and the seed brands (the high-value impersonation targets) are
/// always present regardless.
const BRANDS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// The memoized brand set and when it was computed.
type BrandCache = Mutex<Option<(std::time::Instant, Vec<String>)>>;

/// Memoized wrapper around [`compute_known_good_brands`]. It reads the vault and
/// 300 Trail entries and builds a set — cheap once, but it is now on the path of
/// every navigation (twice: the instant pass and the deferred one) plus every
/// vault autofill/save, so it is worth not recomputing per call.
fn known_good_brands(app: &AppHandle) -> Vec<String> {
    static CACHE: std::sync::OnceLock<BrandCache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((at, brands)) = guard.as_ref() {
            if at.elapsed() < BRANDS_TTL {
                return brands.clone();
            }
        }
    }
    let fresh = compute_known_good_brands(app);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((std::time::Instant::now(), fresh.clone()));
    }
    fresh
}

/// The user's high-value brand labels — the impersonation-TARGET set, tiered by
/// strength (ADR 0013): vault origins (credentials saved there) > Trail-frequent
/// hosts (real engagement) > the curated seed. Deduped. NOT an allowlist.
fn compute_known_good_brands(app: &AppHandle) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut set: BTreeSet<String> = phishing::SEED_BRANDS.iter().map(|s| s.to_string()).collect();

    // Strongest: origins the user saved credentials for (metadata only — no
    // secrets touched). Best-effort: skip if the vault can't be read.
    if let Some(vault) = app.try_state::<crate::vault::VaultState>() {
        if let Ok(metas) = crate::vault::vault_list(vault) {
            for m in metas {
                for url in m.urls {
                    let l = phishing::brand_label(&host_of(&url));
                    if l.len() >= 3 {
                        set.insert(l);
                    }
                }
            }
        }
    }
    // Broad: Trail hosts with real engagement (hits ≥ 2), not raw visits — a
    // drive-by lookalike never becomes a brand worth protecting.
    if let Some(trace) = app.try_state::<crate::trace::TraceStore>() {
        for v in trace.recent(300) {
            if v.hits >= 2 {
                let l = phishing::brand_label(&host_of(&v.url));
                if l.len() >= 3 {
                    set.insert(l);
                }
            }
        }
    }
    set.into_iter().collect()
}

/// Everything the **deterministic** layer can say the moment a navigation lands
/// (ADR 0013). One call per navigation instead of one per detector: the checks
/// share a single `known_good_brands` computation (which reads the vault and the
/// Trail), and the shell does one round trip instead of three.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct NavAssessment {
    /// Pillar 1 — this host resembles a brand you value.
    pub phishing: Option<phishing::Verdict>,
    /// Pillar 1 — an OAuth consent screen requesting sensitive scopes.
    pub oauth: Option<oauth::OAuthConsent>,
    /// Pillar 2 — a bank/health/gov session worth isolating.
    pub sensitive: Option<sensitive::SensitiveSite>,
}

/// Run every deterministic navigation check at once (ADR 0013). No model, no
/// page content — instant and always available. The model-backed refinements
/// land later via [`sentinel_after_load`], once the page text has been captured.
#[tauri::command]
pub async fn sentinel_on_navigate(app: AppHandle, url: String) -> Result<NavAssessment, String> {
    let host = host_of(&url);
    if host.is_empty() || !url.starts_with("http") {
        return Ok(NavAssessment {
            phishing: None,
            oauth: None,
            sensitive: None,
        });
    }
    Ok(NavAssessment {
        // Computed once and used only here — the expensive part of the trio.
        phishing: phishing::assess(&host, &known_good_brands(&app)),
        oauth: oauth::detect(&url),
        sensitive: sensitive::classify(&host),
    })
}

/// A one-line, agent-written assessment of a live permission request
/// (ADR 0013, Pillar 2 M4). Advisory annotation for the *existing* prompt —
/// the user still decides; nothing here allows or denies.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PermissionNote {
    /// Whether the model judged the request expected for this kind of page.
    pub expected: bool,
    /// One short sentence for the permission bar.
    pub note: String,
}

/// Assess whether a permission request fits the page asking for it. Called by
/// the shell when the permission bar appears; the bar renders immediately and
/// fills this in when it arrives, so the model is never on the prompt's path.
/// `None` whenever we can't say anything useful (no page text yet, model down)
/// — the prompt then behaves exactly as it always has.
#[tauri::command]
pub async fn sentinel_assess_permission(
    state: State<'_, FluxState>,
    host: String,
    permission: String,
) -> Result<Option<PermissionNote>, String> {
    let Some(snap) = state.active_snapshot() else {
        return Ok(None);
    };
    if host_of(&snap.url) != host_of(&host) && !host.is_empty() {
        return Ok(None); // snapshot is for a different page — don't guess
    }
    let text = snap.text.to_string();
    if text.trim().is_empty() {
        return Ok(None);
    }
    let title = state
        .tabs
        .iter()
        .find(|t| host_of(&t.url) == host_of(&host))
        .map(|t| t.title.clone())
        .unwrap_or_default();

    let judged = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().assess_permission(&host, &permission, &title, &text)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Advisory only: a model that's down or unhelpful simply adds nothing.
    Ok(match judged {
        Ok(j) if !j.note.trim().is_empty() => Some(PermissionNote {
            expected: j.expected,
            note: j.note,
        }),
        _ => None,
    })
}

/// A privacy explainer (ADR 0013, Pillar 3 M5). `summary` is always present and
/// always numerically honest — Rust computed it. `insight` is the model's
/// optional "so what", shown beside it; empty when no model is available.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct Explainer {
    pub summary: String,
    pub insight: String,
}

/// Decode a consent banner from an already-captured page (ADR 0013, Pillar 3).
/// `None` unless the page actually carries one. The summary is deterministic;
/// the model only adds what accepting would enable, and its absence costs
/// nothing. Takes the snapshot so the deferred pass captures the page once.
async fn consent_check(
    snap: Option<std::sync::Arc<crate::state::DomSnapshot>>,
) -> Result<Option<Explainer>, String> {
    let Some(snap) = snap else {
        return Ok(None);
    };
    let text = snap.text.to_string();
    if !explain::looks_like_consent(&text) {
        return Ok(None);
    }
    let summary =
        "This page is asking you to accept cookies and data sharing with its partners.".to_string();
    // Hand the model the banner's own words; it explains what "Accept" enables.
    let banner = format!(
        "A cookie consent banner says: {}",
        text.chars().take(1500).collect::<String>()
    );
    let insight = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().explain_privacy(&banner)
    })
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_default();
    Ok(Some(Explainer { summary, insight }))
}

/// Click the page's genuine "reject / necessary only" control (ADR 0013,
/// Pillar 3 M5) — the one buried behind "Manage preferences".
///
/// The click vocabulary lives in Rust ([`explain::REJECT_TERMS`]) and is baked
/// into the injected script, so the **model never chooses what is clicked** —
/// this stays on the right side of the read ≠ act firewall, and it only runs
/// when the user explicitly asks. Fire-and-forget: the page's own banner
/// disappearing (or not) is the honest feedback, so nothing here claims success.
#[tauri::command]
pub fn sentinel_reject_consent(app: AppHandle, tab_id: u64) -> Result<(), String> {
    crate::webview::eval(&app, tab_id, &explain::reject_js())
}

/// One notable clause from a privacy policy / ToS (ADR 0013, Pillar 3 M5).
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PolicyFlag {
    pub clause: String,
    pub why: String,
}

/// Read the active page as a privacy policy / ToS and surface the few clauses
/// that actually affect the reader (ADR 0013, Pillar 3 M5). Run **on demand**
/// (the user asks), not on navigation — it reads a long document, so it's the
/// one explainer worth an explicit click. Empty when there's nothing notable,
/// no page text, or no model: an explainer that can't explain says nothing.
#[tauri::command]
pub async fn sentinel_policy_flags(
    state: State<'_, FluxState>,
) -> Result<Vec<PolicyFlag>, String> {
    let Some(snap) = state.active_snapshot() else {
        return Ok(Vec::new());
    };
    let text = snap.text.to_string();
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let title = state
        .tabs
        .iter()
        .find(|t| t.url == snap.url)
        .map(|t| t.title.clone())
        .unwrap_or_default();

    let flags = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().flag_policy(&title, &text)
    })
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_default();

    Ok(flags
        .into_iter()
        .map(|f| PolicyFlag {
            clause: f.clause,
            why: f.why,
        })
        .collect())
}

/// Narrate the tracker graph (ADR 0013, Pillar 3 M5) — "the graph → a sentence".
/// The figures come from a deterministic aggregation and the model is only asked
/// what they *mean*, so a wandering or absent model can never misstate them.
#[tauri::command]
pub async fn sentinel_tracker_narrative(
    store: State<'_, crate::trackers::TrackerStore>,
) -> Result<Explainer, String> {
    let facts = explain::tracker_facts(&store.graph());
    let summary = explain::tracker_sentence(&facts);
    // Nothing meaningful recorded → don't wake the model to editorialize on it.
    if facts.third_parties == 0 {
        return Ok(Explainer {
            summary,
            insight: String::new(),
        });
    }
    let for_model = summary.clone();
    let insight = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().explain_privacy(&for_model)
    })
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_default();
    Ok(Explainer { summary, insight })
}

/// Credential-entry firewall check (ADR 0013, Pillar 2 M4): does `host` look
/// like an impersonation of a brand the user values, *at the moment credentials
/// are at stake*?
///
/// Unlike the browsing-time check this removes the host's **own** brand label
/// from the known-good set first. Vault origins feed that set, so a credential
/// saved *on* a phishing site would otherwise whitewash it into "known-good"
/// and permanently suppress its own warning — the exact inverse of what should
/// happen. A lookalike never gets to vouch for itself here.
pub fn credential_origin_risk(app: &AppHandle, host: &str) -> Option<phishing::Verdict> {
    assess_excluding_self(host, known_good_brands(app))
}

/// The pure half of [`credential_origin_risk`] — drops `host`'s own brand label
/// from the known-good set before assessing, so a lookalike can't vouch for
/// itself. Split out so the whitewash defense is unit-testable without an app.
fn assess_excluding_self(host: &str, brands: Vec<String>) -> Option<phishing::Verdict> {
    let own = phishing::brand_label(host);
    let filtered: Vec<String> = brands.into_iter().filter(|b| *b != own).collect();
    phishing::assess(host, &filtered)
}

/// Memoized `(url, content-hash) → refined verdict` cache (ADR 0013: "memoized
/// per (url, content-hash) like Shields' decision cache"). Bounded; the model is
/// never re-run for a page whose URL + visible text we already judged.
fn verdict_cache() -> &'static Mutex<HashMap<u64, Option<phishing::Verdict>>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<u64, Option<phishing::Verdict>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(url: &str, text: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    text.len().hash(&mut h); // length + prefix is enough to notice a content change
    text.as_bytes().iter().take(512).for_each(|b| b.hash(&mut h));
    h.finish()
}

/// Does the captured HTML expose a credential field? A cheap, robust signal the
/// LLM verdict conditions on (a lookalike with a password box is far worse).
fn has_credential_field(html: &str) -> bool {
    let h = html.to_ascii_lowercase();
    h.contains("type=\"password\"") || h.contains("type='password'") || h.contains("type=password")
}

/// Fold the model's content judgment into the deterministic verdict (ADR 0013,
/// Pillar 1 M3). The model may **confirm/escalate** (→ High, with its reason) or
/// **clear a false positive** (→ None); "suspicious" keeps the deterministic
/// verdict and annotates it. Fail-safe: this is only reached when the model
/// actually answered — a model that's down never removes protection.
fn fold_judgment(
    deterministic: phishing::Verdict,
    j: &flux_agent::PhishingJudgment,
) -> Option<phishing::Verdict> {
    // Keep the model's reasons short and clearly attributed.
    let agent_reasons: Vec<String> = j
        .reasons
        .iter()
        .filter(|r| !r.trim().is_empty())
        .take(2)
        .map(|r| format!("Flux read the page: {}", r.trim()))
        .collect();
    match j.verdict.as_str() {
        "legitimate" => None,
        "phishing" => {
            let mut reasons = agent_reasons;
            reasons.extend(deterministic.reasons);
            Some(phishing::Verdict {
                resembles: deterministic.resembles,
                reasons,
                confidence: phishing::Confidence::High,
            })
        }
        // "suspicious" (or anything else) → keep the deterministic verdict,
        // append the model's note without changing its confidence.
        _ => {
            let mut v = deterministic;
            v.reasons.extend(agent_reasons);
            Some(v)
        }
    }
}

/// Refine the deterministic phishing flag with a local-model content judgment
/// (ADR 0013, Pillar 1 M3), reading an already-captured page. Fail-safe: any
/// error, missing content, or absent model leaves the deterministic verdict
/// standing (never fail-open). Takes the snapshot so the deferred pass captures
/// the page once and both refinements read the same bytes.
async fn verify_url(
    app: &AppHandle,
    snap: Option<std::sync::Arc<crate::state::DomSnapshot>>,
    url: &str,
    title: String,
) -> Result<Option<phishing::Verdict>, String> {
    let host = host_of(url);
    if host.is_empty() || !url.starts_with("http") {
        return Ok(None);
    }
    // No deterministic suspicion → nothing to refine; don't wake the model.
    let Some(deterministic) = phishing::assess(&host, &known_good_brands(app)) else {
        return Ok(None);
    };

    // Use the visible text + credential signal only if the snapshot is for THIS
    // page (a stale snapshot from another tab is useless).
    let (text, has_form) = match snap {
        Some(s) if host_of(&s.url) == host && !s.text.trim().is_empty() => {
            (s.text.to_string(), has_credential_field(&s.html))
        }
        // No matching content yet → can't refine; keep the deterministic flag.
        _ => return Ok(Some(deterministic)),
    };

    let key = cache_key(url, &text);
    if let Some(hit) = verdict_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }

    let resembles = deterministic.resembles.clone();
    let judgment = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().assess_phishing(&host, &resembles, &title, &text, has_form)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Fail-safe: a model error keeps the deterministic verdict (never clears it).
    let refined = match judgment {
        Ok(j) => fold_judgment(deterministic, &j),
        Err(_) => Some(deterministic),
    };

    if let Ok(mut cache) = verdict_cache().lock() {
        if cache.len() >= 512 {
            cache.clear(); // crude bound; verdicts are cheap to recompute
        }
        cache.insert(key, refined.clone());
    }
    Ok(refined)
}

/// The model-backed pass, run once the page's text has been captured (ADR 0013).
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct LoadAssessment {
    /// The refined phishing verdict. `None` means the model cleared a false
    /// positive, or nothing was flagged in the first place — either way the
    /// banner should end up hidden.
    pub phishing: Option<phishing::Verdict>,
    /// A decoded cookie-consent banner, if the page carries one.
    pub consent: Option<Explainer>,
}

/// Everything that needs the captured page, in one deferred call (ADR 0013):
/// the phishing refinement (Pillar 1) and the consent decode (Pillar 3).
///
/// The snapshot is read **once** and shared, so the two passes agree on exactly
/// which page they judged — and neither wakes the model without cause
/// (`verify_url` returns early unless the deterministic layer already fired;
/// `consent_check` unless a banner is actually present).
#[tauri::command]
pub async fn sentinel_after_load(
    app: AppHandle,
    state: State<'_, FluxState>,
    url: String,
    title: String,
) -> Result<LoadAssessment, String> {
    let snap = state.active_snapshot();
    Ok(LoadAssessment {
        phishing: verify_url(&app, snap.clone(), &url, title).await?,
        consent: consent_check(snap).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flux_agent::PhishingJudgment;
    use phishing::{Confidence, Verdict};

    fn low() -> Verdict {
        Verdict {
            resembles: "paypal".into(),
            reasons: vec!["“paypaI.com” is one or two edits from “paypal”".into()],
            confidence: Confidence::Low,
        }
    }

    fn judge(verdict: &str, reasons: &[&str]) -> PhishingJudgment {
        PhishingJudgment {
            verdict: verdict.into(),
            brand: "paypal".into(),
            reasons: reasons.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn host_parsing_is_scheme_and_userinfo_safe() {
        assert_eq!(host_of("https://user@Paypal.com:443/login"), "paypal.com");
        assert_eq!(host_of("http://a.b.c/x"), "a.b.c");
        assert_eq!(host_of("notaurl"), "notaurl");
    }

    #[test]
    fn credential_field_detected_across_quote_styles() {
        assert!(has_credential_field(r#"<input type="password">"#));
        assert!(has_credential_field("<input type=password name=pw>"));
        assert!(has_credential_field("<INPUT TYPE='PASSWORD'>"));
        assert!(!has_credential_field("<input type=\"text\">"));
    }

    #[test]
    fn model_phishing_escalates_to_high_and_keeps_both_reasons() {
        let v = fold_judgment(low(), &judge("phishing", &["it shows a PayPal login form"])).unwrap();
        assert_eq!(v.confidence, Confidence::High);
        assert!(v.reasons.iter().any(|r| r.contains("Flux read the page")));
        assert!(v.reasons.iter().any(|r| r.contains("edits from")), "deterministic reason kept");
    }

    #[test]
    fn model_legitimate_clears_the_false_positive() {
        assert!(fold_judgment(low(), &judge("legitimate", &[])).is_none());
    }

    #[test]
    fn model_suspicious_keeps_confidence_and_annotates() {
        let v = fold_judgment(low(), &judge("suspicious", &["unclear branding"])).unwrap();
        assert_eq!(v.confidence, Confidence::Low, "not downgraded/upgraded");
        assert!(v.reasons.iter().any(|r| r.contains("Flux read the page")));
    }

    #[test]
    fn saved_lookalike_cannot_whitewash_itself_at_credential_time() {
        // The user was phished once and saved a credential on paypa1.com, so its
        // own label is now in the known-good set (vault origins feed it).
        // Sorted, as `known_good_brands` returns it (BTreeSet) — and that order
        // is what makes the hole bite: "paypa1" < "paypal", so the self-match is
        // reached before the impersonation match that would have flagged it.
        let brands = vec!["paypa1".to_string(), "paypal".to_string()];
        // Browsing-time assess is suppressed by that self-match…
        assert!(
            phishing::assess("paypa1.com", &brands).is_none(),
            "self-match suppresses the browsing-time check (the hole)",
        );
        // …but the credential-entry firewall drops the host's own label first,
        // so it still flags — a lookalike never vouches for itself.
        let v = assess_excluding_self("paypa1.com", brands).expect("firewall still flags");
        assert_eq!(v.resembles, "paypal");
        assert_eq!(v.confidence, Confidence::High);
    }

    #[test]
    fn firewall_does_not_flag_your_own_real_bank() {
        // The everyday case: you're on the genuine site you have saved.
        let brands = vec!["paypal".to_string(), "chase".to_string(), "github".to_string()];
        assert!(assess_excluding_self("paypal.com", brands.clone()).is_none());
        assert!(assess_excluding_self("login.chase.com", brands.clone()).is_none());
        assert!(assess_excluding_self("example.com", brands).is_none());
    }

    #[test]
    fn empty_model_reasons_are_dropped() {
        let v = fold_judgment(low(), &judge("suspicious", &["  ", ""])).unwrap();
        assert!(v.reasons.iter().all(|r| !r.contains("Flux read the page")));
    }
}
