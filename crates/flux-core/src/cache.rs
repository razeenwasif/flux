//! Generic in-memory TTL + LRU cache (BACKLOG #101).
//!
//! Research basis: server-side TTL caching gives 90–95% response-time cuts on
//! repeated work (arXiv 2602.06074), and "do the expensive computation once,
//! reuse the result" is the through-line of the optimization survey
//! (`research/RESEARCH.md`). Flux recomputes the same things constantly —
//! per-request block/allow verdicts (#99), favicon/metadata lookups, per-site
//! settings, repeated local-LLM prompts — so a small bounded cache in the Rust
//! core removes that work from the hot path.
//!
//! Design: a single `parking_lot::Mutex` over a `HashMap` (cheap, uncontended at
//! our scale), bounded by capacity with **LRU eviction** and an optional
//! per-entry **TTL**. Expired entries are dropped lazily on access and during
//! eviction scans, so a stale key never serves a stale value. `Send + Sync` for
//! any `Send` key/value, so it drops straight into Tauri-managed state.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

struct Slot<V> {
    value: V,
    /// `None` → never expires by time (capacity/LRU still applies).
    expires: Option<Instant>,
    /// Monotonic access stamp; the smallest is the least-recently-used.
    touched: u64,
}

struct Inner<K, V> {
    map: HashMap<K, Slot<V>>,
    /// Logical clock, bumped on every access so LRU order is total.
    clock: u64,
    hits: u64,
    misses: u64,
}

/// A bounded, thread-safe TTL+LRU cache. `V` must be `Clone` because reads hand
/// back an owned copy (the lock is never held across the caller's work).
pub struct TtlCache<K, V> {
    inner: Mutex<Inner<K, V>>,
    capacity: usize,
    ttl: Option<Duration>,
}

/// A point-in-time snapshot of cache effectiveness (for diagnostics / `flux://`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub len: usize,
    pub capacity: usize,
}

