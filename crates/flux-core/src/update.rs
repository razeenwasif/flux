//! Updates from GitHub Releases (BACKLOG #26).
//!
//! `scripts/release.sh` builds Flux on the maintainer's Mac, signs the app with
//! their certificate and the update archive with the updater key, and publishes
//! both, with a `latest.json` describing them, as a GitHub release. Flux asks
//! for that file a minute after launch and every six hours after, downloads a
//! newer build in the background, and asks before restarting into it. A
//! downloaded update that wasn't restarted into is installed when Flux quits.
//!
//! The archive's signature is checked against the public key in
//! tauri.conf.json before anything is installed. `latest.json` itself isn't
//! signed, so a forged one could pair a high version number with an older
//! signed build and roll Flux back. The signature's trusted comment names the
//! archive, and the release script puts the version in that name, so Flux also
//! checks the signed name against the version it was offered ([`signed_for`]).
//! (The plugin's own `requireSignedVersion` needs a newer Tauri CLI than the
//! one this repo builds with.)
//!
//! Only macOS builds are published, and only a release build looks for them by
//! itself. A debug or smoke build would otherwise replace itself with the
//! published app. `FLUX_UPDATE_URL` points any build at another `latest.json`,
//! which is how a smoke build tests this.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// What the Settings page shows, and the `flux://update-ready` payload.
#[derive(Serialize, Clone, Debug, Default, PartialEq, specta::Type)]
pub struct UpdateStatus {
    /// The running version.
    pub current: String,
    /// Whether this build can update itself at all.
    pub supported: bool,
    /// Whether it looks for updates by itself.
    pub auto: bool,
    /// A newer version, downloaded and waiting for a restart.
    pub ready: Option<String>,
    /// That version's release notes.
    pub notes: Option<String>,
    /// A check or download is under way.
    pub busy: bool,
    /// When Flux last heard back from the release feed, in ms since the epoch.
    pub checked_at: Option<f64>,
    /// Why the last check failed, if it did.
    pub error: Option<String>,
}

pub struct Updates {
    auto: AtomicBool,
    /// Where `auto` is kept between runs. `None` = in memory only.
    path: Option<PathBuf>,
    busy: AtomicBool,
    last: Mutex<Last>,
    #[cfg(desktop)]
    ready: Mutex<Option<imp::Ready>>,
}

#[derive(Default)]
struct Last {
    checked_at: Option<f64>,
    error: Option<String>,
}

impl Updates {
    /// Automatic checks are on unless the user turned them off (`updates.txt`
    /// holding `0`).
    pub fn restore(path: Option<PathBuf>) -> Self {
        let off = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|s| s.trim() == "0");
        Self {
            auto: AtomicBool::new(!off),
            path,
            busy: AtomicBool::new(false),
            last: Mutex::new(Last::default()),
            #[cfg(desktop)]
            ready: Mutex::new(None),
        }
    }

    fn set_auto(&self, on: bool) {
        if self.auto.swap(on, Ordering::Relaxed) != on {
            if let Some(p) = &self.path {
                crate::persist::queue_text(
                    p,
                    if on { "1" } else { "0" },
                    crate::persist::Durability::Barrier,
                );
            }
        }
    }

    pub fn status(&self, app: &AppHandle) -> UpdateStatus {
        let last = self.last.lock();
        #[cfg(desktop)]
        let (ready, notes) = self.ready.lock().as_ref().map_or((None, None), |r| {
            (Some(r.update.version.clone()), r.update.body.clone())
        });
        #[cfg(mobile)]
        let (ready, notes) = (None, None);
        UpdateStatus {
            current: app.package_info().version.to_string(),
            supported: feed().is_some(),
            auto: self.auto.load(Ordering::Relaxed),
            ready,
            notes,
            busy: self.busy.load(Ordering::Relaxed),
            checked_at: last.checked_at,
            error: last.error.clone(),
        }
    }
}

/// Where this build looks for updates: `FLUX_UPDATE_URL`, or the published
/// feed for a release build on macOS. `None` = it doesn't update itself.
fn feed() -> Option<String> {
    if let Ok(url) = std::env::var("FLUX_UPDATE_URL") {
        return (!url.is_empty()).then_some(url);
    }
    let published =
        cfg!(all(target_os = "macos", not(debug_assertions))) && !cfg!(feature = "native-smoke");
    published.then(|| FEED.to_string())
}

