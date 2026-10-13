//! The Indexer orb (replaces the music bubble, BACKLOG #125): ask a question,
//! typed or spoken, and get back the answer you already wrote in your Onyx vault.
//!
//! A port of desktop-buddies/Indexer (SiriBubble). Notes are cut into
//! question → answer *cards*: each heading and the text under it, or, in notes
//! whose path mentions "interview", each question line and the paragraphs that
//! answer it. Retrieval is that app's hybrid: half cosine similarity from an
//! embedding model (EmbeddingGemma 2 through the local Ollama), half keyword
//! overlap weighted by where a word appears (question > category > answer).
//! Here the keyword half is also weighted by rarity, which does generally what
//! the original's hand-picked list of terms worth boosting did for one vault.
//!
//! When the best card isn't clearly ahead (low confidence, or a near tie), the
//! orb asks [`indexer_decide`]: the question and the closest cards go to a local
//! *System 1* decision model, Laya (`laya-serve`), which picks one in a single
//! forward pass with calibrated probabilities instead of writing prose about it.
//! It's optional. Unreachable, the orb says the match is uncertain and shows the
//! candidates.
//!
//! Books are a second source: every PDF in a books folder (`~/Documents/Books`,
//! or `FLUX_INDEXER_BOOKS`), read with poppler's `pdftotext` and cut into
//! passages of about a page, each a card titled by book and page. A book's
//! first index takes a while (about a thousand passages a minute), so a build
//! saves as it goes: books appear as they're done, and quitting halfway resumes
//! where it stopped.
//!
//! Everything stays on the machine: notes and books are read from disk,
//! embeddings come from the local Ollama, and Laya listens on loopback.

use crate::vecstore::{quantize_query, score, VecStore};
use parking_lot::{MappedRwLockReadGuard, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

/// EmbeddingGemma 2, text-only. `FLUX_INDEXER_EMBED_MODEL` overrides it; it has
/// to be pulled in Ollama. The Indexer runs its own embedder rather than the
/// global `FLUX_EMBED_MODEL`, so changing one never re-embeds the other's corpus.
pub const DEFAULT_EMBED_MODEL: &str = "embeddinggemma-2:270m";
/// Where `laya-serve` listens; `FLUX_LAYA_URL` overrides it.
pub const DEFAULT_LAYA_URL: &str = "http://127.0.0.1:8765";
/// Laya's English checkpoint. Naming it keeps the server from routing a short
/// question to (and loading) a second checkpoint.
const LAYA_MODEL: &str = "english";

/// Bumped when the saved layout changes; an older index is rebuilt, not misread.
/// 3 is the manifest and its segments; 1 and 2 (one JSON file of every card and
/// a vectors sidecar) are converted when they're loaded.
const FORMAT: u32 = 3;
const MAX_FILES: usize = 20_000;
/// Notes larger than this aren't notes (exports, dumps); books have no cap.
const MAX_FILE_BYTES: u64 = 1 << 20;
/// A book passage is cut at about this many characters, on a paragraph or
/// sentence where it can be: about a page, short enough to read off a card.
const BOOK_CHUNK_CHARS: usize = 1_500;
/// Shorter passages (a page holding only a heading, a figure caption or a page
/// number) aren't worth a card.
const MIN_BOOK_CHUNK: usize = 160;
/// pdftotext reads a 1,200-page book in a few seconds; one that takes minutes
/// is malformed or hostile.
const PDFTOTEXT_TIMEOUT: Duration = Duration::from_secs(180);
const PDFTOTEXT_LIMIT: usize = 64 << 20;
/// A card's answer beyond this is cut. Sections that long are reference text,
/// not an answer to read off a card.
const MAX_ANSWER_CHARS: usize = 6_000;
/// How much of an answer goes into its embedding, after its title.
const EMBED_TEXT_CHARS: usize = 600;
const EMBED_BATCH: usize = 32;
const MAX_QUERY_CHARS: usize = 1_000;
const MAX_K: usize = 10;
/// Laya's options are short labels; long ones crowd the question out of its
/// context window.
const MAX_OPTION_CHARS: usize = 160;
const MAX_OPTIONS: usize = 8;

/// The semantic score is how far a card's cosine sits above the median card's,
/// over this span. EmbeddingGemma 2's cosines are all high and shift with the
/// question's phrasing (the median card is 0.53–0.58 depending on wording, an
/// answer 0.20–0.25 above it), so a fixed range either saturates or never
/// reaches the top; the question's own median is the baseline that doesn't.
const SPAN: f32 = 0.25;
/// At most this many sections of one note in a result list, so the cards to page
/// through aren't one note's headings in a row.
const PER_NOTE: usize = 2;
/// A top match below this confidence, or within `MARGIN` of the runner-up, is
/// ambiguous and goes to the System 1 model.
const SURE: f32 = 0.55;
const MARGIN: f32 = 0.04;
/// Laya's pick reorders the results only when it gives that card at least this
/// probability. Over five candidates a flat 20% each is "no idea"; on the vault
/// this was tuned against, clear picks came out at 55–68% and coin tosses
/// between equally good notes at 30–36%.
const DECISIVE: f32 = 0.45;

fn embed_model() -> String {
    std::env::var("FLUX_INDEXER_EMBED_MODEL").unwrap_or_else(|_| DEFAULT_EMBED_MODEL.into())
}

fn laya_url() -> String {
    std::env::var("FLUX_LAYA_URL").unwrap_or_else(|_| DEFAULT_LAYA_URL.into())
}

// ─── Cards ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    #[default]
    Note,
    Book,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Card {
    /// The note or book on disk (vault-relative in format 1).
    path: String,
    #[serde(default)]
    kind: Kind,
    /// A book passage's page (1-based, as the PDF numbers them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    /// "Category > note", as the original shows it.
    source: String,
    category: String,
    question: String,
    answer: String,
    key_points: Vec<String>,
}

/// `s` cut to at most `n` characters, on a character boundary.
fn prefix_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// A Markdown ATX heading's text: one to six `#` and a space. A bare `#tag` is
/// an Obsidian tag, not a heading.
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim();
    (!text.is_empty()).then_some(text)
}

fn is_fence(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

fn strip_frontmatter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---") else {
        return text;
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            // The rest of the closing `---` line.
            after.find('\n').map_or("", |nl| &after[nl + 1..])
        }
        None => text,
    }
}

/// Cards for one note. `rel` is the note's vault-relative path (it names the
/// category and note); `path` is what the cards point at.
fn parse_note(text: &str, rel: &str, path: &str) -> Vec<Card> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let body = strip_frontmatter(text);
    let parts: Vec<&str> = rel.split('/').collect();
    let file = parts
        .last()
        .map(|f| {
            f.strip_suffix(".md")
                .or_else(|| f.strip_suffix(".MD"))
                .unwrap_or(f)
        })
        .unwrap_or(rel);
    let mut category = if parts.len() > 1 { parts[0] } else { "General" };
    // "10 - Interview prep" → "Interview prep".
    if let Some(i) = category.find(" - ") {
        category = &category[i + 3..];
    }
    let source = format!("{category} > {file}");

    if rel.to_lowercase().contains("interview") {
        let cards = parse_document(body, path, &source);
        if !cards.is_empty() {
            return cards;
        }
    }

    let mut cards = Vec::new();
    let mut heading: Option<String> = None;
    let mut lines: Vec<&str> = Vec::new();
    let mut in_fence = false;
    let flush = |heading: &Option<String>, lines: &[&str], cards: &mut Vec<Card>| {
        let answer = lines.join("\n");
        let answer = answer.trim();
        if answer.chars().count() <= 40 {
            return;
        }
        let question = match heading {
            Some(h) => format!("{file}: {h}"),
            None => file.to_string(),
        };
        cards.push(card(path, &source, category, question, answer));
    };
    for line in body.lines() {
        let t = line.trim();
        if is_fence(t) {
            in_fence = !in_fence;
        } else if !in_fence {
            // A heading that is itself a link ("# [[Index]]") isn't a section.
            if let Some(h) = heading_text(t).filter(|h| !h.starts_with('[')) {
                flush(&heading, &lines, &mut cards);
                heading = Some(h.to_string());
                lines.clear();
                continue;
            }
        }
        lines.push(line);
    }
    flush(&heading, &lines, &mut cards);
    cards
}

/// Interview-style notes: a question (or header) line, then the paragraphs that
/// answer it.
fn parse_document(text: &str, path: &str, source: &str) -> Vec<Card> {
    let mut cards = Vec::new();
    let mut question: Option<String> = None;
    let mut answer: Vec<&str> = Vec::new();
    let flush = |question: &Option<String>, answer: &[&str], cards: &mut Vec<Card>| {
        let Some(q) = question else { return };
        let a = answer.join("\n\n");
        let a = a.trim();
        if !a.is_empty() {
            cards.push(card(path, source, categorize(q), q.clone(), a));
        }
    };
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim();
        if is_fence(t) {
            in_fence = !in_fence;
        }
        if t.is_empty() || t.starts_with("——") || t.starts_with("==") || t.starts_with("---") {
            continue;
        }
        if !in_fence && is_question_or_header(t) {
            flush(&question, &answer, &mut cards);
            question = Some(clean_question(t));
            answer.clear();
        } else if question.is_some() {
            answer.push(t);
        } else {
            question = Some(clean_question(t));
        }
    }
    flush(&question, &answer, &mut cards);
    cards
}

fn is_question_or_header(line: &str) -> bool {
    if heading_text(line).is_some() {
        return true;
    }
    let text = line.trim_matches('*').trim();
    let n = text.chars().count();
    if text.ends_with('?') && n < 220 {
        return true;
    }
    const OPENERS: &[&str] = &[
        "tell me about",
        "describe a situation",
        "give an example",
        "what is",
        "what do you",
        "why are you",
        "how do you",
        "introduction",
        "interesting part",
        "follow-ups",
        "unpacking",
    ];
    let lower = text.to_lowercase();
    if n < 200 && OPENERS.iter().any(|o| lower.starts_with(o)) {
        return true;
    }
    text.ends_with(':') && n < 100 && !text.contains(". ")
}

fn clean_question(line: &str) -> String {
    let mut q = heading_text(line).unwrap_or(line).trim();
    q = q.trim_matches('*').trim();
    for (open, close) in [("\"", "\""), ("“", "”")] {
        if let Some(inner) = q.strip_prefix(open).and_then(|s| s.strip_suffix(close)) {
            q = inner.trim();
        }
    }
    let q = q.strip_suffix(':').unwrap_or(q).trim();
    if q.eq_ignore_ascii_case("introduction") {
        return "Introduction: Tell me about yourself and your background".into();
    }
    q.to_string()
}

fn categorize(question: &str) -> &'static str {
    let lower = question.to_lowercase();
    let words: HashSet<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    let has = |w: &str| words.contains(w);
    if [
        "disagreement",
        "conflict",
        "initiative",
        "ethical",
        "struggling",
    ]
    .iter()
    .any(|w| has(w))
        || lower.contains("tell me about a time")
    {
        "Behavioral (STAR)"
    } else if [
        "structured",
        "data",
        "ai",
        "pipeline",
        "model",
        "algorithm",
        "system",
    ]
    .iter()
    .any(|w| has(w))
    {
        "Technical"
    } else if lower.starts_with("introduction") || has("why") || has("fit") {
        "Background"
    } else {
        "General"
    }
}

fn card(path: &str, source: &str, category: &str, question: String, answer: &str) -> Card {
    let answer = prefix_chars(answer, MAX_ANSWER_CHARS).to_string();
    Card {
        path: path.to_string(),
        kind: Kind::Note,
        page: None,
        source: source.to_string(),
        category: category.to_string(),
        key_points: key_points(&answer),
        question,
        answer,
    }
}

