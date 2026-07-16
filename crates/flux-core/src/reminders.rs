//! Persistent reminders + a background scheduler. Reminders live in
//! `app-data/reminders.json` so they survive restarts; a task started at app setup
//! checks them every ~20 s while Flux runs, marks due ones fired, emits
//! `flux://reminder-due` to the UI (which speaks + shows them), and pops an OS
//! notification so a due reminder surfaces even if the agent panel is closed or the
//! window isn't focused.
//!
//! (Reminders only fire while Flux is running — true cross-launch alarms would need
//! an OS-level scheduled task, which is out of scope here.)

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Reminder {
    pub id: String,
    pub text: String,
    pub due: Option<i64>, // epoch ms; None = an undated to-do
    #[serde(default)]
    pub fired: bool,
    #[serde(default)]
    pub created: i64,
}

// Serialize file access so the scheduler and commands don't race.
static LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("reminders.json"))
}

fn load(app: &AppHandle) -> Vec<Reminder> {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, rs: &[Reminder]) -> Result<(), String> {
    let p = store_path(app)?;
    let json = serde_json::to_string_pretty(rs).map_err(|e| e.to_string())?;
    crate::persist::write_atomic(&p, json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reminders_list(app: AppHandle) -> Vec<Reminder> {
    let _g = LOCK.lock();
    load(&app)
}

#[tauri::command]
pub fn reminders_add(
    app: AppHandle,
    id: String,
    text: String,
    due: Option<i64>,
    created: i64,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to remind about".into());
    }
    let _g = LOCK.lock();
    let mut rs = load(&app);
    rs.push(Reminder {
        id,
        text,
        due,
        fired: false,
        created,
    });
    save(&app, &rs)
}

#[tauri::command]
pub fn reminders_remove(app: AppHandle, id: String) -> Result<(), String> {
    let _g = LOCK.lock();
    let mut rs = load(&app);
    rs.retain(|r| r.id != id);
    save(&app, &rs)
}

/// Merge migration items from the old localStorage store (by id; existing win).
#[tauri::command]
pub fn reminders_import(app: AppHandle, items: Vec<Reminder>) -> Result<(), String> {
    let _g = LOCK.lock();
    let mut rs = load(&app);
    let ids: std::collections::HashSet<String> = rs.iter().map(|r| r.id.clone()).collect();
    for it in items {
        if !ids.contains(&it.id) {
            rs.push(it);
        }
    }
    save(&app, &rs)
}

/// Fire an OS notification on demand — used by the clocks widget (#134) so a
/// timer/alarm alert reaches you even when Flux is minimized or on another tab.
/// Generic and reusable; the notification capability is already granted.
#[tauri::command]
pub fn os_notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Spawn the scheduler (call once from `.setup()`).
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let now = now_ms();
            let mut due: Vec<Reminder> = Vec::new();
            {
                let _g = LOCK.lock();
                let mut rs = load(&app);
                let mut changed = false;
                for r in rs.iter_mut() {
                    if !r.fired {
                        if let Some(d) = r.due {
                            if d <= now {
                                r.fired = true;
                                due.push(r.clone());
                                changed = true;
                            }
                        }
                    }
                }
                if changed {
                    let _ = save(&app, &rs);
                }
            }
            for r in &due {
                let _ = app.emit("flux://reminder-due", r); // UI: speak + show
                let _ = app
                    .notification()
                    .builder()
                    .title("Flux reminder")
                    .body(&r.text)
                    .show();
            }
        }
    });
}
