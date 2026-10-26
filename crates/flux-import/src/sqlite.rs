//! Reading another browser's SQLite databases without disturbing it.
//!
//! The browser holds its databases open while it runs, often in WAL mode, so
//! we never touch them in place. An import copies the database (with its
//! write-ahead log or journal) to a temporary folder and reads the copy; a
//! count for the import list opens the original read-only and `immutable`,
//! which takes no lock and may be a little behind. Both go through the
//! system's `sqlite3` tool (every Mac has `/usr/bin/sqlite3`): bundling
//! SQLite itself would cost about a megabyte of binary for one import.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::de::DeserializeOwned;

use crate::ImportError;

/// The `sqlite3` tool: the system's on a Mac (an app launched from the Dock
/// doesn't see a shell's PATH), else whichever is on PATH.
pub(crate) fn tool() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    if Path::new("/usr/bin/sqlite3").exists() {
        return Some(PathBuf::from("/usr/bin/sqlite3"));
    }
    let exe = if cfg!(windows) {
        "sqlite3.exe"
    } else {
        "sqlite3"
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

/// `db` and whichever of its `-wal` / `-journal` exist, copied to a folder
/// of their own. Returns the folder and the copy's path.
fn snapshot(db: &Path) -> Result<(PathBuf, PathBuf), ImportError> {
    let dir = std::env::temp_dir().join(format!(
        "flux-import-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir)?;
    let name = db.file_name().unwrap_or_default();
    let copy = dir.join(name);
    if let Err(e) = fs::copy(db, &copy) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    for side in ["-wal", "-journal"] {
        let mut from = db.as_os_str().to_owned();
        from.push(side);
        let from = PathBuf::from(from);
        if from.exists() {
            let mut to = copy.as_os_str().to_owned();
            to.push(side);
            let _ = fs::copy(&from, PathBuf::from(to));
        }
    }
    Ok((dir, copy))
}

/// `file:` URI for opening `db` read-only without taking a lock.
fn immutable_uri(db: &Path) -> String {
    let mut uri = String::from("file:");
    for b in db.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(b as char)
            }
            _ => uri.push_str(&format!("%{b:02X}")),
        }
    }
    uri.push_str("?immutable=1");
    uri
}

fn run<T: DeserializeOwned>(
    tool: &Path,
    target: &str,
    sql: &str,
    file: &'static str,
) -> Result<Vec<T>, ImportError> {
    let out = Command::new(tool)
        .arg("-json")
        .arg(target)
        .arg(sql)
        .output()?;
    if !out.status.success() {
        return Err(ImportError::Other(format!(
            "sqlite3 couldn't read {file}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new()); // `-json` prints nothing at all for no rows
    }
    serde_json::from_slice(&out.stdout).map_err(|source| ImportError::Parse { file, source })
}

/// Rows of `sql` against a copy of `db`, today's writes included.
pub(crate) fn query<T: DeserializeOwned>(
    db: &Path,
    sql: &str,
    file: &'static str,
) -> Result<Vec<T>, ImportError> {
    let tool = tool().ok_or_else(|| ImportError::Other("no sqlite3 tool to read with".into()))?;
    let (dir, copy) = snapshot(db)?;
    let out = run(&tool, &copy.to_string_lossy(), sql, file);
    let _ = fs::remove_dir_all(&dir);
    out
}

/// Rows of `sql` against `db` itself, read-only and lock-free: for counts.
pub(crate) fn peek<T: DeserializeOwned>(
    db: &Path,
    sql: &str,
    file: &'static str,
) -> Result<Vec<T>, ImportError> {
    let tool = tool().ok_or_else(|| ImportError::Other("no sqlite3 tool to read with".into()))?;
    // Opening a protected file (Safari's, without Full Disk Access) fails
    // here rather than as a vague sqlite error.
    fs::File::open(db)?;
    run(&tool, &immutable_uri(db), sql, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_escape_spaces_and_query_marks() {
        assert_eq!(
            immutable_uri(Path::new("/Users/a/Library/Application Support/Arc/User Data/Default/History")),
            "file:/Users/a/Library/Application%20Support/Arc/User%20Data/Default/History?immutable=1"
        );
        assert_eq!(
            immutable_uri(Path::new("/x/a?b#c")),
            "file:/x/a%3Fb%23c?immutable=1"
        );
    }

    #[test]
    fn reads_a_copy_and_peeks_at_the_original() {
        let Some(tool) = tool() else { return };
        let dir = std::env::temp_dir().join(format!("flux-sqlite-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("History");
        let made = Command::new(&tool)
            .arg(&db)
            .arg("CREATE TABLE urls(url TEXT, n INT); INSERT INTO urls VALUES ('https://a.test/', 2), ('https://b.test/', 5);")
            .status()
            .unwrap();
        assert!(made.success());
        #[derive(serde::Deserialize)]
        struct R {
            url: String,
            n: i64,
        }
        let rows: Vec<R> =
            query(&db, "SELECT url, n FROM urls ORDER BY n DESC;", "History").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].url.as_str(), rows[0].n), ("https://b.test/", 5));
        #[derive(serde::Deserialize)]
        struct C {
            c: i64,
        }
        let c: Vec<C> = peek(&db, "SELECT COUNT(*) AS c FROM urls;", "History").unwrap();
        assert_eq!(c[0].c, 2);
        let empty: Vec<R> = query(&db, "SELECT url, n FROM urls WHERE n > 9;", "History").unwrap();
        assert!(empty.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
