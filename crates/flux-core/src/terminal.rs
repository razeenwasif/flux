//! Embedded terminal — real PTY sessions (ADR 0003).
//!
//! Each session owns a pseudo-terminal: a shell spawned with the Flux context
//! env (`FLUX_TAB_*`), a background thread streaming output bytes to the
//! frontend over a Tauri `Channel`, and a handle for writing stdin / resizing
//! / killing. The frontend renders with xterm.js (lazy-loaded).
//!
//! Sessions are keyed by a `u64`:
//!   · a Terminal *tab*'s `TabId`  → that tab's shell
//!   · `PANE_SESSION` (0)          → the vertical terminal column's shell
//!
//! **Persistence** has two independent halves (BACKLOG #98), because they solve
//! different problems and neither subsumes the other:
//!
//!   · `live`       — the shell and its children keep running across a Flux
//!                    restart. This *requires* an out-of-process PTY owner: our
//!                    master fd dies with us, SIGHUP-ing the process group. So we
//!                    delegate to `dtach` (preferred: ~50 KB, no config, and no
//!                    second terminal emulator in the path) or `tmux`.
//!   · `transcript` — the output stream is recorded to a capped file and replayed
//!                    when the terminal reopens. No external binary, works on
//!                    native Windows, and unlike the live half it survives a
//!                    crash or a reboot — but the processes are gone.
//!
//! Paired, they give back both the running work and the scrollback. Off by
//! default: `transcript` writes terminal output to disk, which is the user's
//! call to make, not ours.
//!
//! flux-term (the WGPU grid/renderer) is untouched and remains the future
//! native-render path; it would consume the same PTY bytes this module reads.
//!
//! Desktop only: `portable-pty`'s transitive `termios` doesn't build for Android
//! and a phone has no shell to spawn (ADR 0012). On mobile the module compiles to
//! the `stub` below — identical command signatures, each reporting unavailability
//! — so `lib.rs` state management and the IPC `generate_handler!` are unchanged.

#[cfg(desktop)]
mod real {
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::FluxState;

/// Reserved session id for the always-available vertical terminal column.
pub const PANE_SESSION: u64 = 0;

/// Bash OSC 133 shell-integration snippet (#16) — sourced via `bash --rcfile`
/// so the embedded terminal gets prompt/command marks (status gutter, prompt
/// jump, copy-last-output). Re-sources the user's own startup files first.
const BASH_INTEGRATION: &str = include_str!("../assets/shell-integration.bash");

/// One live PTY. Every field is behind a `Mutex` so `Session` is `Sync` and
/// can live in the shared map (the PTY handles themselves are `Send`-only).
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
    /// Resolved when the session was spawned, so a close tears down exactly what
    /// that session created — re-reading the setting could disagree with it.
    mode: PersistMode,
}