/// Up to three lines worth reading at a glance: ones that say what was done and
/// what came of it, else the first three.
fn key_points(text: &str) -> Vec<String> {
    let sentences: Vec<&str> = text
        .split(['.', '!', '?', '\n'])
        .map(|s| s.trim().trim_start_matches(['-', '*', '•', '>']).trim())
        .filter(|s| (21..250).contains(&s.chars().count()))
        .collect();
    const ACTION: &[&str] = &[
        "i proposed",
        "so i",
        "i built",
        "we built",
        "result",
        "metric",
        "initiative",
        "pipeline",
        "improved",
        "reduced",
        "increased",
        "f1",
    ];
    let mut points: Vec<String> = sentences
        .iter()
        .filter(|s| {
            let l = s.to_lowercase();
            ACTION.iter().any(|a| l.contains(a))
        })
        .take(3)
        .map(|s| s.to_string())
        .collect();
    if points.is_empty() {
        points = sentences.iter().take(3).map(|s| s.to_string()).collect();
    }
    points
}

// ─── Books ────────────────────────────────────────────────────────────────────

/// "Bishop-Pattern-Recognition-and-Machine-Learning-2006.pdf" → "Bishop Pattern
/// Recognition and Machine Learning 2006". A name that already has spaces keeps
/// its hyphens.
fn book_title(file: &str) -> String {
    let stem = file
        .rsplit_once('.')
        .map_or(file, |(s, _)| s)
        .replace("(z-lib.org)", "");
    let stem = if stem.contains(' ') {
        stem
    } else {
        stem.replace(['-', '_'], " ")
    };
    stem.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A page's paragraphs, with pdftotext's hard line wraps (and the hyphens it
/// leaves at them) joined back up.
fn paragraphs(page: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in page.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if cur.ends_with('-') && t.starts_with(|c: char| c.is_lowercase()) {
            cur.pop();
        } else if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(t);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `text` in pieces of at most `max` characters, cut after a sentence where one
/// is within reach.
fn split_long(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while rest.chars().count() > max {
        let head = prefix_chars(rest, max);
        let cut = head
            .rfind(". ")
            .map(|i| i + 1)
            .filter(|&i| i > head.len() / 2)
            .unwrap_or(head.len());
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// Passages of a book from pdftotext's output, where a form feed ends each page.
/// `rel` is the book's path under the books folder; `path` is what the cards
/// point at.
fn parse_book(text: &str, rel: &str, path: &str) -> Vec<Card> {
    let parts: Vec<&str> = rel.split('/').collect();
    let title = book_title(parts.last().copied().unwrap_or(rel));
    let category = if parts.len() > 1 { parts[0] } else { "Books" };
    let source = format!("Books > {title}");
    let mut cards = Vec::new();
    for (i, page) in text.split('\u{c}').enumerate() {
        let n = i as u32 + 1;
        let pieces: Vec<String> = paragraphs(page)
            .iter()
            .flat_map(|p| split_long(p, BOOK_CHUNK_CHARS))
            .collect();
        let mut chunk = String::new();
        for piece in pieces {
            if !chunk.is_empty()
                && chunk.chars().count() + piece.chars().count() + 2 > BOOK_CHUNK_CHARS
            {
                cards.extend(book_card(path, &source, category, &title, n, &chunk));
                chunk.clear();
            }
            if !chunk.is_empty() {
                chunk.push_str("\n\n");
            }
            chunk.push_str(&piece);
        }
        cards.extend(book_card(path, &source, category, &title, n, &chunk));
    }
    cards
}

fn book_card(
    path: &str,
    source: &str,
    category: &str,
    title: &str,
    page: u32,
    chunk: &str,
) -> Option<Card> {
    let text = chunk.trim();
    if text.chars().count() < MIN_BOOK_CHUNK {
        return None;
    }
    let lead = text.split(['.', '\n']).next().unwrap_or(text).trim();
    Some(Card {
        path: path.to_string(),
        kind: Kind::Book,
        page: Some(page),
        source: source.to_string(),
        category: category.to_string(),
        question: format!("{title}, p. {page}: {}", prefix_chars(lead, 80)),
        answer: text.to_string(),
        key_points: Vec::new(),
    })
}

/// poppler's `pdftotext`. A Dock-launched app gets launchd's PATH, without
/// Homebrew's bin, so the usual install spots come before PATH.
fn pdftotext() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("FLUX_PDFTOTEXT").filter(|p| !p.is_empty()) {
        return Some(p.into());
    }
    let exe = if cfg!(windows) {
        "pdftotext.exe"
    } else {
        "pdftotext"
    };
    [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ]
    .iter()
    .map(|d| Path::new(d).join(exe))
    .chain(
        std::env::var_os("PATH")
            .map(|p| {
                std::env::split_paths(&p)
                    .map(|d| d.join(exe))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    )
    .find(|c| c.is_file())
}

fn extract_pdf(bin: &Path, pdf: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new(bin);
    // The path is absolute, so it can't be read as an option.
    cmd.args(["-q", "-enc", "UTF-8", "-eol", "unix"])
        .arg(pdf)
        .arg("-");
    let out = crate::exec::run_bounded(cmd, PDFTOTEXT_TIMEOUT, PDFTOTEXT_LIMIT)?;
    if out.timed_out {
        return Err(format!("pdftotext gave up on {}", pdf.display()));
    }
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

const STOP: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "if", "then", "so", "as", "at", "by", "for", "from",
    "in", "into", "of", "off", "on", "onto", "out", "over", "to", "up", "with", "is", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "can", "could",
    "will", "would", "shall", "should", "may", "might", "must", "i", "you", "he", "she", "it",
    "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "their", "our", "what",
    "which", "who", "whom", "this", "that", "these", "those", "am", "about", "tell",
];

/// Lowercased words of two or more characters, minus stop words (unless that
/// leaves nothing).
fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let raw: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() > 1)
        .collect();
    let kept: Vec<String> = raw
        .iter()
        .filter(|w| !STOP.contains(w))
        .map(|w| w.to_string())
        .collect();
    if kept.is_empty() {
        raw.into_iter().map(String::from).collect()
    } else {
        kept
    }
}

/// FNV-1a: words are matched by hash, so a segment's vocabulary is a sorted
/// `u64` list rather than thousands of small strings. Segments save these
/// hashes, so a change to how words are cut or hashed has to bump `FORMAT`.
fn term(w: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in w.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn terms(text: &str) -> Vec<u64> {
    let mut t: Vec<u64> = words(text).iter().map(|w| term(w)).collect();
    t.sort_unstable();
    t.dedup();
    t
}

/// A card's words, each with the original's 3/2/1 weighting for where it
/// appears: question, category or answer. A word in more than one of those
/// counts once, at the heaviest.
fn weighted_terms(c: &Card) -> Vec<(u64, u32)> {
    let mut w: Vec<(u64, u32)> = terms(&c.question)
        .into_iter()
        .map(|t| (t, 3))
        .chain(terms(&c.category).into_iter().map(|t| (t, 2)))
        .chain(terms(&c.answer).into_iter().map(|t| (t, 1)))
        .collect();
    w.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    w.dedup_by_key(|p| p.0);
    w
}

/// A segment's words, inverted: for each word, the cards that use it and how
/// heavily. A question's keyword score walks the lists for its few words
/// instead of looking each one up in every card, a hit costs four bytes where a
/// word in a card's own list cost eight, and a word's document frequency is the
/// length of its lists, so there's no IDF table to keep either.
struct Words {
    /// Every word in the segment, sorted.
    terms: Vec<u64>,
    /// Word `i`'s hits are `hits[starts[i]..starts[i + 1]]`.
    starts: Vec<u32>,
    /// A card's index shifted left two bits, with the word's weight in that
    /// card (3, 2 or 1) in the low two.
    hits: Vec<u32>,
}

impl Words {
    /// From `(word, hit)` pairs, in any order.
    fn of(mut pairs: Vec<(u64, u32)>) -> Self {
        pairs.sort_unstable();
        let mut terms = Vec::new();
        let mut starts = Vec::new();
        let mut hits = Vec::with_capacity(pairs.len());
        for (t, h) in pairs {
            if terms.last() != Some(&t) {
                terms.push(t);
                starts.push(hits.len() as u32);
            }
            hits.push(h);
        }
        starts.push(hits.len() as u32);
        terms.shrink_to_fit();
        starts.shrink_to_fit();
        Words {
            terms,
            starts,
            hits,
        }
    }

    /// The cards that use word `t`.
    fn hits(&self, t: u64) -> &[u32] {
        match self.terms.binary_search(&t) {
            Ok(i) => &self.hits[self.starts[i] as usize..self.starts[i + 1] as usize],
            Err(_) => &[],
        }
    }

    /// Every `(word, hit)` pair, for carrying cards over into a new segment.
    fn pairs(&self) -> impl Iterator<Item = (u64, u32)> + '_ {
        self.terms.iter().enumerate().flat_map(move |(i, &t)| {
            self.hits[self.starts[i] as usize..self.starts[i + 1] as usize]
                .iter()
                .map(move |&h| (t, h))
        })
    }
}

// ─── Segments ─────────────────────────────────────────────────────────────────
//
// The index is saved as segments: one for the notes and one per book, each
// written once under a name of its own and never changed after, and a small
// manifest that names the current set. Editing a note writes the notes'
// segment (11 MB for a thousand notes) and the manifest; a book is written
// once, when it has been read; a removed book's segment is deleted. Format 2
// kept everything in one JSON file with a vectors sidecar and rewrote all of it
// (83 MB with 25 books) on any change, and every minute of a long book build.
//
// A card's text (question, category, answer, key points) stays in its
// segment's file and is read back only for the few cards a search returns.
// What's held in memory is what scoring needs: the vectors, the words, and
// where each card's text is. Segments are written first and the manifest last,
// so a crash at any point leaves a manifest whose segments are all there.

/// Names the current segments.
const MANIFEST: &str = "manifest.json";
/// Formats 1 and 2: every card in one JSON file, and their vectors' sidecar.
const LEGACY: [&str; 2] = ["index.json", "vectors.bin"];
const SEGMENT_MAGIC: &[u8; 8] = b"FLUXSEG1";

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    /// The folders read: the vault, then the books.
    roots: Vec<PathBuf>,
    /// The model every vector came from; `None` means the index has no vectors
    /// (built while the model wasn't available) and matches on keywords alone.
    model: Option<String>,
    /// Segment files in the index's folder, the notes' first.
    segments: Vec<String>,
}

/// Formats 1 and 2, read only to be converted.
#[derive(Deserialize, Default)]
struct Saved {
    format: u32,
    /// Format 1's one vault, which its card paths were relative to.
    #[serde(default)]
    vault: Option<PathBuf>,
    #[serde(default)]
    roots: Vec<PathBuf>,
    model: Option<String>,
    mtimes: BTreeMap<String, u64>,
    cards: Vec<Card>,
}

/// A note or book that a segment's cards came from.
#[derive(Clone)]
struct Doc {
    /// Its absolute path, as `Job::key` names it.
    path: String,
    /// Modified time (ms) of the version its cards came from. Zero marks a file
    /// whose cards are waiting on the model, so the next build redoes it.
    mtime: u64,
    /// "Category > note", which all its cards share.
    source: String,
}

/// What a segment holds in memory for each card; the rest is in its file.
#[derive(Clone, Copy)]
struct Slot {
    /// Index into the segment's docs.
    doc: u32,
    /// A book passage's page; zero for a note.
    page: u32,
    /// Where the card's text is, as an offset into the segment's text.
    at: u64,
    len: u32,
}

/// Where a segment's card text is.
enum Text {
    /// In memory: the index has no folder (tests), or the segment hasn't been
    /// written yet.
    Mem(Vec<u8>),
    /// In the segment's file, from byte `at` to the end.
    File { path: PathBuf, at: u64 },
}

impl Text {
    /// `len` bytes from `at`.
    fn read(&self, at: u64, len: u32) -> Option<Vec<u8>> {
        match self {
            Text::Mem(b) => {
                let at = usize::try_from(at).ok()?;
                b.get(at..at.checked_add(len as usize)?).map(<[u8]>::to_vec)
            }
            Text::File { path, at: start } => {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = std::fs::File::open(path).ok()?;
                f.seek(SeekFrom::Start(start.checked_add(at)?)).ok()?;
                let mut buf = vec![0; len as usize];
                f.read_exact(&mut buf).ok()?;
                Some(buf)
            }
        }
    }

    /// All of it, for carrying cards into a new segment.
    fn all(&self) -> Option<Vec<u8>> {
        match self {
            Text::Mem(b) => Some(b.clone()),
            Text::File { path, at } => {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = std::fs::File::open(path).ok()?;
                f.seek(SeekFrom::Start(*at)).ok()?;
                let mut buf = Vec::new();
                f.read_to_end(&mut buf).ok()?;
                Some(buf)
            }
        }
    }
}

/// The notes, or one book: its files, its cards' vectors and words, and where
/// to find their text.
struct Segment {
    kind: Kind,
    /// Its file in the index's folder; `None` while it's only in memory.
    file: Option<String>,
    docs: Vec<Doc>,
    cards: Vec<Slot>,
    /// Row `i` is card `i`'s vector; empty when the index has no model.
    vecs: VecStore,
    words: Words,
    text: Text,
}

impl Segment {
    fn len(&self) -> usize {
        self.cards.len()
    }

    /// Card `i` in full, its text read back from the segment.
    fn card(&self, i: usize) -> Option<Card> {
        let slot = self.cards.get(i)?;
        let doc = self.docs.get(slot.doc as usize)?;
        let bytes = self.text.read(slot.at, slot.len)?;
        let mut r = Cursor(&bytes);
        let question = r.str()?;
        let category = r.str()?;
        let answer = r.str()?;
        let points = r.u32()?;
        let key_points = (0..points).map(|_| r.str()).collect::<Option<Vec<_>>>()?;
        Some(Card {
            path: doc.path.clone(),
            kind: self.kind,
            page: (slot.page != 0).then_some(slot.page),
            source: doc.source.clone(),
            category,
            question,
            answer,
            key_points,
        })
    }

    /// The segment's file: the magic, the head's length, the head (kind, docs,
    /// card slots, vectors, words), then the card text to the end. Little-endian
    /// throughout, like the vectors' own layout.
    fn to_bytes(&self, text: &[u8]) -> Vec<u8> {
        let mut head = vec![match self.kind {
            Kind::Note => 0u8,
            Kind::Book => 1,
        }];
        put_u32(&mut head, self.docs.len() as u32);
        for d in &self.docs {
            put_u64(&mut head, d.mtime);
            put_str(&mut head, &d.path);
            put_str(&mut head, &d.source);
        }
        put_u32(&mut head, self.cards.len() as u32);
        for c in &self.cards {
            put_u32(&mut head, c.doc);
            put_u32(&mut head, c.page);
            put_u64(&mut head, c.at);
            put_u32(&mut head, c.len);
        }
        let vecs = self.vecs.to_bytes();
        put_u64(&mut head, vecs.len() as u64);
        head.extend_from_slice(&vecs);
        put_u32(&mut head, self.words.terms.len() as u32);
        put_u64(&mut head, self.words.hits.len() as u64);
        for t in &self.words.terms {
            put_u64(&mut head, *t);
        }
        for n in self.words.starts.iter().chain(&self.words.hits) {
            put_u32(&mut head, *n);
        }
        let mut out = Vec::with_capacity(16 + head.len() + text.len());
        out.extend_from_slice(SEGMENT_MAGIC);
        put_u64(&mut out, head.len() as u64);
        out.extend_from_slice(&head);
        out.extend_from_slice(text);
        out
    }

    /// Segment `name` in `dir`, all but its card text. `None` when it's missing,
    /// cut short or not a segment: a damaged file must not become cards that
    /// point at the wrong text or vectors.
    fn open(dir: &Path, name: &str) -> Option<Segment> {
        use std::io::Read;
        // The manifest names files in this folder and nothing else.
        if !name.ends_with(".seg") || name.contains(['/', '\\']) {
            return None;
        }
        let path = dir.join(name);
        let mut f = std::fs::File::open(&path).ok()?;
        let size = f.metadata().ok()?.len();
        let mut top = [0u8; 16];
        f.read_exact(&mut top).ok()?;
        if &top[..8] != SEGMENT_MAGIC {
            return None;
        }
        let head_len = u64::from_le_bytes(top[8..].try_into().ok()?);
        let text_at = head_len.checked_add(16).filter(|&at| at <= size)?;
        let text_len = size - text_at;
        let mut head = vec![0u8; usize::try_from(head_len).ok()?];
        f.read_exact(&mut head).ok()?;
        let mut r = Cursor(&head);
        let kind = match r.u8()? {
            0 => Kind::Note,
            1 => Kind::Book,
            _ => return None,
        };
        let n = r.u32()? as usize;
        let mut docs = Vec::with_capacity(n.min(r.0.len() / 16));
        for _ in 0..n {
            let mtime = r.u64()?;
            let path = r.str()?;
            let source = r.str()?;
            docs.push(Doc {
                path,
                mtime,
                source,
            });
        }
        let n = r.u32()? as usize;
        let mut cards = Vec::with_capacity(n.min(r.0.len() / 20));
        for _ in 0..n {
            let (doc, page, at, len) = (r.u32()?, r.u32()?, r.u64()?, r.u32()?);
            if doc as usize >= docs.len() || at.checked_add(len as u64)? > text_len {
                return None;
            }
            cards.push(Slot { doc, page, at, len });
        }
        let n = usize::try_from(r.u64()?).ok()?;
        let vecs = VecStore::from_bytes(r.take(n)?)?;
        // Every card has a vector or none does: row i is card i.
        if !vecs.is_empty() && vecs.len() != cards.len() {
            return None;
        }
        let n_terms = r.u32()? as usize;
        let n_hits = usize::try_from(r.u64()?).ok()?;
        let terms = r.u64s(n_terms)?;
        let starts = r.u32s(n_terms.checked_add(1)?)?;
        let hits = r.u32s(n_hits)?;
        // Lookups binary-search the words and slice the hits by `starts`, and
        // every hit has to name one of the cards, with a weight.
        let sound = r.0.is_empty()
            && terms.windows(2).all(|w| w[0] < w[1])
            && starts.first() == Some(&0)
            && starts.last().map(|&s| s as usize) == Some(n_hits)
            && starts.windows(2).all(|w| w[0] <= w[1])
            && hits
                .iter()
                .all(|&h| h & 3 != 0 && ((h >> 2) as usize) < cards.len());
        if !sound {
            return None;
        }
        Some(Segment {
            kind,
            file: Some(name.to_string()),
            docs,
            cards,
            vecs,
            words: Words {
                terms,
                starts,
                hits,
            },
            text: Text::File { path, at: text_at },
        })
    }
}

fn put_u32(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, n: u64) {
    out.extend_from_slice(&n.to_le_bytes());
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_u32(out, s.len() as u32);
    out.extend_from_slice(s.as_bytes());
}

/// A card's text as its segment keeps it: question, category, answer, then the
/// key points.
fn put_card(out: &mut Vec<u8>, c: &Card) {
    put_str(out, &c.question);
    put_str(out, &c.category);
    put_str(out, &c.answer);
    put_u32(out, c.key_points.len() as u32);
    for p in &c.key_points {
        put_str(out, p);
    }
}

/// Reads a segment's fields in the order they were written. Each read is
/// checked against what's left, so a short or foreign file comes back `None`.
struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if n > self.0.len() {
            return None;
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Some(head)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn str(&mut self) -> Option<String> {
        let n = self.u32()? as usize;
        std::str::from_utf8(self.take(n)?).ok().map(String::from)
    }

    fn u32s(&mut self, n: usize) -> Option<Vec<u32>> {
        let b = self.take(n.checked_mul(4)?)?;
        Some(
            b.chunks_exact(4)
                .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
                .collect(),
        )
    }

    fn u64s(&mut self, n: usize) -> Option<Vec<u64>> {
        let b = self.take(n.checked_mul(8)?)?;
        Some(
            b.chunks_exact(8)
                .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
                .collect(),
        )
    }
}

/// A segment being put together, by a build or from an older index.
struct Draft {
    kind: Kind,
    docs: Vec<Doc>,
    cards: Vec<Slot>,
    /// Row `i` is card `i`'s vector, pushed alongside the card.
    vecs: VecStore,
    /// `(word, hit)` for every card so far, inverted by `finish`.
    pairs: Vec<(u64, u32)>,
    text: Vec<u8>,
}

impl Draft {
    fn new(kind: Kind) -> Self {
        Draft {
            kind,
            docs: Vec::new(),
            cards: Vec::new(),
            vecs: VecStore::default(),
            pairs: Vec::new(),
            text: Vec::new(),
        }
    }

    fn doc(&mut self, path: &str, mtime: u64, source: &str) -> u32 {
        self.docs.push(Doc {
            path: path.to_string(),
            mtime,
            source: source.to_string(),
        });
        (self.docs.len() - 1) as u32
    }

    /// A card from file `doc`. Its vector, if cards have them, is the caller's
    /// to push onto `vecs` in the same order.
    fn add(&mut self, doc: u32, c: &Card) {
        let i = self.cards.len() as u32;
        let at = self.text.len();
        put_card(&mut self.text, c);
        self.cards.push(Slot {
            doc,
            page: c.page.unwrap_or(0),
            at: at as u64,
            len: (self.text.len() - at) as u32,
        });
        self.pairs.extend(
            weighted_terms(c)
                .into_iter()
                .map(|(t, w)| (t, (i << 2) | w)),
        );
    }

    /// A draft that starts with `old`'s cards from the files `keep` passes:
    /// their text, vectors and words copied as they are, nothing read or
    /// embedded again. `None` if `old`'s text can't be read back.
    fn keeping(old: &Segment, keep: impl Fn(&Doc) -> bool) -> Option<Draft> {
        let mut d = Draft::new(old.kind);
        let mut docs: Vec<Option<u32>> = Vec::with_capacity(old.docs.len());
        for doc in &old.docs {
            docs.push(keep(doc).then(|| d.doc(&doc.path, doc.mtime, &doc.source)));
        }
        if d.docs.is_empty() {
            return Some(d);
        }
        let text = old.text.all()?;
        let mut rows = old.vecs.rows();
        let mut cards: Vec<Option<u32>> = Vec::with_capacity(old.cards.len());
        for slot in &old.cards {
            let row = if old.vecs.is_empty() {
                None
            } else {
                rows.next()
            };
            let Some(doc) = docs[slot.doc as usize] else {
                cards.push(None);
                continue;
            };
            let at = usize::try_from(slot.at).ok()?;
            let bytes = text.get(at..at.checked_add(slot.len as usize)?)?;
            cards.push(Some(d.cards.len() as u32));
            d.cards.push(Slot {
                doc,
                page: slot.page,
                at: d.text.len() as u64,
                len: slot.len,
            });
            d.text.extend_from_slice(bytes);
            if let Some((row, scale)) = row {
                if !d.vecs.push_quantized(row, scale) {
                    return None;
                }
            }
        }
        d.pairs = old
            .words
            .pairs()
            .filter_map(|(t, h)| cards[(h >> 2) as usize].map(|c| (t, (c << 2) | (h & 3))))
            .collect();
        Some(d)
    }

    fn finish(self) -> Segment {
        let Draft {
            kind,
            mut docs,
            mut cards,
            mut vecs,
            pairs,
            text,
        } = self;
        docs.shrink_to_fit();
        cards.shrink_to_fit();
        vecs.shrink_to_fit();
        Segment {
            kind,
            file: None,
            docs,
            cards,
            vecs,
            words: Words::of(pairs),
            text: Text::Mem(text),
        }
    }
}

/// The "Category > note" a file's cards share.
fn source_of(cards: &[Card]) -> &str {
    cards.first().map_or("", |c| c.source.as_str())
}

/// Format 2's parts as segments: notes in one, each book in its own, each card
/// with its row of `vecs` (when there's a row for every card). Files with no
/// cards (a note too short for one, an unreadable book) are kept, so a build
/// doesn't read them again.
fn segments(mtimes: BTreeMap<String, u64>, cards: Vec<Card>, vecs: VecStore) -> Vec<Segment> {
    let rows: Vec<(&[i8], f32)> = if vecs.len() == cards.len() {
        vecs.rows().collect()
    } else {
        Vec::new()
    };
    // Files in the order their cards came, so cards that tie in a search come
    // out in the same order as before; then the files with no cards. A file
    // with cards but no time (which a build never writes) is read again next
    // build.
    let mut by_file: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut files: Vec<(&str, u64)> = Vec::new();
    for (i, c) in cards.iter().enumerate() {
        let ids = by_file.entry(c.path.as_str()).or_default();
        if ids.is_empty() {
            files.push((&c.path, mtimes.get(&c.path).copied().unwrap_or(0)));
        }
        ids.push(i);
    }
    files.extend(
        mtimes
            .iter()
            .filter(|(k, _)| !by_file.contains_key(k.as_str()))
            .map(|(k, &m)| (k.as_str(), m)),
    );

    let mut notes = Draft::new(Kind::Note);
    let mut books = Vec::new();
    for (path, mtime) in files {
        let ids = by_file.get(path).map_or(&[][..], Vec::as_slice);
        let kind = match ids.first() {
            Some(&i) => cards[i].kind,
            None if path.to_lowercase().ends_with(".pdf") => Kind::Book,
            None => Kind::Note,
        };
        let mut book = Draft::new(Kind::Book);
        let d = if kind == Kind::Book {
            &mut book
        } else {
            &mut notes
        };
        let doc = d.doc(
            path,
            mtime,
            ids.first().map_or("", |&i| cards[i].source.as_str()),
        );
        for &i in ids {
            d.add(doc, &cards[i]);
            if let Some(&(row, scale)) = rows.get(i) {
                d.vecs.push_quantized(row, scale);
            }
        }
        if kind == Kind::Book {
            books.push(book.finish());
        }
    }
    let notes = (!notes.docs.is_empty()).then(|| notes.finish());
    notes.into_iter().chain(books).collect()
}

/// A fresh name for a segment file: segments are never rewritten in place, so
/// one being read is never one being written.
fn segment_name(kind: Kind) -> String {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let kind = match kind {
        Kind::Note => "notes",
        Kind::Book => "book",
    };
    format!("{kind}-{ms:x}-{n}.seg")
}

/// Write a segment that's only in memory to a file of its own, and read its
/// text from there from now on.
fn store(dir: &Path, seg: &mut Segment) -> Result<(), String> {
    let Text::Mem(text) = &seg.text else {
        return Ok(());
    };
    let name = segment_name(seg.kind);
    let path = dir.join(&name);
    let bytes = seg.to_bytes(text);
    let at = (bytes.len() - text.len()) as u64;
    crate::persist::write_atomic(&path, &bytes)
        .map_err(|e| format!("couldn't save the Indexer's index: {e}"))?;
    seg.file = Some(name);
    seg.text = Text::File { path, at };
    Ok(())
}

fn save_manifest(dir: &Path, idx: &Index) -> Result<(), String> {
    let manifest = Manifest {
        format: FORMAT,
        roots: idx.roots.clone(),
        model: idx.model.clone(),
        segments: idx.segs.iter().filter_map(|s| s.file.clone()).collect(),
    };
    let json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    crate::persist::write_atomic(&dir.join(MANIFEST), &json)
        .map_err(|e| format!("couldn't save the Indexer's index: {e}"))
}

/// Delete what the manifest doesn't name: segments it replaced, any a crash
/// left behind before their manifest was written, and the files of formats 1
/// and 2 once converted.
fn sweep(dir: &Path, idx: &Index) {
    let named: HashSet<&str> = idx.segs.iter().filter_map(|s| s.file.as_deref()).collect();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stale = (name.ends_with(".seg") && !named.contains(name.as_ref()))
            || name.ends_with(".tmp")
            || LEGACY.contains(&name.as_ref());
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write every segment that's only in memory, then the manifest naming them
/// all, then clear out what it doesn't name.
fn save(dir: &Path, idx: &mut Index) -> Result<(), String> {
    for seg in &mut idx.segs {
        if let Some(seg) = Arc::get_mut(seg) {
            store(dir, seg)?;
        }
    }
    save_manifest(dir, idx)?;
    sweep(dir, idx);
    Ok(())
}

/// The index saved in `dir`, or one from before segments, converted.
fn load(dir: &Path) -> Option<Index> {
    match std::fs::read(dir.join(MANIFEST)) {
        Ok(json) => open(dir, &json),
        Err(_) => migrate(dir),
    }
}

fn open(dir: &Path, json: &[u8]) -> Option<Index> {
    let manifest: Manifest = serde_json::from_slice(json).ok()?;
    if manifest.format != FORMAT {
        return None;
    }
    let mut segs: Vec<Arc<Segment>> = Vec::with_capacity(manifest.segments.len());
    let mut dim = 0;
    for name in &manifest.segments {
        // A segment that can't be used is left out: its files then look new to
        // the next build, which reads just them again.
        let usable = Segment::open(dir, name).filter(|s| {
            // Vectors have to match the model, and each other's width. There's
            // one notes segment, which the build carries over as a whole.
            let rows = match manifest.model {
                Some(_) => {
                    s.vecs.len() == s.len()
                        && (dim == 0 || s.vecs.is_empty() || s.vecs.dim() == dim)
                }
                None => s.vecs.is_empty(),
            };
            rows && (s.kind == Kind::Book || segs.iter().all(|o| o.kind == Kind::Book))
        });
        match usable {
            Some(s) => {
                if !s.vecs.is_empty() {
                    dim = s.vecs.dim();
                }
                segs.push(Arc::new(s));
            }
            None => {
                tracing::warn!(target: "flux::indexer", segment = %name, "unusable index segment left out")
            }
        }
    }
    Some(Index {
        roots: manifest.roots,
        model: manifest.model,
        segs,
    })
}

/// An index from before segments (formats 1 and 2), saved again as segments.
/// Its vectors move as they are: nothing is read or embedded again. If the new
/// files can't be written (a full disk), the old ones stay and it's used from
/// memory until a later load converts it, or a build saves what it can.
fn migrate(dir: &Path) -> Option<Index> {
    let mut idx = load_legacy(dir)?;
    if let Err(e) = save(dir, &mut idx) {
        tracing::warn!(target: "flux::indexer", "couldn't convert the index to segments: {e}");
    }
    Some(idx)
}

fn load_legacy(dir: &Path) -> Option<Index> {
    let json = std::fs::read(dir.join("index.json")).ok()?;
    let mut saved: Saved = serde_json::from_slice(&json).ok()?;
    drop(json);
    match saved.format {
        2 => {}
        // Format 1 read one vault, and its card paths were relative to it.
        1 => {
            let vault = saved.vault.take()?;
            let abs = |rel: &str| vault.join(rel).to_string_lossy().into_owned();
            for c in &mut saved.cards {
                c.path = abs(&c.path);
            }
            saved.mtimes = saved
                .mtimes
                .into_iter()
                .map(|(k, m)| (abs(&k), m))
                .collect();
            saved.roots = vec![vault];
        }
        _ => return None,
    }
    let vecs = match &saved.model {
        Some(_) => {
            let v = VecStore::from_bytes(&std::fs::read(dir.join("vectors.bin")).ok()?)?;
            // Row i must be card i; a sidecar from another write is refused.
            if v.len() != saved.cards.len() {
                return None;
            }
            v
        }
        None => VecStore::default(),
    };
    Some(Index::from_parts(
        saved.roots,
        saved.model,
        saved.mtimes,
        saved.cards,
        vecs,
    ))
}

// ─── The index ────────────────────────────────────────────────────────────────

/// The index searches use: the notes' segment (when there are notes), then one
/// per book. Segments are shared, not copied, between the index and a build
/// that keeps them.
#[derive(Default)]
struct Index {
    roots: Vec<PathBuf>,
    model: Option<String>,
    segs: Vec<Arc<Segment>>,
}

/// What an index that isn't loaded reads as.
static EMPTY: Index = Index {
    roots: Vec::new(),
    model: None,
    segs: Vec::new(),
};

impl Index {
    /// Format 2's parts: every card in one list, `vecs` row `i` for card `i`
    /// (none without a model), and each file's modified time.
    fn from_parts(
        roots: Vec<PathBuf>,
        model: Option<String>,
        mtimes: BTreeMap<String, u64>,
        cards: Vec<Card>,
        vecs: VecStore,
    ) -> Self {
        Index {
            roots,
            model,
            segs: segments(mtimes, cards, vecs)
                .into_iter()
                .map(Arc::new)
                .collect(),
        }
    }

    fn cards(&self) -> usize {
        self.segs.iter().map(|s| s.len()).sum()
    }

    fn pending(&self) -> usize {
        self.segs
            .iter()
            .map(|s| {
                s.cards
                    .iter()
                    .filter(|c| s.docs[c.doc as usize].mtime == 0)
                    .count()
            })
            .sum()
    }

    /// The vectors' width, when every card has one; otherwise searches match
    /// on keywords alone.
    fn dim(&self) -> Option<usize> {
        let mut dim = None;
        for s in self.segs.iter().filter(|s| s.len() > 0) {
            if s.vecs.len() != s.len() || dim.is_some_and(|d| d != s.vecs.dim()) {
                return None;
            }
            dim = Some(s.vecs.dim());
        }
        dim
    }
}

/// `title: … | text: …` and `task: search result | query: …` are EmbeddingGemma's
/// document and query prompts; embedding each side with its own prompt is what
/// the model was trained for.
fn doc_text(c: &Card) -> String {
    format!(
        "title: {} | text: {}",
        c.question,
        prefix_chars(&c.answer, EMBED_TEXT_CHARS)
    )
}

fn query_text(q: &str) -> String {
    format!("task: search result | query: {q}")
}

/// Each cosine as a semantic score against the median of them all.
fn semantic(cos: Vec<f32>) -> Vec<f32> {
    let mut sorted = cos.clone();
    let mid = sorted.len() / 2;
    let (_, median, _) = sorted.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    let median = *median;
    cos.into_iter()
        .map(|c| ((c - median) / SPAN).clamp(0.0, 1.0))
        .collect()
}

/// A file to index.
struct Job {
    /// Its absolute path, as cards and segments name it.
    key: String,
    /// Its path under its folder, `/`-separated (names its category).
    rel: String,
    path: PathBuf,
    mtime: u64,
    kind: Kind,
}

impl Job {
    fn name(&self) -> String {
        let file = self.rel.rsplit('/').next().unwrap_or(&self.rel);
        match self.kind {
            Kind::Note => file.trim_end_matches(".md").to_string(),
            Kind::Book => book_title(file),
        }
    }
}

/// Embeds a build's new cards, and remembers how that went.
struct Embedder<'a> {
    model: &'a str,
    /// The model the index's vectors come from; `None` matches on keywords
    /// alone.
    keyed: Option<String>,
    /// The model stopped answering: the rest of the build gets zero rows.
    failed: bool,
    /// Every vector's width in this index; zero until there's one.
    dim: usize,
}

impl Embedder<'_> {
    /// Vectors for `cards`, pushed onto `vecs` in order. False when the model
    /// failed partway: those cards get zero rows (they match on keywords) and
    /// their file is marked for the next build.
    fn embed(&mut self, cards: &[Card], vecs: &mut VecStore) -> Result<bool, String> {
        let mut embedded = true;
        if self.keyed.is_none() {
            return Ok(embedded);
        }
        for chunk in cards.chunks(EMBED_BATCH) {
            let texts: Vec<String> = chunk.iter().map(doc_text).collect();
            let got = if self.failed {
                None
            } else {
                flux_agent::ollama::embed_remote_batch_with(self.model, &texts)
                    .filter(|v| v.len() == chunk.len())
            };
            match got {
                Some(rows) => {
                    for row in rows {
                        // Other segments hold rows of this width, so a store
                        // of its own can't be the only check.
                        if (self.dim != 0 && row.len() != self.dim) || !vecs.push(&row) {
                            return Err(format!(
                                "{} returned vectors of a different size; reindex to rebuild",
                                self.model
                            ));
                        }
                        self.dim = row.len();
                    }
                }
                None => {
                    self.failed = true;
                    embedded = false;
                    if self.dim == 0 {
                        // Nothing to size a zero row by (no card has a vector
                        // yet): keywords for the whole index, and everything
                        // embedded next time.
                        self.keyed = None;
                        break;
                    }
                    let zero = vec![0f32; self.dim];
                    for _ in chunk {
                        vecs.push(&zero);
                    }
                }
            }
        }
        if self.keyed.is_none() {
            vecs.clear();
        }
        Ok(embedded)
    }
}

/// Every note (`.md`) or book (`.pdf`) under `root`, sorted by path. Skips
/// dot-folders (`.obsidian`, `.git`), and for notes `Daily` and `Entertainment`
/// as the original does. Never follows a link out of the folder.
fn walk(root: &Path, kind: Kind) -> Vec<Job> {
    let ext = match kind {
        Kind::Note => ".md",
        Kind::Book => ".pdf",
    };
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                if kind == Kind::Book || (name != "Daily" && name != "Entertainment") {
                    stack.push(path);
                }
                continue;
            }
            if !file_type.is_file() || !name.to_lowercase().ends_with(ext) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if kind == Kind::Note && meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(1, |d| d.as_millis().max(1) as u64);
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            out.push(Job {
                key: path.to_string_lossy().into_owned(),
                rel: rel.join("/"),
                path,
                mtime,
                kind,
            });
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Byte-identical copies of a book (one PDF filed in two folders) would double
/// its passages in every result list; the first by path is kept.
fn dedupe(books: Vec<Job>) -> (Vec<Job>, usize) {
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    let mut duplicates = 0;
    for b in books {
        match fingerprint(&b.path) {
            Some(fp) if !seen.insert(fp) => duplicates += 1,
            _ => kept.push(b),
        }
    }
    (kept, duplicates)
}

/// Size and a hash of the first and last 64 KiB: enough to tell copies of a
/// book apart from different books without reading hundreds of megabytes.
fn fingerprint(path: &Path) -> Option<(u64, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    const SPAN: u64 = 64 * 1024;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut buf = Vec::new();
    (&mut f).take(SPAN).read_to_end(&mut buf).ok()?;
    if len > 2 * SPAN {
        f.seek(SeekFrom::End(-(SPAN as i64))).ok()?;
        f.take(SPAN).read_to_end(&mut buf).ok()?;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in buf {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    Some((len, h))
}

/// One card in a search's results.
#[derive(Serialize, Clone, specta::Type)]
pub struct IndexerMatch {
    /// What the System 1 model is shown for this card (pass it back to
    /// `indexer_decide`).
    pub label: String,
    pub question: String,
    pub answer: String,
    pub key_points: Vec<String>,
    /// "Category > note".
    pub source: String,
    pub category: String,
    /// The note or book on disk, for "Open".
    pub path: String,
    /// A book passage (open it at `page`) rather than a note.
    pub book: bool,
    pub page: Option<u32>,
    /// The hybrid score, 0–1.
    pub confidence: f32,
    pub semantic: f32,
    pub keyword: f32,
}

/// Results of one search, best first.
#[derive(Serialize, Clone, specta::Type)]
pub struct IndexerResults {
    pub matches: Vec<IndexerMatch>,
    /// The top match isn't clearly ahead: ask the System 1 model.
    pub ambiguous: bool,
    /// The question was embedded (false: keywords only).
    pub semantic: bool,
}

#[derive(Serialize, Clone, specta::Type)]
pub struct IndexerStatus {
    pub cards: u32,
    /// Notes and books indexed.
    pub notes: u32,
    pub books: u32,
    pub building: bool,
    /// Progress of the build in flight: files read / files to read, and the one
    /// being read now.
    pub files_done: u32,
    pub files_todo: u32,
    pub current: Option<String>,
    pub embed_model: String,
    /// The index has vectors (else it matches on keywords alone).
    pub semantic: bool,
    /// Cards waiting for the model, matched on keywords until it's back.
    pub pending: u32,
    /// The folders read: the vault, then the books.
    pub sources: Vec<String>,
    /// Worth knowing but not a failure: pdftotext missing, duplicate books.
    pub notice: Option<String>,
    pub error: Option<String>,
}

/// Where the Indexer reads from.
#[derive(Clone, Default)]
pub struct Sources {
    pub notes: Option<PathBuf>,
    pub books: Option<PathBuf>,
}

/// Which cards a search looks at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    All,
    Notes,
    Books,
}

impl Scope {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("notes") => Scope::Notes,
            Some("books") => Scope::Books,
            _ => Scope::All,
        }
    }

    fn admits(self, kind: Kind) -> bool {
        match self {
            Scope::All => true,
            Scope::Notes => kind == Kind::Note,
            Scope::Books => kind == Kind::Book,
        }
    }
}

/// The System 1 model's pick among the options it was given.
#[derive(Serialize, Clone, specta::Type)]
pub struct IndexerPick {
    /// Index into the options.
    pub index: u32,
    /// The pick is clear enough to put first; otherwise the results keep their
    /// order and the answer is shown as uncertain.
    pub decisive: bool,
    /// Probability of each option, in order.
    pub probabilities: Vec<f32>,
    /// Laya's calibrated confidence in the pick.
    pub confidence: f32,
}

#[derive(Clone)]
pub struct IndexerState {
    dir: Option<PathBuf>,
    /// `None` until first use.
    index: Arc<RwLock<Option<Index>>>,
    building: Arc<AtomicBool>,
    files_done: Arc<AtomicUsize>,
    files_todo: Arc<AtomicUsize>,
    current: Arc<Mutex<Option<String>>>,
    notice: Arc<Mutex<Option<String>>>,
    error: Arc<Mutex<Option<String>>>,
}

impl IndexerState {
    /// `dir` holds the manifest and its segments; `None` keeps the index in
    /// memory (tests).
    pub fn new(dir: Option<PathBuf>) -> Self {
        IndexerState {
            dir,
            index: Arc::default(),
            building: Arc::default(),
            files_done: Arc::default(),
            files_todo: Arc::default(),
            current: Arc::default(),
            notice: Arc::default(),
            error: Arc::default(),
        }
    }

    /// The index, read from disk on first use.
    fn index(&self) -> MappedRwLockReadGuard<'_, Index> {
        let read = self.index.read();
        let read = if read.is_some() {
            read
        } else {
            drop(read);
            let mut write = self.index.write();
            if write.is_none() {
                *write = Some(self.dir.as_deref().and_then(load).unwrap_or_default());
            }
            RwLockWriteGuard::downgrade(write)
        };
        RwLockReadGuard::map(read, |i| i.as_ref().unwrap_or(&EMPTY))
    }

    pub fn status(&self) -> IndexerStatus {
        let idx = self.index();
        let files = |kind: Kind| -> usize {
            idx.segs
                .iter()
                .filter(|s| s.kind == kind)
                .map(|s| s.docs.len())
                .sum()
        };
        IndexerStatus {
            cards: idx.cards() as u32,
            notes: files(Kind::Note) as u32,
            books: files(Kind::Book) as u32,
            building: self.building.load(Ordering::Acquire),
            files_done: self.files_done.load(Ordering::Relaxed) as u32,
            files_todo: self.files_todo.load(Ordering::Relaxed) as u32,
            current: self.current.lock().clone(),
            embed_model: embed_model(),
            semantic: idx.model.is_some(),
            pending: idx.pending() as u32,
            sources: idx
                .roots
                .iter()
                .map(|r| r.to_string_lossy().into_owned())
                .collect(),
            notice: self.notice.lock().clone(),
            error: self.error.lock().clone(),
        }
    }

    /// Bring the index up to date with its folders on a thread of its own. A
    /// build already running makes this a no-op.
    pub fn start_build(&self, sources: Sources) {
        if self.building.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        let spawned = std::thread::Builder::new()
            .name("flux-indexer".into())
            .spawn(move || {
                let result = this.build(sources);
                *this.current.lock() = None;
                *this.error.lock() = result.err();
                this.building.store(false, Ordering::Release);
            });
        if spawned.is_err() {
            self.building.store(false, Ordering::Release);
        }
    }

    fn build(&self, src: Sources) -> Result<(), String> {
        let (old_model, old) = {
            let idx = self.index();
            (idx.model.clone(), idx.segs.clone())
        };
        let mut jobs: Vec<Job> = Vec::new();
        if let Some(v) = &src.notes {
            jobs.extend(walk(v, Kind::Note));
        }
        let mut duplicates = 0;
        if let Some(b) = &src.books {
            let (books, dups) = dedupe(walk(b, Kind::Book));
            jobs.extend(books);
            duplicates = dups;
        }
        let roots: Vec<PathBuf> = [src.notes, src.books].into_iter().flatten().collect();
        if roots.is_empty() {
            return Err(
                "No Onyx vault or books folder found. Set the vault in the Notebook \
                 (Onyx source), or create ~/OnyxVault or ~/Documents/Books."
                    .into(),
            );
        }
        let model = embed_model();
        let available = flux_agent::ollama::has_model(&model);
        let pdf = pdftotext();
        let has_books = jobs.iter().any(|j| j.kind == Kind::Book);
        *self.notice.lock() = match (&pdf, has_books, duplicates) {
            (None, true, _) => {
                Some("Books need poppler's pdftotext to be read: brew install poppler".into())
            }
            (_, _, 0) => None,
            (_, _, n) => Some(format!(
                "Skipped {n} duplicate book{}",
                if n == 1 { "" } else { "s" }
            )),
        };

        // Unchanged files keep their cards, words and vectors, as long as the
        // vectors came from this model.
        let had_vectors = old_model.as_deref() == Some(model.as_str());
        // Without vectors to keep, only an index that also has none (and still
        // none to make) can keep its cards as they are.
        let reuse = had_vectors || (old_model.is_none() && !available);
        let (mut notes, draft, mut books, todo, dim) = {
            let fresh: HashMap<&str, u64> =
                jobs.iter().map(|j| (j.key.as_str(), j.mtime)).collect();
            let mtimes: HashMap<&str, u64> = old
                .iter()
                .flat_map(|s| &s.docs)
                .map(|d| (d.path.as_str(), d.mtime))
                .collect();
            let keep_file = |p: &str| {
                reuse
                    && mtimes
                        .get(p)
                        .is_some_and(|&m| m != 0 && fresh.get(p) == Some(&m))
            };
            // Nothing to do is the common case (the panel reindexes on every
            // open), and it's decided from the file times alone, before
            // anything is copied. Without pdftotext, books wait for a build
            // that can read them; the ones already indexed stay.
            let nothing_to_read = jobs
                .iter()
                .all(|j| keep_file(&j.key) || (j.kind == Kind::Book && pdf.is_none()));
            let nothing_gone = mtimes.keys().all(|k| keep_file(k));
            if nothing_to_read && nothing_gone && (had_vectors || !available) {
                return Ok(());
            }

            // An unchanged book keeps its segment as it is. The notes share
            // one, so a change to any makes a new one, starting from the notes
            // that didn't change.
            let books: Vec<Arc<Segment>> = old
                .iter()
                .filter(|s| s.kind == Kind::Book && s.docs.iter().all(|d| keep_file(&d.path)))
                .cloned()
                .collect();
            let old_notes = old.iter().find(|s| s.kind == Kind::Note);
            let notes_changed = jobs
                .iter()
                .any(|j| j.kind == Kind::Note && !keep_file(&j.key))
                || old_notes.is_some_and(|s| s.docs.iter().any(|d| !keep_file(&d.path)));
            let (notes, draft) = if notes_changed {
                // Notes whose segment can't be read back are read again.
                let draft = old_notes
                    .and_then(|s| Draft::keeping(s, |d| keep_file(&d.path)))
                    .unwrap_or_else(|| Draft::new(Kind::Note));
                (None, Some(draft))
            } else {
                (old_notes.cloned(), None)
            };
            let todo: Vec<&Job> = {
                let have: HashSet<&str> = books
                    .iter()
                    .chain(&notes)
                    .flat_map(|s| &s.docs)
                    .chain(draft.iter().flat_map(|d| &d.docs))
                    .map(|d| d.path.as_str())
                    .collect();
                jobs.iter()
                    .filter(|j| {
                        !have.contains(j.key.as_str()) && (j.kind == Kind::Note || pdf.is_some())
                    })
                    .collect()
            };
            let dim = books
                .iter()
                .chain(&notes)
                .map(|s| s.vecs.dim())
                .chain(draft.iter().map(|d| d.vecs.dim()))
                .max()
                .unwrap_or(0);
            (notes, draft, books, todo, dim)
        };
        // What this build replaces isn't needed past here; it's freed once the
        // first commit swaps it out of the index too.
        drop(old);

        let mut embedder = Embedder {
            model: &model,
            keyed: (available || had_vectors).then(|| model.clone()),
            failed: !available,
            dim,
        };
        self.files_todo.store(todo.len(), Ordering::Relaxed);
        self.files_done.store(0, Ordering::Relaxed);
        let mut pending = 0usize;
        if let Some(mut d) = draft {
            for job in todo.iter().filter(|j| j.kind == Kind::Note) {
                *self.current.lock() = Some(job.name());
                let fresh = std::fs::read_to_string(&job.path)
                    .map(|t| parse_note(&t, &job.rel, &job.key))
                    .unwrap_or_default();
                let embedded = embedder.embed(&fresh, &mut d.vecs)?;
                let mtime = if embedded { job.mtime } else { 0 };
                let doc = d.doc(&job.key, mtime, source_of(&fresh));
                for c in &fresh {
                    d.add(doc, c);
                }
                if !embedded {
                    pending += 1;
                }
                self.files_done.fetch_add(1, Ordering::Relaxed);
            }
            notes = if d.docs.is_empty() {
                None
            } else {
                Some(self.seal(d)?)
            };
        }
        // Changed notes show up before the long haul through the books.
        self.commit(&roots, &embedder.keyed, &notes, &books)?;
        for job in todo.iter().filter(|j| j.kind == Kind::Book) {
            *self.current.lock() = Some(job.name());
            // An unreadable book (encrypted, malformed, timed out) is recorded
            // as done with no cards, so it isn't retried on every reindex.
            let fresh = match pdf.as_deref().map(|bin| extract_pdf(bin, &job.path)) {
                Some(Ok(text)) => parse_book(&text, &job.rel, &job.key),
                _ => Vec::new(),
            };
            let mut d = Draft::new(Kind::Book);
            let embedded = embedder.embed(&fresh, &mut d.vecs)?;
            let mtime = if embedded { job.mtime } else { 0 };
            let doc = d.doc(&job.key, mtime, source_of(&fresh));
            for c in &fresh {
                d.add(doc, c);
            }
            if !embedded {
                pending += 1;
            }
            books.push(self.seal(d)?);
            self.files_done.fetch_add(1, Ordering::Relaxed);
            // A book is saved once, when it's done, and searchable from then
            // on: quitting halfway resumes after the last one finished.
            self.commit(&roots, &embedder.keyed, &notes, &books)?;
        }
        // An index whose files didn't change can still have a model to record.
        self.commit(&roots, &embedder.keyed, &notes, &books)?;
        if pending > 0 {
            return Err(format!(
                "{model} stopped answering partway; {pending} files match on keywords until the next index"
            ));
        }
        Ok(())
    }

    /// A finished segment, written to its own file when the index has a folder.
    fn seal(&self, draft: Draft) -> Result<Arc<Segment>, String> {
        let mut seg = draft.finish();
        if let Some(dir) = &self.dir {
            store(dir, &mut seg)?;
        }
        Ok(Arc::new(seg))
    }

    /// Make `notes` and `books` the index searches use. Their segments are
    /// written already; the manifest naming them goes last, so a crash before
    /// it leaves the previous manifest with all of its segments still there.
    fn commit(
        &self,
        roots: &[PathBuf],
        model: &Option<String>,
        notes: &Option<Arc<Segment>>,
        books: &[Arc<Segment>],
    ) -> Result<(), String> {
        let segs: Vec<Arc<Segment>> = notes.iter().chain(books).cloned().collect();
        let unchanged = self.index.read().as_ref().is_some_and(|i| {
            i.roots == roots
                && i.model == *model
                && i.segs.len() == segs.len()
                && i.segs.iter().zip(&segs).all(|(a, b)| Arc::ptr_eq(a, b))
        });
        if unchanged {
            return Ok(());
        }
        let idx = Index {
            roots: roots.to_vec(),
            model: model.clone(),
            segs,
        };
        if let Some(dir) = &self.dir {
            save_manifest(dir, &idx)?;
        }
        let mut index = self.index.write();
        // With the lock held, no search is reading a segment this replaces.
        if let Some(dir) = &self.dir {
            sweep(dir, &idx);
        }
        *index = Some(idx);
        Ok(())
    }

    pub fn search(&self, query: &str, k: usize, scope: Scope) -> IndexerResults {
        let q = prefix_chars(query.trim(), MAX_QUERY_CHARS);
        if q.is_empty() {
            return IndexerResults {
                matches: Vec::new(),
                ambiguous: false,
                semantic: false,
            };
        }
        // Embed before taking the lock: it's a round trip to Ollama.
        let model = self.index().model.clone();
        let qvec = model.and_then(|m| {
            flux_agent::ollama::embed_remote_batch_with(&m, &[query_text(q)])
                .and_then(|mut v| v.pop())
        });
        self.rank(q, qvec, k, scope)
    }

    /// Score every card in `scope` against `q` (and its vector, if it has one)
    /// and read the best `k` back from their segments.
    fn rank(&self, q: &str, qvec: Option<Vec<f32>>, k: usize, scope: Scope) -> IndexerResults {
        let empty = IndexerResults {
            matches: Vec::new(),
            ambiguous: false,
            semantic: false,
        };
        let idx = self.index();
        let n = idx.cards();
        if n == 0 {
            return empty;
        }
        // The segments in scope, with where each one's cards start in the
        // index as a whole.
        let mut scoped: Vec<(usize, &Segment, usize)> = Vec::new();
        let mut base = 0;
        for (si, s) in idx.segs.iter().enumerate() {
            if scope.admits(s.kind) {
                scoped.push((si, &**s, base));
            }
            base += s.len();
        }
        if scoped.iter().all(|(_, s, _)| s.len() == 0) {
            return empty;
        }
        let qq = qvec
            .filter(|v| idx.dim() == Some(v.len()))
            .map(|v| quantize_query(&v));
        // The median is the scope's own: thousands of book passages shouldn't
        // set the baseline a question about notes is scored against.
        let mut sem = vec![0.0; n];
        if let Some((qr, qs)) = &qq {
            let cos: Vec<(usize, f32)> = scoped
                .iter()
                .flat_map(|&(_, s, b)| {
                    s.vecs
                        .rows()
                        .enumerate()
                        .map(move |(i, (row, scale))| (b + i, score(row, scale, qr, *qs)))
                })
                .collect();
            let scores = semantic(cos.iter().map(|(_, c)| *c).collect());
            for ((i, _), v) in cos.iter().zip(scores) {
                sem[*i] = v;
            }
        }
        // A word no note uses is as specific as words get. It stays in the
        // denominator: dropping it left a question's common words ("how",
        // "handle") to carry the whole keyword score.
        let unseen = (1.0 + n as f32).ln();
        let weights: Vec<(u64, f32)> = terms(q)
            .into_iter()
            .map(|t| {
                let df: usize = idx.segs.iter().map(|s| s.words.hits(t).len()).sum();
                let idf = match df {
                    0 => unseen,
                    df => (1.0 + n as f32 / df as f32).ln(),
                };
                (t, idf)
            })
            .collect();
        let denom: f32 = 3.0 * weights.iter().map(|(_, w)| w).sum::<f32>();
        // Word by word, in the question's order, so each card's sum adds the
        // same terms in the same order as when each card was scored on its own.
        let mut sums = vec![0f32; n];
        for (t, idf) in &weights {
            for &(_, s, b) in &scoped {
                for &h in s.words.hits(*t) {
                    sums[b + (h >> 2) as usize] += idf * (h & 3) as f32;
                }
            }
        }

        // (segment, card, semantic, keyword)
        let mut scored: Vec<(usize, usize, f32, f32)> = Vec::new();
        for &(si, s, b) in &scoped {
            for i in 0..s.len() {
                let kw = if denom > 0.0 {
                    sums[b + i] / denom
                } else {
                    0.0
                };
                scored.push((si, i, sem[b + i], kw.min(1.0)));
            }
        }
        let hybrid = |s: f32, kw: f32| if qq.is_some() { 0.5 * s + 0.5 * kw } else { kw };
        scored.sort_by(|a, b| hybrid(b.2, b.3).total_cmp(&hybrid(a.2, a.3)));
        let mut per_note: HashMap<(usize, u32), usize> = HashMap::new();
        scored.retain(|&(s, i, _, _)| {
            let n = per_note.entry((s, idx.segs[s].cards[i].doc)).or_default();
            *n += 1;
            *n <= PER_NOTE
        });

        // Only the cards shown are read back from disk.
        let matches: Vec<IndexerMatch> = scored
            .iter()
            .filter_map(|&(s, i, sem, kw)| {
                let c = idx.segs[s].card(i)?;
                Some(IndexerMatch {
                    label: option_label(&c),
                    question: c.question,
                    answer: c.answer,
                    key_points: c.key_points,
                    source: c.source,
                    category: c.category,
                    path: c.path,
                    book: c.kind == Kind::Book,
                    page: c.page,
                    confidence: hybrid(sem, kw),
                    semantic: sem,
                    keyword: kw,
                })
            })
            .take(k.clamp(1, MAX_K))
            .collect();
        IndexerResults {
            ambiguous: ambiguous(&matches),
            semantic: qq.is_some(),
            matches,
        }
    }
}

