//! Keeping the knowledge base current with what you've just written.
//!
//! **The bug this exists to fix.** Indexing was manual — the ↻ button in the
//! Notebook panel was the only caller of `kb_reindex`. So you could write a page
//! in Scribe, ask the agent about it under "My notes", and get nothing, with no
//! indication that the answer was drawn from whatever the last manual reindex
//! happened to capture. An assistant that confidently answers from a stale
//! corpus is worse than one that says it doesn't know.
//!
//! **Why a debounce and not a reindex per save.** `scribe_save` fires roughly
//! every 500 ms while you're typing or drawing. Rebuilding on each one would
//! embed the same page dozens of times. Instead a source is *marked* dirty and a
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

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

/// How long a source must be quiet before it's rebuilt. Long enough that a
/// continuous stroke of typing is one rebuild, short enough that asking the
/// agent right after you stop writing finds it.
const QUIET: Duration = Duration::from_secs(3);
/// How often the worker looks for due sources.
const TICK: Duration = Duration::from_secs(2);

/// Sources with unindexed changes, and when the most recent change landed.
#[derive(Default)]
pub struct KbFreshness {
    dirty: Mutex<HashMap<String, Instant>>,
}

impl KbFreshness {
    /// Note that `source` has changed. Cheap and lock-light — safe to call from
    /// a save path that runs on every keystroke.
    pub fn touch(&self, source: &str) {
        self.dirty.lock().insert(source.to_string(), Instant::now());
    }

    /// Take the sources that have been quiet for [`QUIET`]. Removing them here
    /// (rather than after the rebuild) means an edit *during* a rebuild re-marks
    /// the source and gets picked up on the next tick, instead of being
    /// swallowed by the rebuild that was already in flight.
    fn take_due(&self) -> Vec<String> {
        let mut d = self.dirty.lock();
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

    #[cfg(test)]
    fn pending(&self) -> usize {
        self.dirty.lock().len()
    }
}

/// Rebuild one source, pulling only the corpus that source needs.
///
/// The in-process corpora (Scribe, its transcripts, PDFs) live in Tauri state;
/// file/HTTP-backed sources (`onyx`, `scroll`, `council`) collect themselves and
/// ignore what's passed. Handing over only the relevant slice keeps a Scribe
/// edit from walking the Onyx vault.
fn reindex_one(app: &AppHandle, source: &str) {
    let Some(kb) = app.try_state::<crate::kb::KbStore>() else {
        return;
    };
    let corpora = match source {
        "scribe" => app
            .try_state::<crate::scribe::ScribeStore>()
            .map(|s| crate::kb::Corpora {
                scribe: crate::kb::scribe_docs(&s),
                ..Default::default()
            }),
        "scribe-ocr" => {
            app.try_state::<crate::scribe::TranscriptStore>()
                .map(|t| crate::kb::Corpora {
                    scribe_ocr: crate::kb::scribe_ocr_docs(&t),
                    ..Default::default()
                })
        }
        // Collects from disk / HTTP; the passed corpora is unused.
        _ => Some(crate::kb::Corpora::default()),
    };
    let Some(corpora) = corpora else { return };

    let started = Instant::now();
    match kb.reindex(Some(source.to_string()), corpora) {
        Ok(_) => tracing::info!(
            target: "flux::kb",
            source,
            ms = started.elapsed().as_millis() as u64,
            "auto-reindexed after an edit"
        ),
        // "already running" is the common case when a manual reindex overlaps;
        // the source stays dirty-free but the manual run covers it.
        Err(e) => tracing::debug!(target: "flux::kb", source, "auto-reindex skipped: {e}"),
    }
}

/// Start the debounce worker and the Onyx vault watch. Idempotent per app.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let Some(fresh) = handle.try_state::<Arc<KbFreshness>>() else {
            continue;
        };
        for source in fresh.take_due() {
            reindex_one(&handle, &source);
        }
    });
    watch_onyx(app);
}

/// Watch the Onyx vault so notes written in the Onyx TUI — outside Flux
/// entirely — become answerable without a manual reindex.
///
/// Failure here is not fatal and not worth a dialog: without the watch, Onyx
/// simply goes back to being refreshed on demand, which is where it was before.
fn watch_onyx(app: &AppHandle) {
    use notify::Watcher;

    let Some(kb) = app.try_state::<crate::kb::KbStore>() else {
        return;
    };
    let location = kb.source_location("onyx");
    let Some(vault) = crate::kb::onyx_vault(location.as_deref()) else {
        tracing::debug!(target: "flux::kb", "no Onyx vault to watch");
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
                return;
            }
            tracing::info!(target: "flux::kb", vault = %vault.display(), "watching the Onyx vault");
            // The watcher stops on drop, so it has to outlive this function.
            app.manage(OnyxWatch(Mutex::new(Some(w))));
        }
        Err(e) => tracing::warn!(target: "flux::kb", "no Onyx watcher: {e}"),
    }
}

/// Keeps the vault watcher alive for the process's lifetime (dropping a
/// `notify` watcher silently stops delivery).
struct OnyxWatch(#[allow(dead_code)] Mutex<Option<notify::RecommendedWatcher>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_burst_becomes_one_rebuild() {
        // The whole point of the debounce: scribe_save fires ~2x/second while
        // you write, and each rebuild embeds.
        let f = KbFreshness::default();
        for _ in 0..50 {
            f.touch("scribe");
        }
        assert_eq!(f.pending(), 1, "one source, however many edits");
        assert!(f.take_due().is_empty(), "still within the quiet window");
    }

    #[test]
    fn a_source_is_due_once_it_goes_quiet() {
        let f = KbFreshness::default();
        f.touch("scribe");
        // Reach in rather than sleeping QUIET in a unit test.
        f.dirty.lock().insert(
            "scribe".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due(), vec!["scribe".to_string()]);
        assert_eq!(f.pending(), 0, "taken, not left to rebuild forever");
    }

    #[test]
    fn an_edit_during_a_rebuild_is_not_swallowed() {
        // take_due clears the flag *before* the rebuild runs, so a save landing
        // mid-rebuild re-marks the source instead of being lost to the rebuild
        // that had already read the old state.
        let f = KbFreshness::default();
        f.dirty.lock().insert(
            "scribe".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due().len(), 1);
        f.touch("scribe"); // the edit that arrived during the rebuild
        assert_eq!(f.pending(), 1);
    }

    #[test]
    fn sources_are_tracked_independently() {
        let f = KbFreshness::default();
        f.touch("scribe");
        f.touch("onyx");
        f.dirty.lock().insert(
            "onyx".into(),
            Instant::now() - QUIET - Duration::from_millis(1),
        );
        assert_eq!(f.take_due(), vec!["onyx".to_string()]);
        assert_eq!(f.pending(), 1, "scribe is still waiting out its own window");
    }
}
