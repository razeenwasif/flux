//! Deterministic entity extraction (arXiv / DOI / repo / dataset) — see mod docs.

use super::store::{Entity, EntityKind};

// ─── Entity extraction (payoff layer) ─────────────────────────────────────────
// Deterministic scanners — no regex crate, no LLM. False positives here become
// wrong "cites" edges in the graph, so each pattern is anchored and normalized.

/// Cap per visit so a references page can't spray hundreds of entities.
const MAX_ENTITIES: usize = 12;

/// Extract entities from a page. `url` matches are marked `primary` (the page
/// *is* the thing); `text` matches are mentions. Primaries win dedup and sort
/// first; the result is capped at [`MAX_ENTITIES`].
pub fn extract_entities(url: &str, text: &str) -> Vec<Entity> {
    let mut out: Vec<Entity> = Vec::new();
    scan_haystack(url, true, &mut out);
    scan_haystack(text, false, &mut out);
    // Primaries first (stable), then cap.
    out.sort_by_key(|e| !e.primary);
    out.truncate(MAX_ENTITIES);
    out
}

fn push_entity(out: &mut Vec<Entity>, kind: EntityKind, value: String, primary: bool) {
    if value.is_empty() {
        return;
    }
    if let Some(e) = out.iter_mut().find(|e| e.kind == kind && e.value == value) {
        e.primary |= primary; // primary wins on dedup
        return;
    }
    out.push(Entity {
        kind,
        value,
        primary,
    });
}

fn scan_haystack(hay: &str, primary: bool, out: &mut Vec<Entity>) {
    let b = hay.as_bytes();
    let lower = hay.to_ascii_lowercase();

    // arXiv ids: after "arxiv.org/abs/", "arxiv.org/pdf/", or an "arxiv:" prefix.
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/", "arxiv:"] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(marker) {
            let at = from + p + marker.len();
            if let Some((id, _)) = scan_arxiv_id(b, at) {
                push_entity(out, EntityKind::Arxiv, id, primary);
            }
            from = at;
        }
    }

    // DOIs: "10.<4-9 digits>/<suffix>" — the registered-prefix shape.
    let mut from = 0;
    while let Some(p) = lower[from..].find("10.") {
        let at = from + p;
        // Word boundary on the left (start, or a non-alphanumeric).
        let bounded = at == 0 || !b[at - 1].is_ascii_alphanumeric();
        if bounded {
            if let Some((doi, end)) = scan_doi(&lower, at) {
                push_entity(out, EntityKind::Doi, doi, primary);
                from = end;
                continue;
            }
        }
        from = at + 3;
    }

    // GitHub repos: "github.com/<owner>/<name>".
    let mut from = 0;
    while let Some(p) = lower[from..].find("github.com/") {
        let at = from + p + "github.com/".len();
        if let Some((repo, end)) = scan_repo(&lower, at) {
            push_entity(out, EntityKind::Repo, repo, primary);
            from = end;
        } else {
            from = at;
        }
    }

    // Datasets: Hugging Face + Kaggle.
    for (marker, prefix) in [
        ("huggingface.co/datasets/", "hf:"),
        ("kaggle.com/datasets/", "kaggle:"),
    ] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(marker) {
            let at = from + p + marker.len();
            if let Some((path, end)) = scan_owner_name(&lower, at) {
                push_entity(out, EntityKind::Dataset, format!("{prefix}{path}"), primary);
                from = end;
            } else {
                from = at;
            }
        }
    }
}

/// "dddd.dddd[d]" (+ optional "vN", stripped) starting at `i`.
fn scan_arxiv_id(b: &[u8], i: usize) -> Option<(String, usize)> {
    let n = b.len();
    let mut j = i;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j - i != 4 || j >= n || b[j] != b'.' {
        return None;
    }
    j += 1;
    let s2 = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if !(4..=5).contains(&(j - s2)) {
        return None;
    }
    let id = std::str::from_utf8(&b[i..j]).ok()?.to_string();
    let mut end = j;
    if end < n && (b[end] | 0x20) == b'v' {
        let mut m = end + 1;
        while m < n && b[m].is_ascii_digit() {
            m += 1;
        }
        if m > end + 1 {
            end = m;
        }
    }
    Some((id, end))
}

