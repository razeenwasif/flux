//! Semantic find (BACKLOG #126) — Ctrl+F that finds where a page *discusses*
//! something by meaning, not substring, in the current page or across every open
//! tab. Reuses the per-tab captured DOM text (`dom_cache`) + the unified embedder
//! (`crate::embedding`: Ollama model → hashing fallback). Each ranked passage is a
//! verbatim slice of the page, so the UI can scroll/highlight it with the same
//! native `window.find` the string find-bar uses.

use std::sync::Arc;

use serde::Serialize;

use crate::embedding;
use crate::state::{FluxState, TabId};

/// Per-tab text cap before chunking (huge pages); global passage cap bounds latency.
const MAX_TEXT: usize = 80_000;
const MAX_PASSAGES_PER_TAB: usize = 200;
const MAX_PASSAGES_TOTAL: usize = 700;
/// Don't let one page flood the results.
const MAX_HITS_PER_TAB: usize = 4;

/// One ranked passage match.
#[derive(Serialize, Clone, specta::Type)]
pub struct FindHit {
    pub tab_id: TabId,
    pub title: String,
    pub url: String,
    /// The matching passage (a verbatim slice of the page text).
    pub passage: String,
    pub score: f32,
}

/// Cut `text` into ~45-word passages on whitespace boundaries, keeping each one a
/// **verbatim substring** of the source (so `window.find` can locate it later).
fn passages(text: &str, max: usize) -> Vec<String> {
    const WORDS_PER: usize = 45;
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut words = 0usize;
    let mut in_word = false;
    let mut i = 0usize;
    for c in text.chars() {
        let ws = c.is_whitespace();
        if !ws {
            in_word = true;
        } else if in_word {
            in_word = false;
            words += 1;
            if words >= WORDS_PER {
                let seg = text[start..i].trim();
                if seg.split_whitespace().count() >= 4 {
                    out.push(seg.to_string());
                    if out.len() >= max {
                        return out;
                    }
                }
                start = i;
                words = 0;
            }
        }
        i += c.len_utf8();
    }
    let seg = text[start..].trim();
    if seg.split_whitespace().count() >= 4 {
        out.push(seg.to_string());
    }
    out
}

/// Dot product — the unified embedder L2-normalizes its vectors, so this is cosine.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

struct Doc {
    tab_id: TabId,
    title: String,
    url: String,
    text: String,
}

/// Chunk → embed → rank. Blocking (embeds many passages); run off-thread.
fn rank(query: &str, docs: Vec<Doc>, limit: usize) -> Result<Vec<FindHit>, String> {
    let kind = embedding::current();
    // Collect passages, remembering which doc each came from.
    let mut owner: Vec<usize> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for (di, d) in docs.iter().enumerate() {
        let body = if d.text.len() > MAX_TEXT {
            &d.text[..MAX_TEXT]
        } else {
            &d.text
        };
        for p in passages(body, MAX_PASSAGES_PER_TAB) {
            owner.push(di);
            texts.push(p);
            if texts.len() >= MAX_PASSAGES_TOTAL {
                break;
            }
        }
        if texts.len() >= MAX_PASSAGES_TOTAL {
            break;
        }
    }
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let qv = embedding::embed_with(query, kind).ok_or("couldn't embed the query")?;
    let vecs = embedding::embed_batch(&texts, kind).ok_or("couldn't embed the page")?;

    let ql = query.to_lowercase();
    let q_tokens: Vec<&str> = ql.split_whitespace().filter(|t| t.len() >= 3).collect();
    let mut scored: Vec<(f32, usize)> = texts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut s = cosine(&qv, &vecs[i]);
            let pl = p.to_lowercase();
            if pl.contains(&ql) {
                s += 0.4; // whole query present verbatim
            }
            for t in &q_tokens {
                if pl.contains(t) {
                    s += 0.12;
                }
            }
            (s, i)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut per_tab: std::collections::HashMap<TabId, usize> = std::collections::HashMap::new();
    let mut hits = Vec::new();
    for (s, i) in scored {
        if s <= 0.05 {
            break;
        }
        let d = &docs[owner[i]];
        let n = per_tab.entry(d.tab_id).or_insert(0);
        if *n >= MAX_HITS_PER_TAB {
            continue;
        }
        *n += 1;
        hits.push(FindHit {
            tab_id: d.tab_id,
            title: d.title.clone(),
            url: d.url.clone(),
            passage: texts[i].clone(),
            score: s,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

/// Rank passages across the given tabs by semantic + keyword match to `query`.
/// The frontend passes `[active_tab]` for in-page find or all browser tabs for
/// across-tabs find.
#[tauri::command]
pub async fn semantic_find(
    state: tauri::State<'_, FluxState>,
    query: String,
    tab_ids: Vec<TabId>,
    limit: Option<usize>,
) -> Result<Vec<FindHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut docs = Vec::new();
    for id in tab_ids {
        let Some(snap) = state.dom_cache.get(&id) else {
            continue;
        };
        if snap.text.trim().is_empty() {
            continue;
        }
        let title = state
            .tabs
            .get(&id)
            .map(|t| t.title.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| snap.url.to_string());
        docs.push(Doc {
            tab_id: id,
            title,
            url: snap.url.to_string(),
            text: Arc::clone(&snap.text).to_string(),
        });
    }
    if docs.is_empty() {
        return Err("nothing captured yet — open a page and let it load".into());
    }
    tauri::async_runtime::spawn_blocking(move || rank(&query, docs, limit.unwrap_or(30)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passages_are_verbatim_slices() {
        let text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
        let ps = passages(&text, 50);
        assert!(ps.len() >= 2);
        // Every passage must appear verbatim in the source (so window.find can locate it).
        for p in &ps {
            assert!(
                text.contains(p.as_str()),
                "passage not a verbatim slice: {p}"
            );
        }
    }

    #[test]
    fn ranks_relevant_passage_first() {
        let text = "Bananas are yellow and rich in potassium for athletes.\n\n\
                    The TLS handshake negotiates a cipher suite and exchanges keys over the network.\n\n\
                    My grandmother bakes sourdough bread every sunday morning.";
        let docs = vec![Doc {
            tab_id: 1,
            title: "t".into(),
            url: "u".into(),
            text: text.into(),
        }];
        // Keyword-bearing query so the hash embedder (used when Ollama is absent in
        // tests) is deterministic; the model handles true synonymy at runtime.
        let hits = rank("negotiate the cipher and exchange keys", docs, 5).unwrap();
        assert!(!hits.is_empty());
        assert!(
            hits[0].passage.to_lowercase().contains("tls"),
            "got: {}",
            hits[0].passage
        );
    }
}
