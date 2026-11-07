//! Saved tab groups from the Chromium family (BACKLOG #23).
//!
//! A saved group outlives its tabs being open, and Chrome keeps it in the
//! profile's sync store, `Sync Data/LevelDB`, whether or not you're signed in.
//! Every group and every tab is its own record, under `saved_tab_group-dt-<guid>`
//! (`A-saved_tab_group-dt-<guid>` for ones held in the account). The value is a
//! protobuf: `SavedTabGroupData { specifics = 2 }` since about Chrome 131, and
//! the `SavedTabGroupSpecifics` inside it, bare, before that.
//! (components/saved_tab_groups/proto and components/sync/protocol in Chromium.)
//!
//! Internal to Chrome, so it's read defensively: a record that doesn't parse is
//! skipped rather than failing the import. The store is locked while the browser
//! runs, so it's read from a copy, like the databases in sqlite.rs.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use rusty_leveldb::{LdbIterator, Options, DB};

use crate::private_dir::PrivateDir;
use crate::ImportError;

/// A store bigger than this isn't copied to look through it: `Sync Data` holds
/// everything sync has, and scanning for browsers shouldn't stall on it.
const MAX_STORE_BYTES: u64 = 256 * 1024 * 1024;

/// A saved group and its tabs, in the order the browser shows them.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedGroup {
    pub title: String,
    /// (title, url)
    pub tabs: Vec<(String, String)>,
}

/// A field in protobuf's wire format, as far as these messages need.
enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut out = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *bytes.get(*at)?;
        *at += 1;
        out |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(out);
        }
    }
    None
}

/// Each field's number with its varint or its bytes. `None` when `bytes` isn't
/// a message at all.
fn fields(bytes: &[u8]) -> Option<Vec<(u64, Value<'_>)>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let tag = varint(bytes, &mut at)?;
        let value = match tag & 7 {
            0 => Value::Varint(varint(bytes, &mut at)?),
            2 => {
                let len = usize::try_from(varint(bytes, &mut at)?).ok()?;
                let end = at.checked_add(len)?;
                let v = bytes.get(at..end)?;
                at = end;
                Value::Bytes(v)
            }
            1 => {
                at = at.checked_add(8)?;
                bytes.get(..at)?;
                continue;
            }
            5 => {
                at = at.checked_add(4)?;
                bytes.get(..at)?;
                continue;
            }
            _ => return None,
        };
        out.push((tag >> 3, value));
    }
    Some(out)
}

