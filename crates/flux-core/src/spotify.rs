//! AudioPulse / Spotify bridge — control playback by NL through the agent.
//!
//! AudioPulse (the user's Go TUI) plays via an embedded librespot Spotify Connect
//! device controlled by the Spotify Web API, and caches its OAuth token at
//! `~/.config/audiopulse/token.json` (client id in `config.json`). We **reuse
//! that token** (Path A — no changes to AudioPulse) and drive the Web API
//! directly: when AudioPulse is running, its device is the active one, so
//! play/pause/next here control exactly what it's playing (its TUI re-polls).
//!
//! Token handling is lazy + robust: try the cached access token; on 401 refresh
//! it via the refresh-token + client id (PKCE public client, no secret, like
//! AudioPulse) and retry. Spotify rotates a PKCE client's refresh token on every
//! refresh and revokes the old one, so refreshes are serialized, a newer token
//! AudioPulse wrote is adopted instead of spending the refresh token again, and
//! a rotated pair is merged back into AudioPulse's token file.

use std::path::{Path, PathBuf};
use std::sync::RwLock;
// The AudioPulse launcher runs a TUI in a headless PTY — desktop-only (ADR 0012:
// `portable-pty`'s `termios` doesn't build for Android, and there's no local
// AudioPulse binary on a phone anyway). The Web-API player commands are HTTP and
// stay on every platform.
#[cfg(desktop)]
use std::sync::Mutex;
use std::time::Duration;

#[cfg(desktop)]
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";

/// In-memory refreshed access token (avoids a refresh per call).
static ACCESS: RwLock<Option<String>> = RwLock::new(None);
/// Serializes refreshes: the refresh token is single-use, so two calls that 401
/// together (the bubble's poll and a command) must not both spend it.
static REFRESH_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// UI-set config-dir override (Settings → Integrations), checked before the env
/// var. Lets the user paste the `\\wsl.localhost\<distro>\…` path once.
static OVERRIDE_DIR: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, with "") the AudioPulse config-dir override from Settings.
#[tauri::command]
pub fn spotify_set_dir(path: String) {
    if let Ok(mut g) = OVERRIDE_DIR.write() {
        *g = if path.trim().is_empty() {
            None
        } else {
            Some(path)
        };
    }
}

/// Locate AudioPulse's config dir (holds `token.json` + `config.json`).
///
/// The tricky case: Flux's native **Windows** build has no `HOME`, and AudioPulse
/// runs in **WSL**, so its config lives on the WSL filesystem. We (1) honour an
/// explicit `FLUX_AUDIOPULSE_DIR` override, (2) use the normal XDG/`HOME` path on
/// Linux/WSL, and (3) on Windows probe `\\wsl$\<distro>\home\<user>\.config\
/// audiopulse` so it usually "just works" across the boundary.
fn ap_config_dir() -> Option<PathBuf> {
    if let Some(d) = OVERRIDE_DIR
        .read()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| !s.trim().is_empty())
    {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("FLUX_AUDIOPULSE_DIR") {
        return Some(PathBuf::from(d));
    }
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(x).join("audiopulse"));
    }
    if let Some(h) = std::env::var_os("HOME") {
        return Some(PathBuf::from(h).join(".config").join("audiopulse"));
    }
    #[cfg(windows)]
    if let Some(d) = wsl_probe() {
        return Some(d);
    }
    None
}

