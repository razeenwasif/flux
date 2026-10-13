//! Atomic best-effort persistence (Phase 2 refactor).
//!
//! Every feature store persists its own JSON file to the app-data dir. The
//! writers were all `let _ = fs::write(path, json)` — fire-and-forget by
//! design (a failed save must never take down the browser) but a crash or
//! power loss mid-write could leave a truncated file that silently wiped the
//! store on next boot. These helpers keep the best-effort contract and close
//! that hole: write to a temp file in the same directory, then rename over
//! the target. Rename is atomic on the same filesystem (POSIX and NTFS), so
//! a reader sees either the old file or the new one — never a torn mix.
//!
//! Each write says how durable it must be ([`Durability`]). On a Mac the full
//! flush behind `sync_all` empties the drive's own cache and often takes 5–20 ms
//! or more, which only the files that can't be rebuilt need.
//!
//! Stores that save from the UI thread, or in bursts, hand their bytes to one
//! writer thread instead ([`queue_json`] and friends); see "The shared writer"
//! below.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex, MutexGuard};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// How sure a write must be of reaching the disk before it counts as done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Durability {
    /// Flush the drive's cache too (`F_FULLFSYNC` on Apple, `fsync` elsewhere):
    /// once written, the bytes survive a power cut. For what can't be rebuilt
    /// or fetched again: the password vault and its key files, the Trail's key,
    /// the sync blob that carries every device's salt.
    Full,
    /// Order the data before the rename without waiting for the drive to empty
    /// its cache (`F_BARRIERFSYNC` on Apple, `fdatasync` elsewhere). A crash or
    /// power cut still leaves the old file or the new one, never a torn mix,
    /// but may lose the last few seconds of changes. For everything else.
    Barrier,
}

/// Atomically replace `path` with `bytes`. Creates parent dirs. The temp name
/// carries the pid and a sequence counter so concurrent writers never clobber staging.
pub(crate) fn write_atomic_with(
    path: &Path,
    bytes: &[u8],
    durability: Durability,
) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}.{}.tmp", std::process::id(), seq));
    let tmp = path.with_file_name(name);
    let written = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        match durability {
            Durability::Full => file.sync_all(),
            Durability::Barrier => barrier_sync(&file),
        }
    });
    written
        .and_then(|()| std::fs::rename(&tmp, path))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp); // don't leave staging litter behind
        })
}

/// Apple: `F_BARRIERFSYNC`, which orders this file's data before any later
/// write (the rename) without flushing the drive cache. Filesystems that
/// don't support it (some network mounts) get a plain `fsync`, which is what
/// the barrier adds to.
#[cfg(target_vendor = "apple")]
fn barrier_sync(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    // SAFETY: `fd` stays open while `file` is borrowed, and neither call takes
    // a pointer.
    retry_interrupted(|| unsafe { libc::fcntl(fd, libc::F_BARRIERFSYNC) })
        .or_else(|_| retry_interrupted(|| unsafe { libc::fsync(fd) }))
}

