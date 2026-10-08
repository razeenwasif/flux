//! Persistent reminders + a background scheduler. Reminders live in
//! `app-data/reminders.json` so they survive restarts; a task started at app setup
//! checks them every ~20 s while Flux runs, marks due ones fired, emits
//! `flux://reminder-due` to the UI (which speaks + shows them), and pops an OS
//! notification so a due reminder surfaces even if the agent panel is closed or the
//! window isn't focused.
//!
//! (Reminders only fire while Flux is running — true cross-launch alarms would need
//! an OS-level scheduled task, which is out of scope here.)

use std::path::{Path, PathBuf};
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

// Serialize file access so the scheduler and commands don't race. Also holds
// the ids already announced this session (see `take_due`).
static LOCK: Mutex<Vec<String>> = Mutex::new(Vec::new());

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

fn load(app: &AppHandle) -> Result<Vec<Reminder>, String> {
    read_store(&store_path(app)?)
}

/// `Err` when the file exists but can't be read or parsed: writers must stop
/// there, or their save would replace every reminder with the one being added.
fn read_store(p: &Path) -> Result<Vec<Reminder>, String> {
    let raw = match std::fs::read_to_string(p) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read reminders: {e}")),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw)
        .map_err(|e| format!("reminders.json is unreadable ({e}); left untouched"))
}

fn save(app: &AppHandle, rs: &[Reminder]) -> Result<(), String> {
    let p = store_path(app)?;
    let json = serde_json::to_string_pretty(rs).map_err(|e| e.to_string())?;
    crate::persist::write_atomic(&p, json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reminders_list(app: AppHandle) -> Vec<Reminder> {
    let _g = LOCK.lock();
    load(&app).unwrap_or_default()
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
    let mut rs = load(&app)?;
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
    let mut rs = load(&app)?;
    rs.retain(|r| r.id != id);
    save(&app, &rs)
}

/// Merge migration items from the old localStorage store (by id; existing win).
#[tauri::command]
pub fn reminders_import(app: AppHandle, items: Vec<Reminder>) -> Result<(), String> {
    let _g = LOCK.lock();
    let mut rs = load(&app)?;
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
        // Logged once per outage, not on every tick.
        let mut failing = false;
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let now = now_ms();
            let mut due: Vec<Reminder> = Vec::new();
            {
                let mut announced = LOCK.lock().unwrap_or_else(|p| p.into_inner());
                let checked = load(&app).and_then(|mut rs| {
                    if take_due(&mut rs, now, &mut announced, &mut due) {
                        save(&app, &rs)?;
                    }
                    Ok(())
                });
                match checked {
                    Ok(()) => failing = false,
                    Err(e) if !failing => {
                        failing = true;
                        tracing::warn!(target: "flux::reminders", error = %e, "reminder store unusable");
                    }
                    Err(_) => {}
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

/// Mark due reminders fired; true if any were (so the store needs saving). Only
/// ones not yet announced this session go into `due`: when saving `fired`
/// fails, the next tick reads them unfired again, and they used to be notified
/// and spoken every 20 s until a save succeeded.
fn take_due(
    rs: &mut [Reminder],
    now: i64,
    announced: &mut Vec<String>,
    due: &mut Vec<Reminder>,
) -> bool {
    let mut changed = false;
    for r in rs.iter_mut() {
        if !r.fired && r.due.is_some_and(|d| d <= now) {
            r.fired = true;
            changed = true;
            if !announced.contains(&r.id) {
                announced.push(r.id.clone());
                due.push(r.clone());
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_store_stops_writers_instead_of_reading_as_empty() {
        let dir = std::env::temp_dir().join(format!("flux-reminders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("reminders.json");
        assert!(
            read_store(&p).unwrap().is_empty(),
            "no file is no reminders"
        );
        std::fs::write(&p, "  ").unwrap();
        assert!(read_store(&p).unwrap().is_empty());
        // A hand edit left a trailing comma: adding one reminder used to save
        // a one-element file over all the others.
        std::fs::write(&p, r#"[{"id":"r1","text":"call mum","due":null},]"#).unwrap();
        assert!(read_store(&p).is_err());
        std::fs::write(&p, r#"[{"id":"r1","text":"call mum","due":null}]"#).unwrap();
        assert_eq!(read_store(&p).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_due_reminder_is_announced_once_even_if_saving_it_fails() {
        let at = |id: &str, due: Option<i64>| Reminder {
            id: id.into(),
            text: id.into(),
            due,
            fired: false,
            created: 0,
        };
        let on_disk = [
            at("due", Some(100)),
            at("later", Some(5_000)),
            at("todo", None),
        ];
        let mut announced = Vec::new();
        let mut tick = |now: i64| {
            let mut due = Vec::new();
            let changed = take_due(&mut on_disk.clone(), now, &mut announced, &mut due);
            (changed, due)
        };
        let (changed, due) = tick(1_000);
        assert!(changed);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "due");
        // The save failed, so the next tick reads it unfired again: marked (and
        // saved) again, but not announced again.
        let (changed, due) = tick(1_020);
        assert!(changed && due.is_empty());
        // Other reminders still fire when their time comes.
        let (_, due) = tick(6_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "later");
    }
}