/// Scan the WSL 9P mounts for an AudioPulse config (Windows only). Looks for the
/// first `\\wsl$\*\home\*\.config\audiopulse\token.json`.
#[cfg(windows)]
fn wsl_probe() -> Option<PathBuf> {
    for root in ["\\\\wsl.localhost", "\\\\wsl$"] {
        let Ok(distros) = std::fs::read_dir(root) else {
            continue;
        };
        for distro in distros.flatten() {
            let Ok(users) = std::fs::read_dir(distro.path().join("home")) else {
                continue;
            };
            for user in users.flatten() {
                let cand = user.path().join(".config").join("audiopulse");
                if cand.join("token.json").is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[derive(Deserialize)]
struct TokenFile {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
}
#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    client_id: String,
}

/// (access_token, refresh_token, client_id) read from AudioPulse's config.
fn read_creds() -> Result<(String, String, String), String> {
    let dir = ap_config_dir().ok_or(
        "can't find AudioPulse's config. On a Windows build, set FLUX_AUDIOPULSE_DIR to the WSL path, \
         e.g. \\\\wsl.localhost\\Ubuntu\\home\\<you>\\.config\\audiopulse",
    )?;
    let tpath = dir.join("token.json");
    // Surface the real read error (vs a generic "no token") — on Windows this
    // distinguishes a path/WSL-mount problem ("cannot find the path") from perms
    // ("access denied") from a genuinely-missing/empty token.
    let raw = std::fs::read_to_string(&tpath).map_err(|e| {
        format!(
            "can't read {} ({e}). On Windows, try FLUX_AUDIOPULSE_DIR with the \\\\wsl.localhost\\<distro>\\… form \
             and make sure WSL is running.",
            tpath.display()
        )
    })?;
    let tok: TokenFile = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "{} isn't a valid AudioPulse token file: {e}",
            tpath.display()
        )
    })?;
    if tok.access_token.is_empty() {
        return Err(
            "AudioPulse's token.json has no access_token — log in to Spotify in AudioPulse".into(),
        );
    }
    let cfg: ConfigFile = std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(ConfigFile {
            client_id: String::new(),
        });
    Ok((tok.access_token, tok.refresh_token, cfg.client_id))
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
}

fn current_access() -> Result<String, String> {
    if let Some(t) = ACCESS.read().ok().and_then(|g| g.clone()) {
        return Ok(t);
    }
    Ok(read_creds()?.0)
}

/// A new access token after `stale` got a 401 (refresh-token grant, public
/// client). Caches it. The flag says whether it was just minted: `false` means
/// an already-refreshed token was adopted, which may have expired since.
fn refresh(stale: &str) -> Result<(String, bool), String> {
    let _gate = REFRESH_GATE.lock().unwrap_or_else(|e| e.into_inner());
    // Another call refreshed while this one waited for the gate.
    if let Some(t) = ACCESS.read().ok().and_then(|g| g.clone()) {
        if t != stale {
            return Ok((t, false));
        }
    }
    let (file_at, rt, cid) = read_creds()?;
    // AudioPulse refreshed on its own: adopt its token rather than spend the
    // refresh token out from under it.
    if file_at != stale {
        if let Ok(mut g) = ACCESS.write() {
            *g = Some(file_at.clone());
        }
        return Ok((file_at, false));
    }
    if rt.is_empty() || cid.is_empty() {
        return Err("can't refresh the Spotify token (AudioPulse hasn't stored a refresh token / client id)".into());
    }
    let resp = http()
        .post(TOKEN_URL)
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &rt),
            ("client_id", &cid),
        ])
        .map_err(|e| format!("spotify token refresh failed: {e}"))?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    let at = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("no access_token in the refresh response")?
        .to_string();
    // The old refresh token is revoked now. Without the new one on disk,
    // AudioPulse (and our own next refresh) would be left with a dead token.
    if let Some(new_rt) = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        if let Some(Err(e)) =
            ap_config_dir().map(|d| store_rotated(&d.join("token.json"), &at, new_rt))
        {
            tracing::warn!(target: "flux::spotify", error = %e, "couldn't save the rotated Spotify refresh token");
        }
    }
    if let Ok(mut g) = ACCESS.write() {
        *g = Some(at.clone());
    }
    Ok((at, true))
}

/// Merge a rotated token pair into AudioPulse's token.json, keeping its other
/// fields. An atomic replace whose temp file gets the original's mode from the
/// start (normally 0600): this is a long-lived credential, and
/// `persist::write_atomic` would create it with the umask default.
fn store_rotated(path: &Path, access: &str, refresh: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| std::io::Error::other("token.json isn't a JSON object"))?;
    obj.insert("access_token".into(), json!(access));
    obj.insert("refresh_token".into(), json!(refresh));
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".flux-{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    let _ = std::fs::remove_file(&tmp); // left over from a crash
    let written = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            opts.mode(std::fs::metadata(path)?.mode() & 0o777);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&serde_json::to_vec(&v)?)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// One Web API call with a 401-refresh-retry. Returns the JSON body (or `None`
