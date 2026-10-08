//! Audio-visualiser bridge (#126) — relay the `audioviz` helper's level stream to
//! the music bubble. The helper (tools/audioviz, run in WSL) taps the PulseAudio
//! monitor and serves SSE level frames; we connect to it (proxying through Rust so
//! the webview CSP doesn't block `http://localhost`) and forward each frame over a
//! Tauri Channel. If the helper isn't running we start it once and retry.

use std::time::{Duration, Instant};

use tauri::ipc::Channel;

/// At most one helper launch per this long. The frontend reconnects every ~7 s
/// while music plays, and a missing helper used to be re-spawned on every try.
const START_EVERY: Duration = Duration::from_secs(60);
static LAST_START: parking_lot::Mutex<Option<Instant>> = parking_lot::Mutex::new(None);

/// Longest one relay runs. `Channel::send` only fails once the webview itself is
/// gone, so an uncapped stream would outlive the music (or the bubble); the
/// frontend reconnects while something is still playing.
const SESSION_MAX: Duration = Duration::from_secs(600);

fn base() -> String {
    std::env::var("FLUX_AUDIOVIZ_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:3232".into())
        .trim_end_matches('/')
        .to_string()
}

/// Best-effort launch of the helper (it backgrounds itself by being long-running;
/// we spawn-and-don't-wait, like the other managed services). Reaped, so a helper
/// that exits, or a missing one (`sh -lc audioviz` → 127), leaves no zombie.
fn start_helper() {
    {
        let mut last = LAST_START.lock();
        if last.is_some_and(|t| t.elapsed() < START_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
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
    if let Err(e) = crate::exec::spawn_reaped(&mut c) {
        tracing::debug!(target: "flux::audioviz", error = %e, "couldn't start the audioviz helper");
    }
}

/// The `/levels` client. Not `Request::timeout`: in ureq 2 that is a whole-request
/// deadline that also bounds body reads, so it cut this endless SSE stream 3 s
/// after every connect. Bound the connect and each read instead: the helper sends
/// a frame every 25 ms, so 5 s without a byte means it's gone.
fn levels_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .build()
}

/// Stream audio levels to `on_frame` as JSON strings (`{e,bass,mid,treble}`) until
/// the connection ends, the frontend drops the channel, or [`SESSION_MAX`] passes.
/// Resolves when it stops.
#[tauri::command]
pub async fn audioviz_stream(on_frame: Channel<String>) -> Result<(), String> {
    let url = format!("{}/levels", base());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let agent = levels_agent();
        // The error detail is never used (any failure means "helper not up"), so
        // connect yields an Option — also keeps ureq's large error type off the stack.
        let connect = || agent.get(&url).call().ok();
        // Connect; if the helper isn't up, start it once and retry briefly.
        let resp = match connect() {
            Some(r) => r,
            None => {
                start_helper();
                let mut got = None;
                for _ in 0..6 {
                    std::thread::sleep(Duration::from_millis(700));
                    if let Some(r) = connect() {
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
        let started = Instant::now();
        while started.elapsed() < SESSION_MAX {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

    #[test]
    fn levels_stream_outlives_the_old_three_second_deadline() {
        // A helper-like SSE server: a frame every 50 ms for 3.6 s, then close.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/levels", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = sock.read(&mut [0u8; 2048]); // the request head
            let _ = sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            );
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(3600) {
                if sock.write_all(b"data: {\"e\":0.5}\n\n").is_err() {
                    return; // the client hung up
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });

        let started = Instant::now();
        let resp = levels_agent().get(&url).call().unwrap();
        let mut last_frame = Duration::ZERO;
        for line in std::io::BufReader::new(resp.into_reader()).lines() {
            match line {
                Ok(l) if l.starts_with("data:") => last_frame = started.elapsed(),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        server.join().unwrap();
        assert!(
            last_frame > Duration::from_millis(3300),
            "the stream was cut after {last_frame:?}"
        );
    }
}
