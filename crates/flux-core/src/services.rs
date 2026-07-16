//! Local background services (#KB) — auto-start the user's Omni search engine and
//! Scroll clipper so the KB / omnibox / clip features just work without manually
//! launching them. Each service has a health probe and a start command run through
//! the user's shell (so on a Windows build they launch inside WSL, where they live).
//! Start commands background themselves (`nohup … &`) and survive Flux closing.
//!
//! Auto-start runs once on boot for any service that's down; opt out with
//! `FLUX_NO_AUTOSTART=1`. Commands `services_status` / `services_start` drive the UI.

use std::time::Duration;

use serde::Serialize;

/// A managed local service.
struct Service {
    name: &'static str,
    label: &'static str,
    /// Env var holding its base URL, and the default.
    url_env: &'static str,
    url_default: &'static str,
    /// Path appended to the base URL to probe (any HTTP response = up).
    health_path: &'static str,
    /// Env var overriding the start command, and the default (a shell command line).
    start_env: &'static str,
    start_default: &'static str,
}

const SERVICES: &[Service] = &[
    Service {
        name: "omni",
        label: "Omni",
        url_env: "FLUX_OMNI_URL",
        url_default: "http://localhost:8080",
        health_path: "/health",
        start_env: "FLUX_OMNI_START",
        start_default: "~/Omni/scripts/serve.sh",
    },
    Service {
        name: "scroll",
        label: "Scroll",
        url_env: "FLUX_SCROLL_URL",
        url_default: "http://localhost:3131",
        health_path: "/clip",
        start_env: "FLUX_SCROLL_START",
        start_default: "scroll serve",
    },
];

#[derive(Serialize, Clone, specta::Type)]
pub struct ServiceStatus {
    pub name: String,
    pub label: String,
    pub running: bool,
}

fn base_url(s: &Service) -> String {
    std::env::var(s.url_env)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| s.url_default.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Is the service responding? Any HTTP reply (even a 404) means the port is up;
/// only a transport error (connection refused) means it's down.
fn is_up(s: &Service) -> bool {
    let url = format!("{}{}", base_url(s), s.health_path);
    match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
        Ok(_) => true,
        Err(ureq::Error::Status(_, _)) => true,
        Err(ureq::Error::Transport(_)) => false,
    }
}

/// Launch a service's start command. We spawn it in the FOREGROUND of the shell
/// process and simply don't wait on it: the shell (e.g. `wsl.exe`) stays alive
/// hosting the long-running server, which keeps the WSL session up and survives
/// Flux closing (a dropped `Child` is never killed). This is more reliable than
/// `nohup … &`, whose orphaned job can die with the transient one-shot session.
fn start(s: &Service) -> Result<(), String> {
    let user_cmd = std::env::var(s.start_env)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| s.start_default.to_string());
    let mut cmd = crate::exec::shell_command(&user_cmd);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (no console flash)
    }
    // spawn() (not output()/wait) returns immediately; we drop the Child, which
    // does NOT kill it — the server keeps running.
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't start {}: {e}", s.name))
}

fn autostart_enabled() -> bool {
    !std::env::var("FLUX_NO_AUTOSTART")
        .map(|v| {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
}

/// Start any managed service that isn't already up. Called once on boot (best-effort,
/// off-thread) unless `FLUX_NO_AUTOSTART` is set.
pub fn autostart_down_services() {
    if !autostart_enabled() {
        return;
    }
    for s in SERVICES {
        if !is_up(s) {
            match start(s) {
                Ok(()) => {
                    tracing::info!(target: "flux::services", service = s.name, "auto-started")
                }
                Err(e) => tracing::warn!(target: "flux::services", service = s.name, "{e}"),
            }
        }
    }
}

#[tauri::command]
pub async fn services_status() -> Vec<ServiceStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        SERVICES
            .iter()
            .map(|s| ServiceStatus {
                name: s.name.to_string(),
                label: s.label.to_string(),
                running: is_up(s),
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Start one service by name (manual trigger from the UI). No-op if already up.
#[tauri::command]
pub async fn services_start(name: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = SERVICES
            .iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("unknown service: {name}"))?;
        if is_up(s) {
            return Ok(false); // already running
        }
        start(s).map(|_| true)
    })
    .await
    .map_err(|e| e.to_string())?
}
