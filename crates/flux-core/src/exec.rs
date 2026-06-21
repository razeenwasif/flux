//! Run a shell command for the agent ("hey Gemma, run …"). One-shot: it runs the
//! command in the same shell the embedded terminal uses (WSL on Windows), captures
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
    "rm", "rmdir", "del", "erase", "rd", "unlink",
    "format", "mkfs", "dd", "fdisk", "diskpart", "wipefs",
    "shutdown", "reboot", "halt", "poweroff",
];

pub fn blocked_reason(cmd: &str) -> Option<String> {
    let c = cmd.trim();
    if c.is_empty() {
        return Some("no command given".into());
    }
    if c.contains(":(){") || c.contains(":|:&") {
        return Some("that looks like a fork bomb — refused".into());
    }
    for tok in c.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '(' | ')' | '`')) {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        let base = t.rsplit(['/', '\\']).next().unwrap_or(t).to_ascii_lowercase();
        let base = base.strip_suffix(".exe").unwrap_or(&base);
        if DENY.contains(&base) {
            return Some(format!("`{base}` is blocked for safety — the agent won't run destructive commands"));
        }
    }
    None
}

/// Build the command in the right shell: an explicit `FLUX_EXEC_SHELL`/`FLUX_SHELL`,
/// else WSL on Windows (matching the embedded terminal) / `sh` elsewhere.
fn shell_command(cmd: &str) -> Command {
    if let Some(sh) = std::env::var("FLUX_EXEC_SHELL").ok().or_else(|| std::env::var("FLUX_SHELL").ok()).filter(|s| !s.trim().is_empty()) {
        let low = sh.to_ascii_lowercase();
        let mut c = Command::new(&sh);
        if low.contains("wsl") {
            c.args(["--", "bash", "-lc", cmd]);
        } else if low.contains("cmd") {
            c.args(["/C", cmd]);
        } else if low.contains("powershell") || low.contains("pwsh") {
            c.args(["-NoProfile", "-Command", cmd]);
        } else {
            c.args(["-lc", cmd]);
        }
        return c;
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("wsl.exe");
        c.args(["--", "bash", "-lc", cmd]);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-lc", cmd]);
        c
    }
}

/// Safety pre-check for a command we're about to *type into the live terminal*
/// (which bypasses `run_shell`'s capture path): returns the block reason, or None
/// if it's allowed. Same denylist as the headless run.
#[tauri::command]
pub fn shell_guard(command: String) -> Option<String> {
    blocked_reason(&command)
}

/// Run `command` and return its output (truncated). stdin is closed so commands
/// that would wait for input get EOF instead of hanging.
#[tauri::command]
pub async fn run_shell(command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(reason) = blocked_reason(&command) {
            return Err(reason);
        }
        let out = shell_command(&command)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't run the command: {e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&err);
        }
        let text = text.trim();
        let shown: String = if text.chars().count() > 4000 {
            text.chars().take(4000).collect::<String>() + "\n…(truncated)"
        } else {
            text.to_string()
        };
        if out.status.success() {
            Ok(if shown.is_empty() { "(done, no output)".into() } else { shown })
        } else {
            let code = out.status.code().unwrap_or(-1);
            Ok(if shown.is_empty() { format!("(exit {code}, no output)") } else { format!("{shown}\n(exit {code})") })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
