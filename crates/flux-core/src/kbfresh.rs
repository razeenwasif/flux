//! Keeping the knowledge base current with what you've just written.
//!
//! **The bug this exists to fix.** Indexing was manual — the ↻ button in the
//! Notebook panel was the only caller of `kb_reindex`. So you could write a note
//! in Onyx, ask the agent about it under "My notes", and get nothing, with no
//! indication that the answer was drawn from whatever the last manual reindex
//! happened to capture. An assistant that confidently answers from a stale
//! corpus is worse than one that says it doesn't know.
//!
//! **Why a debounce and not a reindex per save.** An editor saves at each pause
//! in your typing. Rebuilding on each one would embed the same note dozens of
//! times. Instead a source is *marked* dirty and a
//! background worker rebuilds it once the edits stop — and because
//! `reindex_source` skips documents whose mtime is unchanged, the rebuild only
//! embeds the pages that actually moved.
//!
//! **Onyx is watched, not polled.** The vault is edited outside Flux (that's the
//! point of Onyx), so Flux-side writes alone wouldn't notice. `notify` is
//! already a dependency for the Files tab, so the vault gets a real filesystem
//! watch rather than a timer re-reading every note.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use tauri::{AppHandle, Manager};

/// How long a source must be quiet before it's rebuilt. Long enough that a
/// continuous stroke of typing is one rebuild, short enough that asking the
/// agent right after you stop writing finds it.
const QUIET: Duration = Duration::from_secs(3);

/// Sources with unindexed changes, and when the most recent change landed.
/// The worker sleeps on `wake` until there's one, then until it's quiet: it
/// used to look every 2 s, edits or not, most of what Flux did while idle.
#[derive(Default)]
pub struct KbFreshness {
    dirty: Mutex<HashMap<String, Instant>>,
    wake: Condvar,
}

/// Take the sources in `d` that have been quiet for [`QUIET`].
fn due_in(d: &mut HashMap<String, Instant>) -> Vec<String> {
    let due: Vec<String> = d
        .iter()
        .filter(|(_, at)| at.elapsed() >= QUIET)
        .map(|(s, _)| s.clone())
        .collect();
    for s in &due {
        d.remove(s);
    }
    due
}

impl KbFreshness {
    /// Note that `source` has changed. Cheap and lock-light — safe to call from
    /// a save path that runs on every keystroke.
    pub fn touch(&self, source: &str) {
        self.dirty.lock().insert(source.to_string(), Instant::now());
        self.wake.notify_one();
    }

    /// Take the sources that have been quiet for [`QUIET`]. Removing them here
    /// (rather than after the rebuild) means an edit *during* a rebuild re-marks
    /// the source and gets picked up on the next wait, instead of being
    /// swallowed by the rebuild that was already in flight.
    #[cfg(test)]
    fn take_due(&self) -> Vec<String> {
        due_in(&mut self.dirty.lock())
    }

    /// Wait for sources to come due and take them: asleep while nothing is
    /// dirty, then until the latest edit to one has been quiet for [`QUIET`].
    fn wait_due(&self) -> Vec<String> {
        let mut d = self.dirty.lock();
        loop {
            let due = due_in(&mut d);
            if !due.is_empty() {
                return due;
            }
            match d
                .values()
                .map(|at| QUIET.saturating_sub(at.elapsed()))
                .min()
            {
                Some(left) => {
                    self.wake.wait_for(&mut d, left);
                }
                None => self.wake.wait(&mut d),
            }
        }
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        self.dirty.lock().len()
    }
}

/// Rebuild one source. The sources marked here (`onyx`, `scroll`, `council`)
/// collect themselves from disk or HTTP, so no in-process corpus is passed.
///
/// `take_due` has already cleared the source, so when another build holds the
/// index (often the Trail's `web` auto-index, which doesn't cover this source)
/// it's marked again and retried after the next quiet window, not dropped.
fn reindex_one(app: &AppHandle, fresh: &KbFreshness, source: &str) {
    let Some(kb) = app.try_state::<crate::kb::KbStore>() else {
        return;
    };
    if kb.is_indexing() {
        fresh.touch(source);
        return;
    }
    let started = Instant::now();
    match kb.reindex(Some(source.to_string()), crate::kb::Corpora::default()) {
        Ok(_) => tracing::info!(
            target: "flux::kb",
            source,
            ms = started.elapsed().as_millis() as u64,
            "auto-reindexed after an edit"
        ),
        // Lost the race for the index after the check above: same treatment.
        Err(e) if e == crate::kb::BUSY => fresh.touch(source),
        Err(e) => tracing::debug!(target: "flux::kb", source, "auto-reindex skipped: {e}"),
    }
}

/// Start the debounce worker and the Onyx vault watch. Idempotent per app.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    match app.try_state::<Arc<KbFreshness>>() {
        Some(fresh) => {
            let fresh = fresh.inner().clone();
            std::thread::spawn(move || loop {
                for source in fresh.wait_due() {
                    reindex_one(&handle, &fresh, &source);
                }
            });
        }
        None => tracing::warn!(target: "flux::kb", "no KbFreshness; edits won't reindex"),
    }
    watch_onyx(app);
}

