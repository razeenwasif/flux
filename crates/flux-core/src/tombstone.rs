//! Deletion tombstones for E2E sync (BACKLOG #62).
//!
//! A tombstone records that a keyed item was deleted at a millisecond timestamp.
//! Stores keep one per deleted item and sync them inside the encrypted blob, so a
//! delete on one device *propagates* instead of being silently re-added by the
//! next additive merge. An item is suppressed when a tombstone for its key is at
//! least as new as the item's own timestamp; re-adding the key with a newer
//! timestamp wins again (the tombstone is dropped on re-add).

use std::collections::HashMap;

/// key → deletion time (ms since epoch).
pub type Tombstones = HashMap<String, u64>;

/// Fold `incoming` into `local`, keeping the newest deletion time per key.
pub fn merge_into(local: &mut Tombstones, incoming: &Tombstones) {
    for (k, &ts) in incoming {
        let slot = local.entry(k.clone()).or_insert(0);
        if ts > *slot {
            *slot = ts;
        }
    }
}

/// Is an item keyed `key`, created/updated at `item_ms`, deleted by a tombstone?
/// `>=` so a same-millisecond delete wins the tie (deletion intent is explicit).
pub fn suppressed(tombs: &Tombstones, key: &str, item_ms: u64) -> bool {
    tombs.get(key).is_some_and(|&ts| ts >= item_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_newest() {
        let mut a: Tombstones = HashMap::from([("x".into(), 10), ("y".into(), 5)]);
        let b: Tombstones = HashMap::from([("x".into(), 20), ("z".into(), 1)]);
        merge_into(&mut a, &b);
        assert_eq!(a["x"], 20); // newer incoming wins
        assert_eq!(a["y"], 5); // untouched
        assert_eq!(a["z"], 1); // new key added
    }

    #[test]
    fn suppression_respects_timestamps() {
        let t: Tombstones = HashMap::from([("k".into(), 100)]);
        assert!(suppressed(&t, "k", 100)); // deleted at the same instant
        assert!(suppressed(&t, "k", 50)); // older item is dead
        assert!(!suppressed(&t, "k", 150)); // re-added after the delete survives
        assert!(!suppressed(&t, "other", 1)); // no tombstone, alive
    }
}
