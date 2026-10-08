//! Run a shell command for the agent ("hey Gemma, run …"). One-shot: it runs the
//! command in the same shell the embedded terminal uses (MSYS2 on Windows), captures
//! stdout+stderr, and returns it. A safety **denylist** blocks `rm` and other
//! clearly-destructive commands so a mis-heard voice command can't wreck anything.
//!
//! This is deliberately NOT the interactive PTY terminal — it's for quick,
//! scriptable commands whose output comes back to the agent panel.

use std::process::{Command, Stdio};

/// Command basenames we refuse to run — `rm` (per request) + the obvious
/// catastrophes. Matched against *every* token, so `find … -exec rm` / `sudo rm`
/// / pipelines are caught too.
const DENY: &[&str] = &[
    "rm", "rmdir", "del", "erase", "rd", "unlink", "format", "mkfs", "dd", "fdisk", "diskpart",
    "wipefs", "shutdown", "reboot", "halt", "poweroff",
];

pub fn blocked_reason(cmd: &str) -> Option<String> {
    let c = cmd.trim();
    if c.is_empty() {
        return Some("no command given".into());
    }
    if c.contains(":(){") || c.contains(":|:&") {
        return Some("that looks like a fork bomb — refused".into());
    }
    for tok in
        c.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '(' | ')' | '`'))
    {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        let base = t
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(t)
            .to_ascii_lowercase();
        let base = base.strip_suffix(".exe").unwrap_or(&base);
        if DENY.contains(&base) {
            return Some(format!(
                "`{base}` is blocked for safety — the agent won't run destructive commands"
            ));
        }
    }
    None
}

/// Keep a console program from opening a window. Release Flux is a GUI-subsystem
/// binary on Windows, so every console child (tesseract, whisper, piper,
/// wsl.exe) otherwise gets a console window of its own, even with piped stdio.
pub(crate) fn no_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Build the command in the right shell: an explicit `FLUX_EXEC_SHELL`/`FLUX_SHELL`,
/// else MSYS2 bash on Windows (matching the embedded terminal) / `sh` elsewhere.
///
/// Matching the terminal is the whole point — `shellhist` reads `~/.bash_history`
/// through here, and a one-shot that lands in a different shell's home reads a
/// history the user never typed.
pub(crate) fn shell_command(cmd: &str) -> Command {
    if let Some(sh) = std::env::var("FLUX_EXEC_SHELL")
        .ok()
        .or_else(|| std::env::var("FLUX_SHELL").ok())
        .filter(|s| !s.trim().is_empty())
    {
        let low = sh.to_ascii_lowercase();
        let mut c = Command::new(&sh);
        if low.contains("cmd.exe") || low.ends_with("cmd") {
            c.args(["/C", cmd]);
        } else if low.contains("powershell") || low.contains("pwsh") {
            c.args(["-NoProfile", "-Command", cmd]);
        } else {
            c.args(["-lc", cmd]);
            #[cfg(windows)]
            crate::msys::configure(&mut c, false);
        }
        return c;
    }
    #[cfg(windows)]
    {
        // The same bash the terminal spawns, as a login shell so $MSYSTEM's PATH
        // is built before the command runs. No install found → PowerShell, which
        // at least reaches the Windows-side tools.
        match crate::msys::login_command(cmd) {
            Some(c) => c,
            None => {
                let mut c = Command::new("powershell.exe");
                c.args(["-NoProfile", "-Command", cmd]);
                c
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-lc", cmd]);
        c
    }
}

/// Spawn a fire-and-forget process and reap it when it exits; returns its pid.
/// Dropping a `Child` never waits on it, so on Unix every such process that
/// exited stayed a zombie, holding a slot against the per-user process limit,
/// until Flux quit. Kills nothing: a long-lived child keeps running as before.
pub(crate) fn spawn_reaped(cmd: &mut Command) -> std::io::Result<u32> {
    let mut child = cmd.spawn()?;
    let pid = child.id();
    // A failed thread spawn just leaves this one unreaped, as before.
    let _ = std::thread::Builder::new()
        .name("flux-reap".into())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(pid)
}

/// Safety pre-check for a command we're about to *type into the live terminal*
/// (which bypasses `run_shell`'s capture path): returns the block reason, or None
/// if it's allowed. Same denylist as the headless run.
#[tauri::command]
pub fn shell_guard(command: String) -> Option<String> {
    blocked_reason(&command)
}

/// Run `command` synchronously and return combined stdout+stderr (trimmed),
/// applying the same safety denylist as [`run_shell`]. Returns `Ok` **only when
/// the process exits successfully** — a non-zero exit (e.g. `pac: command not
/// found`, exit 127) comes back as `Err`, so callers can distinguish "ran and
/// printed" from "failed", which the shared `run_shell` path deliberately blurs.
/// Used by read-only preflights like `pac_status`.
struct BoundedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: std::process::ExitStatus,
    timed_out: bool,
    truncated: bool,
}

fn drain_pipe<R: std::io::Read>(mut reader: R, limit: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 4096];
    while let Ok(n) = reader.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if buf.len() < limit {
            let take = (limit - buf.len()).min(n);
            buf.extend_from_slice(&chunk[..take]);
            if take < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
    (buf, truncated)
}

fn run_bounded(
    mut cmd: Command,
    timeout: std::time::Duration,
    limit: usize,
) -> Result<BoundedOutput, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // Own process group, so the deadline can take down everything the shell
    // started: a grandchild (`cd x && npm run dev`, `a | b`) inherits the pipes,
    // and killing only `sh` left the drains below blocked on it forever.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't run the command: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let timed_out_watcher = std::sync::Arc::clone(&timed_out);

    let child_arc = std::sync::Arc::new(parking_lot::Mutex::new(child));
    let child_watcher = std::sync::Arc::clone(&child_arc);

    let (tx_done, rx_done) = std::sync::mpsc::channel();
    let watcher = std::thread::spawn(move || {
        if rx_done.recv_timeout(timeout).is_err() {
            timed_out_watcher.store(true, std::sync::atomic::Ordering::SeqCst);
            // The shell isn't reaped until `wait` below, so its pid (the group
            // id) can't have been reused yet.
            kill_tree(pid);
            let mut guard = child_watcher.lock();
            let _ = guard.kill();
        }
    });

    let (stdout_res, stderr_res) = std::thread::scope(|s| {
        let t1 = s.spawn(|| {
            if let Some(r) = stdout {
                drain_pipe(r, limit)
            } else {
                (Vec::new(), false)
            }
        });
        let t2 = s.spawn(|| {
            if let Some(r) = stderr {
                drain_pipe(r, limit)
            } else {
                (Vec::new(), false)
            }
        });
        (t1.join().unwrap_or_default(), t2.join().unwrap_or_default())
    });

    let _ = tx_done.send(());
    let _ = watcher.join();

    let was_timed_out = timed_out.load(std::sync::atomic::Ordering::SeqCst);
    let mut child = std::sync::Arc::try_unwrap(child_arc)
        .map_err(|_| "failed to unwrap child process handle".to_string())?
        .into_inner();
    let status = child.wait().map_err(|e| format!("wait failed: {e}"))?;

    Ok(BoundedOutput {
        stdout: stdout_res.0,
        stderr: stderr_res.0,
        status,
        timed_out: was_timed_out,
        truncated: stdout_res.1 || stderr_res.1,
    })
}