/// Watch the Onyx vault so notes written in the Onyx TUI — outside Flux
/// entirely — become answerable without a manual reindex.
///
/// Failure here is not fatal and not worth a dialog: without the watch, Onyx
/// simply goes back to being refreshed on demand, which is where it was before.
///
/// Re-run by `kb_set_source` when the vault path changes: the boot-time watch
/// is on whatever resolved then, possibly nothing. Each run replaces the last.
pub(crate) fn watch_onyx(app: &AppHandle) {
    use notify::Watcher;

    let Some(kb) = app.try_state::<crate::kb::KbStore>() else {
        return;
    };
    let location = kb.source_location("onyx");
    let Some(vault) = crate::kb::onyx_vault(location.as_deref()) else {
        tracing::debug!(target: "flux::kb", "no Onyx vault to watch");
        set_onyx_watch(app, None); // nor the one the user pointed away from
        return;
    };

    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        // Ignore pure metadata churn (access times); only content changes can
        // change an answer.
        if !matches!(
            ev.kind,
            notify::EventKind::Create(_)
                | notify::EventKind::Modify(_)
                | notify::EventKind::Remove(_)
        ) {
            return;
        }
        // Editors write sidecars and swap files constantly; only .md matters.
        if !ev
            .paths
            .iter()
            .any(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")))
        {
            return;
        }
        if let Some(fresh) = handle.try_state::<Arc<KbFreshness>>() {
            fresh.touch("onyx");
        }
    });

    match watcher {
        Ok(mut w) => {
            if let Err(e) = w.watch(&vault, notify::RecursiveMode::Recursive) {
                tracing::warn!(target: "flux::kb", "couldn't watch the Onyx vault: {e}");
                set_onyx_watch(app, None);
                return;
            }
            tracing::info!(target: "flux::kb", vault = %vault.display(), "watching the Onyx vault");
            // The watcher stops on drop, so it has to outlive this function.
            set_onyx_watch(app, Some(w));
        }
        Err(e) => {
            tracing::warn!(target: "flux::kb", "no Onyx watcher: {e}");
            set_onyx_watch(app, None);
        }
    }
}

/// Install `w` as the vault watch, dropping (and so stopping) the previous
/// vault's. `manage` only takes the first value per type, so after that the
/// managed slot's contents are swapped instead.
fn set_onyx_watch(app: &AppHandle, w: Option<notify::RecommendedWatcher>) {
    app.manage(OnyxWatch(Mutex::new(None))); // no-op once managed
    *app.state::<OnyxWatch>().0.lock() = w;
}

/// Keeps the current vault's watcher alive (dropping a `notify` watcher
/// silently stops delivery).
struct OnyxWatch(Mutex<Option<notify::RecommendedWatcher>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_burst_becomes_one_rebuild() {
        // The whole point of the debounce: an editor saves at every pause while
        // you write, and each rebuild embeds.
        let f = KbFreshness::default();
        for _ in 0..50 {
            f.touch("onyx");
        }
        assert_eq!(f.pending(), 1, "one source, however many edits");
        assert!(f.take_due().is_empty(), "still within the quiet window");
    }

    #[test]
    fn a_source_is_due_once_it_goes_quiet() {
        let f = KbFreshness::default();
        f.touch("onyx");
        // Reach in rather than sleeping QUIET in a unit test.
        f.dirty.lock().insert(
            "onyx".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due(), vec!["onyx".to_string()]);
        assert_eq!(f.pending(), 0, "taken, not left to rebuild forever");
    }

    #[test]
    fn an_edit_during_a_rebuild_is_not_swallowed() {
        // take_due clears the flag *before* the rebuild runs, so a save landing
        // mid-rebuild re-marks the source instead of being lost to the rebuild
        // that had already read the old state.
        let f = KbFreshness::default();
        f.dirty.lock().insert(
            "onyx".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due().len(), 1);
        f.touch("onyx"); // the edit that arrived during the rebuild
        assert_eq!(f.pending(), 1);
    }

    #[test]
    fn the_worker_sleeps_until_an_edit_goes_quiet() {
        let f = Arc::new(KbFreshness::default());
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = f.clone();
        std::thread::spawn(move || tx.send(worker.wait_due()).unwrap());
        // Nothing dirty: nothing comes back, however long it waits.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        let at = Instant::now();
        f.touch("onyx");
        let due = rx.recv_timeout(QUIET * 2).expect("woken by the edit");
        assert_eq!(due, vec!["onyx".to_string()]);
        assert!(at.elapsed() >= QUIET, "not before the edit went quiet");
    }

    #[test]
    fn sources_are_tracked_independently() {
        let f = KbFreshness::default();
        f.touch("scroll");
        f.touch("onyx");
        f.dirty.lock().insert(
            "onyx".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due(), vec!["onyx".to_string()]);
        assert_eq!(f.pending(), 1, "scroll is still waiting out its own window");
    }
}
