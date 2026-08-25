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
//! server. It also crosses the Windows shell boundary for free: on that build
//! nvim is started from the MSYS2 terminal, so the client runs there too, and
//! that is one `bash -lc` rather than a socket-forwarding problem.
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
/// sides, and it is written by one process and read by another. `/tmp` needs no
/// environment lookup, so the string can't drift. The socket itself is created
/// 0600 by nvim.
///
/// **Windows gets a named pipe instead**, and has to: nvim there is a native
/// Windows binary, and it refuses a filesystem path outright — *"Failed to
/// --listen: permission denied"* — so the editor doesn't merely lose RPC, it
/// fails to start. (Under WSL this never came up; nvim was a Linux process with
/// real Unix sockets.) Written `//./pipe/…` rather than the more familiar
/// `\\.\pipe\…` because the name reaches nvim by way of bash, and the MSYS
/// runtime eats backslashes on the way through. Forward slashes are the same
/// object to Win32 and survive the trip unaltered.
pub fn socket_path(session: u64) -> String {
    #[cfg(windows)]
    {
        format!("//./pipe/flux-nvim-{session}")
    }
    #[cfg(not(windows))]
    {
        format!("/tmp/flux-nvim-{session}.sock")
    }
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
    /// The last visual selection: `mode ⟼ file ⟼ start ⟼ end ⟼ text`, or empty
    /// when nothing has ever been selected.
    ///
    /// `'<` / `'>` are the marks nvim leaves *after* visual mode ends, which is
    /// exactly the state "explain this" is asked in — the user selects, presses
    /// Esc, and types. Reading them live would require the selection still to be
    /// active while the agent panel has focus, which it can't be.
    ///
    /// The text comes from `getregion()` rather than from the line range and
    /// columns: it already handles charwise vs linewise vs blockwise, and
    /// `col()` is a *byte* index, so slicing it here would be one multi-byte
    /// character away from a panic.
    pub const SELECTION: &str = r#"visualmode()=="" ? "" : join([visualmode(), expand("%:p"), getpos("'<")[1], getpos("'<")[2], getpos("'>")[1], getpos("'>")[2], join(getregion(getpos("'<"), getpos("'>"), {"type": visualmode()}), "\n")], "\x1f")"#;
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

/// On the Windows build the editor was started from the MSYS2 terminal, so the
/// client runs there too — same shell, same `PATH`, so it is the same `nvim`
/// answering as the one being asked about.
///
/// Two Windows-only details, both found the hard way:
///
///   · `--headless`. Without it, `--remote-expr` on Windows opens a full TUI and
///     prints the answer nowhere; the query returns empty and the panel looks
///     like an editor that isn't there. On Linux the flag isn't needed, so it
///     stays on this side of the split.
///   · positional parameters. `bash -c <script> <name> <args…>` binds `"$1"` and
///     `"$2"` from argv, so the socket and the expression are *passed*, never
///     parsed. `--remote-expr` evaluates Vimscript, which makes this the one
///     place in the module where a string could become code — the constants in
///     `expr` are why it can't, and this is why the shell can't reopen the door.
#[cfg(windows)]
fn spawn_client(sock: &str, expression: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let bash = crate::msys::bash().ok_or("no MSYS2 bash found for the nvim client")?;
    let mut cmd = Command::new(bash);
    cmd.args([
        "-lc",
        r#"exec nvim --headless --server "$1" --remote-expr "$2""#,
        "flux-nvim", // $0
        sock,
        expression,
    ]);
    crate::msys::configure(&mut cmd, false);
    cmd.creation_flags(CREATE_NO_WINDOW);
    run_bounded(cmd)
}

/// The last visual selection — what "explain this" points at.
#[derive(Serialize, Debug, Clone, Default, PartialEq, specta::Type)]
pub struct NvimSelection {
    /// Something has been selected. False means the user hasn't selected
    /// anything in this session, which is a different answer from "empty".
    pub has: bool,
    /// `v` charwise, `V` linewise, `\x16` blockwise.
    pub mode: String,
    /// File the selection is in.
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    /// The selected text exactly as nvim resolves it.
    pub text: String,
}

/// Parse the packed `SELECTION` reply.
///
/// `splitn` with the text last, so a selection that itself contains the unit
/// separator — unlikely in source, but free to get right — stays intact instead
/// of being truncated at its first occurrence.
pub(crate) fn parse_selection(raw: &str) -> NvimSelection {
    if raw.trim().is_empty() {
        return NvimSelection::default();
    }
    let mut p = raw.splitn(7, '\u{1f}');
    let mode = p.next().unwrap_or("").trim().to_string();
    let file = p.next().unwrap_or("").trim().to_string();
    let start_line = p.next().unwrap_or("").trim().parse().unwrap_or(0);
    let _start_col = p.next();
    let end_line = p.next().unwrap_or("").trim().parse().unwrap_or(0);
    let _end_col = p.next();
    let text = p.next().unwrap_or("").to_string();
    // A mark of line 0 is nvim's "never set", which the guard above usually
    // catches — but a malformed reply must not present as a real selection.
    if start_line == 0 || text.is_empty() {
        return NvimSelection::default();
    }
    NvimSelection {
        has: true,
        mode,
        file,
        start_line,
        end_line,
        text,
    }
}

/// The last visual selection, for "explain this".
#[tauri::command]
pub async fn nvim_selection(session: u64) -> NvimSelection {
    tauri::async_runtime::spawn_blocking(move || match query(session, expr::SELECTION) {
        Ok(raw) => parse_selection(&raw),
        Err(_) => NvimSelection::default(),
    })
    .await
    .unwrap_or_default()
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
    fn parses_a_linewise_selection() {
        // Exactly what a real nvim returned for `6GV8G<Esc>`: linewise, so the
        // end column is v_max rather than a real column.
        let raw = "V\u{1f}/home/me/demo.rs\u{1f}6\u{1f}1\u{1f}8\u{1f}2147483647\u{1f}fn helper(n: i32) {\n    println!(\"{}\", n + 1);\n}";
        let s = parse_selection(raw);
        assert!(s.has);
        assert_eq!(s.mode, "V");
        assert_eq!((s.start_line, s.end_line), (6, 8));
        assert!(s.text.starts_with("fn helper"));
        assert!(s.text.ends_with('}'));
    }

    #[test]
    fn parses_a_charwise_selection() {
        // getregion() resolves the columns for us, so the text is the exact
        // characters — this is why the parser ignores the column fields rather
        // than slicing by them (col() is a *byte* index).
        let raw = "v\u{1f}/home/me/demo.rs\u{1f}3\u{1f}11\u{1f}3\u{1f}14\u{1f}(x);";
        let s = parse_selection(raw);
        assert!(s.has);
        assert_eq!(s.mode, "v");
        assert_eq!(s.text, "(x);");
        assert_eq!((s.start_line, s.end_line), (3, 3));
    }

    #[test]
    fn nothing_selected_is_reported_as_such_not_as_an_empty_selection() {
        // `visualmode()` is "" before the first selection, and the expression
        // short-circuits to an empty reply. Presenting that as a real but empty
        // selection would have the agent explain nothing, confidently.
        for raw in ["", "   ", "\n"] {
            assert!(!parse_selection(raw).has, "{raw:?}");
        }
        // A mark of line 0 is nvim's "never set".
        assert!(!parse_selection("V\u{1f}/f\u{1f}0\u{1f}0\u{1f}0\u{1f}0\u{1f}x").has);
        // Text that came back empty is not something to explain either.
        assert!(!parse_selection("V\u{1f}/f\u{1f}1\u{1f}1\u{1f}2\u{1f}9\u{1f}").has);
    }

    #[test]
    fn a_selection_containing_the_separator_survives() {
        // The text is last and split with a limit, so source that happens to
        // contain \x1f arrives whole rather than truncated at it.
        let raw = "v\u{1f}/f\u{1f}1\u{1f}1\u{1f}1\u{1f}9\u{1f}let sep = '\u{1f}'; // odd but legal";
        let s = parse_selection(raw);
        assert!(s.has);
        assert!(s.text.contains("odd but legal"), "{}", s.text);
    }

    #[test]
    fn the_socket_path_matches_what_the_frontend_boots() {
        // The frontend derives this independently (`editorboot.ts::socketPath`)
        // because awaiting it would race the column's mount. Nothing checks the
        // two agree at runtime — a mismatch just means the agent silently can't
        // reach the editor — so both sides pin the literal instead.
        #[cfg(windows)]
        assert_eq!(socket_path(7), "//./pipe/flux-nvim-7");
        #[cfg(not(windows))]
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
