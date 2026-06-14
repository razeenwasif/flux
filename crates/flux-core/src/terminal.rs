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

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::state::FluxState;

/// Reserved session id for the always-available vertical terminal column.
pub const PANE_SESSION: u64 = 0;

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
        // PowerShell is a far better default than cmd.exe and ships on every
        // Windows; resolved via PATH at spawn.
        "powershell.exe".to_string()
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
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    // Build the shell command with the Flux context environment — this is what
    // makes `cd $FLUX_TAB_DIR` / `flux extract-json` work the moment the shell
    // opens (the env bridge from `commands::terminal_env`, reused here).
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FLUX_SESSION", session.to_string());
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

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

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
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string());
    result
}

/// Kill and drop a session (tab/pane closed).
#[tauri::command]
pub fn terminal_kill(manager: State<'_, TerminalManager>, session: u64) -> Result<(), String> {
    if let Some(s) = manager.sessions.lock().remove(&session) {
        let _ = s.child.lock().kill();
    }
    Ok(())
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
