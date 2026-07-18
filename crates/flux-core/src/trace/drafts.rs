//! Draft capture (ADR 0011, final phase — **opt-in, off by default**): fragments
//! of what you were *typing* on a page (a half-written comment, an issue draft, a
//! long form answer), attached to the Visit so the Time-Machine restore can give
//! your words back.
//!
//! This is the most sensitive store in Flux, so the rules are structural, not
//! best-effort:
//! - The injected `drafts.js` never *reads* password/hidden fields, cc/OTP
//!   autocomplete fields, `[data-sensitive]` fields, or ANY field in a form that
//!   contains a password input (login/signup forms wholesale).
//! - This module re-checks on the Rust side (defense in depth): a sensitive
//!   field-name, or a value containing a Luhn-valid card number, is rejected —
//!   a card number is *impossible to store* even if the page lies about types.
//! - The command layer additionally drops drafts from private tabs, and
//!   everything when the toggle is off.
//! - The file is sealed at rest (`sealed.rs`) and forgotten with the visit.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use super::now_ms;
use super::store::VisitId;

/// Bounds: latest draft per field label, a few fields per visit, a bounded
/// number of visits, sane text sizes.
const MAX_FIELDS_PER_VISIT: usize = 12;
const MAX_VISITS_WITH_DRAFTS: usize = 300;
const MIN_TEXT: usize = 12;
const MAX_TEXT: usize = 4 * 1024;

/// One captured draft: the field's label + what was typed, latest wins per field.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Draft {
    pub field: String,
    pub text: String,
    pub ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct DraftData {
    /// The opt-in toggle lives with the data (off by default).
    enabled: bool,
    drafts: HashMap<VisitId, Vec<Draft>>,
}

/// Per-visit typed-draft store — sealed at rest, persisted to `trace/drafts.json`.
#[derive(Default)]
pub struct TraceDrafts {
    inner: RwLock<DraftData>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
}