/// Process-wide table of live terminals. Managed into Tauri state alongside
/// `FluxState`.
#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<u64, Session>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Pick the user's shell. `$FLUX_SHELL` overrides everything (so a user can
/// pick pwsh/cmd/bash without a rebuild); otherwise PowerShell on Windows,
/// `$SHELL` on Unix.
fn default_shell() -> String {
    if let Ok(s) = std::env::var("FLUX_SHELL") {
        if !s.trim().is_empty() {
            return s;
        }
    }
    #[cfg(windows)]
    {
        // Default to WSL (the user's dev environment lives there). Override
        // with FLUX_SHELL=powershell.exe / cmd.exe / pwsh.exe if WSL isn't set
        // up; the spawn error surfaces in the terminal either way.
        "wsl.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Spawn a PTY for `session`, streaming output through `on_data`.
///
/// Returns once the shell is running and the reader thread is live; output
/// then flows asynchronously over the channel. A re-spawn for an existing
/// session id replaces the old one (the previous child is dropped/killed).
#[tauri::command]
// Three of the eight are Tauri's own injections (app/state/manager) and one is
// the output Channel, so the callable surface is only four.
#[allow(clippy::too_many_arguments)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, FluxState>,
    manager: State<'_, TerminalManager>,
    session: u64,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    // What this terminal should survive: "off" | "live" | "transcript" | "both".
    // `None` falls back to `FLUX_TERM_PERSIST`.
    persist: Option<String>,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    // Build the shell command with the Flux context environment — this is what
    // makes `cd $FLUX_TAB_DIR` / `flux extract-json` work the moment the shell
    // opens (the env bridge from `commands::terminal_env`, reused here).
    let shell = default_shell();
    // With the live half enabled, wrap the shell in a per-session detach/attach
    // broker so it survives a Flux restart: closing Flux detaches, reopening
    // re-attaches (tab ids persist via session restore #19). Best-effort — with
    // neither broker installed this falls back to a plain shell, and the
    // transcript half (which needs nothing external) still applies.
    let mode = resolve_mode(persist.as_deref());
    let engine = if mode.live { live_engine() } else { None };
    let tmux_name = format!("flux-{session}");
    let sock = dtach_socket(session);
    // `-z` so dtach doesn't act on ^Z and `-E` so it claims no detach key: with
    // xterm.js as the emulator, the broker should be invisible to keystrokes.
    // `-r winch` asks the program to redraw by resizing it rather than injecting
    // a ^L, which is gentler on a full-screen TUI.
    let dtach_args = ["-A", sock.as_str(), "-z", "-E", "-r", "winch"];

    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new(&shell);
        // WSL: start in the Linux home (~), not the translated Windows cwd
        // (/mnt/c/Users/...). `--cd` overrides the inherited working directory.
        if shell.to_ascii_lowercase().contains("wsl") {
            c.arg("--cd");
            c.arg("~");
            if let Some(eng) = engine {
                c.arg("--");
                match eng {
                    LiveEngine::Tmux => {
                        for a in ["tmux", "new-session", "-A", "-s", &tmux_name] {
                            c.arg(a);
                        }
                    }
                    LiveEngine::Dtach => {
                        c.arg("dtach");
                        for a in dtach_args {
                            c.arg(a);
                        }
                        // dtach needs a program to run; give it a login shell so
                        // the user's rc files are sourced as usual.
                        for a in ["bash", "-l"] {
                            c.arg(a);
                        }
                    }
                }
            } else if integration_enabled() {
                // Run bash inside WSL with Flux's OSC 133 integration (#16). The
                // rcfile lives on the Windows side, so hand bash its /mnt path.
                if let Some(rc) = integration_rcfile().as_deref().and_then(to_wsl_path) {
                    for a in ["--", "bash", "--rcfile"] {
                        c.arg(a);
                    }
                    c.arg(rc);
                }
            }
        }
        c
    };
    #[cfg(not(windows))]
    let mut cmd = if let Some(eng) = engine {
        match eng {
            LiveEngine::Tmux => {
                let mut c = CommandBuilder::new("tmux");
                for a in ["new-session", "-A", "-s", &tmux_name] {
                    c.arg(a);
                }
                c
            }
            LiveEngine::Dtach => {
                let mut c = CommandBuilder::new("dtach");
                for a in dtach_args {
                    c.arg(a);
                }
                // The user's shell, with the OSC 133 integration when we can —
                // the broker shouldn't cost the status gutter (#16).
                c.arg(&shell);
                if integration_enabled() && shell_is_bash(&shell) {
                    if let Some(rc) = integration_rcfile() {
                        c.arg("--rcfile");
                        c.arg(rc.to_string_lossy().as_ref());
                    }
                }
                c
            }
        }
    } else if integration_enabled() && shell_is_bash(&shell) {
        // Wrap bash so it sources Flux's OSC 133 integration (#16) on top of the
        // user's own ~/.bashrc (which --rcfile would otherwise skip).
        match integration_rcfile() {
            Some(rc) => {
                let mut c = CommandBuilder::new(&shell);
                c.arg("--rcfile");
                c.arg(rc.to_string_lossy().as_ref());
                c
            }
            None => CommandBuilder::new(&shell),
        }
    } else {
        CommandBuilder::new(&shell)
    };

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FLUX_SESSION", session.to_string());
    // DOM-aware terminal bridge (#65/#4): the dir holding active.json, which the
    // `flux` CLI reads for the active page. WSLENV `/p` (below) translates the
    // path for WSL shells.
    let rpc_dir = app.state::<crate::rpc::RpcDir>();
    cmd.env("FLUX_RPC_DIR", rpc_dir.dir().to_string_lossy().as_ref());
    let mut cwd: Option<String> = None;
    if let Some(id) = state.active_tab() {
        if let Some(tab) = state.tabs.get(&id) {
            cmd.env("FLUX_TAB_ID", id.to_string());
            cmd.env("FLUX_TAB_URL", &tab.url);
            cmd.env("FLUX_TAB_TITLE", &tab.title);
            if let Some(host) = tab.url.split('/').nth(2) {
                let dir = format!("{}/flux/{host}", downloads_dir());
                cmd.env("FLUX_TAB_DIR", &dir);
            }
            // A Terminal tab stores its working dir in `url`; start there.
            if tab.url.starts_with('/') || tab.url.starts_with('~') {
                cwd = Some(expand_home(&tab.url));
            }
        }
    }
    // When the shell is WSL, forward the Flux context vars into the distro
    // (Windows env doesn't cross into WSL unless listed in WSLENV). Harmless
    // for non-WSL shells.
    #[cfg(windows)]
    cmd.env(
        "WSLENV",
        // `/p` on FLUX_RPC_DIR → WSL sees the path as /mnt/c/... so the Linux
        // `flux` CLI can read active.json across the Windows↔WSL boundary.
        "FLUX_SESSION:FLUX_TAB_ID:FLUX_TAB_URL:FLUX_TAB_TITLE:FLUX_TAB_DIR:FLUX_RPC_DIR/p",
    );

    // Only set a cwd that actually exists — an invalid cwd makes spawn fail
    // (e.g. a Unix-style path on Windows).
    let cwd = cwd.unwrap_or_else(home_dir);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }

    tracing::info!(target: "flux::term", session, %shell, %cwd, cols, rows, "spawning shell");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {shell:?} (cwd {cwd:?}): {e}"))?;
    // Close our handle to the slave so the PTY reports EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer: {e}"))?;

    manager.sessions.lock().insert(
        session,
        Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            mode,
        },
    );

    // Replay what was on screen last time, before any live output arrives, so the
    // ordering the user sees matches the order it happened in.
    let mut recorder = None;
    if mode.transcript {
        if let Some(prev) = read_transcript(&app, session) {
            let _ = on_data.send(prev);
            let _ = on_data.send(
                b"\r\n\x1b[90m\xe2\x94\x80\xe2\x94\x80 restored transcript \xe2\x80\x94 processes above are not running \xe2\x94\x80\xe2\x94\x80\x1b[0m\r\n"
                    .to_vec(),
            );
        }
        recorder = transcript_dir(&app).and_then(|d| Transcript::open(&d, session));
    }

    // Reader thread: blocking reads off the PTY, batched into the channel.
    // Ends on EOF (shell exit) or error, then signals the frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Record before sending: if the frontend has gone away, the
                    // output still belongs in the transcript.
                    if let Some(t) = recorder.as_mut() {
                        t.append(&buf[..n]);
                    }
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break; // frontend dropped the channel (tab closed)
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit("flux://term-exit", session);
    });

    tracing::info!(target: "flux::term", session, cols, rows, "spawned PTY");
    Ok(())
}

