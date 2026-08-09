//! Reading the editor's live state (#179).
//!
//! The nvim column (#174) runs a real editor in a real PTY, but until now the
//! agent could only see it the way a camera does: `read the terminal` returned
//! xterm's rendered screen — your lines tangled with nvim's line numbers, `~`
//! fillers and statusline, viewport only. And `read <path>` reads *disk*, so
//! ten minutes of unsaved editing were invisible.
//!
//! Neovim solves this itself. Started with `--listen <socket>` it exposes an
//! RPC endpoint, and the `nvim` binary doubles as the client:
//!
//! ```text
//! nvim --server /tmp/flux-nvim-<session>.sock --remote-expr 'expand("%:p")'
//! ```
//!
//! Using the binary rather than speaking msgpack ourselves is deliberate. It
//! costs a process spawn per query — tens of milliseconds, against an agent turn
//! measured in seconds — and buys no msgpack implementation to get wrong, no new
//! dependency, and a client that is by construction the right version for the
//! server. It also crosses the WSL boundary for free: on the Windows build nvim
//! runs inside WSL, so the client has to as well, and that is one `wsl.exe`
//! prefix rather than a socket-forwarding problem.
//!
//! # The expressions are ours, never the model's
//!
//! `--remote-expr` evaluates arbitrary Vimscript, so an expression chosen by the
//! model would be remote code execution wearing a hat — `system('…')` is one
//! call away, and page text reaches the model. Every expression here is a
//! compile-time constant. This is the same rule the action compiler runs on
//! (`flux-agent`): the model picks *which* question from a fixed menu, Rust
//! decides *how* it is asked. Nothing on this path takes a caller-supplied
//! expression, and `query` is private so nothing outside can add one.

use std::process::Command;
use std::time::Duration;

use serde::Serialize;

/// Where the editor's RPC socket lives, for a given PTY session.
///
/// `/tmp` rather than `$XDG_RUNTIME_DIR`: the path has to be identical on both
/// sides, and on the Windows build the two sides are different operating
/// systems. `/tmp` exists in WSL and on Linux and needs no environment lookup,
/// so the string can't drift. The socket itself is created 0600 by nvim.
pub fn socket_path(session: u64) -> String {
    format!("/tmp/flux-nvim-{session}.sock")
}

/// What the editor is doing right now.
#[derive(Serialize, Debug, Clone, Default, PartialEq, specta::Type)]
pub struct NvimState {
    /// The editor answered. False means no socket yet, or nvim isn't running.
    pub connected: bool,
    /// Absolute path of the file in the current window, empty for a scratch buffer.
    pub file: String,
    /// 1-based cursor position.
    pub line: u32,
    pub col: u32,
    /// The buffer has edits that aren't on disk — the reason to read from here
    /// rather than from the filesystem.
    pub modified: bool,
    /// Total lines in the current buffer.
    pub lines: u32,
    /// Absolute paths of every listed buffer.
    pub buffers: Vec<String>,
}

/// Vimscript we are willing to evaluate. Constants, never composed from input.
///
/// Two, not eight: everything `state` needs comes back from one `\x1f`-joined
/// round trip, and a separate constant per field would be six extra process
/// spawns for one panel refresh. The unit separator is the delimiter because it
/// cannot occur in a path or in `&modified`.
mod expr {
    /// The whole current buffer, including unwritten changes.
    pub const BUFFER_TEXT: &str = r#"join(getline(1, "$"), "\n")"#;
    /// `file ⟼ line ⟼ col ⟼ modified ⟼ line-count ⟼ buffers` (tab-separated).
    pub const STATE: &str = r#"join([expand("%:p"), line("."), col("."), &modified, line("$"), join(map(getbufinfo({"buflisted":1}), {_, b -> b.name}), "\t")], "\x1f")"#;
}

/// How long to wait for the editor. Generous enough for a loaded session,
/// short enough that a dead socket doesn't stall an agent turn.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Run the client, but never wait on it forever.
///
/// `Command::output()` has no timeout, so a wedged editor would pin this thread
/// for the life of the process — and the caller is an agent turn, which would
/// simply never finish. The wait happens on its own thread so the pipes are
/// still drained (a large buffer would otherwise fill the pipe and deadlock a
/// poll-and-kill loop); on timeout the client is abandoned rather than killed,
/// because it exits on its own the moment the server answers or the socket dies,
/// and leaking a short-lived process on a rare timeout is a better trade than
/// per-platform kill handling.
fn run_bounded(cmd: Command) -> Result<std::process::Output, String> {
    run_bounded_for(cmd, TIMEOUT)
}

/// `run_bounded` with the deadline supplied, so the timeout path is testable in
/// milliseconds instead of seconds.
fn run_bounded_for(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    match rx.recv_timeout(timeout) {
        Ok(r) => r.map_err(|e| format!("nvim: {e}")),
        Err(_) => Err(format!(
            "nvim: no reply within {}s — the editor may be waiting on something (a prompt, a modal)",
            timeout.as_secs().max(1)
        )),
    }
}

