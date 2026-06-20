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
use std::sync::RwLock;
use std::time::Duration;

use serde::Deserialize;
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
                return Err("no active Spotify device — start AudioPulse (or open Spotify) and try again".into());
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