/// A card as Laya sees it: its title and one line of what it says. Titles alone
/// were worse on questions asked in interview phrasing ("a time you took
/// initiative"), where the answer is in the text rather than the heading.
fn option_label(c: &Card) -> String {
    let gist = c
        .key_points
        .first()
        .map(String::as_str)
        .unwrap_or_else(|| prefix_chars(&c.answer, 100));
    format!("{}: {}", c.question, gist)
}

fn ambiguous(matches: &[IndexerMatch]) -> bool {
    match matches {
        [first, second, ..] => {
            first.confidence < SURE || first.confidence - second.confidence < MARGIN
        }
        _ => false,
    }
}

// ─── System 1 (Laya) ──────────────────────────────────────────────────────────

/// Ask Laya which option answers `question`. Options are the closest cards'
/// labels, best-ranked first.
pub fn decide(question: &str, options: &[String]) -> Result<IndexerPick, String> {
    if options.len() < 2 {
        return Err("nothing to choose between".into());
    }
    let options = &options[..options.len().min(MAX_OPTIONS)];
    let criteria: serde_json::Map<String, serde_json::Value> = options
        .iter()
        .enumerate()
        .map(|(i, o)| {
            (
                (i + 1).to_string(),
                prefix_chars(o, MAX_OPTION_CHARS).into(),
            )
        })
        .collect();
    let body = serde_json::json!({
        "model": LAYA_MODEL,
        "state": prefix_chars(question.trim(), MAX_QUERY_CHARS),
        "questions": {
            "pick": {
                "type": "choice",
                "instructions": "Which of these notes answers the question?",
                "criteria": criteria,
            }
        }
    });
    let url = format!("{}/v1/systemone", laya_url().trim_end_matches('/'));
    // A cold request loads the checkpoint first (about 20 s on Apple silicon).
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(1))
        .timeout_read(Duration::from_secs(90))
        .build();
    let resp = agent.post(&url).send_json(body).map_err(|e| match e {
        ureq::Error::Transport(_) => format!("Laya isn't running at {}", laya_url()),
        ureq::Error::Status(code, _) => format!("Laya answered {code}"),
    })?;
    let value: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    parse_pick(&value, options.len())
}