/// Write keystrokes / pasted text to the session's stdin.
#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    session: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = manager.sessions.lock();
    let s = sessions.get(&session).ok_or("no such terminal session")?;
    let mut w = s.writer.lock();
    w.write_all(&data).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Resize the PTY (fit-addon / window resize on the frontend).
#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    session: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock();
    let s = sessions.get(&session).ok_or("no such terminal session")?;
    let result = s
        .master
        .lock()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string());
    result
}

/// Kill and drop a session (tab/pane closed).
///
/// With tmux persistence, killing the child only *detaches* (the whole point —
/// so Flux closing keeps the session alive). An explicit tab close, though, is a
/// deliberate "I'm done with this" — so also kill the tmux session, or it would
/// leak. (App close doesn't run this: the webview dies without JS cleanup, so
/// those sessions correctly survive to be re-attached next launch.)
#[tauri::command]
pub fn terminal_kill(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session: u64,
) -> Result<(), String> {
    let mode = manager.sessions.lock().remove(&session).map(|s| {
        let _ = s.child.lock().kill();
        s.mode
    });
    // Nothing left to persist for a terminal the user deliberately closed.
    let mode = mode.unwrap_or_default();
    if mode.live {
        if let Some(eng) = live_engine() {
            kill_live_session(session, eng);
        }
    }
    if mode.transcript {
        remove_transcript(&app, session);
    }
    Ok(())
}

