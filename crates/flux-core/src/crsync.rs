//! cr-sqlite CRDT sync — **prototype** (evolution of #62).
//!
//! The idea: each device keeps its own SQLite database whose tables are cr-sqlite
//! **CRRs** (conflict-free replicated relations). Instead of shipping the whole DB
//! file (which corrupts over Dropbox and can't merge), each device exports compact
//! **changesets** (rows from `crsql_changes` newer than what the peer has seen),
//! which any device can apply in any order and **converge conflict-free** —
//! cr-sqlite resolves concurrent edits (last-writer-wins per column, ties broken by
//! site id). The changeset bytes are what you'd encrypt + drop in the existing
//! bring-your-own sync folder (reusing `sync.rs`'s AES-256-GCM), keeping Flux's
//! no-server, local-first model.
//!
//! This module is the **storage + merge core**, behind the `crsync` feature (it
//! needs the native cr-sqlite extension). Wiring it to the live bookmark/session/
//! history stores + the encrypted transport is the next step; the tests below
//! prove the merge converges.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One CRR table for the prototype (bookmarks). A real version registers every
/// synced table; the mechanism is identical.
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS bookmarks (\
  id TEXT PRIMARY KEY NOT NULL, title TEXT, url TEXT, folder TEXT, added_ms INTEGER) STRICT;";

/// A SQLite cell value, serializable so a changeset can travel as bytes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Val {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// One row of `crsql_changes` — a single column's CRDT update.
#[derive(Serialize, Deserialize, Clone)]
pub struct Change {
    table: String,
    pk: Vec<u8>,
    cid: String,
    val: Val,
    col_version: i64,
    db_version: i64,
    site_id: Vec<u8>,
    cl: i64,
    seq: i64,
}

pub struct Db {
    conn: Connection,
}

fn val_from(r: &rusqlite::Row, idx: usize) -> Val {
    use rusqlite::types::ValueRef;
    match r.get_ref(idx) {
        Ok(ValueRef::Integer(i)) => Val::Int(i),
        Ok(ValueRef::Real(f)) => Val::Real(f),
        Ok(ValueRef::Text(t)) => Val::Text(String::from_utf8_lossy(t).into_owned()),
        Ok(ValueRef::Blob(b)) => Val::Blob(b.to_vec()),
        _ => Val::Null,
    }
}
fn val_to_sql(v: &Val) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        Val::Null => Value::Null,
        Val::Int(i) => Value::Integer(*i),
        Val::Real(f) => Value::Real(*f),
        Val::Text(t) => Value::Text(t.clone()),
        Val::Blob(b) => Value::Blob(b.clone()),
    }
}

impl Db {
    pub fn open(path: &str, ext_path: &str) -> Result<Db, String> {
        Self::init(Connection::open(path).map_err(|e| e.to_string())?, ext_path)
    }
    pub fn open_memory(ext_path: &str) -> Result<Db, String> {
        Self::init(
            Connection::open_in_memory().map_err(|e| e.to_string())?,
            ext_path,
        )
    }

    fn init(conn: Connection, ext_path: &str) -> Result<Db, String> {
        // Load the cr-sqlite extension (the entry point is `sqlite3_crsqlite_init`).
        unsafe {
            conn.load_extension_enable().map_err(|e| e.to_string())?;
            conn.load_extension(ext_path, Some("sqlite3_crsqlite_init"))
                .map_err(|e| format!("load cr-sqlite ({ext_path}): {e}"))?;
            conn.load_extension_disable().map_err(|e| e.to_string())?;
        }
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // Upgrade the table to a conflict-free replicated relation.
        conn.query_row("SELECT crsql_as_crr('bookmarks')", [], |_| Ok(()))
            .map_err(|e| format!("crsql_as_crr: {e}"))?;
        Ok(Db { conn })
    }

