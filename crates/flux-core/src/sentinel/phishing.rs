//! Deterministic phishing / impersonation pre-filter (ADR 0013, Pillar 1).
//!
//! No LLM: cheap, always-on detection that a domain is trying to *look like* a
//! brand the user values. It answers the one question a blocklist can't — "does
//! this resemble a known-good brand but isn't it?" — using three signals:
//!
//! - **homoglyph** attack: visually-confusable characters folded to a canonical
//!   form (`paypa1`, `pаypal` with a Cyrillic а → `paypal`);
//! - **typosquat**: a small edit distance to a known brand (`gooogle`, `payple`);
//! - **brand-embedding**: the brand as a component of a different domain
//!   (`paypal-secure`, `login-apple`).
//!
//! "Known-good" is the impersonation-TARGET set (vault origins > Trail-frequent >
//! this curated seed), NOT an allowlist — its only jobs are to be the set of
//! brands worth impersonating and to suppress false positives on the user's own
//! sites. The agent verdict (M3) refines only when this fires.
//!
//! v1 registrable-domain handling is the last-two-labels heuristic; a Public
//! Suffix List is a documented refinement (multi-part TLDs like `co.uk`).

/// The most-impersonated brands — a cold-start seed so a fresh install has day-1
/// protection before the user's vault/Trail set grows in. Brand *labels* (the
/// registrable's leading label), lowercase.
pub const SEED_BRANDS: &[&str] = &[
    "google", "youtube", "gmail", "apple", "icloud", "microsoft", "office365",
    "outlook", "live", "amazon", "aws", "facebook", "instagram", "whatsapp",
    "meta", "netflix", "paypal", "stripe", "coinbase", "binance", "metamask",
    "chase", "wellsfargo", "bankofamerica", "citibank", "hsbc", "barclays",
    "americanexpress", "dropbox", "github", "gitlab", "linkedin", "twitter",
    "reddit", "steam", "discord", "roblox", "spotify", "docusign", "adobe",
    "twitch",
];

/// Registrable domains a brand **actually owns**, which the brand-embedding rule
/// would otherwise flag as impersonating itself.
///
/// A brand is a *cluster* of domains, not one name (ADR 0013: "a brand may span
/// `chase.com` / `chaseonline.com` / `jpmorgan.com`"). `embeds_brand` matches a
/// brand as a prefix/suffix compound — which is exactly right for
/// `paypalsecure.com`, and exactly wrong for `microsoftonline.com`, Microsoft's
/// real sign-in domain. Structure alone cannot tell those apart; only knowing
/// who owns what can. Without this, Flux flagged the world's most-used
/// enterprise login as a high-confidence impersonation — and, worse, the
/// credential-entry firewall then refused to autofill on it.
///
/// Only domains that would actually trip a SEED_BRANDS comparison need to be
/// here. The user's own vault/Trail entries are already suppressed by the
/// exact-label match in [`assess`], so this is only the cold-start set.
const BRAND_OWNED: &[&str] = &[
    // Microsoft (Entra ID / M365 sign-in and asset domains).
    "microsoftonline.com", "microsoftonline-p.com", "microsoft.com", "msftauth.net",
    "msauth.net", "office.com", "office365.com", "live.com", "sharepoint.com",
    "onedrive.com", "azure.com", "windows.net", "windowsazure.com",
    // Google.
    "google.com", "googleapis.com", "googleusercontent.com", "googlemail.com",
    "googlesource.com", "withgoogle.com", "google-analytics.com",
    // Apple.
    "apple.com", "icloud.com", "apple-cloudkit.com", "applemusic.com",
    // Amazon / AWS.
    "amazon.com", "amazonaws.com", "amazoncognito.com", "amazontrust.com",
    // Meta.
    "facebook.com", "instagram.com", "whatsapp.com", "messenger.com",
    // Developer / SaaS.
    "github.com", "githubusercontent.com", "githubassets.com", "gitlab.com",
    "paypal.com", "paypalobjects.com", "stripe.com", "linkedin.com",
    "dropbox.com", "dropboxstatic.com", "adobe.com", "adobelogin.com",
    "netflix.com", "spotify.com", "twitch.tv", "discord.com", "reddit.com",
];