/// Ask the editor one **fixed** expression. Private on purpose — see the module
/// docs on why no caller may supply one.
fn query(session: u64, expression: &'static str) -> Result<String, String> {
    let sock = socket_path(session);
    let out = spawn_client(&sock, expression)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // The overwhelmingly common case, and not really an error: the editor
        // isn't up yet, or this Flux never started one.
        if err.contains("connect") || err.contains("No such file") || err.is_empty() {
            return Err("not connected".into());
        }
        return Err(format!(
            "nvim: {}",
            err.trim().chars().take(200).collect::<String>()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Run the nvim client where the editor actually lives.
#[cfg(not(windows))]
fn spawn_client(sock: &str, expression: &str) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("nvim");
    cmd.args(["--server", sock, "--remote-expr", expression]);
    run_bounded(cmd)
}

/// On the Windows build the editor is inside WSL, so the client must be too.
/// The expression is passed as an argument, never spliced into a shell string —
/// the lesson `files.rs` records about `wsl.exe` re-parsing its command line.
#[cfg(windows)]
fn spawn_client(sock: &str, expression: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--", "nvim", "--server", sock, "--remote-expr", expression])
        .creation_flags(CREATE_NO_WINDOW);
    run_bounded(cmd)
}

/// Parse the packed `STATE` reply. Split out so the wire format is testable
/// without an editor.
pub(crate) fn parse_state(raw: &str) -> NvimState {
    let mut parts = raw.split('\u{1f}');
    let file = parts.next().unwrap_or("").trim().to_string();
    let line = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
    let col = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
    // `&modified` is Vimscript's 0/1, not a bool literal.
    let modified = parts.next().unwrap_or("").trim() == "1";
    let lines = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
    let buffers = parts
        .next()
        .unwrap_or("")
        .split('\t')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    NvimState {
        connected: true,
        file,
        line,
        col,
        modified,
        lines,
        buffers,
    }
}

/// What the editor is doing, or `connected: false` if it isn't answering.
///
/// Never an error: "no editor" is an ordinary state the UI polls through, not a
/// failure worth a red message.
#[tauri::command]
pub async fn nvim_state(session: u64) -> NvimState {
    tauri::async_runtime::spawn_blocking(move || match query(session, expr::STATE) {
        Ok(raw) => parse_state(&raw),
        Err(_) => NvimState::default(),
    })
    .await
    .unwrap_or_default()
}

/// The current buffer's text **including unsaved changes** — the thing reading
/// the file from disk cannot give you.
#[tauri::command]
pub async fn nvim_buffer(session: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || query(session, expr::BUFFER_TEXT))
        .await
        .map_err(|e| e.to_string())?
}

/// The socket the editor column should pass to `--listen`.
#[tauri::command]
pub fn nvim_socket(session: u64) -> String {
    socket_path(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_state_reply() {
        let raw =
            "/home/me/demo.rs\u{1f}12\u{1f}5\u{1f}1\u{1f}40\u{1f}/home/me/demo.rs\t/home/me/lib.rs";
        let s = parse_state(raw);
        assert!(s.connected);
        assert_eq!(s.file, "/home/me/demo.rs");
        assert_eq!((s.line, s.col), (12, 5));
        // The whole point: unsaved edits are visible as such.
        assert!(s.modified);
        assert_eq!(s.lines, 40);
        assert_eq!(s.buffers.len(), 2);
    }

    #[test]
    fn an_unmodified_scratch_buffer_is_not_a_parse_failure() {
        // Fresh nvim with no file: empty name, modified 0, one unnamed buffer.
        let s = parse_state("\u{1f}1\u{1f}1\u{1f}0\u{1f}1\u{1f}");
        assert!(s.connected);
        assert_eq!(s.file, "");
        assert!(!s.modified);
        assert_eq!(s.line, 1);
        assert!(
            s.buffers.is_empty(),
            "an unnamed buffer is dropped, not kept as \"\""
        );
    }

    #[test]
    fn a_truncated_reply_degrades_instead_of_panicking() {
        // Whatever nvim does, this must not take the panel down with it.
        for raw in ["", "\u{1f}", "/x/y.rs", "garbage\u{1f}nope\u{1f}nope"] {
            let s = parse_state(raw);
            assert!(s.connected, "{raw:?}");
            assert_eq!(s.col, s.col); // no panic is the assertion
        }
        assert_eq!(parse_state("/x/y.rs").file, "/x/y.rs");
        // Non-numeric line/col fall back to 0 rather than poisoning the struct.
        assert_eq!(parse_state("f\u{1f}abc\u{1f}def").line, 0);
    }

    #[test]
    fn a_wedged_editor_times_out_instead_of_hanging_the_turn() {
        // The property that matters: an editor that never answers must not pin
        // the caller — which is an agent turn — for the life of the process.
        let mut slow = Command::new("sleep");
        slow.arg("30");
        let started = std::time::Instant::now();
        let err = run_bounded_for(slow, Duration::from_millis(200)).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "should give up promptly"
        );
        assert!(err.contains("no reply"), "{err}");
    }

    #[test]
    fn a_prompt_reply_comes_back_normally() {
        let mut fast = Command::new("echo");
        fast.arg("hi");
        let out = run_bounded_for(fast, Duration::from_secs(5)).expect("echo should succeed");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[test]
    fn the_socket_path_matches_what_the_frontend_boots() {
        // The frontend derives this independently (`editorboot.ts::socketPath`)
        // because awaiting it would race the column's mount. Nothing checks the
        // two agree at runtime — a mismatch just means the agent silently can't
        // reach the editor — so both sides pin the literal instead.
        assert_eq!(socket_path(7), "/tmp/flux-nvim-7.sock");
        // Distinct per session, or two columns would fight over one socket.
        assert_ne!(socket_path(7), socket_path(8));
    }

    #[test]
    fn every_expression_is_a_constant_with_no_side_effects() {
        // The security property, asserted rather than assumed: these strings are
        // the entire vocabulary, and none of them can run a command.
        for e in [expr::BUFFER_TEXT, expr::STATE] {
            for banned in ["system(", "execute(", "call ", "!", "writefile", "delete("] {
                assert!(!e.contains(banned), "{e:?} contains {banned:?}");
            }
        }
    }
}
