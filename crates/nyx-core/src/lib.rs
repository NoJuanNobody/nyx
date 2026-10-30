//! Nyx core: pure Rust, no UI. Shared by the desktop shell, CLI and MCP server.
//!
//! - [`model`]: typed domain model ported from the Drizzle schema.
//! - [`store`]: SQLite persistence, migrations, repositories, Postgres import.
//! - [`ledger`]: append-only credit ledger (agent-native utility tokens).
//! - [`lifecycle`]: lifecycle stages, domain pipelines, transitions, templates.
//! - [`vcs`]: product version control (diff, three-way merge, branches, timeline, snapshots, approvals, change proposals).
//! - [`security`]: input validation, path jail, SSRF guard, sanitizers, rate limiting, crypto, redaction.
//! - [`git_provider`]: GitHub/GitLab/Bitbucket integration behind a `GitProvider` trait.
//! - [`export`]: document export (Markdown, TXT, PDF, DOCX, LaTeX, Jupyter) and deliverables.
//! - [`tree`]: folder/document tree (folders, cycle-safe moves, path resolution, ordering, subtrees).
//! - [`ai`]: BYOK model providers and the AI quality / Advisor surface.
//! - [`sync`]: live sync: impact graph, drift detection on push, semantic retrieval, context matching.
//! - [`error`]: shared error type.
#![allow(
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::struct_field_names,
    clippy::similar_names,
    clippy::many_single_char_names,
    clippy::trivially_copy_pass_by_ref,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss
)]

pub mod ai;
pub mod error;
pub mod export;
pub mod git_provider;
pub mod governance;
pub mod intake;
pub mod ledger;
pub mod lifecycle;
pub mod model;
pub mod notify;
pub mod profile;
pub mod security;
pub mod store;
pub mod sync;
pub mod tree;
pub mod vcs;

pub use error::{Error, Result};

/// Crate version, for `--version` style output in front-ends.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Minimal smoke-test entry point used by the Tauri hello-world.
#[must_use]
pub fn hello() -> String {
    format!("nyx-core {VERSION}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn hello_mentions_version() {
        assert!(super::hello().contains(super::VERSION));
    }
}