/// Is this registrable domain one the brand itself owns?
fn brand_owned(reg: &str) -> bool {
    BRAND_OWNED.contains(&reg)
}

/// How sure we are it's an impersonation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
pub enum Confidence {
    /// Resembles a brand — worth a non-blocking banner.
    Low,
    /// Strong impersonation (homoglyph fold or brand-embedding) — interstitial.
    High,
}

/// A phishing pre-filter verdict.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct Verdict {
    /// The brand this domain appears to impersonate.
    pub resembles: String,
    /// Human-readable reasons (for the banner/interstitial).
    pub reasons: Vec<String>,
    pub confidence: Confidence,
}

/// Registrable domain via the last-two-labels heuristic (v1). `login.paypal.com`
/// → `paypal.com`. Not PSL-aware yet (so `x.co.uk` → `co.uk`).
pub fn registrable(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    if n <= 2 {
        labels.join(".")
    } else {
        labels[n - 2..].join(".")
    }
}

/// The brand label — the registrable's leading label (`paypal.com` → `paypal`).
pub fn brand_label(host: &str) -> String {
    let reg = registrable(host);
    reg.split('.').next().unwrap_or(&reg).to_string()
}

/// Fold visually-confusable characters to a canonical ASCII form so a homoglyph
/// impersonation collapses onto the brand it mimics. Lowercases, maps digits +
/// common Cyrillic/Greek look-alikes, and the `rn`→`m` / `vv`→`w` digraphs.
pub fn homoglyph_normalize(s: &str) -> String {
    let lowered = s.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        let mapped = match c {
            '0' => 'o',
            '1' | 'l' | '|' | 'ӏ' | 'і' | 'ı' => 'i',
            '3' | 'е' | 'ε' => 'e',
            '4' | 'а' | 'α' => 'a',
            '5' | '$' => 's',
            '7' => 't',
            '9' => 'g',
            'о' | 'ο' => 'o',
            'р' | 'ρ' => 'p',
            'с' => 'c',
            'х' | 'χ' => 'x',
            'у' | 'ν' => 'y',
            'ѕ' => 's',
            'ԁ' => 'd',
            'һ' => 'h',
            'ј' => 'j',
            'к' | 'κ' => 'k',
            'т' | 'τ' => 't',
            'в' => 'b',
            'н' => 'h',
            'м' | 'μ' => 'm',
            other => other,
        };
        out.push(mapped);
    }
    out.replace("rn", "m").replace("vv", "w")
}

/// Bounded Levenshtein edit distance.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Does `label` embed `brand` as a bounded token (`paypal-secure`, `login_apple`,
/// `applelogin`), rather than merely containing the letters? Guards against a
/// brand that's a common word producing noise — requires the brand to sit on a
/// separator or string boundary.
fn embeds_brand(label: &str, brand: &str) -> bool {
    if brand.len() < 4 || label == brand {
        return false;
    }
    label.split(['-', '_', '.']).any(|tok| {
        tok == brand
            || (tok.len() > brand.len() && (tok.starts_with(brand) || tok.ends_with(brand)))
    })
}

