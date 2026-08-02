//! Quantized embedding storage for the knowledge base.
//!
//! **Why this exists.** Embeddings used to live inline on each `KbChunk` and
//! were persisted with the rest of the index as JSON decimal floats. Measured
//! at 60k chunks × 768 dimensions: a 623 MB file, 1.16 s to write, 1.09 s to
//! parse on every boot, and 176 MB of `f32` resident — 3.5× the size of the raw
//! bytes, spent entirely on rendering numbers as text. The retrieval scan over
//! that same corpus costs about 3 ms, so storage was three orders of magnitude
//! more expensive than the thing it existed to serve.
//!
//! Two changes fix that together:
//!
//! 1. **int8 instead of f32.** Vectors are L2-normalized, so a symmetric
//!    per-row scale (`max|x|`) quantizes cleanly into `i8`. That's 4× less
//!    memory, and because the scan is memory-bandwidth bound rather than
//!    ALU bound, moving a quarter as many bytes is worth more than hand-written
//!    SIMD over `f32` would have been. Ranking only needs *relative* order, and
//!    a test measures the recall against exact `f32` rather than assuming it.
//!
//! 2. **One contiguous matrix, not a `Vec` per chunk.** Rows sit end to end at
//!    a fixed stride, so scoring walks memory linearly instead of chasing a
//!    pointer per chunk. This is also the layout an ANN index would need, so
//!    the flat matrix isn't built twice.
//!
//! **The invariant.** Row `i` belongs to chunk `i`. Nothing here can enforce
//! that alone — the paired mutation lives on `KbData`, which moves both sides
//! together. Get it wrong and every result is silently attributed to the wrong
//! document, which is why loading verifies the counts agree and refuses the
//! sidecar rather than trusting it.

use rayon::prelude::*;

/// int8 range. 127 rather than 128 keeps quantization symmetric, so a vector
/// and its negation quantize to exact negations of each other.
const Q_MAX: f32 = 127.0;
/// Applied once to a `dot` of two quantized vectors, with both scales.
const Q_NORM: f32 = Q_MAX * Q_MAX;

const MAGIC: &[u8; 8] = b"FLUXVEC1";
/// magic + dim + count.
const HEADER: usize = 8 + 4 + 8;

/// A contiguous `i8` matrix of embeddings, one row per chunk.
#[derive(Default, Clone)]
pub struct VecStore {
    /// Row width. Zero only while empty — the corpus is re-embedded wholesale
    /// when the embedder (and therefore the dimension) changes.
    dim: usize,
    /// Per-row `max|x|`, the dequantization factor.
    scales: Vec<f32>,
    /// `len() * dim` values, row-major.
    data: Vec<i8>,
}

impl VecStore {
    pub fn len(&self) -> usize {
        self.scales.len()
    }

    pub fn is_empty(&self) -> bool {
        self.scales.is_empty()
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn clear(&mut self) {
        self.dim = 0;
        self.scales.clear();
        self.data.clear();
    }

    /// Quantize and append. `false` if `v` disagrees with the established row
    /// width, which the caller must treat as a failed write rather than ignore
    /// — a dropped row would shift every later chunk onto the wrong vector.
    pub fn push(&mut self, v: &[f32]) -> bool {
        if v.is_empty() {
            return false;
        }
        if self.is_empty() {
            self.dim = v.len();
        } else if v.len() != self.dim {
            return false;
        }
        let (row, scale) = quantize(v);
        self.data.extend_from_slice(&row);
        self.scales.push(scale);
        true
    }

    /// Append another store's rows. Both must agree on width.
    pub fn append(&mut self, other: &VecStore) -> bool {
        if other.is_empty() {
            return true;
        }
        if self.is_empty() {
            self.dim = other.dim;
        } else if other.dim != self.dim {
            return false;
        }
        self.data.extend_from_slice(&other.data);
        self.scales.extend_from_slice(&other.scales);
        true
    }

    /// Keep the rows whose index passes, compacting in place. Must be driven by
    /// the same predicate that filters the chunks, in the same order.
    pub fn retain(&mut self, mut keep: impl FnMut(usize) -> bool) {
        if self.dim == 0 {
            return;
        }
        let dim = self.dim;
        let mut w = 0usize;
        for r in 0..self.scales.len() {
            if keep(r) {
                if w != r {
                    self.scales[w] = self.scales[r];
                    self.data.copy_within(r * dim..(r + 1) * dim, w * dim);
                }
                w += 1;
            }
        }
        self.scales.truncate(w);
        self.data.truncate(w * dim);
        if w == 0 {
            self.dim = 0;
        }
    }

    /// Rows in order, for a serial scan.
    pub fn rows(&self) -> impl Iterator<Item = (&[i8], f32)> + '_ {
        self.data
            .chunks_exact(self.dim.max(1))
            .zip(self.scales.iter().copied())
    }

