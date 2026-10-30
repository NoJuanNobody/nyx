//! Repo scan, onboarding and code indexing (AI-67).
//!
//! Rust port of `codebase-scanner.service.ts`, `onboarding.service.ts`, `code-embedding.service.ts`,
//! `embedding-pipeline.service.ts`, `embedding.service.ts`, `job.service.ts` and the
//! `routes/{scanner,onboarding,jobs}.ts` behaviour. See `docs/rust-core/scan.md`.
//!
//! | Module | Role |
//! |---|---|
//! | [`filter`] | ignore lists, size / binary limits, language detection ([`FileFilter`], [`Language`]) |
//! | [`chunker`] | per-language structural code chunking ([`chunk_code_file`]) |
//! | [`source`] | [`RepoSource`] over a git host ([`GitProviderSource`]), a local folder (offline) or memory |
//! | [`plan`] | incremental plan by revision token ([`plan_scan`]) |
//! | [`embed`] | [`Embedder`] trait, deterministic [`FakeEmbedder`], OpenAI-compatible [`HttpEmbedder`], batching + dedupe + cache ([`embed_texts`]) |
//! | [`meter`] | credit metering ([`ScanMeter`], [`LedgerMeter`]) |
//! | [`indexer`] | the pipeline ([`index_repo`]) with progress events and cancellation |
//! | [`jobs`] | background jobs: queue, status, progress, retry, cancel ([`JobRunner`], [`ScanJobHandler`]) |
//! | [`onboarding`] | onboarding progress and the repo-to-starter-docs scan |
//! | [`specs`] | spec-vs-code scan, code search, relevant-code cache |
//!
//! # Example (offline, local folder)
//!
//! ```no_run
//! use nyx_core::scan::{index_repo, FakeEmbedder, IndexOptions, LocalFolderSource, NoMeter, ScanHooks};
//! use nyx_core::store::Db;
//!
//! # fn main() -> nyx_core::Result<()> {
//! let db = Db::open_in_memory()?;
//! let source = LocalFolderSource::new(".")?;
//! // `team-1` must exist in `teams`.
//! let report = index_repo(
//!     db.conn(),
//!     &source,
//!     &FakeEmbedder::default(),
//!     &NoMeter,
//!     &IndexOptions::new("team-1", "local/project"),
//!     &mut ScanHooks::none(),
//! );
//! # let _ = report; Ok(())
//! # }
//! ```

#![cfg_attr(
    test,
    allow(
        clippy::assert_is_empty,
        clippy::unnecessary_wraps,
        clippy::unnecessary_literal_bound
    )
)]

pub mod chunker;
pub mod embed;
pub mod filter;
pub mod indexer;
pub mod jobs;
pub mod meter;
pub mod onboarding;
pub mod plan;
pub mod source;
pub mod specs;
pub mod store;

pub use chunker::{chunk_code_file, CodeChunkOptions, CodeChunkPiece};
pub use embed::{
    embed_texts, EmbedError, EmbedStats, Embedder, FakeEmbedder, HttpEmbedder,
    DEFAULT_EMBEDDING_MODEL,
};
pub use filter::{Decision, FileFilter, Language, SkipReason};
pub use indexer::{index_repo, IndexError, IndexOptions, IndexReport, ScanEvent, ScanHooks};
pub use jobs::{
    enqueue, JobContext, JobError, JobHandler, JobRunner, JobStatus, NewJob, ScanJobHandler,
    REPO_SCAN_JOB,
};
pub use meter::{CountingMeter, LedgerMeter, MeterError, NoMeter, ScanMeter};
pub use plan::{plan_scan, PlannedFile, ScanPlan};
pub use source::{GitProviderSource, LocalFolderSource, MemorySource, RepoSource, SourceEntry};