/// A DOI starting at `i` in lowercased `hay` ("10." already sighted there).
/// Suffix chars per the Crossref recommendation; trailing punctuation trimmed,
/// with `)` kept only when balanced inside the suffix (DOIs like
/// `10.1016/s0140-6736(20)30183-5` are real).
fn scan_doi(hay: &str, i: usize) -> Option<(String, usize)> {
    let b = hay.as_bytes();
    let n = b.len();
    let mut j = i + 3;
    let reg_start = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if !(4..=9).contains(&(j - reg_start)) || j >= n || b[j] != b'/' {
        return None;
    }
    j += 1;
    let suf_start = j;
    while j < n {
        let c = b[j];
        let ok = c.is_ascii_alphanumeric()
            || matches!(
                c,
                b'-' | b'.' | b'_' | b';' | b'(' | b')' | b'/' | b':' | b'#'
            );
        if !ok {
            break;
        }
        j += 1;
    }
    // Trim trailing punctuation that's almost certainly sentence/markup, not DOI.
    let mut end = j;
    loop {
        if end <= suf_start {
            break;
        }
        let c = b[end - 1];
        let trim = matches!(c, b'.' | b',' | b';' | b':')
            || (c == b')' && {
                let suffix = &hay[suf_start..end];
                suffix.matches('(').count() < suffix.matches(')').count()
            });
        if trim {
            end -= 1;
        } else {
            break;
        }
    }
    if end - suf_start < 2 {
        return None;
    }
    Some((hay[i..end].to_string(), end))
}

/// "<owner>/<name>" starting at `i` (both segments non-empty, url-ish charset),
/// skipping GitHub's non-repo first segments; strips a trailing ".git".
fn scan_repo(hay: &str, i: usize) -> Option<(String, usize)> {
    const NOT_REPOS: &[&str] = &[
        "about",
        "apps",
        "collections",
        "contact",
        "events",
        "explore",
        "features",
        "issues",
        "login",
        "marketplace",
        "new",
        "notifications",
        "orgs",
        "pricing",
        "pulls",
        "search",
        "security",
        "settings",
        "signup",
        "site",
        "sponsors",
        "topics",
        "trending",
    ];
    let (path, end) = scan_owner_name(hay, i)?;
    let owner = path.split('/').next().unwrap_or("");
    if NOT_REPOS.contains(&owner) {
        return None;
    }
    let path = path.strip_suffix(".git").unwrap_or(&path).to_string();
    Some((path, end))
}

/// Two url-path segments "<a>/<b>" starting at `i` in lowercased `hay`.
fn scan_owner_name(hay: &str, i: usize) -> Option<(String, usize)> {
    let b = hay.as_bytes();
    let n = b.len();
    let seg = |mut j: usize| {
        let s = j;
        while j < n && (b[j].is_ascii_alphanumeric() || matches!(b[j], b'-' | b'_' | b'.')) {
            j += 1;
        }
        (s, j)
    };
    let (s1, e1) = seg(i);
    if e1 == s1 || e1 >= n || b[e1] != b'/' {
        return None;
    }
    let (s2, e2) = seg(e1 + 1);
    if e2 == s2 {
        return None;
    }
    // Trim a trailing '.' (sentence period after a bare "owner/name" mention).
    let mut e2t = e2;
    while e2t > s2 && b[e2t - 1] == b'.' {
        e2t -= 1;
    }
    if e2t == s2 {
        return None;
    }
    Some((format!("{}/{}", &hay[s1..e1], &hay[s2..e2t]), e2))
}

