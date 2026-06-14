//! flux-import: bring user data over from other browsers.
//!
//! v0 scope (honest about what's possible):
//!   * Bookmarks — full import. Chrome stores them as plain JSON; we flatten
//!     the folder tree, preserving paths.
//!   * Extensions — INVENTORY only. Chrome extensions cannot run inside
//!     native webviews (no chrome.* runtime); we read each installed
//!     extension's manifest so Flux can show "you had these N extensions"
//!     and suggest built-in equivalents (BACKLOG #24).
//!   * Saved tab groups — DISCOVERY only for now. Chrome keeps them in a
//!     per-profile SQLite database with a sync-internals schema; full import
//!     is BACKLOG #23.

pub mod chrome;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("no Chrome installation found (looked in the default user-data locations)")]
    NotFound,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed {file}: {source}")]
    Parse {
        file: &'static str,
        #[source]
        source: serde_json::Error,
    },
}