/// Assess `host` against a set of known-good brand labels (the impersonation
/// targets). Returns a verdict when the host looks like one of them but isn't it.
/// The caller supplies the union of vault-origin, Trail-frequent, and seed labels.
pub fn assess(host: &str, known_good: &[String]) -> Option<Verdict> {
    let reg = registrable(host);
    let label = brand_label(host);
    if label.is_empty() {
        return None;
    }
    // A brand's own domains are not impersonations of it (see BRAND_OWNED).
    if brand_owned(&reg) {
        return None;
    }
    let norm = homoglyph_normalize(&label);

    let mut best: Option<Verdict> = None;
    for brand in known_good {
        let brand = brand.to_ascii_lowercase();
        if brand.len() < 3 {
            continue;
        }
        // Exact match on the registrable's label → it IS the brand: suppress.
        if label == brand {
            return None;
        }
        let brand_norm = homoglyph_normalize(&brand);
        let (confidence, reason) = if norm == brand_norm {
            (
                Confidence::High,
                format!("uses look-alike characters to spell “{brand}”"),
            )
        } else if embeds_brand(&label, &brand) {
            (
                Confidence::High,
                format!("puts the brand “{brand}” in a look-alike domain"),
            )
        } else {
            let d = edit_distance(&norm, &brand_norm);
            // A 1–2 char typo of a brand ≥5 chars (avoid short-word noise).
            if brand.len() >= 5 && (1..=2).contains(&d) {
                (Confidence::Low, format!("is one or two edits from “{brand}”"))
            } else {
                continue;
            }
        };
        // Prefer the strongest (High over Low), first match wins within a tier.
        let stronger = best
            .as_ref()
            .map(|v| confidence == Confidence::High && v.confidence == Confidence::Low)
            .unwrap_or(true);
        if stronger {
            best = Some(Verdict {
                resembles: brand.clone(),
                reasons: vec![format!("“{reg}” {reason}")],
                confidence,
            });
            if confidence == Confidence::High {
                break;
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Vec<String> {
        SEED_BRANDS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn registrable_and_label() {
        assert_eq!(registrable("login.paypal.com"), "paypal.com");
        assert_eq!(brand_label("login.paypal.com"), "paypal");
        assert_eq!(brand_label("Www.Google.COM"), "google");
    }

    #[test]
    fn flags_homoglyph_and_digit_swaps() {
        // digit look-alike
        let v = assess("paypa1.com", &seed()).expect("paypa1 flagged");
        assert_eq!(v.resembles, "paypal");
        assert_eq!(v.confidence, Confidence::High);
        // Cyrillic а in "аpple"
        assert!(assess("\u{0430}pple.com", &seed()).is_some());
    }

    #[test]
    fn flags_typos_and_brand_embedding() {
        assert_eq!(assess("gooogle.com", &seed()).unwrap().confidence, Confidence::Low);
        let v = assess("paypal-secure.com", &seed()).unwrap();
        assert_eq!(v.resembles, "paypal");
        assert_eq!(v.confidence, Confidence::High);
    }

    #[test]
    fn brand_owned_domains_are_not_impersonations_of_themselves() {
        // Reported from a real ANU sign-in: login.microsoftonline.com — Microsoft's
        // own Entra ID domain — was flagged HIGH as impersonating "microsoft",
        // because embeds_brand treats a prefix compound as an attack. That also
        // made the credential firewall refuse to autofill on it.
        for host in [
            "login.microsoftonline.com",
            "microsoftonline.com",
            "login.microsoft.com",
            "accounts.google.com",
            "storage.googleapis.com",
            "lh3.googleusercontent.com",
            "s3.amazonaws.com",
            "raw.githubusercontent.com",
            "www.paypalobjects.com",
            "appleid.apple.com",
        ] {
            assert!(
                assess(host, &seed()).is_none(),
                "{host} is brand-owned and must not be flagged"
            );
        }
    }

    #[test]
    fn brand_owned_list_does_not_blunt_real_detection() {
        // The compound rule still has to catch the attack it exists for.
        assert_eq!(assess("paypal-secure.com", &seed()).unwrap().confidence, Confidence::High);
        assert_eq!(assess("microsoft-login.com", &seed()).unwrap().confidence, Confidence::High);
        // A lookalike built FROM a brand-owned domain is not itself brand-owned.
        assert!(assess("microsoftonline-secure.com", &seed()).is_some());
        // Homoglyphs of the brand itself are caught.
        assert_eq!(assess("rnicrosoft.com", &seed()).unwrap().resembles, "microsoft");

        // KNOWN GAP (pre-existing, not introduced by BRAND_OWNED): a homoglyph of
        // a brand's *other* owned domain slips through, because only SEED_BRANDS
        // labels are comparison targets — "rnicrosoftonline" folds to
        // "microsoftonline", which is nobody's brand label. Closing it means
        // making the owned domains targets too, which widens the target set and
        // risks fresh false positives; deliberately not bundled into a
        // false-positive fix. Asserted so the gap is visible, not forgotten.
        assert!(assess("rnicrosoftonline.com", &seed()).is_none(), "documents the gap");
    }

    #[test]
    fn does_not_flag_the_real_brand_or_unrelated() {
        assert!(assess("paypal.com", &seed()).is_none(), "the real brand is suppressed");
        assert!(assess("www.google.com", &seed()).is_none());
        assert!(assess("example.com", &seed()).is_none(), "unrelated domain");
        assert!(assess("myrandomblog.net", &seed()).is_none());
    }
}