/// What a terminal keeps across a Flux restart. The two halves are independent:
/// `live` keeps the processes, `transcript` keeps what was on screen.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct PersistMode {
    pub live: bool,
    pub transcript: bool,
}

impl PersistMode {
    fn any(&self) -> bool {
        self.live || self.transcript
    }
}

/// Parse a mode string. `1`/`true`/`yes` mean **live** for backwards
/// compatibility — that's what `FLUX_TERM_PERSIST=1` has always done.
fn parse_mode(v: &str) -> PersistMode {
    let v = v.trim().to_ascii_lowercase();
    match v.as_str() {
        "" | "0" | "off" | "false" | "no" | "none" => PersistMode::default(),
        "1" | "true" | "yes" | "live" => PersistMode {
            live: true,
            transcript: false,
        },
        "transcript" | "scrollback" => PersistMode {
            live: false,
            transcript: true,
        },
        "both" | "all" => PersistMode {
            live: true,
            transcript: true,
        },
        // Tolerate a combined form ("live+transcript") rather than silently
        // treating an almost-right value as off.
        other => PersistMode {
            live: other.contains("live"),
            transcript: other.contains("transcript") || other.contains("scrollback"),
        },
    }
}

/// The mode for a spawn: what the frontend asked for, else `FLUX_TERM_PERSIST`,
/// else off. The env var stays as an override for a headless/scripted run.
fn resolve_mode(requested: Option<&str>) -> PersistMode {
    if let Some(r) = requested {
        let m = parse_mode(r);
        if m.any() || !r.trim().is_empty() {
            return m;
        }
    }
    std::env::var("FLUX_TERM_PERSIST")
        .map(|v| parse_mode(&v))
        .unwrap_or_default()
}

/// Which detach/attach broker to use for the `live` half.
///
/// `dtach` is preferred: it does only this one thing, holds no opinions about
/// keybindings, and — since xterm.js is already the emulator — avoids running the
/// screen through tmux's emulation a second time. The cost is that dtach keeps no
/// screen copy: it asks the app to redraw on attach, so a shell's earlier output
/// isn't restored. That's precisely the gap the transcript half fills.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LiveEngine {
    Dtach,
    Tmux,
}

fn live_engine() -> Option<LiveEngine> {
    static CHOICE: OnceLock<Option<LiveEngine>> = OnceLock::new();
    *CHOICE.get_or_init(|| {
        match std::env::var("FLUX_TERM_ENGINE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "dtach" => return command_available("dtach").then_some(LiveEngine::Dtach),
            "tmux" => return command_available("tmux").then_some(LiveEngine::Tmux),
            _ => {}
        }
        if command_available("dtach") {
            Some(LiveEngine::Dtach)
        } else if command_available("tmux") {
            Some(LiveEngine::Tmux)
        } else {
            None
        }
    })
}

/// The dtach socket for a session. `/tmp` rather than `$XDG_RUNTIME_DIR` because
/// on Windows the path is resolved *inside WSL*, where we can't read that var.
fn dtach_socket(session: u64) -> String {
    format!("/tmp/flux-term-{session}.sock")
}

/// Pattern identifying a session's dtach master for `pkill -f`.
///
/// Requiring `dtach` before the socket path matters: `-f` matches the entire
/// command line, so the bare path alone would also match any unrelated process
/// that merely mentions it (`rm -f /tmp/flux-term-3.sock`, an editor, a grep).
fn dtach_kill_pattern(session: u64) -> String {
    format!("dtach.*flux-term-{session}\\.sock")
}

