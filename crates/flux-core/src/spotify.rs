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
//! AudioPulse) and retry once. The refreshed token is held in memory — we never
//! rewrite AudioPulse's token file.

use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";

/// In-memory refreshed access token (avoids a refresh per call).
static ACCESS: RwLock<Option<String>> = RwLock::new(None);

/// UI-set config-dir override (Settings → Integrations), checked before the env
/// var. Lets the user paste the `\\wsl.localhost\<distro>\…` path once.
static OVERRIDE_DIR: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, with "") the AudioPulse config-dir override from Settings.
#[tauri::command]
pub fn spotify_set_dir(path: String) {
    if let Ok(mut g) = OVERRIDE_DIR.write() {
        *g = if path.trim().is_empty() { None } else { Some(path) };
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
    if let Some(d) = OVERRIDE_DIR.read().ok().and_then(|g| g.clone()).filter(|s| !s.trim().is_empty()) {
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
        let Ok(distros) = std::fs::read_dir(root) else { continue };
        for distro in distros.flatten() {
            let Ok(users) = std::fs::read_dir(distro.path().join("home")) else { continue };
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
    let tok: TokenFile = serde_json::from_str(&raw)
        .map_err(|e| format!("{} isn't a valid AudioPulse token file: {e}", tpath.display()))?;
    if tok.access_token.is_empty() {
        return Err("AudioPulse's token.json has no access_token — log in to Spotify in AudioPulse".into());
    }
    let cfg: ConfigFile = std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(ConfigFile { client_id: String::new() });
    Ok((tok.access_token, tok.refresh_token, cfg.client_id))
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build()
}

fn current_access() -> Result<String, String> {
    if let Some(t) = ACCESS.read().ok().and_then(|g| g.clone()) {
        return Ok(t);
    }
    Ok(read_creds()?.0)
}

/// Refresh the access token (refresh-token grant, public client). Caches it.
fn refresh() -> Result<String, String> {
    let (_, rt, cid) = read_creds()?;
    if rt.is_empty() || cid.is_empty() {
        return Err("can't refresh the Spotify token (AudioPulse hasn't stored a refresh token / client id)".into());
    }
    let resp = http()
        .post(TOKEN_URL)
        .send_form(&[("grant_type", "refresh_token"), ("refresh_token", &rt), ("client_id", &cid)])
        .map_err(|e| format!("spotify token refresh failed: {e}"))?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    let at = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("no access_token in the refresh response")?
        .to_string();
    if let Ok(mut g) = ACCESS.write() {
        *g = Some(at.clone());
    }
    Ok(at)
}

/// One Web API call with a 401-refresh-retry. Returns the JSON body (or `None`
/// for 204 No Content, which the playback control endpoints return on success).
fn api(method: &str, path: &str, query: &[(&str, &str)], body: Option<Value>) -> Result<Option<Value>, String> {
    for attempt in 0..2u8 {
        let token = if attempt == 0 { current_access()? } else { refresh()? };
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
        let res = match &body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        };
        match res {
            Ok(resp) => {
                if resp.status() == 204 {
                    return Ok(None);
                }
                return Ok(resp.into_json::<Value>().ok());
            }
            Err(ureq::Error::Status(401, _)) if attempt == 0 => continue, // expired → refresh + retry
            Err(ureq::Error::Status(404, _)) => {
                // No active device — auto-start AudioPulse (idempotent) so the
                // retry works once its Connect device registers.
                let started = launch_audiopulse().is_ok();
                return Err(if started {
                    "no active device yet — I'm starting AudioPulse; give it a few seconds and ask again".into()
                } else {
                    "no active Spotify device — start AudioPulse (or open Spotify) and try again".into()
                });
            }
            Err(ureq::Error::Status(code, r)) => {
                let msg: String = r.into_string().unwrap_or_default().chars().take(180).collect();
                return Err(format!("spotify {code}: {msg}"));
            }
            Err(e) => return Err(format!("spotify request failed: {e}")),
        }
    }
    Err("spotify authorization failed".into())
}

fn search_track(q: &str) -> Result<(String, String, String), String> {
    let v = api("GET", "/search", &[("q", q), ("type", "track"), ("limit", "1")], None)?
        .ok_or("empty search response")?;
    let item = v
        .get("tracks")
        .and_then(|t| t.get("items"))
        .and_then(|i| i.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("no track found for “{q}”"))?;
    let uri = item.get("uri").and_then(|x| x.as_str()).ok_or("track has no uri")?.to_string();
    let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
        api("PUT", "/me/player/play", &[], Some(json!({ "uris": [uri] })))?;
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
        api("PUT", "/me/player/shuffle", &[("state", if on { "true" } else { "false" })], None)?;
        Ok(if on { "🔀 Shuffle on".into() } else { "➡ Shuffle off".into() })
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
        let v = api("GET", "/me/tracks", &[("limit", "50")], None)?.ok_or("empty liked-songs response")?;
        let uris: Vec<Value> = v
            .get("items")
            .and_then(|i| i.as_array())
            .map(|a| a.iter().filter_map(|it| it.get("track").and_then(|t| t.get("uri")).cloned()).collect())
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
        let v = api("GET", "/me/playlists", &[("limit", "50")], None)?.ok_or("empty playlists response")?;
        let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
        let want = q.to_ascii_lowercase();
        let name_of = |p: &Value| p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let pick = items
            .iter()
            .find(|p| name_of(p).eq_ignore_ascii_case(q))
            .or_else(|| items.iter().find(|p| name_of(p).to_ascii_lowercase().contains(&want)))
            .ok_or_else(|| format!("no playlist matching “{q}”"))?;
        let uri = pick.get("uri").and_then(|x| x.as_str()).ok_or("playlist has no uri")?;
        let pname = name_of(pick);
        api("PUT", "/me/player/play", &[], Some(json!({ "context_uri": uri })))?;
        Ok(format!("▶ Playing playlist “{pname}”"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Launch AudioPulse so its Spotify Connect device comes online. The TUI needs a
/// real terminal, so we run it inside a headless PTY and keep the handle alive
/// (dropping it would SIGHUP the TUI). Linux/WSL build only — the native Windows
/// build would need to cross into WSL, which isn't wired yet.
static AUDIOPULSE: Mutex<Option<(Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>)>> = Mutex::new(None);

/// Build the command that launches AudioPulse.
///
/// On Linux/WSL it's the local `~/AudioPulse/audiopulse` (override with
/// `FLUX_AUDIOPULSE_BIN`). On a native **Windows** build AudioPulse lives in WSL,
/// so we launch it through `wsl.exe` and let the WSL login shell expand `~` — far
/// more robust than poking at the `\\wsl.localhost` mount from Windows. Set
/// `FLUX_AUDIOPULSE_BIN` to a different WSL-side path, and `FLUX_AUDIOPULSE_DISTRO`
/// if it isn't your default distro. The ConPTY we spawn it in gives the TUI a tty.
fn audiopulse_command() -> Result<CommandBuilder, String> {
    #[cfg(not(windows))]
    return native_audiopulse_command();
    #[cfg(windows)]
    return windows_audiopulse_command();
}

#[cfg(not(windows))]
fn native_audiopulse_command() -> Result<CommandBuilder, String> {
    let bin = std::env::var("FLUX_AUDIOPULSE_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| std::env::var("HOME").map(|h| format!("{h}/AudioPulse/audiopulse")).unwrap_or_default());
    if bin.is_empty() || !std::path::Path::new(&bin).is_file() {
        return Err(format!("AudioPulse binary not found ({bin}) — set FLUX_AUDIOPULSE_BIN to it"));
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
    if let Some(distro) = std::env::var("FLUX_AUDIOPULSE_DISTRO").ok().filter(|s| !s.trim().is_empty()) {
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

#[tauri::command]
pub async fn spotify_launch() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(launch_audiopulse).await.map_err(|e| e.to_string())?
}

/// Start AudioPulse if it isn't already running (sync; used by the command and by
/// the no-active-device auto-start). Idempotent — safe to call repeatedly.
fn launch_audiopulse() -> Result<String, String> {
    // Already running? (the child is alive if try_wait → Ok(None))
    if let Ok(mut g) = AUDIOPULSE.lock() {
        if let Some((_, child)) = g.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok("AudioPulse is already running.".to_string());
            }
        }
    }
    let mut cmd = audiopulse_command()?;
    cmd.env("TERM", "xterm-256color");
    let pair = native_pty_system()
        .openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("couldn't launch AudioPulse: {e}"))?;
    drop(pair.slave);
    // Drain the TUI's output so a full PTY buffer never stalls it.
    if let Ok(mut reader) = pair.master.try_clone_reader() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
    }
    if let Ok(mut g) = AUDIOPULSE.lock() {
        *g = Some((pair.master, child));
    }
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
            val.and_then(|i| i.get(key)).and_then(|x| x.as_str()).unwrap_or("").to_string()
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
            playing: v.get("is_playing").and_then(|x| x.as_bool()).unwrap_or(false),
            track: first_str(item, "name"),
            artist,
            art,
            progress_ms: v.get("progress_ms").and_then(|x| x.as_i64()).unwrap_or(0),
            duration_ms: item.and_then(|i| i.get("duration_ms")).and_then(|x| x.as_i64()).unwrap_or(0),
            volume: device.and_then(|d| d.get("volume_percent")).and_then(|x| x.as_i64()).unwrap_or(0),
            shuffle: v.get("shuffle_state").and_then(|x| x.as_bool()).unwrap_or(false),
            repeat: v.get("repeat_state").and_then(|x| x.as_str()).unwrap_or("off").to_string(),
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
        let v = api("GET", "/me/playlists", &[("limit", "50")], None)?.ok_or("empty playlists response")?;
        let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
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
        api("PUT", "/me/player/play", &[], Some(json!({ "context_uri": uri })))?;
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
        let name = item.and_then(|i| i.get("name")).and_then(|x| x.as_str()).unwrap_or("");
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
