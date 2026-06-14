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
//! window instead of spawning a new one) is BACKLOG #20.

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

FLAGS:
    -t, --terminal    open a terminal tab on launch
    -h, --help        print this help
    -V, --version     print version";

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
