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

use crate::agent::OmniHit;
use crate::archive::{ArchiveEntryWire, ArchiveMeta};
use crate::bookmarks::Bookmark;
use crate::boosts::Boost;
use crate::calendar::{CalEvent, CalFeed, LocalEvent};
use crate::cli::LaunchIntent;
use crate::commands::ShellSnapshot;
use crate::cookies::CookieStatus;
use crate::currency::CurrencyRates;
use crate::dom::ReaderBlock;
use crate::downloads::DownloadItem;
use crate::extensions::{ContentScript, InstalledExt, Manifest, ToolbarButton, UiContrib};
use crate::feeds::{Feed, FeedItem};
use crate::files::{DirListing, FileEntry, QuickLocation};
use crate::hibernate::{EvictionRank, HibernateCandidate};
use crate::history::HistoryEntry;
use crate::https::HttpsStatus;
use crate::kb::{KbCheck, KbHit, KbRecentItem, KbSourceStat, KbStatus};
use crate::leanmode::LeanStatus;
use crate::macros::{Macro, MacroStatus, Step};
use crate::mem::MemInfo;
use crate::netspeed::SpeedResult;
use crate::permissions::{PermAsk, PermDecision, PermKind, SitePerm};
use crate::prefetch::PrefetchHint;
use crate::pwa::PwaApp;
use crate::reminders::Reminder;
use crate::semfind::FindHit;
use crate::services::ServiceStatus;
use crate::sessions::{DaySnapshot, SavedSession, SavedTab};
use crate::shellhist::ShellHistHit;
use crate::shields::{HotRule, ShieldsStatus};
use crate::specialists::Specialist;
use crate::spotify::{SpotifyPlaylist, SpotifyState};
use crate::state::{
    AgentStatus, ClusterTag, Container, TabFolder, TabGroup, TabKind, TabMeta, WebPanel, Workspace,
};
use crate::sync::{SyncReport, SyncStatus};
use crate::taskmgr::{GpuInfo, ProcInfo, SysStats};
use crate::todos::Todo;
use crate::trackers::{TrackerEdge, TrackerGraph, TrackerNode};
use crate::tui_apps::TuiApp;
use crate::vault::{CredentialMeta, VaultSavePrompt, VaultStatus};
use crate::watch::WatchItem;

/// Path to the generated bindings, relative to the crate root (= CWD under
/// `cargo test`/`cargo run`).
pub const BINDINGS_PATH: &str = "../../apps/shell/src/bindings.gen.ts";

const HEADER: &str = "// AUTO-GENERATED from crates/flux-core/src/state.rs (BACKLOG #12).\n\
// Do NOT edit by hand. Regenerate: `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`.\n\n";

