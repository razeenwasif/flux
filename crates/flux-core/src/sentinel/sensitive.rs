//! Sensitive-site classifier (ADR 0013, Pillar 2 M4 — containerization).
//!
//! Banking, health, and government sessions are the ones worth isolating: their
//! cookies are the highest-value cross-site tracking target, and a compromised
//! ad/tracker in another tab has no business sharing a jar with your bank. Flux
//! already has multi-account containers (BACKLOG #59, isolated cookie jars) —
//! this just recognizes the moment worth offering one.
//!
//! Deliberately **deterministic and narrow**. No LLM: this runs on every
//! navigation, and a false positive here is a nag, not a warning. It fires only
//! on unmistakable signals (a `.gov`/`.mil` domain, a known finance brand, an
//! explicit health/banking word in the domain) — never on "you have a password
//! saved here", which would match GitHub and Reddit and train the user to
//! dismiss it.

/// What kind of sensitive session this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
pub enum SensitiveKind {
    Banking,
    Health,
    Government,
}

/// A site worth isolating in its own container.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SensitiveSite {
    pub kind: SensitiveKind,
    /// Human phrase for the offer ("a banking site").
    pub label: String,
}

/// Well-known finance brands — the label alone is enough to classify.
const FINANCE_BRANDS: &[&str] = &[
    "chase", "wellsfargo", "bankofamerica", "citibank", "citi", "hsbc", "barclays",
    "americanexpress", "amex", "paypal", "stripe", "coinbase", "binance", "kraken",
    "revolut", "monzo", "starling", "santander", "natwest", "lloyds", "halifax",
    "commbank", "westpac", "anz", "nab", "schwab", "fidelity", "vanguard",
    "robinhood", "wise", "sofi", "ally", "discover", "capitalone", "usbank",
];

/// Words that, as a component of the domain, mark a banking session. Note there
/// is no "banking" entry: the `bank` + prefix-compound rule already covers
/// `banking`, whereas listing it would also match `urbanking` as a *suffix*.
const BANK_WORDS: &[&str] = &["bank", "creditunion", "buildingsociety"];

/// Words that mark a health session.
const HEALTH_WORDS: &[&str] = &[
    "health", "nhs", "medicare", "medicaid", "hospital", "clinic", "patient",
    "medical", "pharmacy", "healthcare", "mychart",
];

/// Does the domain contain `word` as a real component (bounded by a separator or
/// the string edge), rather than merely as letters inside another word?
///
/// Matched against the **whole host**, not the registrable domain: the
/// last-two-labels heuristic collapses `mybank.com.au` to `com.au` and would
/// lose the signal entirely, and a `mychart.hospital.org` subdomain is exactly
/// as sensitive as the apex.
fn has_word(host: &str, word: &str) -> bool {
    host.split(['-', '_', '.']).any(|tok| {
        tok == word
            // Compounds like "chasebank" / "mybank" / "myhealth" count too.
            || (tok.len() > word.len() && (tok.starts_with(word) || tok.ends_with(word)))
    })
}

/// Classify a host. `None` for the overwhelming majority of sites.
pub fn classify(host: &str) -> Option<SensitiveSite> {
    let label = super::phishing::brand_label(host);
    if label.is_empty() {
        return None;
    }
    let full = host.to_ascii_lowercase();

    // Government / military: the TLD says it outright (.gov, .mil, gov.uk, .gov.au).
    if full.ends_with(".gov")
        || full.ends_with(".mil")
        || full.contains(".gov.")
        || full.contains(".mil.")
    {
        return Some(SensitiveSite {
            kind: SensitiveKind::Government,
            label: "a government site".into(),
        });
    }
    // Banking: a known finance brand, or an explicit banking word in the domain.
    if FINANCE_BRANDS.contains(&label.as_str()) || BANK_WORDS.iter().any(|w| has_word(&full, w)) {
        return Some(SensitiveSite {
            kind: SensitiveKind::Banking,
            label: "a banking site".into(),
        });
    }
    // Health.
    if HEALTH_WORDS.iter().any(|w| has_word(&full, w)) {
        return Some(SensitiveSite {
            kind: SensitiveKind::Health,
            label: "a health site".into(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(host: &str) -> Option<SensitiveKind> {
        classify(host).map(|s| s.kind)
    }

    #[test]
    fn government_by_tld() {
        assert_eq!(kind("www.irs.gov"), Some(SensitiveKind::Government));
        assert_eq!(kind("hmrc.gov.uk"), Some(SensitiveKind::Government));
        assert_eq!(kind("my.gov.au"), Some(SensitiveKind::Government));
        assert_eq!(kind("army.mil"), Some(SensitiveKind::Government));
    }

    #[test]
    fn banking_by_brand_or_word() {
        assert_eq!(kind("chase.com"), Some(SensitiveKind::Banking));
        assert_eq!(kind("secure.bankofamerica.com"), Some(SensitiveKind::Banking));
        assert_eq!(kind("mybank.com.au"), Some(SensitiveKind::Banking));
        assert_eq!(kind("first-creditunion.org"), Some(SensitiveKind::Banking));
    }

    #[test]
    fn health_by_word() {
        // A subdomain is as sensitive as the apex — matching is on the whole host.
        assert_eq!(kind("myhealth.example.com"), Some(SensitiveKind::Health));
        assert_eq!(kind("nhs.uk"), Some(SensitiveKind::Health));
        assert_eq!(kind("mychart.org"), Some(SensitiveKind::Health));
    }

    #[test]
    fn everyday_sites_are_silent() {
        // A nag on these would train the user to dismiss the offer entirely.
        for host in [
            "github.com",
            "reddit.com",
            "news.ycombinator.com",
            "youtube.com",
            "example.com",
            "urbanking-blog.com", // "banking" only as a substring of "urbanking"
        ] {
            assert_eq!(classify(host).map(|s| s.kind), None, "{host} must be silent");
        }
    }
}
