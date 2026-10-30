//! External capabilities the operations may need, behind trait objects so the host (CLI, MCP
//! server, desktop shell) decides what is plugged in.
//!
//! [`Services::offline`] is the default: nothing reaches the network. Operations that need a
//! missing capability return a `not_configured` error instead of pretending (no fabricated model
//! output). The orchestrator plugs live transports in later (`nyx-net`).

use std::sync::Arc;

use nyx_core::ai::{LlmProvider, ModelPair};
use nyx_core::sync::{Embedder, HashingEmbedder, WebSearch};
use nyx_core::tickets::tracker::TrackerSet;

/// Pluggable capabilities.
#[derive(Clone)]
pub struct Services {
    /// Model provider (BYOK). `None` means offline: LLM-backed tools report `not_configured`.
    pub llm: Option<Arc<dyn LlmProvider>>,
    /// Models used with [`Services::llm`].
    pub models: ModelPair,
    /// Text embedder for indexing and semantic search (offline lexical hashing by default).
    pub embedder: Arc<dyn Embedder>,
    /// Web search backend. `None` means offline.
    pub web_search: Option<Arc<dyn WebSearch>>,
    /// Ticket trackers (GitHub/GitLab/Bitbucket/Jira/Linear). Empty offline.
    pub trackers: TrackerSet,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services")
            .field("llm", &self.llm.as_ref().map(|l| l.name().to_owned()))
            .field("embedder", &self.embedder.model())
            .field("web_search", &self.web_search.is_some())
            .finish_non_exhaustive()
    }
}

impl Services {
    /// No network capabilities; lexical embedder; no trackers.
    #[must_use]
    pub fn offline() -> Self {
        Self {
            llm: None,
            models: ModelPair {
                default: "offline".into(),
                fast: "offline".into(),
            },
            embedder: Arc::new(HashingEmbedder::new(256)),
            web_search: None,
            trackers: TrackerSet::new(),
        }
    }

    /// Replace the model provider and models.
    #[must_use]
    pub fn with_llm(mut self, llm: Arc<dyn LlmProvider>, models: ModelPair) -> Self {
        self.llm = Some(llm);
        self.models = models;
        self
    }

    /// Replace the web search backend.
    #[must_use]
    pub fn with_web_search(mut self, s: Arc<dyn WebSearch>) -> Self {
        self.web_search = Some(s);
        self
    }

    /// Replace the tracker set.
    #[must_use]
    pub fn with_trackers(mut self, t: TrackerSet) -> Self {
        self.trackers = t;
        self
    }

    /// Replace the embedder.
    #[must_use]
    pub fn with_embedder(mut self, e: Arc<dyn Embedder>) -> Self {
        self.embedder = e;
        self
    }
}

impl Default for Services {
    fn default() -> Self {
        Self::offline()
    }
}
