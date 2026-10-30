//! Live sync: doc-to-code drift detection, impact map and semantic retrieval (ticket AI-68).
//!
//! # TS source mapping
//!
//! | TS | Rust |
//! |---|---|
//! | `services/impact-graph.service.ts`, `routes/impact-graph.ts` | [`impact`] (`build_audit_graph`, `document_audit_graph`) |
//! | impact map "what does this affect" (`ImpactMap.tsx` needs) | [`impact::ImpactGraph::affected_by`], persisted in `impact_edges` |
//! | `services/trace.service.ts`, `routes/trace.ts` | [`trace`] |
//! | `services/retrieval.service.ts`, `routes/retrieval.ts` | [`retrieval`] (+ keyword and hybrid ranking) |
//! | `services/query.service.ts`, `routes/query.ts` | [`query`] |
//! | `services/search.service.ts`, `routes/search.ts` | [`search`] |
//! | `services/context-matching.service.ts`, `routes/context.ts` | [`context`] |
//! | `routes/webhooks.ts` push to drift flow, `ai.service.detectDrift` | [`drift`] + [`matching`] |
//! | (new) file watcher acceptance criterion | [`watch`] |
//!
//! # Flow
//!
//! ```text
//! push webhook / watcher poll
//!   -> ChangeSet (changed paths + idempotency key)
//!   -> matching::match_specs   (impact edges, path mentions, chunk similarity)
//!   -> prompts::drift via LlmProvider, one call per matched spec
//!   -> drift::parse_verdict    (tolerant; malformed replies are failures, not "no drift")
//!   -> drift_records           (unique per run key, document, document version)
//! ```
//!
//! Everything external is behind a trait ([`crate::ai::LlmProvider`], [`retrieval::Embedder`],
//! [`drift::CodeSource`], [`search::WebSearch`]) with an in-memory implementation for tests.

#![allow(
    unknown_lints,
    clippy::assert_is_empty,
    clippy::implicit_hasher,
    clippy::too_many_arguments
)]

pub mod context;
pub mod drift;
pub mod impact;
pub mod matching;
pub mod query;
pub mod retrieval;
pub mod search;
pub mod trace;
pub mod watch;

pub use context::{ContextMatch, ContextMatchResult, ContextMatcher, ContextSignal};
pub use drift::{
    parse_verdict, process_webhook, ChangeSet, CodeSource, DriftConfig, DriftEngine, DriftRecord,
    DriftRunReport, DriftStatus, DriftVerdict, MemoryCode, SqliteDrift, WebhookOutcome,
};
pub use impact::{
    build_audit_graph, document_audit_graph, Direction, Edge, Impact, ImpactGraph, NodeKind,
    NodeRef, SqliteImpact,
};
pub use matching::{match_specs, MatchConfig, MatchReason, SpecMatch};
pub use query::{query_docs, QueryAnswer};
pub use retrieval::{
    index_code_file, index_document, retrieve_chunks, retrieve_code, search_documents, Embedder,
    HashingEmbedder, Mode, RetrieveOptions, RetrievedChunk,
};
pub use search::{SearchResult, TavilySearch, WebSearch};
pub use trace::{build_trace, document_trace, Trace};
pub use watch::{DirCodeSource, Watcher};
