//! Semantic shell-history search (BACKLOG #122) — find a past command by meaning
//! ("that ffmpeg command from last week"), not substring.
//!
//! Reads the user's real shell history (`~/.bash_history`, `~/.zsh_history`) via
//! the same exec bridge the embedded terminal uses (so it works across the WSL
//! boundary on Windows), embeds each unique command with the local hashing
//! embedder (`flux-embed` — instant, fully on-device, no model needed), and ranks
//! by cosine similarity to the query. A substring boost keeps literal lookups
//! exact while the embedding handles fuzzier matches. The corpus lives in memory
//! and is rebuilt on demand (reindex is cheap — a file read + hashing).

use std::collections::HashSet;

use parking_lot::RwLock;
use serde::Serialize;

use flux_embed::EMBED_DIM;

/// Cap the corpus to the most recent unique commands (keeps ranking fast + RAM low).
const MAX_ENTRIES: usize = 5000;

struct Entry {
    cmd: String,
    ts: Option<i64>,
    source: &'static str,
    vec: [f32; EMBED_DIM],
}

/// One ranked match returned to the UI.
#[derive(Serialize, Clone, specta::Type)]
pub struct ShellHistHit {
    pub command: String,
    /// Cosine similarity (+ substring boost), higher is closer.
    pub score: f32,
    /// `"bash"` or `"zsh"`.
    pub source: String,
    /// Unix seconds, when the history file records it (zsh, or bash with
    /// `HISTTIMEFORMAT`); `null` otherwise.
    pub ts: Option<i64>,
}

#[derive(Default)]
pub struct ShellHistStore {
    entries: RwLock<Vec<Entry>>,
}

impl ShellHistStore {
    fn replace(&self, entries: Vec<Entry>) {
        *self.entries.write() = entries;
    }

    fn len(&self) -> usize {
        self.entries.read().len()
    }

