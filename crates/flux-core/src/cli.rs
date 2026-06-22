//! CLI entry: `flux` is launchable from any terminal.
//!
//!   flux                          open with the start page
//!   flux https://example.com …    open one tab per URL
//!   flux -t / --terminal          open with a terminal tab focused
//!   flux --version / --help
//!
//! Hand-rolled parser on purpose: clap would add ~200 KB and ~3 s of compile
//! for four flags. Revisit only if the surface grows (tracked in BACKLOG).
//!
//! Single-instance forwarding (second `flux <url>` adds a tab to the running
//! window instead of spawning a new one) is wired in `run()` via
//! `tauri-plugin-single-instance`, reusing this same `parse` (#20).

use serde::{Deserialize, Serialize};

/// What the user asked for at launch. Managed into Tauri state; the shell
/// pulls it once on mount (`launch_intent` command) and materializes tabs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LaunchIntent {
    /// URLs to open as Browser tabs, in argv order.
    pub urls: Vec<String>,
    /// `--terminal`: also open (and focus) a Terminal tab.
    pub terminal: bool,
}

/// Parse argv. `Err` carries text to print (help/version/usage error) — the
/// caller decides the exit code, keeping this function trivially testable.
pub fn parse(args: impl Iterator<Item = String>) -> Result<LaunchIntent, (String, i32)> {
    let mut intent = LaunchIntent::default();
    for arg in args {
        match arg.as_str() {
            "-h" | "--help" => return Err((HELP.into(), 0)),
            "-V" | "--version" => {
                return Err((format!("flux {}", env!("CARGO_PKG_VERSION")), 0));
            }
            "-t" | "--terminal" => intent.terminal = true,
            url if url.starts_with("http://") || url.starts_with("https://") => {
                intent.urls.push(url.into());
            }
            // Bare words get the browser treatment: "flux example.com" works.
            word if !word.starts_with('-') => intent.urls.push(format!("https://{word}")),
            other => {
                return Err((format!("flux: unknown flag `{other}`\n{HELP}"), 2));
            }
        }
    }
    Ok(intent)
}

const HELP: &str = "\
flux — AI-native browser with a built-in terminal

USAGE:
    flux [FLAGS] [URL]...
    flux <context-command>      (inside a Flux terminal)

FLAGS:
    -t, --terminal    open a terminal tab on launch
    -h, --help        print this help
    -V, --version     print version

CONTEXT COMMANDS (read the active page; run inside a Flux terminal):
    flux url            print the active page URL
    flux title          print the active page title
    flux dom            print the active page's visible text
    flux links          print the page's links, one per line
    flux extract-json   print the page context as JSON (pipe to jq)";

/// Context subcommands read the active browser page from the file Flux writes at
/// `$FLUX_RPC_DIR/active.json` (BACKLOG #65/#4). Returns `Some((output, code))`
/// when `name` is a context command (so `main` can print + exit), else `None`
/// so it falls through to normal launch parsing.
pub fn context_command(name: &str) -> Option<(String, i32)> {
    match name {
        "url" | "title" | "dom" | "text" | "links" | "json" | "extract-json" => {
            Some(run_context(name))
        }
        _ => None,
    }
}

fn run_context(cmd: &str) -> (String, i32) {
    let Ok(dir) = std::env::var("FLUX_RPC_DIR") else {
        return ("flux: not inside a Flux terminal (FLUX_RPC_DIR is unset)".into(), 1);
    };
    let path = std::path::Path::new(&dir).join("active.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ("flux: no active page yet — open a page in Flux first".into(), 1);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return ("flux: could not read the page context".into(), 1);
    };
    if v.get("private").and_then(|p| p.as_bool()).unwrap_or(false) {
        return ("flux: the active tab is private — no page context is exposed".into(), 1);
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match cmd {
        "url" => (s("url"), 0),
        "title" => (s("title"), 0),
        "dom" | "text" => (s("text"), 0),
        "links" => {
            let out = v
                .get("links")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            (out, 0)
        }
        "json" | "extract-json" => (serde_json::to_string_pretty(&v).unwrap_or(raw), 0),
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> std::vec::IntoIter<String> {
        s.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn urls_and_terminal_flag() {
        let i = parse(argv(&["https://a.dev", "-t", "b.dev"])).unwrap();
        assert_eq!(i.urls, vec!["https://a.dev", "https://b.dev"]);
        assert!(i.terminal);
    }

    #[test]
    fn help_short_circuits_with_exit_zero() {
        let (text, code) = parse(argv(&["--help"])).unwrap_err();
        assert_eq!(code, 0);
        assert!(text.contains("USAGE"));
    }

    #[test]
    fn unknown_flag_is_a_usage_error() {
        let (_, code) = parse(argv(&["--frobnicate"])).unwrap_err();
        assert_eq!(code, 2);
    }
}
