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
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant, UNIX_EPOCH};
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
const FORMAT: u32 = 2;
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
/// How often a long build saves what it has so far.
const COMMIT_EVERY: Duration = Duration::from_secs(60);
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

/// FNV-1a: words are matched by hash, so a card's vocabulary is a sorted `u64`
/// list rather than thousands of small strings. Not persisted, so it only has to
/// agree with itself within a run.
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

#[derive(Clone)]
struct Terms {
    question: Vec<u64>,
    category: Vec<u64>,
    answer: Vec<u64>,
}

impl Terms {
    fn of(c: &Card) -> Self {
        Terms {
            question: terms(&c.question),
            category: terms(&c.category),
            answer: terms(&c.answer),
        }
    }

    /// The original's 3/2/1 weighting for a word found in the question,
    /// category or answer.
    fn weight(&self, t: u64) -> f32 {
        if self.question.binary_search(&t).is_ok() {
            3.0
        } else if self.category.binary_search(&t).is_ok() {
            2.0
        } else if self.answer.binary_search(&t).is_ok() {
            1.0
        } else {
            0.0
        }
    }
}

/// Inverse document frequency of every word, over cards.
fn idf_of(all: &[Terms]) -> HashMap<u64, f32> {
    let mut df: HashMap<u64, u32> = HashMap::new();
    for t in all {
        let mut seen: Vec<u64> = t
            .question
            .iter()
            .chain(&t.category)
            .chain(&t.answer)
            .copied()
            .collect();
        seen.sort_unstable();
        seen.dedup();
        for w in seen {
            *df.entry(w).or_default() += 1;
        }
    }
    let n = all.len().max(1) as f32;
    df.into_iter()
        .map(|(w, d)| (w, (1.0 + n / d as f32).ln()))
        .collect()
}

// ─── The index ────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    format: u32,
    /// Format 1's one vault, which its card paths were relative to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vault: Option<PathBuf>,
    /// The folders read: the vault, then the books.
    #[serde(default)]
    roots: Vec<PathBuf>,
    /// The model every vector came from; `None` means the index has no vectors
    /// (built while the model wasn't available) and matches on keywords alone.
    model: Option<String>,
    /// File → modified time (ms) of the version its cards came from. Zero marks a
    /// file whose cards are waiting on the model, so the next build redoes it.
    mtimes: BTreeMap<String, u64>,
    cards: Vec<Card>,
}

#[derive(Default)]
struct Index {
    roots: Vec<PathBuf>,
    model: Option<String>,
    mtimes: BTreeMap<String, u64>,
    cards: Vec<Card>,
    /// Row `i` is card `i`'s vector; empty when `model` is `None`.
    vecs: VecStore,
    terms: Vec<Terms>,
    idf: HashMap<u64, f32>,
}

impl Index {
    fn from_parts(
        roots: Vec<PathBuf>,
        model: Option<String>,
        mtimes: BTreeMap<String, u64>,
        cards: Vec<Card>,
        vecs: VecStore,
    ) -> Self {
        let terms: Vec<Terms> = cards.iter().map(Terms::of).collect();
        Self::assemble(roots, model, mtimes, cards, vecs, terms)
    }

    /// `from_parts` with each card's terms already worked out: a long build
    /// saves every minute, and re-tokenising every passage each time adds up.
    fn assemble(
        roots: Vec<PathBuf>,
        model: Option<String>,
        mtimes: BTreeMap<String, u64>,
        cards: Vec<Card>,
        vecs: VecStore,
        terms: Vec<Terms>,
    ) -> Self {
        let idf = idf_of(&terms);
        Index {
            roots,
            model,
            mtimes,
            cards,
            vecs,
            terms,
            idf,
        }
    }

    fn pending(&self) -> usize {
        self.cards
            .iter()
            .filter(|c| self.mtimes.get(&c.path) == Some(&0))
            .count()
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
    /// Its absolute path, as cards and `mtimes` name it.
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
    index: Arc<RwLock<Index>>,
    loaded: Arc<Once>,
    building: Arc<AtomicBool>,
    files_done: Arc<AtomicUsize>,
    files_todo: Arc<AtomicUsize>,
    current: Arc<Mutex<Option<String>>>,
    notice: Arc<Mutex<Option<String>>>,
    error: Arc<Mutex<Option<String>>>,
}

impl IndexerState {
    /// `dir` holds `index.json` and its `vectors.bin` sidecar; `None` keeps the
    /// index in memory (tests).
    pub fn new(dir: Option<PathBuf>) -> Self {
        IndexerState {
            dir,
            index: Arc::default(),
            loaded: Arc::new(Once::new()),
            building: Arc::default(),
            files_done: Arc::default(),
            files_todo: Arc::default(),
            current: Arc::default(),
            notice: Arc::default(),
            error: Arc::default(),
        }
    }