/// The published feed. tauri.conf.json names the same URL for the plugin (a
/// test keeps the two equal).
const FEED: &str = "https://github.com/razeenwasif/flux/releases/latest/download/latest.json";

/// The first check waits out the launch, so it doesn't compete with restoring
/// tabs; after that, four times a day is plenty for a browser built by hand.
const FIRST_CHECK: std::time::Duration = std::time::Duration::from_secs(60);
const EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Start the background checks. A build that doesn't update itself never
/// wakes for them.
pub fn start(app: &AppHandle) {
    if feed().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let auto = app
                .try_state::<Updates>()
                .is_some_and(|u| u.auto.load(Ordering::Relaxed));
            if auto {
                let _ = check(&app).await;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Ask the feed, and download a newer build if there is one. Announces a
/// download with `flux://update-ready`; quiet otherwise.
async fn check(app: &AppHandle) -> Result<(), String> {
    let Some(updates) = app.try_state::<Updates>() else {
        return Ok(());
    };
    if updates.busy.swap(true, Ordering::Relaxed) {
        return Ok(());
    }
    let result = run_check(app).await;
    {
        let mut last = updates.last.lock();
        last.checked_at = Some(now_ms());
        last.error = result.as_ref().err().cloned();
    }
    updates.busy.store(false, Ordering::Relaxed);
    if let Err(e) = &result {
        tracing::warn!(target: "flux::update", "update check failed: {e}");
    }
    result
}

#[cfg(desktop)]
async fn run_check(app: &AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let Some(url) = feed() else {
        return Err("this build doesn't update itself".into());
    };
    let Some(ready) = imp::fetch(app, &url).await? else {
        tracing::info!(target: "flux::update", "Flux is up to date");
        return Ok(());
    };
    tracing::info!(target: "flux::update", version = %ready.update.version, "update downloaded");
    let updates = app.state::<Updates>();
    *updates.ready.lock() = Some(ready);
    let _ = app.emit("flux://update-ready", updates.status(app));
    Ok(())
}

#[cfg(mobile)]
async fn run_check(_app: &AppHandle) -> Result<(), String> {
    Err("this build doesn't update itself".into())
}

/// Whether an update's signature was made for `version`: its trusted comment
/// names the archive, and release.sh names that `Flux_<version>_<arch>…`. Only
/// meaningful once the signature has been verified, which covers the comment.
#[cfg_attr(mobile, allow(dead_code))]
fn signed_for(signature: &str, version: &str) -> bool {
    use base64::Engine as _;
    let Ok(text) = base64::engine::general_purpose::STANDARD.decode(signature.trim()) else {
        return false;
    };
    let text = String::from_utf8_lossy(&text);
    let want = format!("Flux_{}_", version.trim_start_matches('v'));
    text.lines()
        .filter_map(|l| l.strip_prefix("trusted comment:"))
        .flat_map(|c| c.trim().split('\t'))
        .filter_map(|field| field.strip_prefix("file:"))
        .any(|file| file.starts_with(&want))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// Install a downloaded update as Flux quits, if there is one. Called from
/// `RunEvent::Exit`, which a restart from [`update_restart`] goes through too.
pub fn install_on_exit(app: &AppHandle) {
    #[cfg(desktop)]
    if let Some(updates) = app.try_state::<Updates>() {
        if let Some(ready) = updates.ready.lock().take() {
            imp::install_quietly(&ready);
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

#[cfg(desktop)]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_updater::{Update, UpdaterExt};

    pub(super) struct Ready {
        pub update: Update,
        pub bytes: Vec<u8>,
    }

    /// A newer build from `url`, downloaded and its signature checked, or
    /// `None` when this one is current.
    pub(super) async fn fetch(app: &AppHandle, url: &str) -> Result<Option<Ready>, String> {
        let url = url
            .parse()
            .map_err(|e| format!("bad update address: {e}"))?;
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        // `download` checks the signature before it returns the bytes, which
        // makes the signature's trusted comment trustworthy from here on.
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        if !super::signed_for(&update.signature, &update.version) {
            return Err(format!(
                "the update offered as {} was signed for a different version",
                update.version
            ));
        }
        Ok(Some(Ready { update, bytes }))
    }

    /// Put the new app in place. Only where that needs no administrator
    /// password: the plugin asks for one through AppleScript on the main
    /// thread, and on the way out that thread is this one, so asking would
    /// hang the quit. Such an install waits for the Restart button instead.
    pub(super) fn install_quietly(ready: &Ready) {
        if !bundle_writable() {
            tracing::warn!(target: "flux::update", "the app's folder isn't writable; update left for the Restart button");
            return;
        }
        match ready.update.install(&ready.bytes) {
            Ok(()) => {
                tracing::info!(target: "flux::update", version = %ready.update.version, "update installed")
            }
            Err(e) => tracing::warn!(target: "flux::update", "update install failed: {e}"),
        }
    }

    pub(super) fn install(ready: &Ready) -> Result<(), String> {
        ready
            .update
            .install(&ready.bytes)
            .map_err(|e| e.to_string())
    }

    /// Whether the folder holding the app (or the binary, off macOS) takes a
    /// new file without asking: the plugin swaps the app by renaming it there.
    fn bundle_writable() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        // …/Flux.app/Contents/MacOS/flux → the folder Flux.app is in.
        let dir = if cfg!(target_os = "macos") {
            exe.ancestors().nth(4).map(std::path::Path::to_path_buf)
        } else {
            exe.parent().map(std::path::Path::to_path_buf)
        };
        let Some(dir) = dir else {
            return false;
        };
        let probe = dir.join(format!(".flux-update-{}", std::process::id()));
        let ok = std::fs::File::create(&probe).is_ok();
        let _ = std::fs::remove_file(&probe);
        ok
    }
}

#[tauri::command]
pub fn update_status(app: AppHandle, updates: State<'_, Updates>) -> UpdateStatus {
    updates.status(&app)
}

/// Check now, whatever the automatic setting says.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    check(&app).await?;
    Ok(app.state::<Updates>().status(&app))
}

#[tauri::command]
pub fn update_set_auto(app: AppHandle, updates: State<'_, Updates>, on: bool) -> UpdateStatus {
    updates.set_auto(on);
    updates.status(&app)
}

/// Install the downloaded update and restart into it. Installed here rather
/// than on the way out so that an app folder needing a password can ask for it.
#[tauri::command]
pub async fn update_restart(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let ready = app
            .state::<Updates>()
            .ready
            .lock()
            .take()
            .ok_or("no update is waiting")?;
        if let Err(e) = imp::install(&ready) {
            // Keep it for the next try, or for the quit.
            *app.state::<Updates>().ready.lock() = Some(ready);
            return Err(e);
        }
        tracing::info!(target: "flux::update", version = %ready.update.version, "update installed; restarting");
        app.request_restart();
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("this build doesn't update itself".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_checks_are_on_until_turned_off_and_stay_off() {
        let dir = std::env::temp_dir().join(format!("flux-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("updates.txt");
        let u = Updates::restore(Some(path.clone()));
        assert!(u.auto.load(Ordering::Relaxed), "on by default");
        u.set_auto(true);
        assert!(!path.exists(), "an unchanged setting is no write");
        u.set_auto(false);
        assert!(!Updates::restore(Some(path.clone()))
            .auto
            .load(Ordering::Relaxed));
        u.set_auto(true);
        assert!(Updates::restore(Some(path.clone()))
            .auto
            .load(Ordering::Relaxed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sig(comment: &str) -> String {
        use base64::Engine as _;
        let text = format!(
            "untrusted comment: signature from tauri secret key\nRUQ…\ntrusted comment: {comment}\nAbc…\n"
        );
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn a_signature_counts_only_for_the_version_in_its_signed_file_name() {
        let s = sig("timestamp:1793396299\tfile:Flux_0.2.0_aarch64.app.tar.gz");
        assert!(signed_for(&s, "0.2.0"));
        assert!(signed_for(&s, "v0.2.0"));
        // An older build's genuine signature offered as a newer version.
        assert!(!signed_for(&s, "0.3.0"));
        // A prefix isn't a match: 0.2.0 is not 0.2.
        assert!(!signed_for(&s, "0.2"));
        // A name without the version, and nonsense, count for nothing.
        assert!(!signed_for(
            &sig("timestamp:1\tfile:Flux.app.tar.gz"),
            "0.2.0"
        ));
        assert!(!signed_for("not base64!", "0.2.0"));
    }

    #[test]
    fn the_published_feed_is_the_latest_release() {
        // tauri.conf.json names the same file; the release script writes it.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = &conf["plugins"]["updater"]["endpoints"];
        assert_eq!(endpoints[0], FEED);
        assert!(conf["plugins"]["updater"]["pubkey"]
            .as_str()
            .is_some_and(|k| !k.is_empty()));
    }
}