    /// Rows in order, split across cores. Indexed, so it zips with the chunk
    /// list positionally.
    pub fn par_rows(&self) -> impl IndexedParallelIterator<Item = (&[i8], f32)> + '_ {
        self.data
            .par_chunks_exact(self.dim.max(1))
            .zip(self.scales.par_iter().copied())
    }

    /// Serialize for the sidecar file: a fixed header, then scales, then rows.
    ///
    /// Little-endian and `i8`-as-byte, which is the same on every target Flux
    /// builds for; the magic carries a version so a future layout change is a
    /// rejected load rather than a misread one.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER + self.scales.len() * 4 + self.data.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(self.dim as u32).to_le_bytes());
        out.extend_from_slice(&(self.len() as u64).to_le_bytes());
        for s in &self.scales {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out.extend_from_slice(bytemuck_cast(&self.data));
        out
    }

    /// Parse a sidecar. `None` on anything unexpected — a truncated or foreign
    /// file must not become a corpus of plausible-looking wrong vectors.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() < HEADER || &b[..8] != MAGIC {
            return None;
        }
        let dim = u32::from_le_bytes(b[8..12].try_into().ok()?) as usize;
        let count = u64::from_le_bytes(b[12..20].try_into().ok()?) as usize;
        if dim == 0 && count != 0 {
            return None;
        }
        let scales_end = HEADER.checked_add(count.checked_mul(4)?)?;
        let data_end = scales_end.checked_add(count.checked_mul(dim)?)?;
        if b.len() != data_end {
            return None;
        }
        let scales = b[HEADER..scales_end]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect::<Vec<f32>>();
        // Every scale is a magnitude; a NaN or negative one would poison every
        // score computed from that row.
        if scales.iter().any(|s| !s.is_finite() || *s < 0.0) {
            return None;
        }
        let data = b[scales_end..data_end].iter().map(|&x| x as i8).collect();
        Some(VecStore { dim, scales, data })
    }
}

/// Quantize a vector, returning its rows and the scale that restores them.
///
/// An all-zero vector has no scale; it gets zero, which makes every dot product
/// against it zero — "matches nothing", which is the truthful answer for a
/// document with no signal.
fn quantize(v: &[f32]) -> (Vec<i8>, f32) {
    let scale = v
        .iter()
        .fold(0f32, |m, x| if x.is_finite() { m.max(x.abs()) } else { m });
    if scale <= 0.0 {
        return (vec![0i8; v.len()], 0.0);
    }
    let inv = Q_MAX / scale;
    let row = v
        .iter()
        .map(|x| (x * inv).round().clamp(-Q_MAX, Q_MAX) as i8)
        .collect();
    (row, scale)
}

/// Quantize a query the same way, so scoring is `i8 × i8` rather than a
/// dequantization per row.
pub fn quantize_query(v: &[f32]) -> (Vec<i8>, f32) {
    quantize(v)
}

/// Cosine similarity of a stored row against a quantized query.
///
/// `i32` accumulation is exact: the largest possible term count (`dim`) times
/// `127 × 127` stays far inside the range for any embedding width in use.
#[inline]
pub fn score(row: &[i8], scale: f32, q: &[i8], q_scale: f32) -> f32 {
    debug_assert_eq!(row.len(), q.len());
    let dot: i32 = row
        .iter()
        .zip(q.iter())
        .map(|(&a, &b)| a as i32 * b as i32)
        .sum();
    dot as f32 * (scale * q_scale / Q_NORM)
}