    pub fn exec(&self, sql: &str) -> Result<(), String> {
        self.conn
            .execute(sql, [])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The local logical clock — store this per-peer to send only newer changes.
    pub fn db_version(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT crsql_db_version()", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    fn changes_since(&self, version: i64) -> Result<Vec<Change>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq FROM crsql_changes WHERE db_version > ?")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([version], |r| {
                Ok(Change {
                    table: r.get(0)?,
                    pk: r.get(1)?,
                    cid: r.get(2)?,
                    val: val_from(r, 3),
                    col_version: r.get(4)?,
                    db_version: r.get(5)?,
                    site_id: r.get(6)?,
                    cl: r.get(7)?,
                    seq: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    fn apply(&self, changes: &[Change]) -> Result<(), String> {
        let mut stmt = self
            .conn
            .prepare("INSERT INTO crsql_changes (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?,?,?,?,?,?,?,?,?)")
            .map_err(|e| e.to_string())?;
        for c in changes {
            stmt.execute(rusqlite::params![
                c.table,
                c.pk,
                c.cid,
                val_to_sql(&c.val),
                c.col_version,
                c.db_version,
                c.site_id,
                c.cl,
                c.seq
            ])
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Export the changeset newer than `version` as bytes — encrypt these and drop
    /// them in the sync folder for peers (the transport step, reusing `sync.rs`).
    pub fn export_changeset(&self, version: i64) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.changes_since(version)?).map_err(|e| e.to_string())
    }
    /// Merge a peer's changeset (decrypted). Idempotent + order-independent.
    pub fn import_changeset(&self, bytes: &[u8]) -> Result<(), String> {
        let changes: Vec<Change> = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        self.apply(&changes)
    }

    pub fn bookmark_count(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }
    pub fn bookmark_title(&self, id: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT title FROM bookmarks WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        // cr-sqlite requires finalizing before the connection closes.
        let _ = self.conn.query_row("SELECT crsql_finalize()", [], |_| {
            Ok::<(), rusqlite::Error>(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Extension path relative to the crate dir (where `cargo test` runs).
    const EXT: &str = "../../third_party/crsqlite/crsqlite.so";

    #[test]
    fn changesets_converge() {
        let a = Db::open_memory(EXT).expect("open A");
        let b = Db::open_memory(EXT).expect("open B");
        a.exec("INSERT INTO bookmarks (id,title,url,folder,added_ms) VALUES ('1','Rust','https://rust-lang.org','',100)").unwrap();
        b.exec("INSERT INTO bookmarks (id,title,url,folder,added_ms) VALUES ('2','Flux','https://flux.dev','',200)").unwrap();

        // Exchange both ways (full history; production tracks per-peer versions).
        let ca = a.export_changeset(0).unwrap();
        let cb = b.export_changeset(0).unwrap();
        b.import_changeset(&ca).unwrap();
        a.import_changeset(&cb).unwrap();

        assert_eq!(a.bookmark_count().unwrap(), 2);
        assert_eq!(b.bookmark_count().unwrap(), 2);
        assert_eq!(a.bookmark_title("2").unwrap().as_deref(), Some("Flux"));
        assert_eq!(b.bookmark_title("1").unwrap().as_deref(), Some("Rust"));
    }

    #[test]
    fn concurrent_edits_converge() {
        let a = Db::open_memory(EXT).unwrap();
        let b = Db::open_memory(EXT).unwrap();
        a.exec("INSERT INTO bookmarks (id,title,url,folder,added_ms) VALUES ('1','Orig','u','',1)")
            .unwrap();
        b.import_changeset(&a.export_changeset(0).unwrap()).unwrap(); // seed B

        // Concurrent edits to the same column on both devices.
        a.exec("UPDATE bookmarks SET title='A-edit' WHERE id='1'")
            .unwrap();
        b.exec("UPDATE bookmarks SET title='B-edit' WHERE id='1'")
            .unwrap();

        // Cross-apply — both must land on the SAME value (no conflicted copies).
        b.import_changeset(&a.export_changeset(0).unwrap()).unwrap();
        a.import_changeset(&b.export_changeset(0).unwrap()).unwrap();

        let ta = a.bookmark_title("1").unwrap();
        let tb = b.bookmark_title("1").unwrap();
        assert_eq!(ta, tb, "devices converge to one value");
        assert!(matches!(ta.as_deref(), Some("A-edit") | Some("B-edit")));
    }

    #[test]
    fn delete_propagates() {
        let a = Db::open_memory(EXT).unwrap();
        let b = Db::open_memory(EXT).unwrap();
        a.exec("INSERT INTO bookmarks (id,title,url,folder,added_ms) VALUES ('1','X','u','',1)")
            .unwrap();
        b.import_changeset(&a.export_changeset(0).unwrap()).unwrap();
        assert_eq!(b.bookmark_count().unwrap(), 1);

        a.exec("DELETE FROM bookmarks WHERE id='1'").unwrap();
        b.import_changeset(&a.export_changeset(0).unwrap()).unwrap();
        assert_eq!(
            b.bookmark_count().unwrap(),
            0,
            "delete replicated (no tombstone bookkeeping needed)"
        );
    }
}