fn parse_pick(value: &serde_json::Value, n: usize) -> Result<IndexerPick, String> {
    let pick = value
        .pointer("/answers/pick")
        .ok_or("Laya's reply had no answer")?;
    let index = pick
        .get("choice")
        .and_then(|c| c.as_str())
        .and_then(|c| c.parse::<usize>().ok())
        .filter(|c| (1..=n).contains(c))
        .ok_or("Laya picked an option that wasn't offered")?
        - 1;
    let probs = pick.get("probabilities");
    let probabilities: Vec<f32> = (1..=n)
        .map(|i| {
            probs
                .and_then(|p| p.get(i.to_string()))
                .and_then(|p| p.as_f64())
                .unwrap_or(0.0) as f32
        })
        .collect();
    Ok(IndexerPick {
        index: index as u32,
        decisive: probabilities[index] >= DECISIVE,
        probabilities,
        confidence: pick
            .get("confidence")
            .and_then(|c| c.as_f64())
            .unwrap_or(0.0) as f32,
    })
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// The Onyx vault and the books folder (`FLUX_INDEXER_BOOKS`, else
/// `~/Documents/Books`), whichever exist.
fn sources(kb: &crate::kb::KbStore) -> Sources {
    Sources {
        notes: crate::kb::onyx_vault(kb.source_location("onyx").as_deref()),
        books: books_dir(),
    }
}

fn books_dir() -> Option<PathBuf> {
    let dir = match std::env::var_os("FLUX_INDEXER_BOOKS").filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?)
                .join("Documents")
                .join("Books")
        }
    };
    dir.is_dir().then_some(dir)
}