/// for 204 No Content, which the playback control endpoints return on success).
fn api(
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
) -> Result<Option<Value>, String> {
    // The token the last attempt was refused with, and whether the refresh that
    // replaced it minted a new one (or only adopted an existing one).
    let mut stale = String::new();
    let mut minted = false;
    for attempt in 0..3u8 {
        let token = if attempt == 0 {
            current_access()?
        } else {
            let (token, fresh) = refresh(&stale)?;
            minted = fresh;
            token
        };
        let url = format!("{API}{path}");
        let ag = http();
        let mut req = match method {
            "PUT" => ag.put(&url),
            "POST" => ag.post(&url),
            _ => ag.get(&url),
        };
        for (k, v) in query {
            req = req.query(k, v);
        }
        req = req.set("Authorization", &format!("Bearer {token}"));
        let res = match (&body, method) {
            (Some(b), _) => req.send_json(b.clone()),
            // Spotify's PUT/POST control endpoints (pause, next, …) reject a
            // bodyless request with 411 Length Required — send an explicit empty
            // body so a `Content-Length: 0` header is set. GET stays bodyless.
            (None, "PUT" | "POST") => req.send_bytes(&[]),
            (None, _) => req.call(),
        };
        match res {
            Ok(resp) => {
                if resp.status() == 204 {
                    return Ok(None);
                }
                return Ok(resp.into_json::<Value>().ok());
            }
            // Expired → refresh + retry; once more if the refresh only adopted a
            // token (AudioPulse's) that has expired as well.
            Err(ureq::Error::Status(401, _)) if attempt == 0 || !minted => {
                stale = token;
                continue;
            }
            Err(ureq::Error::Status(404, _)) => {
                // No active device — auto-start AudioPulse (idempotent) so the
                // retry works once its Connect device registers.
                #[cfg(desktop)]
                let started = launch_audiopulse().is_ok();
                #[cfg(mobile)]
                let started = false; // no AudioPulse to auto-start on mobile
                return Err(if started {
                    "no active device yet — I'm starting AudioPulse; give it a few seconds and ask again".into()
                } else {
                    "no active Spotify device — start AudioPulse (or open Spotify) and try again"
                        .into()
                });
            }
            Err(ureq::Error::Status(code, r)) => {
                let msg: String = r
                    .into_string()
                    .unwrap_or_default()
                    .chars()
                    .take(180)
                    .collect();
                return Err(format!("spotify {code}: {msg}"));
            }
            Err(e) => return Err(format!("spotify request failed: {e}")),
        }
    }
    Err("spotify authorization failed".into())
}

