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

/// The user's high-value brand labels — the impersonation-TARGET set, tiered by
/// strength (ADR 0013): vault origins (credentials saved there) > Trail-frequent
/// hosts (real engagement) > the curated seed. Deduped. NOT an allowlist.
fn known_good_brands(app: &AppHandle) -> Vec<String> {
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

/// Assess a URL for phishing/impersonation against the user's known-good brands
/// (ADR 0013, Pillar 1). Deterministic + local; `None` when nothing suspicious.
/// The frontend calls this on navigation to drive the banner/interstitial.
#[tauri::command]
pub async fn sentinel_check_url(
    app: AppHandle,
    url: String,
) -> Result<Option<phishing::Verdict>, String> {
    let host = host_of(&url);
    if host.is_empty() || !url.starts_with("http") {
        return Ok(None);
    }
    Ok(phishing::assess(&host, &known_good_brands(&app)))
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

/// Classify a URL as a sensitive session worth isolating in its own container
/// (ADR 0013, Pillar 2 M4). Deterministic + narrow — `None` for almost every
/// site, so the offer stays rare enough to be worth reading.
#[tauri::command]
pub fn sentinel_check_sensitive(url: String) -> Option<sensitive::SensitiveSite> {
    if !url.starts_with("http") {
        return None;
    }
    sensitive::classify(&host_of(&url))
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

/// Decode an OAuth consent screen (ADR 0013, Pillar 1 M3 — OAuth-consent
/// trigger). Deterministic + local: `Some` only when an app requests a sensitive
/// scope, so routine "Sign in with …" stays silent. Drives the consent-review
/// banner. No known-good lookup — the domain is genuine; the *grant* is the risk.
#[tauri::command]
pub fn sentinel_check_oauth(url: String) -> Option<oauth::OAuthConsent> {
    oauth::detect(&url)
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
/// (ADR 0013, Pillar 1 M3). Called async by the shell *after* `sentinel_check_url`
/// has shown the instant deterministic banner; this upgrades or clears it once
/// the page's visible text is available. Fail-safe: any error, missing content,
/// or absent model leaves the deterministic verdict standing (never fail-open).
#[tauri::command]
pub async fn sentinel_verify_url(
    app: AppHandle,
    state: State<'_, FluxState>,
    url: String,
    title: String,
) -> Result<Option<phishing::Verdict>, String> {
    let host = host_of(&url);
    if host.is_empty() || !url.starts_with("http") {
        return Ok(None);
    }
    // No deterministic suspicion → nothing to refine; don't wake the model.
    let Some(deterministic) = phishing::assess(&host, &known_good_brands(&app)) else {
        return Ok(None);
    };

    // Pull the visible text + credential signal from the active snapshot, but
    // only if it's for THIS page (a stale snapshot from another tab is useless).
    let snap = state.active_snapshot();
    let (text, has_form) = match snap {
        Some(s) if host_of(&s.url) == host && !s.text.trim().is_empty() => {
            (s.text.to_string(), has_credential_field(&s.html))
        }
        // No matching content yet → can't refine; keep the deterministic flag.
        _ => return Ok(Some(deterministic)),
    };

    let key = cache_key(&url, &text);
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