/// The index's state. The first call of a session also starts an incremental
/// build, so notes written since last time are picked up.
#[tauri::command]
pub async fn indexer_status(
    state: State<'_, IndexerState>,
    kb: State<'_, crate::kb::KbStore>,
) -> Result<IndexerStatus, String> {
    let (state, kb) = ((*state).clone(), (*kb).clone());
    tauri::async_runtime::spawn_blocking(move || {
        static FIRST: Once = Once::new();
        FIRST.call_once(|| state.start_build(sources(&kb)));
        state.status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Re-read new and changed notes and books (and embed them) in the background.
#[tauri::command]
pub async fn indexer_reindex(
    state: State<'_, IndexerState>,
    kb: State<'_, crate::kb::KbStore>,
) -> Result<IndexerStatus, String> {
    let (state, kb) = ((*state).clone(), (*kb).clone());
    tauri::async_runtime::spawn_blocking(move || {
        state.start_build(sources(&kb));
        state.status()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn indexer_search(
    state: State<'_, IndexerState>,
    query: String,
    k: Option<u32>,
    scope: Option<String>,
) -> Result<IndexerResults, String> {
    let state = (*state).clone();
    let scope = Scope::parse(scope.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        state.search(&query, k.unwrap_or(5) as usize, scope)
    })
    .await
    .map_err(|e| e.to_string())
}

/// The System 1 tie-break: which of `options` answers `question`.
#[tauri::command]
pub async fn indexer_decide(question: String, options: Vec<String>) -> Result<IndexerPick, String> {
    tauri::async_runtime::spawn_blocking(move || decide(&question, &options))
        .await
        .map_err(|e| e.to_string())?
}

/// Load Laya's checkpoint ahead of a question (a cold one takes ~20 s), so it's
/// ready by the time the question is asked. Fire and forget.
#[tauri::command]
pub fn indexer_warm() {
    let _ = std::thread::Builder::new()
        .name("flux-laya-warm".into())
        .spawn(|| {
            let _ = decide("warm up", &["one".into(), "two".into()]);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_split_into_heading_cards() {
        let note = "---\ntags: [ml]\n---\n#ml\nIntro text that is long enough to be its own card, really.\n\n## Backpropagation\nThe chain rule applied layer by layer from the loss backwards.\n```python\n# not a heading\nx = 1\n```\n# [[Index]]\nshort\n";
        let cards = parse_note(
            note,
            "00 - Machine Learning/Neural nets.md",
            "/v/00 - Machine Learning/Neural nets.md",
        );
        let qs: Vec<&str> = cards.iter().map(|c| c.question.as_str()).collect();
        assert_eq!(qs, ["Neural nets", "Neural nets: Backpropagation"]);
        assert_eq!(cards[0].source, "Machine Learning > Neural nets");
        assert_eq!(cards[1].category, "Machine Learning");
        assert!(
            cards[1].answer.contains("# not a heading"),
            "code stays in the section"
        );
        assert!(cards[0].answer.contains("#ml"), "a tag is not a heading");
    }

    #[test]
    fn interview_notes_split_into_questions() {
        let note = "Introduction\nI study computing at ANU.\nTell me about a time you disagreed with a teammate\nWe built two wireframes. So I proposed a summary dashboard, and the result was a faster review.\n## Why this role?\nApplied AI.";
        let cards = parse_note(
            note,
            "10 - Interview prep/Prep.md",
            "/v/10 - Interview prep/Prep.md",
        );
        let qs: Vec<&str> = cards.iter().map(|c| c.question.as_str()).collect();
        assert_eq!(
            qs,
            [
                "Introduction: Tell me about yourself and your background",
                "Tell me about a time you disagreed with a teammate",
                "Why this role?",
            ]
        );
        assert_eq!(cards[1].category, "Behavioral (STAR)");
        assert_eq!(cards[1].path, "/v/10 - Interview prep/Prep.md");
        assert!(cards[1].key_points[0].starts_with("We built"));
    }

    #[test]
    fn cuts_land_on_character_boundaries() {
        assert_eq!(prefix_chars("héllo wörld", 2), "hé");
        let long = "é".repeat(MAX_ANSWER_CHARS + 10);
        let c = card("a.md", "s", "c", "q".into(), &long);
        assert_eq!(c.answer.chars().count(), MAX_ANSWER_CHARS);
    }

    fn index_of(cards: Vec<Card>) -> IndexerState {
        let state = IndexerState::new(None);
        let mtimes = cards.iter().map(|c| (c.path.clone(), 1)).collect();
        *state.index.write() = Some(Index::from_parts(
            vec!["/v".into()],
            None,
            mtimes,
            cards,
            VecStore::default(),
        ));
        state
    }

    /// Every card in an index, read back from its segments.
    fn all_cards(idx: &Index) -> Vec<Card> {
        idx.segs
            .iter()
            .flat_map(|s| (0..s.len()).filter_map(move |i| s.card(i)))
            .collect()
    }

    #[test]
    fn a_word_counts_once_where_it_weighs_most() {
        let c = card(
            "a.md",
            "s",
            "Momentum",
            "Momentum and friction".into(),
            "Friction slows the momentum down; so does damping.",
        );
        let w: HashMap<u64, u32> = weighted_terms(&c).into_iter().collect();
        assert_eq!(w[&term("momentum")], 3, "the question outweighs the rest");
        assert_eq!(w[&term("friction")], 3);
        assert_eq!(w[&term("damping")], 1);
        let words = Words::of(vec![
            (term("x"), (1 << 2) | 1),
            (term("y"), 3),
            (term("x"), 2),
        ]);
        assert_eq!(words.hits(term("x")), [2, (1 << 2) | 1]);
        assert_eq!(words.hits(term("y")), [3]);
        assert!(words.hits(term("z")).is_empty());
        assert_eq!(words.pairs().count(), 3);
    }

    #[test]
    fn keywords_rank_rare_words_and_questions_first() {
        let state = index_of(vec![
            card(
                "a.md",
                "s",
                "General",
                "Team conflict".into(),
                "We disagreed about the dashboard and the model.",
            ),
            card(
                "b.md",
                "s",
                "General",
                "PlantCLEF walkthrough".into(),
                "A model for plant identification.",
            ),
            card(
                "c.md",
                "s",
                "General",
                "Model notes".into(),
                "Some model details, not much else here.",
            ),
        ]);
        let r = state.search("walk me through PlantCLEF", 3, Scope::All);
        assert!(!r.semantic, "no vectors: keywords only");
        assert_eq!(r.matches[0].question, "PlantCLEF walkthrough");
        let r = state.search("model", 3, Scope::All);
        assert_eq!(
            r.matches[0].question, "Model notes",
            "a question hit beats an answer hit"
        );
        assert!(state.search("   ", 3, Scope::All).matches.is_empty());
    }

    #[test]
    fn a_near_tie_is_ambiguous() {
        let m = |confidence| IndexerMatch {
            label: String::new(),
            question: String::new(),
            answer: String::new(),
            key_points: vec![],
            source: String::new(),
            category: String::new(),
            path: String::new(),
            book: false,
            page: None,
            confidence,
            semantic: 0.0,
            keyword: 0.0,
        };
        assert!(!ambiguous(&[m(0.9), m(0.5)]));
        assert!(ambiguous(&[m(0.9), m(0.87)]), "close runner-up");
        assert!(ambiguous(&[m(0.4), m(0.1)]), "low confidence");
        assert!(!ambiguous(&[m(0.2)]), "nothing to choose between");
    }

    #[test]
    fn laya_replies_are_read_and_checked() {
        let v = serde_json::json!({"answers": {"pick": {"choice": "2", "confidence": 0.4,
            "probabilities": {"1": 0.1, "2": 0.8, "3": 0.1}}}});
        let p = parse_pick(&v, 3).unwrap();
        assert_eq!(p.index, 1);
        assert!(p.decisive);
        let flat = serde_json::json!({"answers": {"pick": {"choice": "1",
            "probabilities": {"1": 0.36, "2": 0.34, "3": 0.30}}}});
        assert!(
            !parse_pick(&flat, 3).unwrap().decisive,
            "a coin toss isn't a pick"
        );
        assert_eq!(p.probabilities, vec![0.1, 0.8, 0.1]);
        let bad = serde_json::json!({"answers": {"pick": {"choice": "4"}}});
        assert!(
            parse_pick(&bad, 3).is_err(),
            "an option that wasn't offered"
        );
    }

    fn passage(path: &str, page: u32, text: &str) -> Card {
        let mut c = card(path, "Books > x", "Books", format!("x, p. {page}"), text);
        c.kind = Kind::Book;
        c.page = Some(page);
        c.key_points.clear();
        c
    }

    #[test]
    fn the_index_survives_a_save_and_load() {
        let dir = std::env::temp_dir().join(format!("flux-indexer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cards = vec![
            card("/v/a.md", "s", "c", "One".into(), "first answer"),
            card("/v/b.md", "s", "c", "Two".into(), "second answer"),
            passage("/b/x.pdf", 4, "convex sets and convex functions"),
        ];
        let mut vecs = VecStore::default();
        vecs.push(&[1.0, 0.0]);
        vecs.push(&[0.0, 1.0]);
        vecs.push(&[0.6, 0.8]);
        let mtimes = [
            ("/v/a.md".to_string(), 5),
            ("/v/b.md".to_string(), 0),
            ("/b/x.pdf".to_string(), 7),
        ]
        .into();
        let mut idx = Index::from_parts(
            vec!["/v".into()],
            Some("m".into()),
            mtimes,
            cards.clone(),
            vecs,
        );
        save(&dir, &mut idx).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!(back.segs.len(), 2, "the notes, and the book");
        assert_eq!(all_cards(&back), cards);
        assert_eq!(back.dim(), Some(2));
        assert_eq!(back.pending(), 1, "b.md is waiting on the model");

        // A segment cut short is left out, not misread; the rest still loads.
        let book = dir.join(back.segs[1].file.as_deref().unwrap());
        let bytes = std::fs::read(&book).unwrap();
        std::fs::write(&book, &bytes[..40]).unwrap();
        assert_eq!(all_cards(&load(&dir).unwrap()), cards[..2]);
        // Nor are vectors trusted that the manifest's model doesn't account for.
        let mut m: Manifest =
            serde_json::from_slice(&std::fs::read(dir.join(MANIFEST)).unwrap()).unwrap();
        m.model = None;
        std::fs::write(dir.join(MANIFEST), serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(load(&dir).unwrap().segs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_index_from_before_books_moves_to_absolute_paths() {
        let dir = std::env::temp_dir().join(format!("flux-indexer-v1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v1 = serde_json::json!({
            "format": 1, "vault": "/vault", "model": null,
            "mtimes": {"ml/a.md": 5},
            "cards": [{"path": "ml/a.md", "source": "ml > a", "category": "ml",
                       "question": "A", "answer": "an answer", "key_points": []}],
        });
        std::fs::write(dir.join("index.json"), v1.to_string()).unwrap();
        let idx = load(&dir).unwrap();
        assert_eq!(idx.roots, vec![PathBuf::from("/vault")]);
        let cards = all_cards(&idx);
        assert_eq!(cards[0].path, "/vault/ml/a.md");
        assert_eq!(cards[0].kind, Kind::Note);
        assert_eq!(idx.segs[0].docs[0].mtime, 5);
        // Converted once: the next load reads the segments.
        assert!(dir.join(MANIFEST).exists() && !dir.join("index.json").exists());
        assert_eq!(all_cards(&load(&dir).unwrap()), cards);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_format_2_index_becomes_segments_and_keeps_its_vectors() {
        let dir = std::env::temp_dir().join(format!("flux-indexer-v2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let note = |path: &str, q: &str| {
            serde_json::json!({"path": path, "kind": "note", "source": "ml > n",
                "category": "ml", "question": q, "answer": "an answer", "key_points": ["a point"]})
        };
        let book = |path: &str, page: u32, a: &str| {
            serde_json::json!({"path": path, "kind": "book", "page": page,
                "source": "Books > x", "category": "Books", "question": format!("p. {page}"),
                "answer": a, "key_points": []})
        };
        let v2 = serde_json::json!({
            "format": 2, "roots": ["/v", "/b"], "model": "m",
            // An unreadable book has a time and no cards, and keeps both.
            "mtimes": {"/v/a.md": 1, "/v/b.md": 2, "/b/x.pdf": 3, "/b/y.pdf": 4, "/b/z.pdf": 5},
            "cards": [note("/v/a.md", "A"), book("/b/x.pdf", 1, "first page"),
                      book("/b/x.pdf", 2, "second page"), note("/v/b.md", "B"),
                      book("/b/y.pdf", 9, "the passage about lattices")],
        });
        let mut vecs = VecStore::default();
        for v in [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.9, 0.1],
            [0.9, 0.1, 0.0],
            [0.0, 0.0, 1.0],
        ] {
            vecs.push(&v);
        }
        std::fs::write(dir.join("index.json"), v2.to_string()).unwrap();
        std::fs::write(dir.join("vectors.bin"), vecs.to_bytes()).unwrap();

        let idx = load(&dir).unwrap();
        let shape: Vec<(Kind, usize, usize)> = idx
            .segs
            .iter()
            .map(|s| (s.kind, s.docs.len(), s.len()))
            .collect();
        assert_eq!(
            shape,
            [
                (Kind::Note, 2, 2),
                (Kind::Book, 1, 2),
                (Kind::Book, 1, 1),
                (Kind::Book, 1, 0)
            ]
        );
        // The same rows, moved rather than embedded again.
        let row = |v: &VecStore, i: usize| v.rows().nth(i).map(|(r, s)| (r.to_vec(), s));
        let moved: Vec<_> = idx
            .segs
            .iter()
            .flat_map(|s| (0..s.len()).map(move |i| row(&s.vecs, i)))
            .collect();
        let want: Vec<_> = [0, 3, 1, 2, 4].iter().map(|&i| row(&vecs, i)).collect();
        assert_eq!(moved, want);
        assert!(!dir.join("index.json").exists() && !dir.join("vectors.bin").exists());

        // Searched by meaning, the book passage comes back with its text.
        let state = IndexerState::new(Some(dir.clone()));
        let r = state.rank("anything", Some(vec![0.0, 0.0, 1.0]), 3, Scope::All);
        assert!(r.semantic);
        assert_eq!(r.matches[0].path, "/b/y.pdf");
        assert_eq!(r.matches[0].answer, "the passage about lattices");
        assert_eq!(r.matches[0].page, Some(9));
        assert_eq!(state.status().books, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn books_split_into_page_passages() {
        let para = "Gradient descent takes a step against the gradient of the loss. ".repeat(4);
        let text = format!(
            "Chapter 1\nIntro-\nduction to learning. {para}\n\n{para}\x0c3\x0c{}",
            para.repeat(12)
        );
        let cards = parse_book(
            &text,
            "Machine Learning/mml-book.pdf",
            "/b/Machine Learning/mml-book.pdf",
        );
        assert!(cards
            .iter()
            .all(|c| c.kind == Kind::Book && c.path.ends_with("mml-book.pdf")));
        assert_eq!(cards[0].page, Some(1));
        assert!(
            cards[0].answer.contains("Introduction to learning"),
            "a wrap's hyphen is rejoined"
        );
        assert!(cards[0]
            .question
            .starts_with("mml book, p. 1: Chapter 1 Introduction"));
        assert_eq!(cards[0].category, "Machine Learning");
        assert!(
            cards.iter().all(|c| c.page != Some(2)),
            "a page that's only a number is no card"
        );
        let third: Vec<&Card> = cards.iter().filter(|c| c.page == Some(3)).collect();
        assert!(third.len() > 1, "a long page is cut into passages");
        assert!(third
            .iter()
            .all(|c| c.answer.chars().count() <= BOOK_CHUNK_CHARS));
    }

    #[test]
    fn book_titles_read_like_titles() {
        assert_eq!(
            book_title("Bishop-Pattern-Recognition-and-Machine-Learning-2006.pdf"),
            "Bishop Pattern Recognition and Machine Learning 2006"
        );
        assert_eq!(
            book_title("Deep Learning by Ian Goodfellow (z-lib.org).pdf"),
            "Deep Learning by Ian Goodfellow"
        );
        assert_eq!(
            book_title("Artificial Intelligence - A Modern Approach.pdf"),
            "Artificial Intelligence - A Modern Approach"
        );
    }

    #[test]
    fn a_search_can_keep_to_notes_or_books() {
        let mut book = card(
            "/b/x.pdf",
            "Books > x",
            "Books",
            "x, p. 4: Convexity".into(),
            "convex sets and convex functions",
        );
        book.kind = Kind::Book;
        book.page = Some(4);
        let state = index_of(vec![
            card(
                "/v/n.md",
                "s",
                "General",
                "Convexity notes".into(),
                "my notes on convex sets",
            ),
            book,
        ]);
        let all = state.search("convex", 5, Scope::All);
        assert_eq!(all.matches.len(), 2);
        let books = state.search("convex", 5, Scope::Books);
        assert_eq!(books.matches.len(), 1);
        assert!(books.matches[0].book);
        assert_eq!(books.matches[0].page, Some(4));
        let notes = state.search("convex", 5, Scope::Notes);
        assert!(notes.matches.iter().all(|m| !m.book));
    }

    #[test]
    fn a_rebuild_reads_only_what_changed() {
        // The embedding model is beside the point here (and absent in CI): point
        // it at a name no Ollama has, so the build is keyword-only.
        std::env::set_var("FLUX_INDEXER_EMBED_MODEL", "flux-test-no-such-model");
        let vault = std::env::temp_dir().join(format!("flux-indexer-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(vault.join("ml")).unwrap();
        let note = vault.join("ml/a.md");
        std::fs::write(
            &note,
            "# Backprop\nThe chain rule applied layer by layer from the loss.",
        )
        .unwrap();
        let src = || Sources {
            notes: Some(vault.clone()),
            books: None,
        };
        let state = IndexerState::new(None);
        state.build(src()).unwrap();
        assert_eq!(state.status().cards, 1);

        // Nothing changed: the index is left exactly as it was.
        // A commit swaps in new segments; a no-op leaves the same ones.
        let before = Arc::as_ptr(&state.index().segs[0]);
        state.build(src()).unwrap();
        assert_eq!(Arc::as_ptr(&state.index().segs[0]), before, "no rebuild");
        assert_eq!(state.status().cards, 1);

        // An edit (a new mtime) is read again.
        std::fs::write(
            &note,
            "# Backprop\nThe chain rule applied layer by layer from the loss.\n# Momentum\nA running average of past gradients that smooths each step.",
        )
        .unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&note)
            .unwrap()
            .set_modified(later)
            .unwrap();
        state.build(src()).unwrap();
        assert_eq!(state.status().cards, 2);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn a_note_edit_rewrites_only_the_notes() {
        use std::os::unix::fs::PermissionsExt;
        std::env::set_var("FLUX_INDEXER_EMBED_MODEL", "flux-test-no-such-model");
        let root = std::env::temp_dir().join(format!("flux-indexer-seg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["vault", "books", "index"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let note = root.join("vault/a.md");
        std::fs::write(
            &note,
            "# Backprop\nThe chain rule applied layer by layer from the loss.",
        )
        .unwrap();
        std::fs::write(root.join("books/Convex Optimization.pdf"), "%PDF-1.4").unwrap();
        // A stand-in for pdftotext: one page about convexity, whatever the PDF.
        let page =
            "A set is convex when the segment between two of its points stays in it. ".repeat(6);
        std::fs::write(root.join("book.txt"), &page).unwrap();
        let bin = root.join("pdftotext");
        let script = format!("#!/bin/sh\ncat '{}'\n", root.join("book.txt").display());
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("FLUX_PDFTOTEXT", &bin);
        let src = || Sources {
            notes: Some(root.join("vault")),
            books: Some(root.join("books")),
        };
        let files = || -> BTreeMap<String, std::time::SystemTime> {
            std::fs::read_dir(root.join("index"))
                .unwrap()
                .flatten()
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    (name, e.metadata().unwrap().modified().unwrap())
                })
                .collect()
        };
        let named =
            |files: &BTreeMap<String, std::time::SystemTime>, prefix: &str| -> Vec<String> {
                files
                    .keys()
                    .filter(|k| k.starts_with(prefix))
                    .cloned()
                    .collect()
            };

        let state = IndexerState::new(Some(root.join("index")));
        state.build(src()).unwrap();
        let first = state.status();
        assert_eq!((first.notes, first.books, first.cards), (1, 1, 2));
        // A book's text stays on disk until a search returns it.
        let r = state.search("convex segment", 3, Scope::Books);
        assert!(r.matches[0].answer.starts_with("A set is convex"));
        assert_eq!(r.matches[0].page, Some(1));
        let before = files();
        assert_eq!(named(&before, "book-").len(), 1);
        assert_eq!(named(&before, "notes-").len(), 1);

        std::fs::write(
            &note,
            "# Backprop\nThe chain rule applied layer by layer from the loss.\n# Momentum\nA running average of past gradients that smooths each step.",
        )
        .unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&note)
            .unwrap()
            .set_modified(later)
            .unwrap();
        state.build(src()).unwrap();
        assert_eq!(state.status().cards, 3);
        let after = files();
        let book = &named(&before, "book-")[0];
        assert_eq!(
            after.get(book),
            before.get(book),
            "the book wasn't rewritten"
        );
        assert_eq!(named(&after, "notes-").len(), 1, "the old notes are gone");
        assert_ne!(named(&after, "notes-"), named(&before, "notes-"));
        assert_eq!(after.len(), 3, "a manifest, the notes and the book");

        // Read back from disk by a fresh start, it's the same index.
        let again = IndexerState::new(Some(root.join("index")));
        assert_eq!(again.status().cards, 3);
        let r = again.search("running average momentum", 3, Scope::Notes);
        assert_eq!(r.matches[0].question, "a: Momentum");
        let _ = std::fs::remove_dir_all(&root);
    }
}
