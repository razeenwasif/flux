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
//! Everything stays on the machine: the vault is read from disk, embeddings come
//! from the local Ollama, and Laya listens on loopback.

use crate::vecstore::{quantize_query, score, VecStore};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, UNIX_EPOCH};
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
const FORMAT: u32 = 1;
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 1 << 20;
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Card {
    /// Vault-relative path, `/`-separated.
    path: String,
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

/// Cards for one note. `rel` is the note's vault-relative path.
fn parse_note(text: &str, rel: &str) -> Vec<Card> {
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
        let cards = parse_document(body, rel, &source);
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
        cards.push(card(rel, &source, category, question, answer));
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
fn parse_document(text: &str, rel: &str, source: &str) -> Vec<Card> {
    let mut cards = Vec::new();
    let mut question: Option<String> = None;
    let mut answer: Vec<&str> = Vec::new();
    let flush = |question: &Option<String>, answer: &[&str], cards: &mut Vec<Card>| {
        let Some(q) = question else { return };
        let a = answer.join("\n\n");
        let a = a.trim();
        if !a.is_empty() {
            cards.push(card(rel, source, categorize(q), q.clone(), a));
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

fn card(rel: &str, source: &str, category: &str, question: String, answer: &str) -> Card {
    let answer = prefix_chars(answer, MAX_ANSWER_CHARS).to_string();
    Card {
        path: rel.to_string(),
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
    vault: PathBuf,
    /// The model every vector came from; `None` means the index has no vectors
    /// (built while the model wasn't available) and matches on keywords alone.
    model: Option<String>,
    /// Note → modified time (ms) of the version its cards came from. Zero marks a
    /// note whose cards are waiting on the model, so the next build redoes it.
    mtimes: BTreeMap<String, u64>,
    cards: Vec<Card>,
}

#[derive(Default)]
struct Index {
    vault: Option<PathBuf>,
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
        vault: PathBuf,
        model: Option<String>,
        mtimes: BTreeMap<String, u64>,
        cards: Vec<Card>,
        vecs: VecStore,
    ) -> Self {
        let terms: Vec<Terms> = cards.iter().map(Terms::of).collect();
        let idf = idf_of(&terms);
        Index {
            vault: Some(vault),
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

/// Every `.md` note under `root`, as (vault-relative path, file, modified ms).
/// Skips dot-folders (`.obsidian`, `.git`), `Daily` and `Entertainment`, as the
/// original does, and never follows a link out of the vault.
fn walk(root: &Path) -> Vec<(String, PathBuf, u64)> {
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
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if name != "Daily" && name != "Entertainment" {
                    stack.push(path);
                }
                continue;
            }
            if !kind.is_file() || !name.to_lowercase().ends_with(".md") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > MAX_FILE_BYTES {
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
            out.push((rel.join("/"), path, mtime));
            if out.len() >= MAX_FILES {
                return out;
            }
        }
    }
    out
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
    /// The note on disk, for "Open note".
    pub path: String,
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
    pub notes: u32,
    pub building: bool,
    /// Progress of the build in flight: cards embedded / cards to embed.
    pub embedded: u32,
    pub to_embed: u32,
    pub embed_model: String,
    /// The index has vectors (else it matches on keywords alone).
    pub semantic: bool,
    /// Cards waiting for the model, matched on keywords until it's back.
    pub pending: u32,
    pub vault: Option<String>,
    pub error: Option<String>,
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
    embedded: Arc<AtomicUsize>,
    to_embed: Arc<AtomicUsize>,
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
            embedded: Arc::default(),
            to_embed: Arc::default(),
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
        IndexerStatus {
            cards: idx.cards.len() as u32,
            notes: idx.mtimes.len() as u32,
            building: self.building.load(Ordering::Acquire),
            embedded: self.embedded.load(Ordering::Relaxed) as u32,
            to_embed: self.to_embed.load(Ordering::Relaxed) as u32,
            embed_model: embed_model(),
            semantic: idx.model.is_some(),
            pending: idx.pending() as u32,
            vault: idx.vault.as_ref().map(|v| v.to_string_lossy().into_owned()),
            error: self.error.lock().clone(),
        }
    }

    /// Bring the index up to date with the vault on a thread of its own. A build
    /// already running makes this a no-op.
    pub fn start_build(&self, vault: Option<PathBuf>) {
        if self.building.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        let spawned = std::thread::Builder::new()
            .name("flux-indexer".into())
            .spawn(move || {
                let result = this.build(vault);
                *this.error.lock() = result.err();
                this.building.store(false, Ordering::Release);
            });
        if spawned.is_err() {
            self.building.store(false, Ordering::Release);
        }
    }

    fn build(&self, vault: Option<PathBuf>) -> Result<(), String> {
        self.hydrate();
        let root = vault.ok_or(
            "No Onyx vault found. Set its folder in the Notebook (Onyx source), or create ~/OnyxVault.",
        )?;
        let files = walk(&root);
        let model = embed_model();
        let available = flux_agent::ollama::has_model(&model);

        // Unchanged notes keep their cards and vectors, as long as the vectors
        // came from this model.
        let (kept_cards, kept_vecs, kept_paths, had_vectors, unchanged) = {
            let old = self.index.read();
            let same_vault = old.vault.as_deref() == Some(root.as_path());
            let had_vectors = same_vault && old.model.as_deref() == Some(model.as_str());
            // Without vectors to keep, only an index that also has none (and
            // still none to make) can keep its cards as they are.
            let reuse = same_vault && (had_vectors || (old.model.is_none() && !available));
            let fresh: HashMap<&str, u64> =
                files.iter().map(|(r, _, m)| (r.as_str(), *m)).collect();
            let keep_file = |p: &str| {
                reuse
                    && old
                        .mtimes
                        .get(p)
                        .is_some_and(|&m| m != 0 && fresh.get(p) == Some(&m))
            };
            let keep: Vec<bool> = old.cards.iter().map(|c| keep_file(&c.path)).collect();
            let kept_cards: Vec<Card> = old
                .cards
                .iter()
                .zip(&keep)
                .filter(|(_, k)| **k)
                .map(|(c, _)| c.clone())
                .collect();
            let mut kept_vecs = old.vecs.clone();
            if had_vectors {
                kept_vecs.retain(|i| keep[i]);
            } else {
                kept_vecs.clear();
            }
            let kept_paths: HashSet<String> = files
                .iter()
                .filter(|(r, _, _)| keep_file(r))
                .map(|(r, _, _)| r.clone())
                .collect();
            let unchanged = reuse
                && kept_paths.len() == files.len()
                && old.mtimes.len() == files.len()
                && (had_vectors || !available);
            (kept_cards, kept_vecs, kept_paths, had_vectors, unchanged)
        };
        if unchanged {
            return Ok(());
        }

        let mut fresh_cards: Vec<Card> = Vec::new();
        for (rel, path, _) in &files {
            if kept_paths.contains(rel) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(path) {
                fresh_cards.extend(parse_note(&text, rel));
            }
        }

        // Vectors for the new cards. A model that fails partway leaves zero rows
        // (they match on keywords) and marks their notes for the next build.
        let mut vecs = kept_vecs;
        let mut keyed: Option<String> = (available || had_vectors).then(|| model.clone());
        let mut pending: HashSet<String> = HashSet::new();
        if keyed.is_some() {
            self.embedded.store(0, Ordering::Relaxed);
            self.to_embed.store(fresh_cards.len(), Ordering::Relaxed);
            let mut failed = !available;
            for chunk in fresh_cards.chunks(EMBED_BATCH) {
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
                        if vecs.is_empty() {
                            // Nothing to size a zero row by: fall back to keywords
                            // for the whole index, and embed it all next time.
                            keyed = None;
                            break;
                        }
                        let zero = vec![0f32; vecs.dim()];
                        for c in chunk {
                            vecs.push(&zero);
                            pending.insert(c.path.clone());
                        }
                    }
                }
                self.embedded.fetch_add(chunk.len(), Ordering::Relaxed);
            }
        }
        if keyed.is_none() {
            vecs.clear();
        }

        let mtimes: BTreeMap<String, u64> = files
            .iter()
            .map(|(r, _, m)| (r.clone(), if pending.contains(r) { 0 } else { *m }))
            .collect();
        let mut cards = kept_cards;
        cards.extend(fresh_cards);
        let idx = Index::from_parts(root, keyed, mtimes, cards, vecs);
        if let Some(dir) = &self.dir {
            save(dir, &idx)?;
        }
        *self.index.write() = idx;
        if !pending.is_empty() {
            return Err(format!(
                "{model} stopped answering partway; {} notes match on keywords until the next index",
                pending.len()
            ));
        }
        Ok(())
    }

    pub fn search(&self, query: &str, k: usize) -> IndexerResults {
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
        let qq = qvec
            .filter(|v| idx.vecs.len() == idx.cards.len() && v.len() == idx.vecs.dim())
            .map(|v| quantize_query(&v));
        let sem: Vec<f32> = match &qq {
            Some((qr, qs)) => semantic(
                idx.vecs
                    .rows()
                    .map(|(row, scale)| score(row, scale, qr, *qs))
                    .collect(),
            ),
            None => vec![0.0; idx.cards.len()],
        };
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

        let root = idx.vault.clone().unwrap_or_default();
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
                    path: root.join(&c.path).to_string_lossy().into_owned(),
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
    let saved: Saved = serde_json::from_str(&json).ok()?;
    if saved.format != FORMAT {
        return None;
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
        saved.vault,
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
        vault: idx.vault.clone().unwrap_or_default(),
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

fn vault(kb: &crate::kb::KbStore) -> Option<PathBuf> {
    crate::kb::onyx_vault(kb.source_location("onyx").as_deref())
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
        FIRST.call_once(|| state.start_build(vault(&kb)));
        state.status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Re-read changed notes (and embed them) in the background.
#[tauri::command]
pub async fn indexer_reindex(
    state: State<'_, IndexerState>,
    kb: State<'_, crate::kb::KbStore>,
) -> Result<IndexerStatus, String> {
    let (state, kb) = ((*state).clone(), (*kb).clone());
    tauri::async_runtime::spawn_blocking(move || {
        state.start_build(vault(&kb));
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
) -> Result<IndexerResults, String> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || state.search(&query, k.unwrap_or(5) as usize))
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
        let cards = parse_note(note, "00 - Machine Learning/Neural nets.md");
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
        let cards = parse_note(note, "10 - Interview prep/Prep.md");
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
            Index::from_parts("/v".into(), None, mtimes, cards, VecStore::default());
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
        let r = state.search("walk me through PlantCLEF", 3);
        assert!(!r.semantic, "no vectors: keywords only");
        assert_eq!(r.matches[0].question, "PlantCLEF walkthrough");
        let r = state.search("model", 3);
        assert_eq!(
            r.matches[0].question, "Model notes",
            "a question hit beats an answer hit"
        );
        assert!(state.search("   ", 3).matches.is_empty());
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
        let idx = Index::from_parts("/v".into(), Some("m".into()), mtimes, cards.clone(), vecs);
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
}
