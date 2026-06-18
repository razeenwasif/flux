//! TypeScript binding generation (BACKLOG #12).
//!
//! The frontend's `ipc.ts` historically hand-mirrored the Rust IPC structs and
//! has drifted. This generates the canonical TS for the core state types from
//! the Rust definitions (via `specta`), so `apps/shell/src/bindings.gen.ts` is
//! derived, never hand-written. A test fails the build when the committed file
//! is stale; regenerate with:
//!
//!   FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings
//!
//! Scope today: the `state.rs` IPC types (the largest hand-mirrored surface).
//! Remaining types + command signatures migrate incrementally (still #12).

use crate::archive::ArchiveMeta;
use crate::bookmarks::Bookmark;
use crate::calendar::{CalEvent, CalFeed};
use crate::todos::Todo;
use crate::feeds::{Feed, FeedItem};
use crate::history::HistoryEntry;
use crate::netspeed::SpeedResult;
use crate::pwa::PwaApp;
use crate::sessions::{SavedSession, SavedTab};
use crate::state::{
    AgentStatus, ClusterTag, Container, TabFolder, TabGroup, TabKind, TabMeta, WebPanel, Workspace,
};
use crate::taskmgr::{ProcInfo, SysStats};

/// Path to the generated bindings, relative to the crate root (= CWD under
/// `cargo test`/`cargo run`).
pub const BINDINGS_PATH: &str = "../../apps/shell/src/bindings.gen.ts";

const HEADER: &str = "// AUTO-GENERATED from crates/flux-core/src/state.rs (BACKLOG #12).\n\
// Do NOT edit by hand. Regenerate: `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`.\n\n";

/// Emit the TS for every exported state type, in a stable order.
pub fn generate_ts() -> String {
    // u64 ids (TabId) → `number`, matching the existing wire contract (JS has no
    // u64; ids never approach 2^53, so this is safe and what ipc.ts already used).
    let c = specta::ts::ExportConfiguration::default()
        .bigint(specta::ts::BigIntExportBehavior::Number);
    let parts = [
        specta::ts::export::<TabKind>(&c),
        specta::ts::export::<ClusterTag>(&c),
        specta::ts::export::<TabMeta>(&c),
        specta::ts::export::<Workspace>(&c),
        specta::ts::export::<TabGroup>(&c),
        specta::ts::export::<TabFolder>(&c),
        specta::ts::export::<Container>(&c),
        specta::ts::export::<WebPanel>(&c),
        specta::ts::export::<AgentStatus>(&c),
        // Command return/arg structs (BACKLOG #12, batch 2).
        specta::ts::export::<Bookmark>(&c),
        specta::ts::export::<Feed>(&c),
        specta::ts::export::<FeedItem>(&c),
        specta::ts::export::<PwaApp>(&c),
        specta::ts::export::<HistoryEntry>(&c),
        specta::ts::export::<SavedTab>(&c),
        specta::ts::export::<SavedSession>(&c),
        specta::ts::export::<ProcInfo>(&c),
        specta::ts::export::<SysStats>(&c),
        specta::ts::export::<SpeedResult>(&c),
        specta::ts::export::<ArchiveMeta>(&c),
        // Calendar + tasks (BACKLOG #114).
        specta::ts::export::<CalFeed>(&c),
        specta::ts::export::<CalEvent>(&c),
        specta::ts::export::<Todo>(&c),
    ];
    let mut out = String::from(HEADER);
    for p in parts {
        out.push_str(&p.expect("specta export is infallible for these types"));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_up_to_date() {
        let generated = generate_ts();
        if std::env::var("FLUX_WRITE_BINDINGS").is_ok() {
            std::fs::write(BINDINGS_PATH, &generated).expect("write bindings");
            return;
        }
        let existing = std::fs::read_to_string(BINDINGS_PATH).unwrap_or_default();
        assert_eq!(
            existing, generated,
            "bindings.gen.ts is stale — run `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`"
        );
    }
}
