//! Temporary folders for copies of another browser's data.
//!
//! Those copies hold history, bookmarks and whatever the browser syncs. A Mac's
//! temp folder is per-user, but Linux's `/tmp` is shared, and a folder made
//! with the default mode there lets anyone on the machine read them. So the
//! folder is private from the moment it exists, rather than made and then
//! narrowed. It's also always new: a name someone else got to first, a symlink
//! included, is passed over rather than used.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Names to try before giving up. One clash is already unlikely: the name has
/// the time in nanoseconds in it.
const ATTEMPTS: u32 = 16;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A new folder only this user can open, removed when dropped.
pub(crate) struct PrivateDir(PathBuf);

impl PrivateDir {
    pub(crate) fn new(prefix: &str) -> io::Result<Self> {
        let parent = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut last = None;
        for _ in 0..ATTEMPTS {
            let path = parent.join(format!(
                "{prefix}-{}-{nanos}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| io::ErrorKind::AlreadyExists.into()))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Fails if anything is already at `path`.
#[cfg(unix)]
fn create(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

/// Fails if anything is already at `path`. Windows' temp folder is per-user.
#[cfg(not(unix))]
fn create(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_separate_and_removed_when_dropped() {
        let a = PrivateDir::new("flux-private-test").unwrap();
        let b = PrivateDir::new("flux-private-test").unwrap();
        assert_ne!(a.path(), b.path());
        assert!(a.path().is_dir());
        let gone = a.path().to_path_buf();
        fs::write(gone.join("copy"), "x").unwrap();
        drop(a);
        assert!(!gone.exists());
        assert!(b.path().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn only_this_user_can_open_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = PrivateDir::new("flux-private-test").unwrap();
        let mode = fs::metadata(dir.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_folder_already_there_is_not_taken_over() {
        let planted = PrivateDir::new("flux-private-test").unwrap();
        let err = create(planted.path()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_already_there_is_not_followed() {
        let root = PrivateDir::new("flux-private-test").unwrap();
        let target = root.path().join("target");
        fs::create_dir(&target).unwrap();
        let planted = root.path().join("planted");
        std::os::unix::fs::symlink(&target, &planted).unwrap();
        let err = create(&planted).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        let dangling = root.path().join("dangling");
        std::os::unix::fs::symlink(root.path().join("nowhere"), &dangling).unwrap();
        assert_eq!(
            create(&dangling).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(!root.path().join("nowhere").exists());
    }
}
