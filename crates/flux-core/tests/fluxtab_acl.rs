//! Guard against silent `fluxtab` command drift.
//!
//! A page (remote `tab-*` / `panel-*` / `peek-*` webview) reaches Rust only via
//! `plugin:fluxtab|cmd`. Tauri (webview/mod.rs) routes that **only** through the
//! fluxtab plugin's `generate_handler!` — there is no fallback to the app
//! handler — and gates it on the plugin ACL. So a page-callable command must be
//! in BOTH places:
//!
//!   * build.rs `InlinedPlugin::commands(&[…])` — the ACL. Missing here →
//!     the call is rejected "not allowed by ACL".
//!   * lib.rs fluxtab `generate_handler![…]` — the dispatch. Missing here →
//!     the call is rejected "command … not found".
//!
//! Either rejection surfaces as a rejected promise the injected scripts swallow
//! in `.catch()`, so the feature just silently does nothing — exactly how the
//! #61 password sentinel, `panel_badge`, `macro_record_step`, and `peek_open`
//! all shipped broken. This test keeps the two lists identical so that class of
//! bug can't ship again: fixing it means updating BOTH sides (or, for a
//! chrome-only command like `peek_open`, keeping it out of the fluxtab handler
//! entirely so it stays a plain app command).

use std::collections::BTreeSet;
use std::path::Path;

/// Blank out `//` line comments so prose (which contains `::`, `"fluxtab"`,
/// `plugin:fluxtab|…`) can't be mistaken for code.
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The quoted command names inside build.rs's fluxtab `.commands(&[ … ])`.
fn acl_commands(build_rs: &str) -> BTreeSet<String> {
    let src = strip_line_comments(build_rs);
    let start = src
        .find(".commands(&[")
        .expect("build.rs: `.commands(&[` not found");
    let rest = &src[start..];
    let end = rest
        .find("])")
        .expect("build.rs: unterminated `.commands(&[ … ])`");
    // Odd-indexed `"`-split segments are the string literals.
    rest[..end]
        .split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, s)| s.to_string())
        .collect()
}

/// The command idents inside the fluxtab plugin's `generate_handler![ … ]`
/// (reduced to the final path segment, e.g. `vault::vault_page_info` →
/// `vault_page_info`).
fn fluxtab_handler_commands(lib_rs: &str) -> BTreeSet<String> {
    let src = strip_line_comments(lib_rs);
    let anchor = src
        .find("new(\"fluxtab\")")
        .expect("lib.rs: fluxtab plugin builder not found");
    let after = &src[anchor..];
    let gh = after
        .find("generate_handler![")
        .expect("lib.rs: fluxtab `generate_handler![` not found");
    let body_start = anchor + gh + "generate_handler![".len();
    let body = &src[body_start..];
    let end = body
        .find(']')
        .expect("lib.rs: unterminated fluxtab `generate_handler![`");
    body[..end]
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.rsplit("::").next().unwrap().trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

#[test]
fn fluxtab_acl_and_handler_agree() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let build_rs = std::fs::read_to_string(dir.join("build.rs")).expect("read build.rs");
    let lib_rs = std::fs::read_to_string(dir.join("src/lib.rs")).expect("read src/lib.rs");

    let acl = acl_commands(&build_rs);
    let handler = fluxtab_handler_commands(&lib_rs);

    // ACL'd but not dispatched → runtime "command not found".
    let not_dispatched: Vec<&String> = acl.difference(&handler).collect();
    // Dispatched but not ACL'd → runtime "not allowed by ACL".
    let not_permitted: Vec<&String> = handler.difference(&acl).collect();

    assert!(
        not_dispatched.is_empty() && not_permitted.is_empty(),
        "fluxtab command drift — these page calls would silently fail at runtime:\n  \
         in build.rs ACL but NOT the fluxtab generate_handler! (→ \"command not found\"): {not_dispatched:?}\n  \
         in the fluxtab generate_handler! but NOT build.rs ACL (→ \"not allowed by ACL\"): {not_permitted:?}\n\
         Fix: add the command to both sides, or (if it's chrome-only) move it out of the fluxtab handler into the app handler.",
    );
}