impl TraceDrafts {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            ..Default::default()
        }
    }

    /// Load from disk, exactly once (lazy, race-proof — see `TraceStore::hydrate`).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        let Some((json, was_plaintext)) = super::sealed::load_string(path) else {
            return;
        };
        let Ok(loaded) = serde_json::from_str::<DraftData>(&json) else {
            return;
        };
        if was_plaintext {
            self.dirty.store(true, Ordering::Relaxed);
        }
        let mut d = self.inner.write();
        if d.drafts.is_empty() {
            *d = loaded;
        }
    }

    pub fn enabled(&self) -> bool {
        self.hydrate();
        self.inner.read().enabled
    }

    pub fn set_enabled(&self, on: bool) {
        self.hydrate();
        self.inner.write().enabled = on;
        self.dirty.store(true, Ordering::Relaxed);
        self.persist_if_dirty(); // a privacy toggle should land immediately
    }

    /// Store a redacted draft for a visit (latest wins per field label).
    pub fn put(&self, visit: VisitId, field: String, text: String) {
        self.hydrate();
        {
            let mut d = self.inner.write();
            let list = d.drafts.entry(visit).or_default();
            if let Some(existing) = list.iter_mut().find(|x| x.field == field) {
                existing.text = text;
                existing.ms = now_ms();
            } else {
                list.push(Draft {
                    field,
                    text,
                    ms: now_ms(),
                });
                if list.len() > MAX_FIELDS_PER_VISIT {
                    list.remove(0);
                }
            }
            // Bound the visit count: evict the visit with the oldest newest-draft.
            if d.drafts.len() > MAX_VISITS_WITH_DRAFTS {
                if let Some(oldest) = d
                    .drafts
                    .iter()
                    .map(|(v, l)| (*v, l.iter().map(|x| x.ms).max().unwrap_or(0)))
                    .min_by_key(|(_, ms)| *ms)
                    .map(|(v, _)| v)
                {
                    d.drafts.remove(&oldest);
                }
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// A visit's drafts (empty if none).
    pub fn get(&self, visit: VisitId) -> Vec<Draft> {
        self.hydrate();
        self.inner
            .read()
            .drafts
            .get(&visit)
            .cloned()
            .unwrap_or_default()
    }

    /// Drop the drafts of forgotten visits (cascade from `trace_forget`).
    pub fn forget_visits(&self, visits: &std::collections::HashSet<VisitId>) {
        if visits.is_empty() {
            return;
        }
        self.hydrate();
        let mut d = self.inner.write();
        let before = d.drafts.len();
        d.drafts.retain(|vid, _| !visits.contains(vid));
        if d.drafts.len() != before {
            drop(d);
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        let d = self.inner.read();
        super::sealed::save_json_sealed(path, &*d);
    }
}

/// Luhn check over a digit string (the card-number checksum).
// `sum % 10` stays: `is_multiple_of` needs Rust 1.87, above our 1.80 MSRV.
#[allow(clippy::manual_is_multiple_of)]
fn luhn_valid(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (i, d) in digits.iter().rev().enumerate() {
        let mut v = (*d - b'0') as u32;
        if i % 2 == 1 {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
    }
    sum % 10 == 0
}

/// Does `text` contain something shaped like a real card number: a 13–19 digit
/// run (spaces/dashes allowed) that passes Luhn? Structural rejection — such a
/// value never reaches the store.
fn contains_pan(text: &str) -> bool {
    let mut run: Vec<u8> = Vec::with_capacity(20);
    let check = |run: &mut Vec<u8>| {
        let hit = (13..=19).contains(&run.len()) && luhn_valid(run);
        run.clear();
        hit
    };
    for c in text.bytes() {
        if c.is_ascii_digit() {
            run.push(c);
            if run.len() > 19 {
                run.remove(0); // sliding window over very long digit runs
                if (13..=19).contains(&run.len()) && luhn_valid(&run) {
                    return true;
                }
            }
        } else if c == b' ' || c == b'-' {
            continue; // grouping separators inside a card number
        } else if check(&mut run) {
            return true;
        }
    }
    check(&mut run)
}

/// Field names that must never be captured, whatever the page claims the input
/// type is. Substring match, lowercased.
const FIELD_BLOCKLIST: &[&str] = &[
    "pass",
    "pwd",
    "card",
    "cvv",
    "cvc",
    "otp",
    "2fa",
    "totp",
    "secret",
    "token",
    "ssn",
    "social-sec",
    "iban",
    "routing",
    "account-number",
    "pin",
];

/// Rust-side redaction gate (defense in depth over drafts.js): `Some(clean)` to
/// store, `None` to reject. Rejects sensitive field names, PAN-bearing values,
/// and out-of-bounds sizes; trims and caps the rest.
pub fn redact(field: &str, text: &str) -> Option<(String, String)> {
    let f = field.trim().to_lowercase();
    if f.is_empty() || f.len() > 80 {
        return None;
    }
    if FIELD_BLOCKLIST.iter().any(|b| f.contains(b)) {
        return None;
    }
    let t = text.trim();
    if t.len() < MIN_TEXT {
        return None;
    }
    if contains_pan(t) {
        return None;
    }
    let mut t = t.to_string();
    if t.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !t.is_char_boundary(end) {
            end -= 1;
        }
        t.truncate(end);
    }
    Some((field.trim().to_string(), t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_is_structural() {
        // Sensitive field names never store, whatever the value.
        for f in [
            "password",
            "new-password",
            "card_number",
            "cvv2",
            "otp-code",
            "PIN",
        ] {
            assert!(
                redact(f, "a perfectly ordinary long draft text").is_none(),
                "{f}"
            );
        }
        // A Luhn-valid card number in the value → rejected (spaces/dashes too).
        for v in [
            "my card is 4539 1488 0343 6467 thanks",
            "4539-1488-0343-6467",
            "pay 4111111111111111 now please",
        ] {
            assert!(redact("comment", v).is_none(), "{v}");
        }
        // A non-Luhn digit run of the same shape is fine (order numbers, ids).
        assert!(redact(
            "comment",
            "my order number is 4539148803436468, please check it"
        )
        .is_some());
        // Too short → not worth storing.
        assert!(redact("comment", "short").is_none());
        // Normal drafts pass, trimmed.
        let (f, t) = redact(" message ", "  a draft of my reply to the issue  ").unwrap();
        assert_eq!(f, "message");
        assert_eq!(t, "a draft of my reply to the issue");
        // Oversized values are capped, not rejected.
        let big = "x".repeat(10_000);
        assert_eq!(redact("body", &big).unwrap().1.len(), MAX_TEXT);
    }

    #[test]
    fn store_caps_latest_wins_and_forget() {
        let s = TraceDrafts::default();
        assert!(!s.enabled(), "off by default");
        s.put(1, "comment".into(), "v1".into());
        s.put(1, "comment".into(), "v2 — the draft evolved".into());
        assert_eq!(s.get(1).len(), 1, "latest wins per field");
        assert!(s.get(1)[0].text.starts_with("v2"));
        for i in 0..(MAX_FIELDS_PER_VISIT + 3) {
            s.put(2, format!("f{i}"), "some text".into());
        }
        assert_eq!(s.get(2).len(), MAX_FIELDS_PER_VISIT);
        s.forget_visits(&std::collections::HashSet::from([1]));
        assert!(s.get(1).is_empty());
        assert!(!s.get(2).is_empty(), "unrelated visit kept");
    }
}
