//! Ambient watcher — "you've seen/solved this before" (ADR 0011, local-only).
//!
//! While browsing, quietly notice when the *current* page shows an **error
//! signature** (a panic, a `SomethingError:`, a rustc `error[E…]`, …) that also
//! appears on a page you visited before — and surface that past page, flagging
//! whether a chat thread is attached (you may have solved it there).
//!
//! Precision over recall, per the ADR's hard gate: extraction is deterministic
//! (shaped error lines only, never prose), matches require the full normalized
//! signature on a *different* URL, and hints are capped. No LLM in the loop and
//! **no network** — this reads only the local snapshot store. Generic "related
//! to your knowledge" ambience is the Connections rail's job (#123); this fires
//! only on the high-confidence error case.

use serde::Serialize;

use super::snapshots::TraceSnapshots;
use super::store::VisitId;

/// Signature bounds: shorter than MIN is too generic to trust ("Error: no"),
/// longer lines are truncated for display + matching stability.
const MIN_SIG_LEN: usize = 16;
const MAX_SIG_LEN: usize = 160;
/// At most this many signatures per page, and this many hints per query.
const MAX_SIGS: usize = 5;
const MAX_HINTS: usize = 3;

/// A past sighting of the current page's error, for the Connections rail.
#[derive(Serialize, Clone, specta::Type)]
pub struct AmbientHint {
    /// The matched error line (normalized, original case) — the "why".
    pub signature: String,
    pub visit_id: VisitId,
    pub url: String,
    pub title: String,
    /// When that page was captured.
    pub saved_ms: u64,
    /// A chat thread is attached to that visit — you may have worked the
    /// problem there.
    pub has_chat: bool,
}

/// Collapse whitespace runs to single spaces and cap the length (on a char
/// boundary). The canonical form for both display and matching.
fn normalize(line: &str) -> String {
    let mut s = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.len() > MAX_SIG_LEN {
        let mut end = MAX_SIG_LEN;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// Does `line` have the shape of an error report (not prose that merely
/// mentions one)? Deterministic patterns only:
/// - `thread '…' panicked at …` (Rust panics)
/// - `error[E0308]: …` (rustc diagnostics)
/// - `fatal: …` (git and friends)
/// - `SomeError: …` / `SomeException: …` — an upper-camel token ending in
///   Error/Exception, a colon, and a real message (Python/JS/Java traces)
/// - fixed high-signal phrases (CUDA OOM, segfaults)
fn is_error_line(line: &str) -> bool {
    if line.contains("panicked at") || line.starts_with("error[E") || line.starts_with("fatal: ") {
        return true;
    }
    for phrase in ["CUDA out of memory", "Segmentation fault", "core dumped"] {
        if line.contains(phrase) {
            return true;
        }
    }
    // `WordError: message` — the token must be upper-camel and end with
    // Error/Exception, and the message must have some meat.
    if let Some((head, tail)) = line.split_once(':') {
        let token = head.rsplit([' ', '(']).next().unwrap_or(head);
        let shaped = (token.ends_with("Error") || token.ends_with("Exception"))
            && token.len() > 5
            && token.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            && token.chars().all(|c| c.is_ascii_alphanumeric());
        if shaped && tail.trim().len() >= 8 {
            return true;
        }
    }
    false
}

/// Extract the page's error signatures — normalized, deduped, capped.
pub fn error_signatures(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || !is_error_line(line) {
            continue;
        }
        let sig = normalize(line);
        if sig.len() < MIN_SIG_LEN || out.contains(&sig) {
            continue;
        }
        out.push(sig);
        if out.len() >= MAX_SIGS {
            break;
        }
    }
    out
}

/// Case-insensitive, whitespace-run-insensitive substring test: a single space
/// in `needle` (already normalized) matches any run of whitespace in
/// `haystack`. Avoids normalizing the whole 20 KiB haystack per snapshot —
/// this runs over every stored snapshot when the current page has an error.
fn contains_normalized(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let hay = haystack.as_bytes();
    let ned = needle.as_bytes();
    let first = ned[0].to_ascii_lowercase();
    'outer: for start in 0..hay.len() {
        if hay[start].to_ascii_lowercase() != first {
            continue;
        }
        let (mut h, mut n) = (start, 0);
        while n < ned.len() {
            if ned[n] == b' ' {
                // One normalized space ↔ one-or-more whitespace bytes.
                if h >= hay.len() || !hay[h].is_ascii_whitespace() {
                    continue 'outer;
                }
                while h < hay.len() && hay[h].is_ascii_whitespace() {
                    h += 1;
                }
                n += 1;
            } else {
                if h >= hay.len() || !hay[h].eq_ignore_ascii_case(&ned[n]) {
                    continue 'outer;
                }
                h += 1;
                n += 1;
            }
        }
        return true;
    }
    false
}