    fn hydrate(&self) {
        self.loaded.call_once(|| {
            if let Some(idx) = self.dir.as_deref().and_then(load) {
                *self.index.write() = idx;
            }
        });
    }

    pub fn status(&self) -> IndexerStatus {
        self.hydrate();
        let idx = self.index.read();
        let books = idx
            .mtimes
            .keys()
            .filter(|k| k.to_lowercase().ends_with(".pdf"))
            .count();
        IndexerStatus {
            cards: idx.cards.len() as u32,
            notes: (idx.mtimes.len() - books) as u32,
            books: books as u32,
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
        self.hydrate();
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

        // Unchanged files keep their cards, terms and vectors, as long as the
        // vectors came from this model.
        let fresh: HashMap<&str, u64> = jobs.iter().map(|j| (j.key.as_str(), j.mtime)).collect();
        let (had_vectors, reuse) = {
            let old = self.index.read();
            let had_vectors = old.model.as_deref() == Some(model.as_str());
            // Without vectors to keep, only an index that also has none (and
            // still none to make) can keep its cards as they are.
            (
                had_vectors,
                had_vectors || (old.model.is_none() && !available),
            )
        };
        let keep_file = |old: &Index, p: &str| {
            reuse
                && old
                    .mtimes
                    .get(p)
                    .is_some_and(|&m| m != 0 && fresh.get(p) == Some(&m))
        };
        // Nothing to do is the common case (the panel reindexes on every open),
        // and it's decided from the file times alone: copying the kept index
        // first, to throw the copy away, was ~110 MB per open with books in it.
        {
            let old = self.index.read();
            // Without pdftotext, books wait for a build that can read them; the
            // ones already indexed stay.
            let nothing_to_read = jobs
                .iter()
                .all(|j| keep_file(&old, &j.key) || (j.kind == Kind::Book && pdf.is_none()));
            let nothing_gone = old.mtimes.keys().all(|k| keep_file(&old, k));
            if nothing_to_read && nothing_gone && (had_vectors || !available) {
                return Ok(());
            }
        }
        let (mut cards, mut terms, mut vecs, mut mtimes, before) = {
            let old = self.index.read();
            let keep_file = |p: &str| keep_file(&old, p);
            let keep: Vec<bool> = old.cards.iter().map(|c| keep_file(&c.path)).collect();
            let pick = |i: usize| keep[i];
            let cards: Vec<Card> = (0..old.cards.len())
                .filter(|&i| pick(i))
                .map(|i| old.cards[i].clone())
                .collect();
            let terms: Vec<Terms> = (0..old.terms.len())
                .filter(|&i| pick(i))
                .map(|i| old.terms[i].clone())
                .collect();
            let mut vecs = old.vecs.clone();
            if had_vectors {
                vecs.retain(|i| keep[i]);
            } else {
                vecs.clear();
            }
            let mtimes: BTreeMap<String, u64> = old
                .mtimes
                .iter()
                .filter(|(k, _)| keep_file(k))
                .map(|(k, m)| (k.clone(), *m))
                .collect();
            (cards, terms, vecs, mtimes, old.mtimes.len())
        };
        // Without pdftotext, books wait for a build that can read them; the ones
        // already indexed stay.
        let todo: Vec<&Job> = jobs
            .iter()
            .filter(|j| !mtimes.contains_key(&j.key) && (j.kind == Kind::Note || pdf.is_some()))
            .collect();
        if todo.is_empty() && mtimes.len() == before && (had_vectors || !available) {
            return Ok(()); // raced a change back; nothing left to do
        }

        let mut keyed: Option<String> = (available || had_vectors).then(|| model.clone());
        if keyed.is_none() {
            vecs.clear();
        }
        self.files_todo.store(todo.len(), Ordering::Relaxed);
        self.files_done.store(0, Ordering::Relaxed);
        let mut failed = !available;
        let mut pending = 0usize;
        let mut last_commit = Instant::now();
        let mut notes_committed = false;
        for job in todo {
            // Changed notes show up before the long haul through the books.
            if job.kind == Kind::Book && !notes_committed {
                notes_committed = true;
                self.commit(&roots, &keyed, &mtimes, &cards, &terms, &vecs)?;
                last_commit = Instant::now();
            }
            *self.current.lock() = Some(job.name());
            let fresh = match job.kind {
                Kind::Note => std::fs::read_to_string(&job.path)
                    .map(|t| parse_note(&t, &job.rel, &job.key))
                    .unwrap_or_default(),
                // An unreadable book (encrypted, malformed, timed out) is recorded
                // as done with no cards, so it isn't retried on every reindex.
                Kind::Book => match pdf.as_deref().map(|bin| extract_pdf(bin, &job.path)) {
                    Some(Ok(text)) => parse_book(&text, &job.rel, &job.key),
                    _ => Vec::new(),
                },
            };

            // A model that fails partway leaves zero rows (those cards match on
            // keywords) and marks the file for the next build.
            let mut embedded = true;
            if keyed.is_some() {
                for chunk in fresh.chunks(EMBED_BATCH) {
                    let texts: Vec<String> = chunk.iter().map(doc_text).collect();
                    let got = if failed {
                        None
                    } else {
                        flux_agent::ollama::embed_remote_batch_with(&model, &texts)
                            .filter(|v| v.len() == chunk.len())
                    };
                    match got {
                        Some(rows) => {
                            for row in rows {
                                if !vecs.push(&row) {
                                    return Err(format!(
                                        "{model} returned vectors of a different size; reindex to rebuild"
                                    ));
                                }
                            }
                        }
                        None => {
                            failed = true;
                            embedded = false;
                            if vecs.is_empty() {
                                // Nothing to size a zero row by (no card has a
                                // vector yet): keywords for the whole index, and
                                // everything embedded next time.
                                keyed = None;
                                break;
                            }
                            let zero = vec![0f32; vecs.dim()];
                            for _ in chunk {
                                vecs.push(&zero);
                            }
                        }
                    }
                }
            }
            if keyed.is_none() {
                vecs.clear();
            }
            terms.extend(fresh.iter().map(Terms::of));
            cards.extend(fresh);
            mtimes.insert(job.key.clone(), if embedded { job.mtime } else { 0 });
            if !embedded {
                pending += 1;
            }
            self.files_done.fetch_add(1, Ordering::Relaxed);
            if last_commit.elapsed() >= COMMIT_EVERY {
                self.commit(&roots, &keyed, &mtimes, &cards, &terms, &vecs)?;
                last_commit = Instant::now();
            }
        }
        self.commit(&roots, &keyed, &mtimes, &cards, &terms, &vecs)?;
        if pending > 0 {
            return Err(format!(
                "{model} stopped answering partway; {pending} files match on keywords until the next index"
            ));
        }
        Ok(())
    }

    /// Save what a build has so far and make it the index searches use.
    fn commit(
        &self,
        roots: &[PathBuf],
        model: &Option<String>,
        mtimes: &BTreeMap<String, u64>,
        cards: &[Card],
        terms: &[Terms],
        vecs: &VecStore,
    ) -> Result<(), String> {
        let idx = Index::assemble(
            roots.to_vec(),
            model.clone(),
            mtimes.clone(),
            cards.to_vec(),
            vecs.clone(),
            terms.to_vec(),
        );
        if let Some(dir) = &self.dir {
            save(dir, &idx)?;
        }
        *self.index.write() = idx;
        Ok(())
    }

    pub fn search(&self, query: &str, k: usize, scope: Scope) -> IndexerResults {
        self.hydrate();
        let q = prefix_chars(query.trim(), MAX_QUERY_CHARS);
        let empty = IndexerResults {
            matches: Vec::new(),
            ambiguous: false,
            semantic: false,
        };
        if q.is_empty() {
            return empty;
        }
        // Embed before taking the lock: it's a round trip to Ollama.
        let model = self.index.read().model.clone();
        let qvec = model.and_then(|m| {
            flux_agent::ollama::embed_remote_batch_with(&m, &[query_text(q)])
                .and_then(|mut v| v.pop())
        });

        let idx = self.index.read();
        if idx.cards.is_empty() {
            return empty;
        }
        let in_scope: Vec<bool> = idx.cards.iter().map(|c| scope.admits(c.kind)).collect();
        if !in_scope.contains(&true) {
            return empty;
        }
        let qq = qvec
            .filter(|v| idx.vecs.len() == idx.cards.len() && v.len() == idx.vecs.dim())
            .map(|v| quantize_query(&v));
        // The median is the scope's own: thousands of book passages shouldn't
        // set the baseline a question about notes is scored against.
        let mut sem = vec![0.0; idx.cards.len()];
        if let Some((qr, qs)) = &qq {
            let cos: Vec<(usize, f32)> = idx
                .vecs
                .rows()
                .enumerate()
                .filter(|(i, _)| in_scope[*i])
                .map(|(i, (row, scale))| (i, score(row, scale, qr, *qs)))
                .collect();
            let scores = semantic(cos.iter().map(|(_, c)| *c).collect());
            for ((i, _), v) in cos.iter().zip(scores) {
                sem[*i] = v;
            }
        }
        // A word no note uses is as specific as words get. It stays in the
        // denominator: dropping it left a question's common words ("how",
        // "handle") to carry the whole keyword score.
        let unseen = (1.0 + idx.cards.len() as f32).ln();
        let weights: Vec<(u64, f32)> = terms(q)
            .into_iter()
            .map(|t| (t, idx.idf.get(&t).copied().unwrap_or(unseen)))
            .collect();
        let denom: f32 = 3.0 * weights.iter().map(|(_, w)| w).sum::<f32>();

        let mut scored: Vec<(usize, f32, f32)> = idx
            .terms
            .iter()
            .enumerate()
            .filter(|(i, _)| in_scope[*i])
            .map(|(i, t)| {
                let kw = if denom > 0.0 {
                    weights
                        .iter()
                        .map(|(w, idf)| idf * t.weight(*w))
                        .sum::<f32>()
                        / denom
                } else {
                    0.0
                };
                (i, sem[i], kw.min(1.0))
            })
            .collect();
        let hybrid = |s: f32, kw: f32| if qq.is_some() { 0.5 * s + 0.5 * kw } else { kw };
        scored.sort_by(|a, b| hybrid(b.1, b.2).total_cmp(&hybrid(a.1, a.2)));
        let mut per_note: HashMap<&str, usize> = HashMap::new();
        scored.retain(|&(i, _, _)| {
            let n = per_note.entry(idx.cards[i].path.as_str()).or_default();
            *n += 1;
            *n <= PER_NOTE
        });
        scored.truncate(k.clamp(1, MAX_K));

        let matches: Vec<IndexerMatch> = scored
            .iter()
            .map(|&(i, s, kw)| {
                let c = &idx.cards[i];
                IndexerMatch {
                    label: option_label(c),
                    question: c.question.clone(),
                    answer: c.answer.clone(),
                    key_points: c.key_points.clone(),
                    source: c.source.clone(),
                    category: c.category.clone(),
                    path: c.path.clone(),
                    book: c.kind == Kind::Book,
                    page: c.page,
                    confidence: hybrid(s, kw),
                    semantic: s,
                    keyword: kw,
                }
            })
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

fn load(dir: &Path) -> Option<Index> {
    let json = std::fs::read_to_string(dir.join("index.json")).ok()?;
    let mut saved: Saved = serde_json::from_str(&json).ok()?;
    match saved.format {
        FORMAT => {}
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

fn save(dir: &Path, idx: &Index) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Sidecar first: a crash between the two leaves JSON that disagrees with the
    // sidecar's row count, which `load` refuses, rather than JSON naming rows
    // that aren't there.
    crate::persist::write_atomic(&dir.join("vectors.bin"), &idx.vecs.to_bytes())
        .map_err(|e| format!("couldn't save the Indexer's vectors: {e}"))?;
    let saved = Saved {
        format: FORMAT,
        vault: None,
        roots: idx.roots.clone(),
        model: idx.model.clone(),
        mtimes: idx.mtimes.clone(),
        cards: idx.cards.clone(),
    };
    let json = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
    crate::persist::write_atomic(&dir.join("index.json"), &json)
        .map_err(|e| format!("couldn't save the Indexer's index: {e}"))
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
        state.loaded.call_once(|| {});
        let mtimes = cards.iter().map(|c| (c.path.clone(), 1)).collect();
        *state.index.write() =
            Index::from_parts(vec!["/v".into()], None, mtimes, cards, VecStore::default());
        state
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

    #[test]
    fn the_index_survives_a_save_and_load() {
        let dir = std::env::temp_dir().join(format!("flux-indexer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cards = vec![
            card("a.md", "s", "c", "One".into(), "first answer"),
            card("b.md", "s", "c", "Two".into(), "second answer"),
        ];
        let mut vecs = VecStore::default();
        vecs.push(&[1.0, 0.0]);
        vecs.push(&[0.0, 1.0]);
        let mtimes = [("a.md".to_string(), 5), ("b.md".to_string(), 0)].into();
        let idx = Index::from_parts(
            vec!["/v".into()],
            Some("m".into()),
            mtimes,
            cards.clone(),
            vecs,
        );
        save(&dir, &idx).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!(back.cards, cards);
        assert_eq!(back.vecs.len(), 2);
        assert_eq!(back.pending(), 1, "b.md is waiting on the model");
        // A sidecar that disagrees with the cards is refused, not misread.
        let mut one = VecStore::default();
        one.push(&[1.0, 0.0]);
        std::fs::write(dir.join("vectors.bin"), one.to_bytes()).unwrap();
        assert!(load(&dir).is_none());
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
        assert_eq!(idx.cards[0].path, "/vault/ml/a.md");
        assert_eq!(idx.cards[0].kind, Kind::Note);
        assert_eq!(idx.mtimes.get("/vault/ml/a.md"), Some(&5));
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
        // A commit swaps in new card storage; a no-op leaves the same allocation.
        let before = state.index.read().cards.as_ptr();
        state.build(src()).unwrap();
        assert_eq!(state.index.read().cards.as_ptr(), before, "no rebuild");
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
}
