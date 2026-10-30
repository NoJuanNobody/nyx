//! External capabilities the operations may need, behind trait objects so the host (CLI, MCP
//! server, desktop shell, tests) decides what is plugged in.
//!
//! - [`Services::offline`] reaches no network. Operations that need a model, search backend or
//!   tracker answer `not_configured` instead of pretending (no fabricated model output). Tests use
//!   it (usually with a scripted `FakeLlm` via [`Services::with_llm`]).
//! - [`Services::live`] is what the shipped binaries use: the SSRF-guarded `ureq` transport of
//!   `nyx-net`, BYOK model calls (the provider is chosen per call from the keys in the secret
//!   store, so `nyx byok set` takes effect without a restart), Tavily web search when a key is
//!   stored, and GitHub / GitLab / Bitbucket ticket trackers reading their tokens from the secret
//!   store per call. A plain-http loopback URL (for example a local Ollama server) is refused by
//!   the transport by design, so keyless local providers are not auto-selected.

use std::sync::Arc;

use nyx_core::ai::{
    Embedder, HashingEmbedder, HttpLlm, HttpTransport, LlmError, LlmProvider, LlmRequest,
    LlmResponse, ModelPair, ProviderConfig, ProviderKind,
};
use nyx_core::git_provider::{BitbucketProvider, GitHubProvider, GitLabProvider};
use nyx_core::profile::{Provider, SecretKey, SecretStore};
use nyx_core::sync::{TavilySearch, WebSearch};
use nyx_core::tickets::tracker::{GitProviderTracker, TrackerSet};

/// Model slug placeholders the live provider replaces with the selected provider's real models.
const DEFAULT_MODEL: &str = "nyx-default";
const FAST_MODEL: &str = "nyx-fast";

/// Cheap "is this capability usable right now?" check.
pub type Probe = Arc<dyn Fn() -> bool + Send + Sync>;

/// Pluggable capabilities.
#[derive(Clone)]
pub struct Services {
    /// Model provider (BYOK). `None` means offline: LLM-backed tools report `not_configured`.
    pub llm: Option<Arc<dyn LlmProvider>>,
    /// Extra readiness check for [`Services::llm`] (for example "a key is stored").
    pub llm_ready: Option<Probe>,
    /// Models used with [`Services::llm`].
    pub models: ModelPair,
    /// Text embedder for indexing and semantic search (offline lexical hashing by default).
    pub embedder: Arc<dyn Embedder>,
    /// Web search backend. `None` means offline.
    pub web_search: Option<Arc<dyn WebSearch>>,
    /// Extra readiness check for [`Services::web_search`].
    pub search_ready: Option<Probe>,
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
            llm_ready: None,
            models: ModelPair {
                default: "offline".into(),
                fast: "offline".into(),
            },
            embedder: Arc::new(HashingEmbedder::default()),
            web_search: None,
            search_ready: None,
            trackers: TrackerSet::new(),
        }
    }

    /// Live capabilities over `nyx-net`'s real transport. Credentials are read from `secrets` on
    /// every call, so adding or rotating a key needs no restart.
    ///
    /// Not wired (documented gaps): Jira and Linear trackers (their credentials live in the
    /// integration config and need a per-call database lookup), keyless local model servers, and a
    /// provider-backed embedder (`nyx_net::LiveServices::with_http_embedder` exists; choosing a
    /// model and endpoint for it is a settings decision).
    #[must_use]
    pub fn live(secrets: Arc<dyn SecretStore>) -> Self {
        let live = nyx_net::live_services();
        let transport = live.transport.clone();
        let byok = Arc::new(ByokLlm {
            secrets: secrets.clone(),
            transport: transport.clone(),
        });
        let probe_llm = byok.clone();
        let search = Arc::new(LazyTavily {
            secrets: secrets.clone(),
            transport: transport.clone(),
        });
        let probe_search = search.clone();
        let trackers = TrackerSet::new()
            .with(Arc::new(GitProviderTracker::new(Arc::new(
                GitHubProvider::new(transport.clone(), secrets.clone()),
            ))))
            .with(Arc::new(GitProviderTracker::new(Arc::new(
                GitLabProvider::new(transport.clone(), secrets.clone(), None),
            ))))
            .with(Arc::new(GitProviderTracker::new(Arc::new(
                BitbucketProvider::new(transport, secrets),
            ))));
        Self {
            llm: Some(byok),
            llm_ready: Some(Arc::new(move || probe_llm.pick().is_some())),
            models: ModelPair {
                default: DEFAULT_MODEL.into(),
                fast: FAST_MODEL.into(),
            },
            embedder: live.embedder,
            web_search: Some(search),
            search_ready: Some(Arc::new(move || probe_search.key().is_some())),
            trackers,
        }
    }

    /// Replace the model provider and models.
    #[must_use]
    pub fn with_llm(mut self, llm: Arc<dyn LlmProvider>, models: ModelPair) -> Self {
        self.llm = Some(llm);
        self.llm_ready = None;
        self.models = models;
        self
    }

    /// Replace the web search backend.
    #[must_use]
    pub fn with_web_search(mut self, s: Arc<dyn WebSearch>) -> Self {
        self.web_search = Some(s);
        self.search_ready = None;
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

    /// True when a model call can be attempted.
    #[must_use]
    pub fn llm_available(&self) -> bool {
        self.llm.is_some() && probe_ok(self.llm_ready.as_ref())
    }

    /// True when a web search can be attempted.
    #[must_use]
    pub fn search_available(&self) -> bool {
        self.web_search.is_some() && probe_ok(self.search_ready.as_ref())
    }
}