impl CacheStats {
    /// Hit ratio in `[0,100]` (0 when nothing has been looked up yet).
    pub fn hit_pct(&self) -> u32 {
        let total = self.hits + self.misses;
        if total == 0 {
            0
        } else {
            ((self.hits.saturating_mul(100)) / total) as u32
        }
    }
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    /// `capacity` entries max (must be ≥ 1); `ttl = None` → entries live until
    /// evicted by capacity. A `ttl` of 0 makes every entry already-expired
    /// (useful only in tests).
    pub fn new(capacity: usize, ttl: Option<Duration>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                map: HashMap::with_capacity(capacity.min(1024)),
                clock: 0,
                hits: 0,
                misses: 0,
            }),
            capacity: capacity.max(1),
            ttl,
        }
    }

    /// Look up `key`; `None` on miss or if the entry has expired (it's dropped).
    /// Records a hit/miss and refreshes the entry's LRU recency on a hit.
    pub fn get(&self, key: &K) -> Option<V> {
        let now = Instant::now();
        let mut g = self.inner.lock();
        g.clock += 1;
        let clock = g.clock;
        match g.map.get_mut(key) {
            Some(slot) if slot.expires.map(|e| now >= e).unwrap_or(false) => {
                g.map.remove(key);
                g.misses += 1;
                None
            }
            Some(slot) => {
                slot.touched = clock;
                let v = slot.value.clone();
                g.hits += 1;
                Some(v)
            }
            None => {
                g.misses += 1;
                None
            }
        }
    }

    /// Insert/replace `key`, applying the configured TTL and evicting the LRU
    /// entry if we're at capacity.
    pub fn insert(&self, key: K, value: V) {
        let now = Instant::now();
        let expires = self.ttl.map(|d| now + d);
        let mut g = self.inner.lock();
        g.clock += 1;
        let touched = g.clock;
        // Make room: drop one expired entry if any, else the LRU.
        if !g.map.contains_key(&key) && g.map.len() >= self.capacity {
            self.evict_one(&mut g, now);
        }
        g.map.insert(key, Slot { value, expires, touched });
    }

    /// Return the cached value for `key`, or compute it with `f`, store, return.
    /// `f` runs **outside** the lock, so a slow computation never blocks other
    /// cache users (two racing misses may both compute — last write wins, which
    /// is fine for pure functions).
    pub fn get_or_insert_with(&self, key: K, f: impl FnOnce() -> V) -> V {
        if let Some(v) = self.get(&key) {
            return v;
        }
        let v = f();
        self.insert(key, v.clone());
        v
    }

    /// Drop the least-recently-used entry (preferring an already-expired one).
    fn evict_one(&self, g: &mut Inner<K, V>, now: Instant) {
        // Prefer reclaiming an expired entry — it's dead weight anyway.
        if let Some(k) = g
            .map
            .iter()
            .find(|(_, s)| s.expires.map(|e| now >= e).unwrap_or(false))
            .map(|(k, _)| k.clone())
        {
            g.map.remove(&k);
            return;
        }
        if let Some(k) = g.map.iter().min_by_key(|(_, s)| s.touched).map(|(k, _)| k.clone()) {
            g.map.remove(&k);
        }
    }

    /// Forget a single key (e.g. settings for a host changed).
    pub fn invalidate(&self, key: &K) {
        self.inner.lock().map.remove(key);
    }

    /// Drop every entry (e.g. the filter rule set was rebuilt — see #99).
    pub fn clear(&self) {
        self.inner.lock().map.clear();
    }

    pub fn stats(&self) -> CacheStats {
        let g = self.inner.lock();
        CacheStats { hits: g.hits, misses: g.misses, len: g.map.len(), capacity: self.capacity }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_and_miss_counts() {
        let c: TtlCache<&str, u32> = TtlCache::new(8, None);
        assert_eq!(c.get(&"a"), None);
        c.insert("a", 1);
        assert_eq!(c.get(&"a"), Some(1));
        assert_eq!(c.get(&"b"), None);
        let s = c.stats();
        assert_eq!((s.hits, s.misses, s.len), (1, 2, 1));
        assert_eq!(s.hit_pct(), 33); // 1 of 3
    }

    #[test]
    fn lru_evicts_least_recently_used() {
        let c: TtlCache<u32, u32> = TtlCache::new(2, None);
        c.insert(1, 1);
        c.insert(2, 2);
        // Touch 1 so 2 becomes the LRU.
        assert_eq!(c.get(&1), Some(1));
        c.insert(3, 3); // evicts 2
        assert_eq!(c.get(&2), None);
        assert_eq!(c.get(&1), Some(1));
        assert_eq!(c.get(&3), Some(3));
        assert_eq!(c.stats().len, 2);
    }

    #[test]
    fn ttl_expires_entries() {
        let c: TtlCache<&str, u32> = TtlCache::new(8, Some(Duration::from_millis(20)));
        c.insert("k", 9);
        assert_eq!(c.get(&"k"), Some(9));
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(c.get(&"k"), None); // expired → dropped
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn get_or_insert_with_computes_once_then_caches() {
        let c: TtlCache<&str, u32> = TtlCache::new(8, None);
        let mut calls = 0;
        let mut compute = |c: &TtlCache<&str, u32>| {
            c.get_or_insert_with("x", || {
                calls += 1;
                42
            })
        };
        assert_eq!(compute(&c), 42);
        assert_eq!(compute(&c), 42);
        assert_eq!(calls, 1); // second call served from cache
    }

    #[test]
    fn invalidate_and_clear() {
        let c: TtlCache<u32, u32> = TtlCache::new(8, None);
        c.insert(1, 1);
        c.insert(2, 2);
        c.invalidate(&1);
        assert_eq!(c.get(&1), None);
        assert_eq!(c.get(&2), Some(2));
        c.clear();
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn expired_entry_is_preferred_for_eviction() {
        let c: TtlCache<u32, u32> = TtlCache::new(2, Some(Duration::from_millis(15)));
        c.insert(1, 1);
        std::thread::sleep(Duration::from_millis(20)); // 1 now expired
        c.insert(2, 2); // fresh
        c.insert(3, 3); // at cap → should reclaim the expired 1, keep 2
        assert_eq!(c.get(&2), Some(2));
        assert_eq!(c.get(&3), Some(3));
    }

    #[test]
    fn is_send_and_sync() {
        fn assert_ss<T: Send + Sync>() {}
        assert_ss::<TtlCache<String, bool>>();
    }
}