/// Past pages (different URL) whose snapshots contain any of `sigs`. One hint
/// per visit, newest first, capped. `has_chat` is filled by the caller (the
/// chat store lives beside, not beneath, the snapshot store).
pub fn find_past_sightings(
    snaps: &TraceSnapshots,
    sigs: &[String],
    current_url: &str,
) -> Vec<AmbientHint> {
    if sigs.is_empty() {
        return Vec::new();
    }
    let mut hints: Vec<AmbientHint> = Vec::new();
    snaps.for_each_snapshot(|visit_id, url, title, saved_ms, text| {
        if url == current_url || hints.iter().any(|h| h.visit_id == visit_id) {
            return;
        }
        if let Some(sig) = sigs.iter().find(|s| contains_normalized(text, s)) {
            hints.push(AmbientHint {
                signature: sig.clone(),
                visit_id,
                url: url.to_string(),
                title: title.to_string(),
                saved_ms,
                has_chat: false,
            });
        }
    });
    // Newest first; same-millisecond captures tie-break by visit id (higher =
    // later visit), so the order is deterministic.
    hints.sort_unstable_by_key(|h| std::cmp::Reverse((h.saved_ms, h.visit_id)));
    hints.truncate(MAX_HINTS);
    hints
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_shaped_error_lines_not_prose() {
        let text = "\
Intro paragraph about my program.
thread 'main' panicked at src/main.rs:10:5:
error[E0308]: mismatched types
TypeError: Cannot read properties of undefined (reading 'map')
fatal: not a git repository (or any of the parent directories)
RuntimeError: CUDA out of memory. Tried to allocate 20.00 MiB
This sentence mentions the word Error: but is prose, not a report.
Error: no
A plain paragraph that talks about exceptions in general terms.";
        let sigs = error_signatures(text);
        assert!(sigs.iter().any(|s| s.contains("panicked at")));
        assert!(sigs.iter().any(|s| s.starts_with("error[E0308]")));
        assert!(sigs.iter().any(|s| s.starts_with("TypeError:")));
        assert!(sigs.iter().any(|s| s.starts_with("fatal:")));
        // Capped at MAX_SIGS — the CUDA line is the 5th shaped line.
        assert_eq!(sigs.len(), MAX_SIGS);
        // Prose and too-short lines never qualify.
        assert!(!sigs.iter().any(|s| s.contains("is prose")));
        assert!(!sigs.iter().any(|s| s == "Error: no"));
        // Nothing shaped → nothing extracted.
        assert!(error_signatures("just a normal page about cooking pasta").is_empty());
    }

    #[test]
    fn normalized_match_tolerates_whitespace_and_case() {
        let sig = normalize("TypeError: Cannot read properties of undefined (reading 'map')");
        // The past snapshot has the same error wrapped across lines, different case.
        let hay = "console output:\n  typeerror: Cannot read\n   properties of undefined (reading 'map') at foo.js";
        assert!(contains_normalized(hay, &sig));
        assert!(!contains_normalized("a page about type theory", &sig));
        assert!(!contains_normalized("", &sig));
        assert!(!contains_normalized(hay, ""));
    }

    #[test]
    fn sightings_skip_same_url_dedupe_and_cap() {
        let snaps = TraceSnapshots::empty_for_tests();
        let err = "TypeError: Cannot read properties of undefined (reading 'map')";
        // Same URL as current → never a hint. Different URLs → hints, newest first.
        snaps.add(
            1,
            "https://same.example/q".into(),
            "Same".into(),
            format!("… {err} …"),
            vec![],
        );
        snaps.add(
            2,
            "https://old.example/a".into(),
            "Old".into(),
            format!("log: {err}"),
            vec![],
        );
        snaps.add(
            3,
            "https://new.example/b".into(),
            "New".into(),
            format!("trace {err} end"),
            vec![],
        );
        snaps.add(
            4,
            "https://none.example/c".into(),
            "None".into(),
            "unrelated text".into(),
            vec![],
        );
        let sigs = error_signatures(err);
        let hints = find_past_sightings(&snaps, &sigs, "https://same.example/q");
        assert_eq!(hints.len(), 2);
        assert_eq!(
            hints[0].url, "https://new.example/b",
            "newest sighting first"
        );
        assert!(hints.iter().all(|h| h.url != "https://same.example/q"));
        // No signatures → no scan, no hints.
        assert!(find_past_sightings(&snaps, &[], "https://x/").is_empty());
    }
}