fn search_track(q: &str) -> Result<(String, String, String), String> {
    let v = api(
        "GET",
        "/search",
        &[("q", q), ("type", "track"), ("limit", "1")],
        None,
    )?
    .ok_or("empty search response")?;
    let item = v
        .get("tracks")
        .and_then(|t| t.get("items"))
        .and_then(|i| i.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("no track found for “{q}”"))?;
    let uri = item
        .get("uri")
        .and_then(|x| x.as_str())
        .ok_or("track has no uri")?
        .to_string();
    let name = item
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let artist = item
        .get("artists")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.get("name"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok((uri, name, artist))
}

fn track_label(name: &str, artist: &str) -> String {
    if artist.is_empty() {
        format!("“{name}”")
    } else {
        format!("“{name}” — {artist}")
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Search for `query` and start playing the top match.
#[tauri::command]
pub async fn spotify_play(query: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim();
        if q.is_empty() {
            return Err("what should I play?".into());
        }
        let (uri, name, artist) = search_track(q)?;
        api(
            "PUT",
            "/me/player/play",
            &[],
            Some(json!({ "uris": [uri] })),
        )?;
        Ok(format!("▶ Playing {}", track_label(&name, &artist)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spotify_pause() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        api("PUT", "/me/player/pause", &[], None)?;
        Ok("⏸ Paused".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spotify_resume() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        api("PUT", "/me/player/play", &[], None)?;
        Ok("▶ Resumed".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spotify_next() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        api("POST", "/me/player/next", &[], None)?;
        Ok("⏭ Skipped".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spotify_prev() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        api("POST", "/me/player/previous", &[], None)?;
        Ok("⏮ Previous".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turn shuffle on/off.
#[tauri::command]
pub async fn spotify_shuffle(on: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        api(
            "PUT",
            "/me/player/shuffle",
            &[("state", if on { "true" } else { "false" })],
            None,
        )?;
        Ok(if on {
            "🔀 Shuffle on".into()
        } else {
            "➡ Shuffle off".into()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the repeat mode: `track` (one), `context` (all), or `off`.
#[tauri::command]
pub async fn spotify_repeat(mode: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let m = match mode.trim().to_ascii_lowercase().as_str() {
            "track" | "one" | "song" | "this" => "track",
            "context" | "all" | "on" | "playlist" | "album" => "context",
            "off" | "none" | "no" => "off",
            other => return Err(format!("repeat mode “{other}” — use one, all, or off")),
        };
        api("PUT", "/me/player/repeat", &[("state", m)], None)?;
        Ok(format!("🔁 Repeat {m}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the active device's volume (0–100%).
#[tauri::command]
pub async fn spotify_volume(percent: i64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = percent.clamp(0, 100).to_string();
        api("PUT", "/me/player/volume", &[("volume_percent", &p)], None)?;
        Ok(format!("🔊 Volume {p}%"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Play the user's Liked Songs (the first ~50, since the library has no URI).
#[tauri::command]
pub async fn spotify_play_liked() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let v = api("GET", "/me/tracks", &[("limit", "50")], None)?
            .ok_or("empty liked-songs response")?;
        let uris: Vec<Value> = v
            .get("items")
            .and_then(|i| i.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|it| it.get("track").and_then(|t| t.get("uri")).cloned())
                    .collect()
            })
            .unwrap_or_default();
        if uris.is_empty() {
            return Err("no liked songs found (is anything in your Liked Songs?)".into());
        }
        let n = uris.len();
        api("PUT", "/me/player/play", &[], Some(json!({ "uris": uris })))?;
        Ok(format!("▶ Playing your Liked Songs ({n})"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Play one of the user's playlists by (fuzzy) name.
#[tauri::command]
pub async fn spotify_play_playlist(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = name.trim();
        if q.is_empty() {
            return Err("which playlist?".into());
        }
        let v = api("GET", "/me/playlists", &[("limit", "50")], None)?
            .ok_or("empty playlists response")?;
        let items = v
            .get("items")
            .and_then(|i| i.as_array())
            .cloned()
            .unwrap_or_default();
        let want = q.to_ascii_lowercase();
        let name_of = |p: &Value| {
            p.get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        let pick = items
            .iter()
            .find(|p| name_of(p).eq_ignore_ascii_case(q))
            .or_else(|| {
                items
                    .iter()
                    .find(|p| name_of(p).to_ascii_lowercase().contains(&want))
            })
            .ok_or_else(|| format!("no playlist matching “{q}”"))?;
        let uri = pick
            .get("uri")
            .and_then(|x| x.as_str())
            .ok_or("playlist has no uri")?;
        let pname = name_of(pick);
        api(
            "PUT",
            "/me/player/play",
            &[],
            Some(json!({ "context_uri": uri })),
        )?;
        Ok(format!("▶ Playing playlist “{pname}”"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A live headless-PTY session: the master side + the child process handle.
#[cfg(desktop)]
type PtySession = (Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>);

/// Launch AudioPulse so its Spotify Connect device comes online. The TUI needs a
/// real terminal, so we run it inside a headless PTY and keep the handle alive
/// (dropping it would SIGHUP the TUI). Linux/WSL build only — the native Windows
/// build would need to cross into WSL, which isn't wired yet.
#[cfg(desktop)]
static AUDIOPULSE: Mutex<Option<PtySession>> = Mutex::new(None);

/// Build the command that launches AudioPulse.
///
/// On Linux/WSL it's the local `~/AudioPulse/audiopulse` (override with
/// `FLUX_AUDIOPULSE_BIN`). On a native **Windows** build AudioPulse lives in WSL,
/// so we launch it through `wsl.exe` and let the WSL login shell expand `~` — far
/// more robust than poking at the `\\wsl.localhost` mount from Windows. Set
/// `FLUX_AUDIOPULSE_BIN` to a different WSL-side path, and `FLUX_AUDIOPULSE_DISTRO`
/// if it isn't your default distro. The ConPTY we spawn it in gives the TUI a tty.
#[cfg(desktop)]
fn audiopulse_command() -> Result<CommandBuilder, String> {
    #[cfg(not(windows))]
    return native_audiopulse_command();
    #[cfg(windows)]
    return windows_audiopulse_command();
}

#[cfg(all(desktop, not(windows)))]
fn native_audiopulse_command() -> Result<CommandBuilder, String> {
    let bin = std::env::var("FLUX_AUDIOPULSE_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(|h| format!("{h}/AudioPulse/audiopulse"))
                .unwrap_or_default()
        });
    if bin.is_empty() || !std::path::Path::new(&bin).is_file() {
        return Err(format!(
            "AudioPulse binary not found ({bin}) — set FLUX_AUDIOPULSE_BIN to it"
        ));
    }
    let mut c = CommandBuilder::new(&bin);
    if let Some(dir) = std::path::Path::new(&bin).parent() {
        c.cwd(dir);
    }
    Ok(c)
}

/// `wsl.exe [-d <distro>] -- bash -lc "exec ~/AudioPulse/audiopulse"`.
#[cfg(windows)]
fn windows_audiopulse_command() -> Result<CommandBuilder, String> {
    let lin = std::env::var("FLUX_AUDIOPULSE_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "~/AudioPulse/audiopulse".to_string());
    let mut c = CommandBuilder::new("wsl.exe");
    if let Some(distro) = std::env::var("FLUX_AUDIOPULSE_DISTRO")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        c.arg("-d");
        c.arg(distro.trim());
    }
    // Login shell so `~` + PATH resolve; `exec` lets the TUI take over the pty.
    c.arg("--");
    c.arg("bash");
    c.arg("-lc");
    c.arg(format!("exec {lin}"));
    Ok(c)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn spotify_launch() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(launch_audiopulse)
        .await
        .map_err(|e| e.to_string())?
}

/// Mobile has no local AudioPulse binary and no PTY — the command stays in the
/// IPC surface (identical signature) but reports the feature is desktop-only.
#[cfg(mobile)]
#[tauri::command]
pub async fn spotify_launch() -> Result<String, String> {
    Err("AudioPulse (the Spotify Connect device) is desktop-only".into())
}

/// Start AudioPulse if it isn't already running (sync; used by the command and by
/// the no-active-device auto-start). Idempotent — safe to call repeatedly.
#[cfg(desktop)]
fn launch_audiopulse() -> Result<String, String> {
    // Held across check → spawn → store. Released in between, two concurrent
    // callers (a double-clicked play that 404s twice, or Launch racing a
    // command's auto-start) both saw "not running" and both launched one.
    let mut g = AUDIOPULSE.lock().unwrap_or_else(|e| e.into_inner());
    // Already running? (the child is alive if try_wait → Ok(None))
    if let Some((_, child)) = g.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok("AudioPulse is already running.".to_string());
        }
    }
    let mut cmd = audiopulse_command()?;
    cmd.env("TERM", "xterm-256color");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("couldn't launch AudioPulse: {e}"))?;
    drop(pair.slave);
    // Drain the TUI's output so a full PTY buffer never stalls it.
    if let Ok(mut reader) = pair.master.try_clone_reader() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
    }
    *g = Some((pair.master, child));
    Ok("▶ Launched AudioPulse — give it a second to come online.".to_string())
}

/// Structured playback state for the mini-player bubble (#125). `/me/player`
/// returns 204 (→ `None` → default) when there's no active device, so polling this
/// never trips the no-device auto-launch.
#[derive(Serialize, Clone, Default, specta::Type)]
pub struct SpotifyState {
    pub playing: bool,
    pub track: String,
    pub artist: String,
    /// Album-art URL (largest), or empty.
    pub art: String,
    pub progress_ms: i64,
    pub duration_ms: i64,
    pub volume: i64,
    pub shuffle: bool,
    /// "off" | "context" | "track".
    pub repeat: String,
    pub has_device: bool,
}

#[tauri::command]
pub async fn spotify_state() -> Result<SpotifyState, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(v) = api("GET", "/me/player", &[], None)? else {
            return Ok(SpotifyState::default()); // 204 — nothing active
        };
        let item = v.get("item");
        let first_str = |val: Option<&Value>, key: &str| {
            val.and_then(|i| i.get(key))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        let artist = item
            .and_then(|i| i.get("artists"))
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|a| a.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let art = item
            .and_then(|i| i.get("album"))
            .and_then(|al| al.get("images"))
            .and_then(|im| im.as_array())
            .and_then(|a| a.first())
            .and_then(|im| im.get("url"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let device = v.get("device");
        Ok(SpotifyState {
            playing: v
                .get("is_playing")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            track: first_str(item, "name"),
            artist,
            art,
            progress_ms: v.get("progress_ms").and_then(|x| x.as_i64()).unwrap_or(0),
            duration_ms: item
                .and_then(|i| i.get("duration_ms"))
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
            volume: device
                .and_then(|d| d.get("volume_percent"))
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
            shuffle: v
                .get("shuffle_state")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            repeat: v
                .get("repeat_state")
                .and_then(|x| x.as_str())
                .unwrap_or("off")
                .to_string(),
            has_device: device.is_some(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One of the user's playlists (for the bubble's playlist menu).
#[derive(Serialize, Clone, specta::Type)]
pub struct SpotifyPlaylist {
    pub name: String,
    pub uri: String,
    pub art: String,
}

#[tauri::command]
pub async fn spotify_playlists() -> Result<Vec<SpotifyPlaylist>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let v = api("GET", "/me/playlists", &[("limit", "50")], None)?
            .ok_or("empty playlists response")?;
        let items = v
            .get("items")
            .and_then(|i| i.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items
            .iter()
            .filter_map(|p| {
                let name = p.get("name")?.as_str()?.to_string();
                let uri = p.get("uri")?.as_str()?.to_string();
                let art = p
                    .get("images")
                    .and_then(|im| im.as_array())
                    .and_then(|a| a.first())
                    .and_then(|im| im.get("url"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(SpotifyPlaylist { name, uri, art })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Play a playlist/album/artist context by its Spotify URI (exact — the bubble
/// menu passes the uri it got from `spotify_playlists`).
#[tauri::command]
pub async fn spotify_play_context(uri: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        api(
            "PUT",
            "/me/player/play",
            &[],
            Some(json!({ "context_uri": uri })),
        )?;
        Ok("▶".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The currently-playing track, or a note that nothing's playing.
#[tauri::command]
pub async fn spotify_now_playing() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let v = match api("GET", "/me/player/currently-playing", &[], None)? {
            Some(v) => v,
            None => return Ok("Nothing playing.".into()),
        };
        let item = v.get("item");
        let name = item
            .and_then(|i| i.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let artist = item
            .and_then(|i| i.get("artists"))
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|a| a.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if name.is_empty() {
            Ok("Nothing playing.".into())
        } else {
            Ok(format!("♪ {}", track_label(name, artist)))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-spotify-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotated_tokens_are_merged_into_token_json() {
        let dir = scratch("rotate");
        let path = dir.join("token.json");
        std::fs::write(
            &path,
            r#"{"access_token":"A1","token_type":"Bearer","refresh_token":"R1","expiry":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        store_rotated(&path, "A2", "R2").unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["access_token"], "A2");
        assert_eq!(v["refresh_token"], "R2");
        // AudioPulse's own fields survive the merge.
        assert_eq!(v["token_type"], "Bearer");
        assert_eq!(v["expiry"], "2026-01-01T00:00:00Z");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "the credential must not become readable by others"
            );
        }
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "no temp file left"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_adopts_a_newer_token_instead_of_spending_the_refresh_token() {
        let dir = scratch("adopt");
        // No config.json, so no client id: reaching the real refresh fails here
        // instead of calling out.
        std::fs::write(
            dir.join("token.json"),
            r#"{"access_token":"A2","refresh_token":"R2"}"#,
        )
        .unwrap();
        spotify_set_dir(dir.to_string_lossy().into_owned());

        // AudioPulse wrote A2 since A1 was refused: adopt it, nothing spent.
        assert_eq!(refresh("A1"), Ok(("A2".to_string(), false)));
        // A2 refused too, and nothing newer anywhere: only now spend the token.
        assert!(refresh("A2").unwrap_err().contains("can't refresh"));
        // Another call refreshed while this one waited: reuse its token.
        *ACCESS.write().unwrap() = Some("A3".into());
        assert_eq!(refresh("A2"), Ok(("A3".to_string(), false)));

        spotify_set_dir(String::new());
        *ACCESS.write().unwrap() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