fn probe_ok(p: Option<&Probe>) -> bool {
    match p {
        Some(f) => f(),
        None => true,
    }
}

impl Default for Services {
    fn default() -> Self {
        Self::offline()
    }
}

/// Chooses the model provider at call time from the stored BYOK keys (`NYX_PROVIDER` forces one).
#[derive(Debug)]
struct ByokLlm {
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
}

impl ByokLlm {
    fn pick(&self) -> Option<ProviderConfig> {
        let has_key = |c: &ProviderConfig| {
            c.secret_key()
                .ok()
                .flatten()
                .is_some_and(|k| matches!(self.secrets.get(&k), Ok(Some(_))))
        };
        if let Some(kind) = std::env::var("NYX_PROVIDER")
            .ok()
            .and_then(|s| ProviderKind::from_slug(&s).ok())
        {
            let cfg = ProviderConfig::new(kind);
            return has_key(&cfg).then_some(cfg);
        }
        ProviderKind::ALL
            .iter()
            .map(|k| ProviderConfig::new(*k))
            .find(has_key)
    }
}

impl LlmProvider for ByokLlm {
    fn name(&self) -> &str {
        "byok"
    }

    fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError> {
        let cfg = self
            .pick()
            .ok_or_else(|| LlmError::NoKey("any (run `nyx byok set <provider>`)".into()))?;
        let models = cfg.models();
        let mut req = request.clone();
        req.model = if request.model == FAST_MODEL {
            models.fast
        } else {
            models.default
        };
        HttpLlm::new(cfg, self.secrets.clone(), self.transport.clone())?.complete(&req)
    }
}

/// Tavily search reading its key (`tavily/api-key`) from the secret store per call.
#[derive(Debug)]
struct LazyTavily {
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
}

impl LazyTavily {
    fn key(&self) -> Option<String> {
        use secrecy::ExposeSecret;
        self.secrets
            .get(&SecretKey::api_key(Provider::Other("tavily".into())))
            .ok()
            .flatten()
            .map(|s| s.expose_secret().to_owned())
    }
}

impl WebSearch for LazyTavily {
    fn search(&self, query: &str) -> nyx_core::Result<Vec<nyx_core::sync::SearchResult>> {
        TavilySearch::new(self.key(), self.transport.clone()).search(query)
    }
}