fn text(msg: &[(u64, Value<'_>)], field: u64) -> String {
    msg.iter()
        .find_map(|(n, v)| match v {
            Value::Bytes(b) if *n == field => Some(String::from_utf8_lossy(b).into_owned()),
            _ => None,
        })
        .unwrap_or_default()
}

fn number(msg: &[(u64, Value<'_>)], field: u64) -> i64 {
    msg.iter()
        .find_map(|(n, v)| match v {
            Value::Varint(x) if *n == field => Some(*x as i64),
            _ => None,
        })
        .unwrap_or(0)
}

fn message<'a>(msg: &[(u64, Value<'a>)], field: u64) -> Option<Vec<(u64, Value<'a>)>> {
    msg.iter().find_map(|(n, v)| match v {
        Value::Bytes(b) if *n == field => fields(b),
        _ => None,
    })
}

#[derive(Debug, PartialEq)]
enum Entry {
    Group {
        guid: String,
        title: String,
        position: i64,
    },
    Tab {
        group: String,
        title: String,
        url: String,
        position: i64,
    },
}

/// One stored record. The wrapper's field 2 is a message, and the bare form's
/// field 2 is a timestamp, which is how the two are told apart.
fn parse_entry(value: &[u8]) -> Option<Entry> {
    let top = fields(value)?;
    let wrapped = top
        .iter()
        .any(|(n, v)| *n == 2 && matches!(v, Value::Bytes(_)));
    let inner;
    let specifics = if wrapped {
        inner = message(&top, 2)?;
        &inner
    } else {
        &top
    };
    if let Some(g) = message(specifics, 4) {
        return Some(Entry::Group {
            guid: text(specifics, 1),
            title: text(&g, 2),
            position: number(&g, 1),
        });
    }
    let t = message(specifics, 5)?;
    Some(Entry::Tab {
        group: text(&t, 1),
        title: text(&t, 4),
        url: text(&t, 3),
        position: number(&t, 2),
    })
}

fn is_saved_group_key(key: &[u8]) -> bool {
    key.starts_with(b"saved_tab_group-dt-") || key.starts_with(b"A-saved_tab_group-dt-")
}

/// Groups from a store's records (key, value): each record once, even when it's
/// held both locally and in the account; only web pages; no empty groups; and a
/// tab whose group is gone is dropped, as the browser drops it.
fn groups_from(records: impl IntoIterator<Item = (Vec<u8>, Vec<u8>)>) -> Vec<SavedGroup> {
    let mut groups: BTreeMap<String, (i64, String)> = BTreeMap::new();
    let mut tabs: HashMap<String, Vec<(i64, String, String)>> = HashMap::new();
    let mut seen_tabs = std::collections::HashSet::new();
    for (key, value) in records {
        if !is_saved_group_key(&key) {
            continue;
        }
        match parse_entry(&value) {
            Some(Entry::Group {
                guid,
                title,
                position,
            }) if !guid.is_empty() => {
                groups.insert(guid, (position, title));
            }
            Some(Entry::Tab {
                group,
                title,
                url,
                position,
            }) if (url.starts_with("http://") || url.starts_with("https://"))
                && seen_tabs.insert(key.strip_prefix(b"A-").unwrap_or(&key).to_vec()) =>
            {
                tabs.entry(group).or_default().push((position, title, url));
            }
            _ => {}
        }
    }
    let mut ordered: Vec<(i64, String, String)> = groups
        .into_iter()
        .map(|(guid, (position, title))| (position, title, guid))
        .collect();
    ordered.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    ordered
        .into_iter()
        .filter_map(|(_, title, guid)| {
            let mut list = tabs.remove(&guid)?;
            list.sort_by_key(|t| t.0);
            Some(SavedGroup {
                title,
                tabs: list.into_iter().map(|(_, t, u)| (t, u)).collect(),
            })
        })
        .collect()
}

/// A copy of the store in a temporary folder, removed when that's dropped.
fn copy_store(store: &Path) -> Result<PrivateDir, ImportError> {
    let copy = PrivateDir::new("flux-import-groups")?;
    let mut total = 0u64;
    for entry in fs::read_dir(store)?.flatten() {
        let name = entry.file_name();
        // The running browser's lock, and logs of what LevelDB did.
        if matches!(name.to_str(), Some("LOCK" | "LOG" | "LOG.old")) {
            continue;
        }
        total += entry.metadata()?.len();
        if total > MAX_STORE_BYTES {
            return Err(ImportError::Other(
                "the sync store is too large to read".into(),
            ));
        }
        fs::copy(entry.path(), copy.path().join(name))?;
    }
    Ok(copy)
}

fn read_store(dir: &Path) -> Result<Vec<SavedGroup>, ImportError> {
    let options = Options {
        create_if_missing: false,
        ..Options::default()
    };
    let mut db = DB::open(dir, options).map_err(|e| ImportError::Other(e.to_string()))?;
    let mut iter = db
        .new_iter()
        .map_err(|e| ImportError::Other(e.to_string()))?;
    let mut records = Vec::new();
    while let Some((key, value)) = iter.next() {
        if is_saved_group_key(&key) {
            records.push((key.to_vec(), value.to_vec()));
        }
    }
    Ok(groups_from(records))
}

/// A profile's saved tab groups. A profile with no sync store has none.
pub fn saved_groups(profile: &Path) -> Result<Vec<SavedGroup>, ImportError> {
    let store = profile.join("Sync Data").join("LevelDB");
    if !store.join("CURRENT").exists() {
        return Ok(Vec::new());
    }
    let copy = copy_store(&store)?;
    read_store(copy.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(field: u64, wire: u64, out: &mut Vec<u8>) {
        put_varint((field << 3) | wire, out);
    }
    fn put_varint(mut v: u64, out: &mut Vec<u8>) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
    fn bytes(field: u64, v: &[u8], out: &mut Vec<u8>) {
        tag(field, 2, out);
        put_varint(v.len() as u64, out);
        out.extend_from_slice(v);
    }
    fn num(field: u64, v: u64, out: &mut Vec<u8>) {
        tag(field, 0, out);
        put_varint(v, out);
    }

    /// `SavedTabGroupSpecifics` for a group, as Chromium writes it.
    fn group_specifics(guid: &str, title: &str, position: u64) -> Vec<u8> {
        let mut g = Vec::new();
        num(1, position, &mut g);
        bytes(2, title.as_bytes(), &mut g);
        num(3, 2, &mut g); // colour: blue
        let mut s = Vec::new();
        bytes(1, guid.as_bytes(), &mut s);
        num(2, 13_380_000_000_000_000, &mut s); // creation time
        num(3, 13_380_000_000_000_001, &mut s); // update time
        bytes(4, &g, &mut s);
        s
    }

    fn tab_specifics(guid: &str, group: &str, position: u64, url: &str, title: &str) -> Vec<u8> {
        let mut t = Vec::new();
        bytes(1, group.as_bytes(), &mut t);
        num(2, position, &mut t);
        bytes(3, url.as_bytes(), &mut t);
        bytes(4, title.as_bytes(), &mut t);
        let mut s = Vec::new();
        bytes(1, guid.as_bytes(), &mut s);
        num(2, 13_380_000_000_000_000, &mut s);
        bytes(5, &t, &mut s);
        s
    }

    /// `SavedTabGroupData`, the wrapper since about Chrome 131.
    fn wrapped(specifics: &[u8]) -> Vec<u8> {
        let mut w = Vec::new();
        num(1, 1, &mut w);
        bytes(2, specifics, &mut w);
        w
    }

    fn key(guid: &str) -> Vec<u8> {
        format!("saved_tab_group-dt-{guid}").into_bytes()
    }

    fn sample() -> Vec<(Vec<u8>, Vec<u8>)> {
        vec![
            (key("g2"), wrapped(&group_specifics("g2", "Work", 2))),
            (key("g1"), wrapped(&group_specifics("g1", "Uni", 1))),
            (
                key("t2"),
                wrapped(&tab_specifics("t2", "g1", 1, "https://b.example/", "B")),
            ),
            (
                key("t1"),
                wrapped(&tab_specifics("t1", "g1", 0, "https://a.example/", "A")),
            ),
            (
                key("t3"),
                wrapped(&tab_specifics("t3", "g2", 0, "https://c.example/", "C")),
            ),
        ]
    }

    fn uni_and_work() -> Vec<SavedGroup> {
        vec![
            SavedGroup {
                title: "Uni".into(),
                tabs: vec![
                    ("A".into(), "https://a.example/".into()),
                    ("B".into(), "https://b.example/".into()),
                ],
            },
            SavedGroup {
                title: "Work".into(),
                tabs: vec![("C".into(), "https://c.example/".into())],
            },
        ]
    }

    #[test]
    fn groups_and_tabs_come_back_in_the_browsers_order() {
        assert_eq!(groups_from(sample()), uni_and_work());
    }

    #[test]
    fn the_older_bare_records_read_the_same() {
        let bare = vec![
            (key("g1"), group_specifics("g1", "Uni", 1)),
            (
                key("t1"),
                tab_specifics("t1", "g1", 0, "https://a.example/", "A"),
            ),
        ];
        assert_eq!(
            groups_from(bare),
            vec![SavedGroup {
                title: "Uni".into(),
                tabs: vec![("A".into(), "https://a.example/".into())],
            }]
        );
    }

    #[test]
    fn account_and_local_copies_of_a_record_count_once() {
        let mut records = sample();
        records.push((
            b"A-saved_tab_group-dt-t1".to_vec(),
            wrapped(&tab_specifics("t1", "g1", 0, "https://a.example/", "A")),
        ));
        records.push((
            b"A-saved_tab_group-dt-g1".to_vec(),
            wrapped(&group_specifics("g1", "Uni", 1)),
        ));
        assert_eq!(groups_from(records), uni_and_work());
    }

    #[test]
    fn what_cant_be_brought_is_left_out_rather_than_failing() {
        let mut records = sample();
        // Not a web page; a tab whose group is gone; a group with no tabs;
        // garbage; metadata, and another data type, under their own keys.
        records.push((
            key("t4"),
            wrapped(&tab_specifics(
                "t4",
                "g1",
                2,
                "chrome://settings",
                "Settings",
            )),
        ));
        records.push((
            key("t5"),
            wrapped(&tab_specifics("t5", "gone", 0, "https://d.example/", "D")),
        ));
        records.push((key("g3"), wrapped(&group_specifics("g3", "Empty", 3))));
        records.push((key("bad"), vec![0xff, 0xff, 0xff]));
        records.push((key("cut"), vec![0x12, 0x40, 0x01]));
        records.push((
            b"saved_tab_group-md-t1".to_vec(),
            wrapped(&tab_specifics("t1", "g1", 0, "https://x.example/", "X")),
        ));
        records.push((
            b"bookmarks-dt-1".to_vec(),
            wrapped(&tab_specifics("t9", "g1", 0, "https://y.example/", "Y")),
        ));
        assert_eq!(groups_from(records), uni_and_work());
    }

    #[test]
    fn a_real_leveldb_store_is_read_from_a_copy() {
        let root = std::env::temp_dir().join(format!("flux-groups-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = root.join("Default/Sync Data/LevelDB");
        fs::create_dir_all(&store).unwrap();
        {
            let options = Options {
                create_if_missing: true,
                ..Options::default()
            };
            let mut db = DB::open(&store, options).unwrap();
            for (k, v) in sample() {
                db.put(&k, &v).unwrap();
            }
            // A deleted group stays deleted, and a later write wins.
            let stale = wrapped(&group_specifics("g9", "Deleted", 9));
            db.put(&key("g9"), &stale).unwrap();
            db.put(
                &key("t9"),
                &wrapped(&tab_specifics("t9", "g9", 0, "https://z.example/", "Z")),
            )
            .unwrap();
            db.delete(&key("g9")).unwrap();
            db.flush().unwrap();
        }
        assert_eq!(saved_groups(&root.join("Default")).unwrap(), uni_and_work());
        // The browser's own store wasn't touched by reading it.
        assert!(store.join("CURRENT").exists());
        // No store: none, not an error.
        assert!(saved_groups(&root.join("Nobody")).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