/// Whether to auto-inject the OSC 133 shell integration (#16). Opt-out via
/// `FLUX_NO_SHELL_INTEGRATION=1` (e.g. if it interferes with an exotic rc setup).
fn integration_enabled() -> bool {
    !std::env::var("FLUX_NO_SHELL_INTEGRATION")
        .map(|v| {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
}

/// Is `shell` (a path or bare name) bash? Only bash is auto-wrapped today —
/// other shells source the equivalent snippet manually (docs/shell-integration.md).
/// Only the Unix cmd-builder consults this; on Windows the WSL branch forces bash.
#[cfg(not(windows))]
fn shell_is_bash(shell: &str) -> bool {
    std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("bash"))
        .unwrap_or(false)
}

/// Materialise the bash integration snippet to a temp file once per process and
/// return its path. `None` if it can't be written (integration is then skipped).
fn integration_rcfile() -> Option<std::path::PathBuf> {
    static PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("flux");
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join("shell-integration.bash");
        std::fs::write(&p, BASH_INTEGRATION).ok()?;
        Some(p)
    })
    .clone()
}

/// Translate a Windows path to the WSL `/mnt/<drive>/…` form so a bash launched
/// inside WSL can read the rcfile written on the Windows side. Assumes the
/// default automount root (`/mnt`).
#[cfg(windows)]
fn to_wsl_path(p: &std::path::Path) -> Option<String> {
    let s = p.to_string_lossy();
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        let drive = (b[0] as char).to_ascii_lowercase();
        Some(format!("/mnt/{}{}", drive, s[2..].replace('\\', "/")))
    } else {
        Some(s.replace('\\', "/"))
    }
}

/// Is `cmd` available (in WSL on Windows, locally on Unix)? Cached per name — the
/// check is a subprocess, and only persist-mode users ever reach it.
fn command_available(cmd: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(&hit) = cache.lock().get(cmd) {
        return hit;
    }
    let probe = format!("command -v {cmd}");
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("wsl.exe");
        c.args(["--", "sh", "-c", &probe]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &probe]);
        c
    };
    let found = c.output().map(|o| o.status.success()).unwrap_or(false);
    cache.lock().insert(cmd.to_string(), found);
    found
}

/// Run a command inside the shell's world — the WSL distro on Windows, locally on
/// Unix — without a `sh -c` wrapper. Best-effort and fire-and-forget.
///
/// **The missing wrapper is the point.** These commands carry a socket path as an
/// argument and one of them is `pkill -f`, which matches on the whole command
/// line: a wrapping `sh -c "pkill -f <sock>; rm -f <sock>"` has that very path in
/// its own argv, so pkill kills the shell running it and everything after the
/// first command is silently skipped. (Observed, not theorised.) Spawned directly,
/// pkill skips only itself and there is no wrapper to match.
fn run_in_shell_world(args: &[&str]) {
    let Some((program, rest)) = args.split_first() else {
        return;
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("wsl.exe")
            .arg("--")
            .arg(program)
            .args(rest)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new(program).args(rest).spawn();
    }
}

/// Tear down a persistent session on explicit tab close (best-effort).
///
/// dtach has no "kill" verb — its master exits when the program it runs does — so
/// the master is found by the socket path, which is unique per session. Killing it
/// closes its PTY master, which SIGHUPs the shell: the same mechanism that ends a
/// non-persistent session when Flux exits.
fn kill_live_session(session: u64, engine: LiveEngine) {
    match engine {
        LiveEngine::Tmux => {
            let name = format!("flux-{session}");
            run_in_shell_world(&["tmux", "kill-session", "-t", &name]);
        }
        LiveEngine::Dtach => {
            let sock = dtach_socket(session);
            let pattern = dtach_kill_pattern(session);
            run_in_shell_world(&["pkill", "-f", &pattern]);
            // Unlink separately: a stale socket makes the next `-A` attach to a
            // session with no master instead of creating a fresh one.
            run_in_shell_world(&["rm", "-f", &sock]);
        }
    }
}

// ─── transcript ─────────────────────────────────────────────────────────────

/// How much output is kept per session. Enough to be the scrollback you wanted
/// back, small enough that a runaway `yes` can't fill the disk.
///
/// Compaction is amortised, so a file sits between this and **twice** this
/// between rewrites. Replay is always capped at exactly this much
/// ([`read_transcript`] seeks to the tail), so the extra never reaches the screen.
const TRANSCRIPT_MAX: u64 = 256 * 1024;

