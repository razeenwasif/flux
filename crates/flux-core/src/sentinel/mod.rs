//! Sentinel — the AI-assisted security layer (ADR 0013).
//!
//! This first module is Pillar 0's **action audit log**: an append-only,
//! **sealed (AES-256-GCM, reusing the trace key ladder)** record of what the
//! agent did on the user's behalf — a security control *and* a trust/debug
//! surface. Detectors + the phishing verdict cache (Pillars 1–3) land beside it
//! later, hence the module dir.

mod audit;
pub mod phishing;

pub use audit::{AuditEntry, SentinelAudit};

use tauri::{AppHandle, Manager};

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
