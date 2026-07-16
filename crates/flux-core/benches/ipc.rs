//! Performance-budget benches (ADR 0001). Two hot paths the whole product
//! leans on:
//!
//!   * `ipc_roundtrip` — serde round-trip of a ~1 KB command payload (the tab
//!     list is the representative high-frequency command). Budget: p99 < 1 ms.
//!   * `dom_snapshot`  — ingest a 5 MB DOM snapshot and hand it to the three
//!     consumers (terminal / agent / embedder). The architecture keeps it as a
//!     single `Arc<DomSnapshot>` so the consumers share **one** allocation;
//!     this bench measures the ingest copy + the shared fan-out. Budget (5 MB,
//!     p99): < 12 ms end-to-end.
//!
//! Run: `cargo bench -p flux-core`. These don't need a window or a display, so
//! they gate cleanly in CI (unlike idle-RAM / cold-start — see
//! docs/perf/memory-benchmark.md).

use std::sync::Arc;

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use flux_core::state::{DomSnapshot, FluxState, TabKind, TabMeta};

fn sample_tabs() -> Vec<TabMeta> {
    // ~8 tabs ≈ 1 KB of JSON — a typical `tab_list` response.
    (0..8)
        .map(|i| TabMeta {
            id: i + 1,
            kind: if i % 3 == 0 {
                TabKind::Terminal
            } else {
                TabKind::Browser
            },
            url: format!("https://example.com/page/{i}?q=search+terms+here"),
            title: format!("Example page {i} — a representative tab title"),
            pinned: i < 2,
            cluster: None,
            group: None,
            folder: None,
            custom_title: None,
            workspace: 1,
            private: false,
            container: 0,
        })
        .collect()
}

fn ipc_roundtrip(c: &mut Criterion) {
    let tabs = sample_tabs();
    let json = serde_json::to_string(&tabs).unwrap();
    let mut group = c.benchmark_group("ipc");
    group.throughput(Throughput::Bytes(json.len() as u64));
    group.bench_function("ipc_roundtrip", |b| {
        b.iter(|| {
            // Serialize (Rust → IPC) then deserialize (IPC → Rust) — the full
            // boundary cost for a command result + its echoed args.
            let s = serde_json::to_string(black_box(&tabs)).unwrap();
            let back: Vec<TabMeta> = serde_json::from_str(black_box(&s)).unwrap();
            black_box(back);
        });
    });
    group.finish();
    let _ = json;
}

fn dom_snapshot(c: &mut Criterion) {
    const SIZE: usize = 5 * 1024 * 1024;
    // Build the source once; the bench measures ingest + shared fan-out, not the
    // synthetic page generation.
    let html: String = "<div>flux dom snapshot payload</div>".repeat(SIZE / 36 + 1);
    let html = &html[..SIZE];
    let text: String = "visible text ".repeat(SIZE / 13 / 8); // ~1/8 the size
    let state = FluxState::new();

    let mut group = c.benchmark_group("ipc");
    group.throughput(Throughput::Bytes(SIZE as u64));
    group.bench_function("dom_snapshot", |b| {
        b.iter(|| {
            // Ingest: the one copy that turns the IPC body into shared storage.
            let snap = Arc::new(DomSnapshot {
                tab: 1,
                url: "https://example.com".into(),
                html: Arc::from(black_box(html)),
                text: Arc::from(text.as_str()),
                captured_at_ms: 0,
            });
            state.dom_cache.insert(1, snap);
            // Fan-out: terminal, agent, embedder each take a handle — Arc clone,
            // zero-copy. This is what makes the multi-consumer path cheap.
            for _ in 0..3 {
                let got = state.dom_cache.get(&1).map(|e| Arc::clone(e.value()));
                black_box(got);
            }
        });
    });
    group.finish();
}

criterion_group!(benches, ipc_roundtrip, dom_snapshot);
criterion_main!(benches);
