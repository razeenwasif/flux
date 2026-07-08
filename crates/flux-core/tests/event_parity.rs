//! Guard against silent Tauri-event drift.
//!
//! Backend→frontend signals are `flux://…` events: Rust `app.emit(…)` /
//! `emit_to(…)`, the shell `listen("flux://…")`. If the two names disagree —
//! a rename on one side, a typo, a removed emitter — nothing errors: the
//! listener just never fires (or the emit falls on deaf ears). That's how the
//! feature quietly half-works. This test extracts both sets from source and
//! asserts they match, so a rename has to touch both sides.
//!
//! Scope note: page→Rust traffic uses the `plugin:fluxtab|…` invoke bridge (see
//! `fluxtab_acl.rs`), and streaming uses `Channel<T>` args — neither is a
//! `flux://` event, so both are correctly out of scope here. Injected page
//! scripts don't `listen()`; the shell is the only listener site.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Events emitted intentionally with no shell listener (add with a reason).
const EMIT_ONLY_ALLOW: &[&str] = &[];
/// Events the shell listens for with no Rust emitter (add with a reason).
const LISTEN_ONLY_ALLOW: &[&str] = &[];

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <root>/crates/flux-core
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
}

/// Collect files under `dir` with one of `exts`, skipping build/output and
/// test/example trees (which mention event names in prose + fixtures).
fn collect(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    const SKIP: &[&str] = &["target", "tests", "benches", "examples", "node_modules", "dist", "mock"];
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if p.is_dir() {
            if !SKIP.iter().any(|s| *s == name) {
                collect(&p, exts, out);
            }
        } else if p.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e)) {
            out.push(p);
        }
    }
}

/// Every `flux://<name>` token on `line`.
fn events_on(line: &str, out: &mut BTreeSet<String>) {
    let mut rest = line;
    while let Some(p) = rest.find("flux://") {
        let after = &rest[p + "flux://".len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
            .unwrap_or(after.len());
        if end > 0 {
            out.insert(format!("flux://{}", &after[..end]));
        }
        rest = &after[end..];
    }
}

/// Events appearing on lines that carry one of `call_tokens` — a precise call
/// marker (`.emit(`, `listen(`, …) rather than prose, so a doc comment that
/// merely names an event isn't mistaken for a real emit/listen. (We can't strip
/// `//` comments naively — `flux://` itself contains `//`.)
fn events_in(files: &[PathBuf], call_tokens: &[&str]) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    for f in files {
        let Ok(src) = std::fs::read_to_string(f) else { continue };
        for line in src.lines() {
            if call_tokens.iter().any(|t| line.contains(t)) {
                events_on(line, &mut set);
            }
        }
    }
    set
}

#[test]
fn rust_emits_and_shell_listens_agree() {
    let root = workspace_root();

    let mut rust = Vec::new();
    collect(&root.join("crates"), &["rs"], &mut rust);
    let mut shell = Vec::new();
    collect(&root.join("apps/shell/src"), &["ts", "tsx"], &mut shell);
    assert!(!rust.is_empty() && !shell.is_empty(), "source scan found no files (root: {})", root.display());

    let emits = events_in(&rust, &[".emit(", ".emit_to(", ".emit_filter("]);
    let listens = events_in(&shell, &["listen(", "listen<"]);

    let allow_emit: BTreeSet<String> = EMIT_ONLY_ALLOW.iter().map(|s| s.to_string()).collect();
    let allow_listen: BTreeSet<String> = LISTEN_ONLY_ALLOW.iter().map(|s| s.to_string()).collect();

    // Emitted but nothing listens (minus the allowlist) → dead emit.
    let emit_only: Vec<&String> = emits.difference(&listens).filter(|e| !allow_emit.contains(*e)).collect();
    // Listened but nothing emits (minus the allowlist) → dead listener: the
    // handler silently never fires.
    let listen_only: Vec<&String> = listens.difference(&emits).filter(|e| !allow_listen.contains(*e)).collect();

    assert!(
        emit_only.is_empty() && listen_only.is_empty(),
        "flux:// event drift — these signals are one-sided and silently do nothing:\n  \
         emitted in Rust but no shell listener (dead emit): {emit_only:?}\n  \
         listened in the shell but no Rust emitter (dead listener): {listen_only:?}\n\
         Fix both sides, or add to EMIT_ONLY_ALLOW / LISTEN_ONLY_ALLOW with a reason.",
    );
}