/// `&[i8]` as bytes. `i8` and `u8` have identical layout, so this is a
/// reinterpretation, not a conversion — worth doing by hand rather than adding
/// a dependency for one call.
fn bytemuck_cast(v: &[i8]) -> &[u8] {
    // SAFETY: i8 and u8 have the same size and alignment, and every bit pattern
    // is valid for both. The lifetime is tied to the input slice.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(seed: u64, dim: usize) -> Vec<f32> {
        let mut s = seed | 1;
        let mut v: Vec<f32> = (0..dim)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                (s >> 40) as f32 / 8388608.0 - 1.0
            })
            .collect();
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter_mut().for_each(|x| *x /= n);
        v
    }

    fn exact_cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn roundtrips_through_bytes() {
        let mut s = VecStore::default();
        for i in 0..10 {
            assert!(s.push(&unit(i, 64)));
        }
        let back = VecStore::from_bytes(&s.to_bytes()).expect("valid sidecar");
        assert_eq!(back.len(), 10);
        assert_eq!(back.dim(), 64);
        assert_eq!(back.scales, s.scales);
        assert_eq!(back.data, s.data);

        // An empty store is a legitimate state, not a parse failure.
        let empty = VecStore::from_bytes(&VecStore::default().to_bytes()).expect("empty roundtrip");
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn refuses_damaged_or_foreign_files() {
        let mut s = VecStore::default();
        for i in 0..4 {
            s.push(&unit(i, 32));
        }
        let good = s.to_bytes();

        assert!(VecStore::from_bytes(&[]).is_none(), "empty input");
        assert!(VecStore::from_bytes(b"not a flux vector file at all").is_none());
        assert!(
            VecStore::from_bytes(&good[..good.len() - 1]).is_none(),
            "truncated"
        );
        let mut extra = good.clone();
        extra.push(0);
        assert!(VecStore::from_bytes(&extra).is_none(), "trailing garbage");

        // A header claiming more rows than the file holds must not be believed.
        let mut lying = good.clone();
        lying[12] = 0xff;
        assert!(VecStore::from_bytes(&lying).is_none());
    }

    #[test]
    fn quantization_preserves_the_ranking() {
        // The claim that justifies int8: the top results are the same ones
        // exact f32 would have returned. Anything less and retrieval quietly
        // gets worse to save memory, which is not a trade worth making.
        const DIM: usize = 768;
        const N: usize = 2_000;
        let vectors: Vec<Vec<f32>> = (0..N as u64).map(|i| unit(i * 7 + 3, DIM)).collect();
        let mut store = VecStore::default();
        for v in &vectors {
            assert!(store.push(v));
        }

        let mut checked = 0;
        let mut agreed = 0;
        for qi in 0..20u64 {
            let q = unit(qi * 1_000_003 + 11, DIM);
            let (qq, qs) = quantize_query(&q);

            let mut exact: Vec<(f32, usize)> = vectors
                .iter()
                .enumerate()
                .map(|(i, v)| (exact_cosine(v, &q), i))
                .collect();
            exact.sort_by(|a, b| b.0.total_cmp(&a.0));

            let mut approx: Vec<(f32, usize)> = store
                .rows()
                .enumerate()
                .map(|(i, (row, sc))| (score(row, sc, &qq, qs), i))
                .collect();
            approx.sort_by(|a, b| b.0.total_cmp(&a.0));

            // Scores themselves must stay close, not just their order.
            for (k, &(e, ei)) in exact.iter().take(8).enumerate() {
                let a = approx.iter().find(|(_, i)| *i == ei).unwrap().0;
                assert!(
                    (e - a).abs() < 0.01,
                    "score drift at rank {k}: exact {e}, quantized {a}"
                );
            }

            let top: std::collections::HashSet<usize> =
                exact.iter().take(8).map(|(_, i)| *i).collect();
            agreed += approx
                .iter()
                .take(8)
                .filter(|(_, i)| top.contains(i))
                .count();
            checked += 8;
        }
        let recall = agreed as f64 / checked as f64;
        assert!(recall >= 0.99, "recall@8 vs exact f32 was {recall}");
    }

    #[test]
    fn retain_compacts_rows_and_keeps_them_paired() {
        let mut s = VecStore::default();
        for i in 0..6 {
            s.push(&unit(i + 100, 16));
        }
        let kept: Vec<(Vec<i8>, f32)> = s
            .rows()
            .enumerate()
            .filter(|(i, _)| i % 2 == 0)
            .map(|(_, (r, sc))| (r.to_vec(), sc))
            .collect();

        s.retain(|i| i % 2 == 0);

        assert_eq!(s.len(), 3);
        let after: Vec<(Vec<i8>, f32)> = s.rows().map(|(r, sc)| (r.to_vec(), sc)).collect();
        assert_eq!(after, kept, "surviving rows must keep their own scales");

        // Emptying resets the width, so the next embedder can set its own.
        s.retain(|_| false);
        assert!(s.is_empty() && s.dim() == 0);
        assert!(s.push(&unit(9, 32)) && s.dim() == 32);
    }

    #[test]
    fn a_width_mismatch_is_refused_rather_than_stored() {
        // The failure this prevents: a rejected-but-ignored row would shift
        // every later chunk onto its neighbour's vector.
        let mut s = VecStore::default();
        assert!(s.push(&unit(1, 768)));
        assert!(!s.push(&unit(2, 256)), "different width must not append");
        assert_eq!(s.len(), 1, "the bad row left nothing behind");
        assert!(!s.push(&[]), "an empty vector is not a row");

        let mut other = VecStore::default();
        other.push(&unit(3, 256));
        assert!(!s.append(&other));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn parallel_and_serial_rows_agree() {
        let mut s = VecStore::default();
        for i in 0..300 {
            s.push(&unit(i, 128));
        }
        let (q, qs) = quantize_query(&unit(77, 128));
        let serial: Vec<f32> = s.rows().map(|(r, sc)| score(r, sc, &q, qs)).collect();
        let parallel: Vec<f32> = s.par_rows().map(|(r, sc)| score(r, sc, &q, qs)).collect();
        assert_eq!(serial, parallel);
    }
}
