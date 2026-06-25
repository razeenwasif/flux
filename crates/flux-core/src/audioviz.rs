//! Audio-visualiser bridge (#126) — relay the `audioviz` helper's level stream to
//! the music bubble. The helper (tools/audioviz, run in WSL) taps the PulseAudio
//! monitor and serves SSE level frames; we connect to it (proxying through Rust so
//! the webview CSP doesn't block `http://localhost`) and forward each frame over a
//! Tauri Channel. If the helper isn't running we start it once and retry.

use std::time::Duration;

use tauri::ipc::Channel;

fn base() -> String {
    std::env::var("FLUX_AUDIOVIZ_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:3232".into())
        .trim_end_matches('/')
        .to_string()
}

/// Best-effort launch of the helper (it backgrounds itself by being long-running;
/// we spawn-and-don't-wait, like the other managed services).
fn start_helper() {
    let cmd = std::env::var("FLUX_AUDIOVIZ_START")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "audioviz".into());
    let mut c = crate::exec::shell_command(&cmd);
    c.stdin(std::process::Stdio::null());
    c.stdout(std::process::Stdio::null());
    c.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = c.spawn();
}

/// Stream audio levels to `on_frame` as JSON strings (`{e,bass,mid,treble}`) until
/// the connection ends or the frontend drops the channel. Resolves when it stops.
#[tauri::command]
pub async fn audioviz_stream(on_frame: Channel<String>) -> Result<(), String> {
    let url = format!("{}/levels", base());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let connect = || ureq::get(&url).timeout(Duration::from_secs(3)).call();
        // Connect; if the helper isn't up, start it once and retry briefly.
        let resp = match connect() {
            Ok(r) => r,
            Err(_) => {
                start_helper();
                let mut got = None;
                for _ in 0..6 {
                    std::thread::sleep(Duration::from_millis(700));
                    if let Ok(r) = connect() {
                        got = Some(r);
                        break;
                    }
                }
                got.ok_or_else(|| {
                    format!("audioviz helper not reachable at {url} — build it once in WSL: `go build -o ~/.local/bin/audioviz ./tools/audioviz`")
                })?
            }
        };

        use std::io::BufRead;
        let mut reader = std::io::BufReader::new(resp.into_reader());
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // stream closed
                Ok(_) => {
                    if let Some(data) = line.trim().strip_prefix("data:") {
                        let payload = data.trim();
                        if !payload.is_empty() && on_frame.send(payload.to_string()).is_err() {
                            break; // frontend dropped the channel
                        }
                    }
                }
                Err(_) => break,
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