/// Emit the TS for every exported state type, in a stable order.
pub fn generate_ts() -> String {
    // u64 ids (TabId) → `number`, matching the existing wire contract (JS has no
    // u64; ids never approach 2^53, so this is safe and what ipc.ts already used).
    let c =
        specta::ts::ExportConfiguration::default().bigint(specta::ts::BigIntExportBehavior::Number);
    let parts = [
        specta::ts::export::<TabKind>(&c),
        specta::ts::export::<ClusterTag>(&c),
        specta::ts::export::<TabMeta>(&c),
        specta::ts::export::<ShellSnapshot>(&c),
        specta::ts::export::<Workspace>(&c),
        specta::ts::export::<TabGroup>(&c),
        specta::ts::export::<TabFolder>(&c),
        specta::ts::export::<Container>(&c),
        specta::ts::export::<WebPanel>(&c),
        specta::ts::export::<AgentStatus>(&c),
        // Sentinel security layer (ADR 0013): phishing verdicts.
        specta::ts::export::<crate::sentinel::phishing::Confidence>(&c),
        specta::ts::export::<crate::sentinel::phishing::Verdict>(&c),
        // Sentinel (ADR 0013): OAuth consent-screen review.
        specta::ts::export::<crate::sentinel::oauth::ScopeInfo>(&c),
        specta::ts::export::<crate::sentinel::oauth::OAuthConsent>(&c),
        // Sentinel (ADR 0013, Pillar 2): agent note on a permission prompt.
        specta::ts::export::<crate::sentinel::PermissionNote>(&c),
        // Sentinel (ADR 0013, Pillar 2): sensitive-site containerization offer.
        specta::ts::export::<crate::sentinel::sensitive::SensitiveKind>(&c),
        specta::ts::export::<crate::sentinel::sensitive::SensitiveSite>(&c),
        // Sentinel (ADR 0013, Pillar 3): plain-language privacy explainers.
        specta::ts::export::<crate::sentinel::Explainer>(&c),
        // Command return/arg structs (BACKLOG #12, batch 2).
        specta::ts::export::<Bookmark>(&c),
        specta::ts::export::<Feed>(&c),
        specta::ts::export::<FeedItem>(&c),
        specta::ts::export::<PwaApp>(&c),
        specta::ts::export::<HistoryEntry>(&c),
        specta::ts::export::<SavedTab>(&c),
        specta::ts::export::<SavedSession>(&c),
        specta::ts::export::<DaySnapshot>(&c),
        specta::ts::export::<ProcInfo>(&c),
        specta::ts::export::<SysStats>(&c),
        specta::ts::export::<GpuInfo>(&c),
        specta::ts::export::<SpeedResult>(&c),
        specta::ts::export::<ArchiveMeta>(&c),
        // Calendar + tasks (BACKLOG #114).
        specta::ts::export::<CalFeed>(&c),
        specta::ts::export::<CalEvent>(&c),
        specta::ts::export::<LocalEvent>(&c),
        specta::ts::export::<CurrencyRates>(&c),
        specta::ts::export::<ShellHistHit>(&c),
        specta::ts::export::<FindHit>(&c),
        specta::ts::export::<WatchItem>(&c),
        specta::ts::export::<TrackerNode>(&c),
        specta::ts::export::<TrackerEdge>(&c),
        specta::ts::export::<TrackerGraph>(&c),
        specta::ts::export::<Todo>(&c),
        // Misc command structs (BACKLOG #12, batch 3): shields/privacy,
        // permissions, vault, extensions, macros, boosts, downloads, files,
        // sync, omni/reader, and the wire shape of a full archive entry.
        specta::ts::export::<OmniHit>(&c),
        specta::ts::export::<ReaderBlock>(&c),
        specta::ts::export::<ShieldsStatus>(&c),
        specta::ts::export::<HotRule>(&c),
        specta::ts::export::<LeanStatus>(&c),
        specta::ts::export::<HttpsStatus>(&c),
        specta::ts::export::<CookieStatus>(&c),
        specta::ts::export::<PermKind>(&c),
        specta::ts::export::<PermDecision>(&c),
        specta::ts::export::<SitePerm>(&c),
        specta::ts::export::<PermAsk>(&c),
        specta::ts::export::<CredentialMeta>(&c),
        specta::ts::export::<VaultStatus>(&c),
        specta::ts::export::<VaultSavePrompt>(&c),
        specta::ts::export::<ContentScript>(&c),
        specta::ts::export::<ToolbarButton>(&c),
        specta::ts::export::<UiContrib>(&c),
        specta::ts::export::<Manifest>(&c),
        specta::ts::export::<InstalledExt>(&c),
        specta::ts::export::<Step>(&c),
        specta::ts::export::<Macro>(&c),
        specta::ts::export::<MacroStatus>(&c),
        specta::ts::export::<Boost>(&c),
        specta::ts::export::<DownloadItem>(&c),
        specta::ts::export::<FileEntry>(&c),
        specta::ts::export::<DirListing>(&c),
        specta::ts::export::<QuickLocation>(&c),
        specta::ts::export::<KbHit>(&c),
        specta::ts::export::<KbSourceStat>(&c),
        specta::ts::export::<KbStatus>(&c),
        specta::ts::export::<KbRecentItem>(&c),
        specta::ts::export::<KbCheck>(&c),
        specta::ts::export::<TuiApp>(&c),
        specta::ts::export::<Specialist>(&c),
        specta::ts::export::<ServiceStatus>(&c),
        specta::ts::export::<SpotifyState>(&c),
        specta::ts::export::<SpotifyPlaylist>(&c),
        specta::ts::export::<SyncStatus>(&c),
        specta::ts::export::<SyncReport>(&c),
        specta::ts::export::<ArchiveEntryWire>(&c),
        // The #12 tail (batch 4): launch intent, reminders, memory/prefetch/
        // hibernation, search config, agent plans, Chrome import.
        specta::ts::export::<LaunchIntent>(&c),
        specta::ts::export::<Reminder>(&c),
        specta::ts::export::<MemInfo>(&c),
        specta::ts::export::<HibernateCandidate>(&c),
        specta::ts::export::<EvictionRank>(&c),
        specta::ts::export::<PrefetchHint>(&c),
        specta::ts::export::<flux_search::SearchEngine>(&c),
        specta::ts::export::<flux_search::Resolution>(&c),
        specta::ts::export::<flux_agent::AgentAction>(&c),
        specta::ts::export::<flux_agent::ExtractFormat>(&c),
        specta::ts::export::<flux_agent::FileEdit>(&c),
        specta::ts::export::<flux_agent::EditPlan>(&c),
        specta::ts::export::<flux_agent::NextStep>(&c),
        specta::ts::export::<flux_agent::ReadingStructure>(&c),
        specta::ts::export::<flux_agent::ReadingSection>(&c),
        specta::ts::export::<flux_agent::pac::PacPlan>(&c),
        specta::ts::export::<crate::agent::PacStatus>(&c),
        specta::ts::export::<crate::trace::EntityKind>(&c),
        specta::ts::export::<crate::trace::Entity>(&c),
        specta::ts::export::<crate::trace::Provenance>(&c),
        specta::ts::export::<crate::trace::Visit>(&c),
        specta::ts::export::<crate::trace::EdgeKind>(&c),
        specta::ts::export::<crate::trace::Edge>(&c),
        specta::ts::export::<crate::trace::TraceGraph>(&c),
        specta::ts::export::<crate::trace::TraceHistogram>(&c),
        specta::ts::export::<crate::trace::ForgetScope>(&c),
        specta::ts::export::<crate::trace::SnapshotWire>(&c),
        specta::ts::export::<crate::trace::ChatMsg>(&c),
        specta::ts::export::<crate::trace::Draft>(&c),
        specta::ts::export::<crate::trace::AmbientHint>(&c),
        specta::ts::export::<crate::trace::TabThread>(&c),
        specta::ts::export::<flux_import::chrome::ProfilePreview>(&c),
        specta::ts::export::<flux_import::chrome::Bookmark>(&c),
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