#[cfg(target_vendor = "apple")]
fn retry_interrupted(mut call: impl FnMut() -> libc::c_int) -> std::io::Result<()> {
    loop {
        if call() != -1 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

/// Elsewhere `fdatasync` (Linux) or `FlushFileBuffers` (Windows): the closest
/// thing each offers, and no dearer than the full sync it replaces.
#[cfg(not(target_vendor = "apple"))]
fn barrier_sync(file: &std::fs::File) -> std::io::Result<()> {
    file.sync_data()
}

/// Serialize `value` and atomically replace `path`, on this thread. Best-effort:
/// serialization or IO failure is swallowed, matching the previous per-module
/// writers. For stores that read their file back, or must know it landed;
/// the rest use [`queue_json`].
pub(crate) fn save_json<T: serde::Serialize + ?Sized>(
    path: &Path,
    value: &T,
    durability: Durability,
) {
    if let Ok(json) = serde_json::to_vec(value) {
        let _ = write_atomic_with(path, &json, durability);
    }
}

/// `save_json`, pretty-printed — for the stores users may open in an editor.
pub(crate) fn save_json_pretty<T: serde::Serialize + ?Sized>(
    path: &Path,
    value: &T,
    durability: Durability,
) {
    if let Ok(json) = serde_json::to_vec_pretty(value) {
        let _ = write_atomic_with(path, &json, durability);
    }
}

// ─── The shared writer ───────────────────────────────────────────────────────
// A toggle, a bookmark or an extension's `storage.set` used to serialize and
// sync its whole store to disk right there, often on the UI thread. Queued
// saves are serialized by the caller (so the bytes match the moment of the
// save) and written by one thread. The newest bytes for a path replace any
// still queued for it, so a burst costs one write, and one thread writing in
// queue order means a path never goes back to older content. A queued save is
// lost if the process dies within a moment of it; a normal quit calls
// [`flush_all`].
//
// Only for stores that never read their file back after loading it: a read
// right after a queued save can still see the old content.

/// How long the writer lets a burst gather before writing it.
const GATHER: Duration = Duration::from_millis(250);

static WRITER: OnceLock<Option<Arc<Writer>>> = OnceLock::new();

/// Queue `bytes` to replace `path` and return at once. Best-effort, like
/// [`save_json`]: a failed write is logged and dropped.
pub(crate) fn queue_write(path: &Path, bytes: Vec<u8>, durability: Durability) {
    // Unit tests write in place: they read store files back right after saving.
    let writer = if cfg!(test) {
        None
    } else {
        WRITER.get_or_init(|| Writer::start(GATHER)).as_deref()
    };
    match writer {
        Some(w) => w.push(path.to_path_buf(), bytes, durability),
        // No writer thread (it couldn't be spawned): write here, as before.
        None => write_logged(path, &bytes, durability),
    }
}

/// [`save_json`] through the shared writer.
pub(crate) fn queue_json<T: serde::Serialize + ?Sized>(
    path: &Path,
    value: &T,
    durability: Durability,
) {
    if let Ok(json) = serde_json::to_vec(value) {
        queue_write(path, json, durability);
    }
}

/// [`save_json_pretty`] through the shared writer.
pub(crate) fn queue_json_pretty<T: serde::Serialize + ?Sized>(
    path: &Path,
    value: &T,
    durability: Durability,
) {
    if let Ok(json) = serde_json::to_vec_pretty(value) {
        queue_write(path, json, durability);
    }
}

/// Plain text through the shared writer. For settings that are a single
/// scalar, where JSON would only add quotes to read back.
pub(crate) fn queue_text(path: &Path, text: &str, durability: Durability) {
    queue_write(path, text.as_bytes().to_vec(), durability);
}

/// Block until every save queued so far is on disk. For shutdown, where a
/// save still queued would be cut off.
pub(crate) fn flush_all() {
    if let Some(Some(w)) = WRITER.get() {
        w.flush();
    }
}

fn write_logged(path: &Path, bytes: &[u8], durability: Durability) {
    if let Err(e) = write_atomic_with(path, bytes, durability) {
        tracing::warn!(target: "flux::persist", path = %path.display(), "queued save failed: {e}");
    }
}

struct Queued {
    bytes: Vec<u8>,
    durability: Durability,
    /// The oldest save these bytes stand for. A save that a newer one replaced
    /// is done once the newer one is written.
    since: u64,
}

#[derive(Default)]
struct Queue {
    queued: HashMap<PathBuf, Queued>,
    /// Paths in the order they were first queued, so a store that saves
    /// constantly can't hold the others back.
    order: VecDeque<PathBuf>,
    /// The number the next save gets.
    next: u64,
    /// The `since` of the save being written right now.
    writing: Option<u64>,
    /// Callers waiting in `flush`: the writer skips the gathering pause.
    flushing: usize,
}

struct Writer {
    queue: Mutex<Queue>,
    changed: Condvar,
    gather: Duration,
    /// Writes done, for tests to see a burst collapse.
    writes: AtomicU64,
}

impl Writer {
    fn start(gather: Duration) -> Option<Arc<Writer>> {
        let writer = Arc::new(Writer {
            queue: Mutex::default(),
            changed: Condvar::new(),
            gather,
            writes: AtomicU64::new(0),
        });
        let run = Arc::clone(&writer);
        std::thread::Builder::new()
            .name("flux-store-writer".into())
            .spawn(move || run.run())
            .ok()?;
        Some(writer)
    }

    fn push(&self, path: PathBuf, bytes: Vec<u8>, durability: Durability) {
        let mut q = self.queue.lock();
        let n = q.next;
        q.next += 1;
        match q.queued.get_mut(&path) {
            Some(older) => {
                older.bytes = bytes;
                // These bytes carry the older save too, so its level still applies.
                if durability == Durability::Full {
                    older.durability = Durability::Full;
                }
            }
            None => {
                q.order.push_back(path.clone());
                q.queued.insert(
                    path,
                    Queued {
                        bytes,
                        durability,
                        since: n,
                    },
                );
            }
        }
        drop(q);
        self.changed.notify_all();
    }

    fn flush(&self) {
        let mut q = self.queue.lock();
        let upto = q.next;
        q.flushing += 1;
        self.changed.notify_all();
        while q.writing.is_some_and(|n| n < upto) || q.queued.values().any(|w| w.since < upto) {
            self.changed.wait(&mut q);
        }
        q.flushing -= 1;
    }

    fn run(&self) {
        let mut q = self.queue.lock();
        loop {
            while q.order.is_empty() {
                self.changed.wait(&mut q);
            }
            let until = Instant::now() + self.gather;
            while q.flushing == 0 && !self.changed.wait_until(&mut q, until).timed_out() {}
            while let Some(path) = q.order.pop_front() {
                let Some(w) = q.queued.remove(&path) else {
                    continue;
                };
                q.writing = Some(w.since);
                MutexGuard::unlocked(&mut q, || {
                    write_logged(&path, &w.bytes, w.durability);
                    self.writes.fetch_add(1, Ordering::Relaxed);
                });
                q.writing = None;
                self.changed.notify_all();
            }
        }
    }
}

/// Load a store at hydration with `parse`. `None` means start empty: the file
/// is missing, or it exists but can't be read or parsed. In that case a copy is
/// kept beside it first ([`quarantine`]), because the store's next save would
/// otherwise replace the only copy with defaults; a session written by a newer
/// build (a tab kind this one doesn't know) silently lost every tab that way.
pub(crate) fn load_or_quarantine<T>(
    path: &Path,
    parse: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Option<T> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            quarantine(path, &e.to_string());
            return None;
        }
    };
    match parse(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            quarantine(path, &e);
            None
        }
    }
}