    fn search(&self, query: &str, limit: usize) -> Vec<ShellHistHit> {
        let entries = self.entries.read();
        let q = query.trim();
        if q.is_empty() {
            // No query → most recent commands (entries are newest-first).
            return entries.iter().take(limit).map(|e| e.hit(1.0)).collect();
        }
        let qv = flux_embed::embed(q);
        let ql = q.to_lowercase();
        // Hybrid score: embedding cosine (fuzzy) + keyword boosts (reliable). The
        // hashing embedder is weak on pure synonyms, so token overlap carries most
        // literal lookups while the embedding orders the rest.
        let q_tokens: Vec<&str> = ql.split_whitespace().filter(|t| t.len() >= 2).collect();
        let mut scored: Vec<(f32, &Entry)> = entries
            .iter()
            .map(|e| {
                let cl = e.cmd.to_lowercase();
                let mut boost = 0.0;
                if cl.contains(&ql) {
                    boost += 0.6; // whole query appears verbatim
                }
                for t in &q_tokens {
                    if cl.contains(t) {
                        boost += 0.25; // each query word present
                    }
                }
                (cosine(&qv, &e.vec) + boost, e)
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(limit)
            .filter(|(s, _)| *s > 0.02)
            .map(|(s, e)| e.hit(s))
            .collect()
    }
}

impl Entry {
    fn hit(&self, score: f32) -> ShellHistHit {
        ShellHistHit {
            command: self.cmd.clone(),
            score,
            source: self.source.to_string(),
            ts: self.ts,
        }
    }
}

/// Dot product — `flux_embed` vectors are L2-normalized, so this is cosine.
fn cosine(a: &[f32; EMBED_DIM], b: &[f32; EMBED_DIM]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Read the raw history files through the terminal's shell (handles WSL on Windows).
fn read_history_raw() -> String {
    let script = "echo '@@FLUXBASH@@'; cat \"$HOME/.bash_history\" 2>/dev/null; \
                  echo '@@FLUXZSH@@'; cat \"$HOME/.zsh_history\" 2>/dev/null; \
                  echo '@@FLUXEND@@'";
    let mut c = crate::exec::shell_command(script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
    }
    match c.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Parse bash + zsh history into `(command, ts, source)` in file order (oldest first).
fn parse_history(raw: &str) -> Vec<(String, Option<i64>, &'static str)> {
    let mut out = Vec::new();
    let mut section = "";
    let mut pending_ts: Option<i64> = None;
    for line in raw.lines() {
        match line.trim_end() {
            "@@FLUXBASH@@" => {
                section = "bash";
                pending_ts = None;
                continue;
            }
            "@@FLUXZSH@@" => {
                section = "zsh";
                pending_ts = None;
                continue;
            }
            "@@FLUXEND@@" => break,
            _ => {}
        }
        if section == "bash" {
            // `#<epoch>` timestamp line (only when HISTTIMEFORMAT is set) precedes its command.
            if let Some(rest) = line.strip_prefix('#') {
                if let Ok(ts) = rest.trim().parse::<i64>() {
                    pending_ts = Some(ts);
                    continue;
                }
            }
            let cmd = line.trim();
            if cmd.len() >= 2 {
                out.push((cmd.to_string(), pending_ts.take(), "bash"));
            } else {
                pending_ts = None;
            }
        } else if section == "zsh" {
            // Extended history: `: <start>:<elapsed>;<command>`.
            if let Some(rest) = line.strip_prefix(": ") {
                if let Some((meta, cmd)) = rest.split_once(';') {
                    let ts = meta
                        .split(':')
                        .next()
                        .and_then(|s| s.trim().parse::<i64>().ok());
                    let cmd = cmd.trim();
                    if cmd.len() >= 2 {
                        out.push((cmd.to_string(), ts, "zsh"));
                    }
                    continue;
                }
            }
            let cmd = line.trim();
            if cmd.len() >= 2 {
                out.push((cmd.to_string(), None, "zsh"));
            }
        }
    }
    out
}

/// Read + parse + dedup (most-recent wins) + embed. Blocking — call off-thread.
fn build_corpus() -> Vec<Entry> {
    let raw = read_history_raw();
    let parsed = parse_history(&raw);
    // Dedup keeping the most recent occurrence of each command (iterate newest→oldest).
    let mut seen = HashSet::new();
    let mut deduped: Vec<(String, Option<i64>, &'static str)> = Vec::new();
    for (cmd, ts, src) in parsed.into_iter().rev() {
        if seen.insert(cmd.clone()) {
            deduped.push((cmd, ts, src));
            if deduped.len() >= MAX_ENTRIES {
                break;
            }
        }
    }
    // `deduped` is newest-first; embed each.
    deduped
        .into_iter()
        .map(|(cmd, ts, source)| {
            let vec = flux_embed::embed(&cmd);
            Entry {
                cmd,
                ts,
                source,
                vec,
            }
        })
        .collect()
}

/// Rebuild the in-memory corpus from the current history files. Returns the count.
#[tauri::command]
pub async fn shell_history_reindex(
    store: tauri::State<'_, ShellHistStore>,
) -> Result<usize, String> {
    let entries = tauri::async_runtime::spawn_blocking(build_corpus)
        .await
        .map_err(|e| e.to_string())?;
    let n = entries.len();
    store.replace(entries);
    Ok(n)
}

/// Semantically rank history against `query` (empty → most recent). Auto-reindexes
/// the first time if the corpus is still empty.
#[tauri::command]
pub async fn shell_history_search(
    store: tauri::State<'_, ShellHistStore>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ShellHistHit>, String> {
    if store.len() == 0 {
        let entries = tauri::async_runtime::spawn_blocking(build_corpus)
            .await
            .map_err(|e| e.to_string())?;
        store.replace(entries);
    }
    Ok(store.search(&query, limit.unwrap_or(40).min(100)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bash_and_zsh_with_timestamps() {
        let raw = "@@FLUXBASH@@\n#1700000000\ngit status\nls -la\n@@FLUXZSH@@\n: 1700000500:0;ffmpeg -i a.mp4 b.webm\necho hi\n@@FLUXEND@@";
        let p = parse_history(raw);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0], ("git status".into(), Some(1700000000), "bash"));
        assert_eq!(p[1], ("ls -la".into(), None, "bash"));
        assert_eq!(
            p[2],
            ("ffmpeg -i a.mp4 b.webm".into(), Some(1700000500), "zsh")
        );
        assert_eq!(p[3], ("echo hi".into(), None, "zsh"));
    }

    #[test]
    fn dedup_and_rank_finds_command() {
        let raw = "@@FLUXBASH@@\nls\nffmpeg -i in.mp4 -vcodec libx264 out.mp4\ngit commit -m x\nls\n@@FLUXZSH@@\n@@FLUXEND@@";
        let entries = {
            // build_corpus reads files; here exercise parse+dedup+embed inline instead.
            let parsed = parse_history(raw);
            let mut seen = HashSet::new();
            let mut deduped = Vec::new();
            for (cmd, ts, src) in parsed.into_iter().rev() {
                if seen.insert(cmd.clone()) {
                    deduped.push((cmd, ts, src));
                }
            }
            deduped
                .into_iter()
                .map(|(cmd, ts, source)| Entry {
                    vec: flux_embed::embed(&cmd),
                    cmd,
                    ts,
                    source,
                })
                .collect::<Vec<_>>()
        };
        // "ls" appeared twice → deduped to one.
        assert_eq!(entries.iter().filter(|e| e.cmd == "ls").count(), 1);
        let store = ShellHistStore::default();
        store.replace(entries);
        let hits = store.search("ffmpeg video convert", 5);
        assert_eq!(hits[0].command, "ffmpeg -i in.mp4 -vcodec libx264 out.mp4");
    }
}