/// Records the PTY byte stream so a reopened terminal shows what was there.
///
/// Owned solely by the reader thread (the only writer), so there's no lock on the
/// hot path. Growth is bounded by rewriting the file down to the last
/// `TRANSCRIPT_MAX` bytes once it reaches twice that — amortised, so the common
/// case is a plain append.
struct Transcript {
    path: PathBuf,
    file: std::fs::File,
    len: u64,
}

impl Transcript {
    fn open(dir: &std::path::Path, session: u64) -> Option<Self> {
        std::fs::create_dir_all(dir).ok()?;
        let path = dir.join(format!("{session}.log"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Self { path, file, len })
    }

    fn append(&mut self, buf: &[u8]) {
        if self.file.write_all(buf).is_err() {
            return;
        }
        self.len += buf.len() as u64;
        if self.len > TRANSCRIPT_MAX * 2 {
            self.compact();
        }
    }

    /// Keep the tail. The cut is moved forward to just after a newline so replay
    /// doesn't begin halfway through an escape sequence — imperfect (a long
    /// single-line TUI frame has no newline to find), but it costs nothing and
    /// fixes the common case.
    fn compact(&mut self) {
        let Ok(all) = std::fs::read(&self.path) else {
            return;
        };
        let start = all.len().saturating_sub(TRANSCRIPT_MAX as usize);
        let cut = all[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| start + i + 1)
            .unwrap_or(start);
        let tail = &all[cut..];
        if std::fs::write(&self.path, tail).is_err() {
            return;
        }
        match std::fs::OpenOptions::new().append(true).open(&self.path) {
            Ok(f) => {
                self.file = f;
                self.len = tail.len() as u64;
            }
            // Couldn't reopen: stop recording rather than write to a stale handle
            // that now points into a truncated file.
            Err(_) => self.len = 0,
        }
    }
}

/// Where transcripts live. Per-session files under the app data dir.
fn transcript_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("terminal-log"))
}

/// The recorded output for a session, if any, as the bytes to replay.
fn read_transcript(app: &AppHandle, session: u64) -> Option<Vec<u8>> {
    let path = transcript_dir(app)?.join(format!("{session}.log"));
    let mut f = std::fs::File::open(path).ok()?;
    // Only ever replay the tail, even if an older/larger file is lying around.
    let len = f.metadata().ok()?.len();
    if len > TRANSCRIPT_MAX {
        f.seek(SeekFrom::Start(len - TRANSCRIPT_MAX)).ok()?;
    }
    let mut out = Vec::new();
    f.read_to_end(&mut out).ok()?;
    (!out.is_empty()).then_some(out)
}

fn remove_transcript(app: &AppHandle, session: u64) {
    if let Some(dir) = transcript_dir(app) {
        let _ = std::fs::remove_file(dir.join(format!("{session}.log")));
    }
}

// ─── small path helpers (kept dependency-free in the scaffold) ──────────────

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into())
}

fn downloads_dir() -> String {
    format!("{}/Downloads", home_dir())
}