/// [`load_or_quarantine`] for a store that is a single JSON value.
pub(crate) fn load_json_or_quarantine<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    load_or_quarantine(path, |b| {
        serde_json::from_slice(b).map_err(|e| e.to_string())
    })
}

/// Copy an unreadable store aside as `<name>.unreadable-<ms>` (best-effort) and
/// say so in the log, the only place a user could learn why it came up empty.
pub(crate) fn quarantine(path: &Path, why: &str) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".unreadable-{ms}"));
    let kept = std::fs::copy(path, path.with_file_name(name)).is_ok();
    tracing::warn!(target: "flux::persist", path = %path.display(), kept, "unreadable store, starting empty: {why}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-persist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_atomic_replaces_existing_content() {
        let dir = scratch("replace");
        let p = dir.join("nested").join("store.json");
        write_atomic_with(&p, b"first", Durability::Full).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"first");
        write_atomic_with(&p, b"second", Durability::Full).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
        // No staging litter left behind.
        let entries: Vec<_> = std::fs::read_dir(p.parent().unwrap()).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_barrier_write_replaces_like_a_full_one() {
        let dir = scratch("barrier");
        let p = dir.join("store.json");
        write_atomic_with(&p, b"first", Durability::Barrier).unwrap();
        write_atomic_with(&p, b"second", Durability::Barrier).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_no_staging_file() {
        let dir = scratch("failed");
        // The target is a directory, so the rename fails after the temp file
        // was written and synced.
        let p = dir.join("store.json");
        std::fs::create_dir_all(p.join("child")).unwrap();
        assert!(write_atomic_with(&p, b"bytes", Durability::Barrier).is_err());
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("store.json")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_json_roundtrips() {
        let dir = scratch("json");
        let p = dir.join("v.json");
        save_json(&p, &vec![1u32, 2, 3], Durability::Barrier);
        let back: Vec<u32> = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(back, vec![1, 2, 3]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_store_is_kept_before_starting_empty() {
        let dir = scratch("quarantine");
        let p = dir.join("store.json");
        // Missing: just empty, nothing copied.
        assert_eq!(load_json_or_quarantine::<Vec<u32>>(&p), None);
        assert!(!dir.exists());
        // Present but unparseable (here: not even UTF-8).
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&p, b"[1, 2, \xff").unwrap();
        assert_eq!(load_json_or_quarantine::<Vec<u32>>(&p), None);
        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("store.json.unreadable-")
            })
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"[1, 2, \xff");
        // A good file loads.
        save_json(&p, &vec![1u32, 2], Durability::Barrier);
        assert_eq!(load_json_or_quarantine::<Vec<u32>>(&p), Some(vec![1, 2]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_burst_collapses_to_its_newest_save_and_flush_skips_the_pause() {
        let dir = scratch("burst");
        let (a, b) = (dir.join("a.json"), dir.join("b.json"));
        // A pause no test would wait out: only `flush` can end it early.
        let w = Writer::start(Duration::from_secs(30)).unwrap();
        let started = Instant::now();
        for n in 0..50u32 {
            w.push(a.clone(), n.to_string().into_bytes(), Durability::Barrier);
        }
        w.push(b.clone(), b"other".to_vec(), Durability::Full);
        w.flush();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "49");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "other");
        assert_eq!(w.writes.load(Ordering::Relaxed), 2, "one write per path");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_queued_path_never_goes_back_to_older_content() {
        let dir = scratch("monotonic");
        let p = dir.join("n.txt");
        let w = Writer::start(Duration::ZERO).unwrap();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Polls while saves stream through: the number may only ever rise.
        let reader = {
            let (p, done) = (p.clone(), Arc::clone(&done));
            std::thread::spawn(move || {
                let mut last = 0u64;
                while !done.load(Ordering::Relaxed) {
                    let Ok(s) = std::fs::read_to_string(&p) else {
                        continue;
                    };
                    let n: u64 = s.parse().unwrap();
                    assert!(n >= last, "went back from {last} to {n}");
                    last = n;
                }
            })
        };
        for n in 1..=200u64 {
            w.push(p.clone(), n.to_string().into_bytes(), Durability::Barrier);
        }
        w.flush();
        done.store(true, Ordering::Relaxed);
        reader.join().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "200");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flush_with_nothing_queued_returns() {
        let w = Writer::start(Duration::from_secs(30)).unwrap();
        w.flush();
        assert_eq!(w.writes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn concurrent_writers_do_not_collide() {
        let dir = scratch("concurrent");
        let p = dir.join("concurrent.json");
        let mut handles = Vec::new();
        for i in 0..10 {
            let p = p.clone();
            handles.push(std::thread::spawn(move || {
                let bytes = format!("writer-{}", i).into_bytes();
                write_atomic_with(&p, &bytes, Durability::Full).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let read = std::fs::read_to_string(&p).unwrap();
        assert!(read.starts_with("writer-"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
