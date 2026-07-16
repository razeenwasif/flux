//! Guard: every command the shell `invoke()`s must be registered in a
//! `generate_handler!`.
//!
//! A frontend `invoke("foo")` for a `foo` that isn't in any handler is rejected
//! at runtime with "command foo not found" — and callers that `.catch()` (or
//! `void` the promise) swallow it, so the action silently does nothing. Same
//! family as the fluxtab/event drift guards, on the primary command surface.
//!
//! This asserts one direction — invoked ⊆ registered — because that's the
//! runtime-breaking one. The reverse (a registered command nothing invokes)
//! is merely dead code and is often a false positive (commands driven from the
//! CLI, ⌘K, or not-yet-wired UI), so it's intentionally not enforced.
//!
//! Scope: shell invokes (`apps/shell/src`) plus every `plugin:fluxtab|cmd`
//! literal in the injected page scripts (`crates/flux-core/assets`) — those are
//! reduced to `cmd` and checked against the (combined) handler set; the ACL side
//! is covered by `fluxtab_acl.rs`. (Not covered: an asset that hides the command
//! name behind a wrapper, e.g. passwords.js's `call("cmd")` → `plugin:fluxtab|`
//! — no literal to match. Those names are short-lived and caught in testing.)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn collect(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    const SKIP: &[&str] = &["target", "node_modules", "dist", "mock"];
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if p.is_dir() {
            if !SKIP.iter().any(|s| *s == name) {
                collect(&p, exts, out);
            }
        } else if p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| exts.contains(&e))
        {
            out.push(p);
        }
    }
}

fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Command idents from every `generate_handler![ … ]` block (app + plugin),
/// reduced to the final path segment.
fn registered_commands(lib_rs: &str) -> BTreeSet<String> {
    let src = strip_line_comments(lib_rs);
    let mut out = BTreeSet::new();
    let marker = "generate_handler![";
    let mut idx = 0;
    while let Some(pos) = src[idx..].find(marker) {
        let start = idx + pos + marker.len();
        let body = &src[start..];
        let end = body.find(']').expect("unterminated generate_handler!");
        for tok in body[..end].split(',') {
            let tok = tok.trim();
            if tok.is_empty() {
                continue;
            }
            let name = tok.rsplit("::").next().unwrap().trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                out.insert(name.to_string());
            }
        }
        idx = start + end;
    }
    out
}

/// Command names the shell invokes: the first string arg of each `invoke(` /
/// `invoke<T>(`, with any `plugin:…|` prefix stripped to the bare command.
fn invoked_commands(files: &[PathBuf]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for f in files {
        let Ok(src) = std::fs::read_to_string(f) else {
            continue;
        };
        let mut search = 0;
        while let Some(pos) = src[search..].find("invoke") {
            let at = search + pos;
            let after = &src[at + "invoke".len()..];
            search = at + "invoke".len();
            // Must be a call: `invoke(` or `invoke<…>(`, not the word "invoked".
            let head = after.trim_start();
            if !(head.starts_with('(') || head.starts_with('<')) {
                continue;
            }
            // First string literal after the opening paren is the command name.
            let Some(q1) = after.find('"') else { continue };
            let rest = &after[q1 + 1..];
            let Some(q2) = rest.find('"') else { continue };
            let raw = &rest[..q2];
            // Reject if a closing paren precedes the quote (no string arg here).
            if after[..q1].contains(')') {
                continue;
            }
            let cmd = raw.rsplit('|').next().unwrap(); // strip plugin:… prefix
            if !cmd.is_empty()
                && cmd
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                out.insert(cmd.to_string());
            }
        }
    }
    out
}

/// Bare command names from `plugin:fluxtab|<cmd>` literals in `files` — the
/// robust way to check the injected assets (which call via `inv`/`call`, not
/// `invoke`).
fn fluxtab_literals(files: &[PathBuf]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let marker = "plugin:fluxtab|";
    for f in files {
        let Ok(src) = std::fs::read_to_string(f) else {
            continue;
        };
        let mut search = 0;
        while let Some(pos) = src[search..].find(marker) {
            let start = search + pos + marker.len();
            let after = &src[start..];
            let end = after
                .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
                .unwrap_or(after.len());
            if end > 0 {
                out.insert(after[..end].to_string());
            }
            search = start + end.max(1);
        }
    }
    out
}

#[test]
fn every_invoked_command_is_registered() {
    let root = workspace_root();
    let lib_rs =
        std::fs::read_to_string(root.join("crates/flux-core/src/lib.rs")).expect("read lib.rs");

    let mut shell = Vec::new();
    collect(&root.join("apps/shell/src"), &["ts", "tsx"], &mut shell);
    assert!(
        !shell.is_empty(),
        "no shell sources found under {}",
        root.display()
    );
    let mut assets = Vec::new();
    collect(&root.join("crates/flux-core/assets"), &["js"], &mut assets);

    let registered = registered_commands(&lib_rs);
    let mut invoked = invoked_commands(&shell);
    invoked.extend(fluxtab_literals(&shell)); // shell plugin:… calls too
    invoked.extend(fluxtab_literals(&assets)); // injected page scripts
    assert!(
        registered.len() > 100,
        "handler scan looks wrong (only {} commands)",
        registered.len()
    );

    let unregistered: Vec<&String> = invoked.difference(&registered).collect();
    assert!(
        unregistered.is_empty(),
        "the shell invokes commands that are in no generate_handler! (→ runtime \"command not found\", \
         swallowed by the caller): {unregistered:?}",
    );
}