fn expand_home(path: &str) -> String {
    match path.strip_prefix('~') {
        Some(rest) => format!("{}{}", home_dir(), rest),
        None => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_mode_parsing() {
        // Back-compat: FLUX_TERM_PERSIST=1 has always meant "keep it running".
        for on in ["1", "true", "yes", "LIVE", " live "] {
            let m = parse_mode(on);
            assert!(m.live, "{on:?} enables the live half");
            assert!(
                !m.transcript,
                "{on:?} does not silently start writing to disk"
            );
        }
        for off in ["", "0", "off", "no", "none", "false"] {
            assert_eq!(parse_mode(off), PersistMode::default(), "{off:?} is off");
        }
        let t = parse_mode("transcript");
        assert!(t.transcript && !t.live);
        let both = parse_mode("both");
        assert!(both.live && both.transcript);
        // A combined form is honoured rather than read as off.
        let combo = parse_mode("live+transcript");
        assert!(combo.live && combo.transcript);
        // Something unrecognised mentions neither half, so nothing is enabled.
        assert_eq!(parse_mode("wibble"), PersistMode::default());
    }

    #[test]
    fn explicit_request_beats_the_env_fallback() {
        // A blank request defers to the env var; a real one (including "off")
        // decides on its own, so a UI setting can turn persistence off even with
        // FLUX_TERM_PERSIST exported.
        assert_eq!(resolve_mode(Some("off")), PersistMode::default());
        assert!(resolve_mode(Some("both")).live);
        assert!(resolve_mode(Some("both")).transcript);
        assert!(resolve_mode(Some("transcript")).transcript);
    }

    #[test]
    fn transcript_is_capped_and_keeps_the_tail() {
        let dir = std::env::temp_dir().join(format!("flux-term-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut t = Transcript::open(&dir, 7).expect("open transcript");

        // Well under the cap: a plain append, nothing dropped.
        t.append(b"hello\n");
        assert_eq!(std::fs::read(&t.path).unwrap(), b"hello\n");

        // Push it past the compaction trigger with identifiable lines.
        for i in 0..80_000u32 {
            t.append(format!("line {i}\n").as_bytes());
        }
        // Amortised: the file lives between one and two caps between rewrites,
        // which is what keeps the common path a plain append.
        let kept = std::fs::read(&t.path).unwrap();
        assert!(
            kept.len() as u64 <= TRANSCRIPT_MAX * 2,
            "grew to {} bytes, past the {} amortised bound",
            kept.len(),
            TRANSCRIPT_MAX * 2
        );
        let text = String::from_utf8_lossy(&kept);
        assert!(
            text.ends_with("line 79999\n"),
            "the newest output is what's kept"
        );
        assert!(!text.contains("hello"), "the oldest output is dropped");
        assert!(
            !text.starts_with("ine ") && text.starts_with("line "),
            "replay starts at a line boundary, not mid-line: {:?}",
            &text[..20.min(text.len())]
        );

        // A compaction itself lands under the cap, at a line boundary.
        t.compact();
        let packed = std::fs::read(&t.path).unwrap();
        assert!(
            packed.len() as u64 <= TRANSCRIPT_MAX,
            "compaction left {} bytes, over the {TRANSCRIPT_MAX} cap",
            packed.len()
        );
        let packed_text = String::from_utf8_lossy(&packed);
        assert!(packed_text.starts_with("line "), "cut at a line boundary");
        assert!(
            packed_text.ends_with("line 79999\n"),
            "kept the newest output"
        );

        // Recording continues after a compaction (the handle was reopened).
        t.append(b"after\n");
        let after = std::fs::read(&t.path).unwrap();
        assert!(String::from_utf8_lossy(&after).ends_with("after\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dtach_kill_pattern_requires_dtach() {
        let pat = dtach_kill_pattern(42);
        assert!(pat.contains("flux-term-42"), "targets one session: {pat}");
        // The guard that matters: `pkill -f` matches the whole command line, so
        // the socket path on its own also matches anything that merely mentions
        // it. Verified against a live decoy; don't simplify this back.
        assert!(
            pat.starts_with("dtach"),
            "the pattern must require dtach before the socket: {pat}"
        );
        assert_ne!(pat, dtach_socket(42), "never kill on the bare path");
    }
}
} // mod real
#[cfg(desktop)]
pub use real::*;

/// Mobile stub: same public surface (`TerminalManager`, `PANE_SESSION`, and the
/// four `terminal_*` commands) so nothing upstream changes; the commands report
/// that the embedded terminal is desktop-only.
#[cfg(mobile)]
mod stub {
    use crate::state::FluxState;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, State};

    pub const PANE_SESSION: u64 = 0;

    #[derive(Default)]
    pub struct TerminalManager;
    impl TerminalManager {
        pub fn new() -> Self {
            Self
        }
    }

    const UNAVAILABLE: &str = "the embedded terminal is desktop-only";

    #[tauri::command]
    pub fn terminal_spawn(
        _app: AppHandle,
        _state: State<'_, FluxState>,
        _manager: State<'_, TerminalManager>,
        _session: u64,
        _cols: u16,
        _rows: u16,
        _on_data: Channel<Vec<u8>>,
        _persist: Option<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn terminal_write(
        _manager: State<'_, TerminalManager>,
        _session: u64,
        _data: Vec<u8>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn terminal_resize(
        _manager: State<'_, TerminalManager>,
        _session: u64,
        _cols: u16,
        _rows: u16,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn terminal_kill(
        _app: AppHandle,
        _manager: State<'_, TerminalManager>,
        _session: u64,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}
#[cfg(mobile)]
pub use stub::*;