#[cfg(test)]
mod tests {
    use super::super::store::{EdgeKind, ForgetScope, TraceStore};
    use super::*;
    #[test]
    fn extracts_and_normalizes_entities() {
        // arXiv: URL is primary, version stripped; text mention is not primary.
        let e = extract_entities(
            "https://arxiv.org/abs/2511.19477v2",
            "see arXiv:1706.03762 for the transformer",
        );
        assert!(e
            .iter()
            .any(|x| x.kind == EntityKind::Arxiv && x.value == "2511.19477" && x.primary));
        assert!(e
            .iter()
            .any(|x| x.kind == EntityKind::Arxiv && x.value == "1706.03762" && !x.primary));

        // DOI: publisher-URL primary; text DOI with trailing period trimmed but
        // balanced parens kept (real Lancet-style DOI).
        let e = extract_entities(
            "https://link.springer.com/article/10.1007/s11229-023-04281-5",
            "as shown in 10.1016/s0140-6736(20)30183-5.",
        );
        assert!(e.iter().any(|x| x.kind == EntityKind::Doi
            && x.value == "10.1007/s11229-023-04281-5"
            && x.primary));
        assert!(e.iter().any(|x| x.kind == EntityKind::Doi
            && x.value == "10.1016/s0140-6736(20)30183-5"
            && !x.primary));

        // Repo: sub-page URL still yields owner/name, lowercased, .git stripped;
        // GitHub's non-repo sections are skipped.
        let e = extract_entities(
            "https://GitHub.com/Razeen/Flux/issues/5",
            "clone github.com/foo/bar.git — not github.com/features/copilot",
        );
        assert!(e
            .iter()
            .any(|x| x.kind == EntityKind::Repo && x.value == "razeen/flux" && x.primary));
        assert!(e
            .iter()
            .any(|x| x.kind == EntityKind::Repo && x.value == "foo/bar" && !x.primary));
        assert!(!e.iter().any(|x| x.value.starts_with("features/")));

        // Datasets + dedup (primary wins) + no junk from plain text.
        let e = extract_entities(
            "https://huggingface.co/datasets/allenai/c4",
            "the C4 corpus (huggingface.co/datasets/allenai/c4) at version 10.5",
        );
        let ds: Vec<_> = e.iter().filter(|x| x.kind == EntityKind::Dataset).collect();
        assert_eq!(ds.len(), 1, "same dataset deduped");
        assert!(ds[0].primary, "primary wins the dedup");
        assert!(
            !e.iter().any(|x| x.kind == EntityKind::Doi),
            "\"10.5\" is not a DOI"
        );
        assert!(extract_entities("https://example.com/", "nothing to see").is_empty());
    }

    #[test]
    fn entity_edges_cites_implements_and_same() {
        let s = TraceStore::default();
        // The paper page (primary arXiv via URL, at nav time).
        let paper = s
            .record(1, "https://arxiv.org/abs/2511.19477", "Paper", None, None)
            .unwrap();
        // A repo whose README mentions the paper → Implements repo→paper.
        let repo = s
            .record(2, "https://github.com/foo/bar", "Repo", None, None)
            .unwrap();
        s.set_entities(
            repo,
            extract_entities("https://github.com/foo/bar", "implements arXiv:2511.19477"),
        );
        s.derive_entity_edges(repo);
        // A blog post mentioning the paper → Cites blog→paper.
        let blog = s
            .record(3, "https://blog.example/post", "Blog", None, None)
            .unwrap();
        s.set_entities(
            blog,
            extract_entities(
                "https://blog.example/post",
                "great read: arxiv.org/abs/2511.19477",
            ),
        );
        s.derive_entity_edges(blog);

        let g = s.graph(None, None);
        assert!(g
            .edges
            .iter()
            .any(|e| e.kind == EdgeKind::Implements && e.from == repo && e.to == paper));
        assert!(g
            .edges
            .iter()
            .any(|e| e.kind == EdgeKind::Cites && e.from == blog && e.to == paper));
        // Blog and repo both *mention* the paper → Same between them.
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Same
            && ((e.from, e.to) == (repo, blog) || (e.from, e.to) == (blog, repo))));
        // Re-deriving is idempotent (both-direction dedup).
        let n = g.edges.len();
        s.derive_entity_edges(blog);
        assert_eq!(s.graph(None, None).edges.len(), n);
        // Forget the paper → its citation edges go with it.
        s.forget(&ForgetScope::Url {
            url: "https://arxiv.org/abs/2511.19477".into(),
        });
        let g = s.graph(None, None);
        assert!(!g
            .edges
            .iter()
            .any(|e| matches!(e.kind, EdgeKind::Cites | EdgeKind::Implements)));
    }
}