/// Kill `pid` and everything it started: on Unix its process group (set up by
/// `process_group(0)`), on Windows its process tree.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-s", "KILL", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Run `command` synchronously and return combined stdout+stderr (trimmed),
/// applying the same safety denylist as [`run_shell`]. Returns `Ok` **only when
/// the process exits successfully** — a non-zero exit (e.g. `pac: command not
/// found`, exit 127) comes back as `Err`, so callers can distinguish "ran and
/// printed" from "failed", which the shared `run_shell` path deliberately blurs.
/// Used by read-only preflights like `pac_status`.
pub(crate) fn run_captured(command: &str) -> Result<String, String> {
    if let Some(reason) = blocked_reason(command) {
        return Err(reason);
    }
    let cmd = shell_command(command);
    let out = run_bounded(cmd, std::time::Duration::from_secs(30), 64 * 1024)?;
    if out.timed_out {
        return Err("command timed out".into());
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let text = text.trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            "command failed".into()
        } else {
            text
        })
    }
}

/// Run `command` and return its output (truncated). stdin is closed so commands
/// that would wait for input get EOF instead of hanging. Output is bounded to 64 KiB
/// during collection and execution has a 60-second deadline (#13).
#[tauri::command]
pub async fn run_shell(command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(reason) = blocked_reason(&command) {
            return Err(reason);
        }
        let cmd = shell_command(&command);
        let out = run_bounded(cmd, std::time::Duration::from_secs(60), 64 * 1024)?;
        if out.timed_out {
            return Err("command timed out after 60 seconds".into());
        }
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&err);
        }
        let text = text.trim();
        let shown: String = if text.chars().count() > 4000 || out.truncated {
            text.chars().take(4000).collect::<String>() + "\n…(truncated)"
        } else {
            text.to_string()
        };
        if out.status.success() {
            Ok(if shown.is_empty() {
                "(done, no output)".into()
            } else {
                shown
            })
        } else {
            let code = out.status.code().unwrap_or(-1);
            Ok(if shown.is_empty() {
                format!("(exit {code}, no output)")
            } else {
                format!("{shown}\n(exit {code})")
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_commands_are_refused() {
        assert!(blocked_reason("rm -rf /").is_some());
        assert!(blocked_reason("del /f /q foo").is_some());
        assert!(blocked_reason("echo ok").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_reaped_leaves_no_zombie() {
        // A dropped `Child` that exits lingers as a zombie ("Z" in ps) until we
        // quit. Reaped, its pid disappears from the process table.
        let pid = spawn_reaped(&mut Command::new("true")).unwrap().to_string();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let ps = Command::new("ps")
                .args(["-o", "stat=", "-p", &pid])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&ps.stdout).trim().is_empty() {
                break; // gone: reaped
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child {pid} was never reaped"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn bounded_drain_caps_output() {
        let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            cmd.args(["/c", "echo 12345678901234567890"]);
        } else {
            cmd.args(["-c", "echo 12345678901234567890"]);
        }
        let out = run_bounded(cmd, std::time::Duration::from_secs(5), 10).unwrap();
        assert!(out.truncated);
        assert_eq!(out.stdout.len(), 10);
    }

    #[test]
    fn run_bounded_terminates_on_timeout() {
        let mut cmd = Command::new(if cfg!(windows) { "powershell" } else { "sh" });
        if cfg!(windows) {
            cmd.args(["-Command", "Start-Sleep -Seconds 5"]);
        } else {
            cmd.args(["-c", "sleep 5"]);
        }
        let out = run_bounded(cmd, std::time::Duration::from_millis(200), 1024).unwrap();
        assert!(out.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn the_deadline_also_kills_what_the_shell_started() {
        // `sleep | cat` forks: both children hold the stdout pipe, and killing
        // only `sh` left the drains (and this call) waiting on them.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5 | cat; true"]);
        let started = std::time::Instant::now();
        let out = run_bounded(cmd, std::time::Duration::from_millis(200), 1024).unwrap();
        assert!(out.timed_out);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "returned only after {:?}",
            started.elapsed()
        );
    }
}
