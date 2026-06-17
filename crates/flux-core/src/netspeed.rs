//! Built-in network speed test (Ookla-style) — download / upload / latency.
//!
//! Measures throughput against Cloudflare's public speed-test backend
//! (`speed.cloudflare.com`, the same endpoints the web speedtest uses), so no
//! API key or bundled server is needed:
//!   * `GET /__down?bytes=N` — returns N incompressible bytes (download + ping).
//!   * `POST /__up`          — accepts an N-byte body (upload).
//!
//! Latency is the **minimum** round-trip over several tiny requests (min rejects
//! scheduler/GC jitter better than the mean); jitter is the mean absolute
//! difference between consecutive samples. Throughput reads the stream for up to
//! a time cap so a slow link still finishes promptly. The math is factored into
//! pure helpers and unit-tested; the network calls run off-thread and stream
//! phase progress to the UI over `flux://netspeed-progress`.

use std::io::Read;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const DOWN_URL: &str = "https://speed.cloudflare.com/__down";
const UP_URL: &str = "https://speed.cloudflare.com/__up";
const SERVER: &str = "speed.cloudflare.com";

/// Ping samples to take.
const PING_SAMPLES: usize = 6;
/// Download ceiling + time cap (whichever comes first).
const DOWN_BYTES: u64 = 50_000_000;
const DOWN_MAX_SECS: f64 = 8.0;
/// Upload payload size.
const UP_BYTES: usize = 10_000_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SpeedResult {
    pub ping_ms: f64,
    pub jitter_ms: f64,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub server: String,
}

/// Throughput in megabits per second from a byte count over a duration.
fn mbps(bytes: u64, secs: f64) -> f64 {
    if secs <= 0.0 {
        return 0.0;
    }
    (bytes as f64 * 8.0) / secs / 1_000_000.0
}

/// (min latency, mean jitter) in ms from RTT samples. Empty → (0, 0).
fn ping_stats(samples: &[f64]) -> (f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
    let jitter = if samples.len() < 2 {
        0.0
    } else {
        let sum: f64 = samples.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
        sum / (samples.len() - 1) as f64
    };
    (min, jitter)
}

fn build_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .build()
}

fn measure_ping(agent: &ureq::Agent) -> Result<(f64, f64), String> {
    let mut samples = Vec::with_capacity(PING_SAMPLES);
    for _ in 0..PING_SAMPLES {
        let t = Instant::now();
        let resp = agent.get(&format!("{DOWN_URL}?bytes=0")).call().map_err(|e| e.to_string())?;
        // Drain the (empty) body so the round-trip is complete before timing.
        let mut sink = Vec::new();
        let _ = resp.into_reader().read_to_end(&mut sink);
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(ping_stats(&samples))
}

fn measure_download(agent: &ureq::Agent) -> Result<f64, String> {
    let resp = agent.get(&format!("{DOWN_URL}?bytes={DOWN_BYTES}")).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 65_536];
    let mut total = 0u64;
    let start = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 || start.elapsed().as_secs_f64() >= DOWN_MAX_SECS {
            total += n as u64;
            break;
        }
        total += n as u64;
    }
    Ok(mbps(total, start.elapsed().as_secs_f64()))
}

fn measure_upload(agent: &ureq::Agent) -> Result<f64, String> {
    // Incompressible-ish payload so the link, not gzip, is measured.
    let payload = vec![0x5Au8; UP_BYTES];
    let start = Instant::now();
    let resp = agent.post(UP_URL).send_bytes(&payload).map_err(|e| e.to_string())?;
    let _ = resp.into_string();
    Ok(mbps(UP_BYTES as u64, start.elapsed().as_secs_f64()))
}

/// Run the full test, calling `progress` with each phase name as it starts.
fn run_test(agent: &ureq::Agent, progress: impl Fn(&str)) -> Result<SpeedResult, String> {
    progress("ping");
    let (ping_ms, jitter_ms) = measure_ping(agent)?;
    progress("download");
    let download_mbps = measure_download(agent)?;
    progress("upload");
    let upload_mbps = measure_upload(agent)?;
    progress("done");
    Ok(SpeedResult { ping_ms, jitter_ms, download_mbps, upload_mbps, server: SERVER.into() })
}

/// Run a speed test off the main thread, emitting `flux://netspeed-progress`
/// (`"ping"` → `"download"` → `"upload"` → `"done"`) and returning the result.
#[tauri::command]
pub async fn netspeed_run(app: AppHandle) -> Result<SpeedResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = build_agent();
        run_test(&agent, |phase| {
            let _ = app.emit("flux://netspeed-progress", phase);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mbps_conversion() {
        // 12.5 MB in 1 s = 100 Mbit/s.
        assert!((mbps(12_500_000, 1.0) - 100.0).abs() < 1e-6);
        assert_eq!(mbps(1_000_000, 0.0), 0.0); // guard against div-by-zero
        // 100 MB in 8 s = 100 Mbit/s.
        assert!((mbps(100_000_000, 8.0) - 100.0).abs() < 1e-6);
    }

    #[test]
    fn ping_stats_min_and_jitter() {
        let (min, jitter) = ping_stats(&[20.0, 24.0, 22.0]);
        assert_eq!(min, 20.0);
        // |24-20| + |22-24| = 4 + 2 = 6, /2 = 3.0
        assert!((jitter - 3.0).abs() < 1e-6);
    }

    #[test]
    fn ping_stats_edge_cases() {
        assert_eq!(ping_stats(&[]), (0.0, 0.0));
        assert_eq!(ping_stats(&[15.0]), (15.0, 0.0)); // single sample → no jitter
    }
}
