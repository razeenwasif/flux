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
//! flux-term (the WGPU grid/renderer) is untouched and remains the future
//! native-render path; it would consume the same PTY bytes this module reads.

use std::collections::HashMap;
use std::io::{Read, Write};
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
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, FluxState>,
    manager: State<'_, TerminalManager>,
    session: u64,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
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
    // With FLUX_TERM_PERSIST set (and tmux installed), wrap each terminal in a
    // per-session tmux (attach-or-create) so the *live* session survives a Flux
    // restart: closing Flux detaches, reopening re-attaches `flux-<id>` (tab ids
    // persist via session restore #19). Best-effort: falls back to a plain shell
    // if tmux is missing. WSL/Unix only — native Windows shells have no tmux.
    let use_tmux = persist_enabled() && tmux_available();
    let tmux_name = format!("flux-{session}");

    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new(&shell);
        // WSL: start in the Linux home (~), not the translated Windows cwd
        // (/mnt/c/Users/...). `--cd` overrides the inherited working directory.
        if shell.to_ascii_lowercase().contains("wsl") {
            c.arg("--cd");
            c.arg("~");
            if use_tmux {
                for a in ["--", "tmux", "new-session", "-A", "-s", &tmux_name] {
                    c.arg(a);
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
    let mut cmd = if use_tmux {
        let mut c = CommandBuilder::new("tmux");
        for a in ["new-session", "-A", "-s", &tmux_name] {
            c.arg(a);
        }
        c
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
        },
    );

    // Reader thread: blocking reads off the PTY, batched into the channel.
    // Ends on EOF (shell exit) or error, then signals the frontend.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
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
pub fn terminal_kill(manager: State<'_, TerminalManager>, session: u64) -> Result<(), String> {
    if let Some(s) = manager.sessions.lock().remove(&session) {
        let _ = s.child.lock().kill();
    }
    if persist_enabled() && tmux_available() {
        kill_tmux_session(session);
    }
    Ok(())
}

/// Whether to wrap terminals in a persistent tmux session (`FLUX_TERM_PERSIST`).
fn persist_enabled() -> bool {
    std::env::var("FLUX_TERM_PERSIST")
        .map(|v| {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
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

/// Is `tmux` available (in WSL on Windows, locally on Unix)? Cached — the check
/// is a subprocess, and only persist-mode users ever reach it.
fn tmux_available() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(windows)]
        let mut c = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("wsl.exe");
            c.args(["--", "sh", "-c", "command -v tmux"]);
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(windows))]
        let mut c = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "command -v tmux"]);
            c
        };
        c.output().map(|o| o.status.success()).unwrap_or(false)
    })
}

/// Remove a leaked tmux session on explicit tab close (best-effort).
fn kill_tmux_session(session: u64) {
    let name = format!("flux-{session}");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("wsl.exe")
            .args(["--", "tmux", "kill-session", "-t", &name])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &name])
            .spawn();
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
