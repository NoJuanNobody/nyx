//! [`live_services`]: the trait-object bundle the app crate plugs in to leave offline mode.
//!
//! This is intentionally **not** the app's `Services` type (`nyx-app` owns that one and `nyx-net`
//! must not depend on it). It is a thin, documented set of real implementations that the
//! orchestrator maps field by field:
//!
//! | `LiveServices` | `nyx_app::Services` field |
//! |---|---|
//! | [`LiveServices::transport`] | feed to every HTTP-backed constructor below |
//! | [`LiveServices::embedder`] | `embedder` (offline hashing until [`LiveServices::with_http_embedder`]) |
//! | [`LiveServices::llm`] | `llm` (needs a provider config and the key store) |
//! | [`LiveServices::web_search`] | `web_search` |
//! | [`LiveServices::linear_tracker`] | an entry of `trackers` |
//!
//! Nothing here reads keys at construction time: secrets stay in the [`SecretStore`] and are read
//! per call by the core types.

use std::sync::Arc;

use nyx_core::ai::{
    Embedder, HashingEmbedder, HttpEmbedder, HttpLlm, LlmError, LlmProvider, ProviderConfig,
};
use nyx_core::net::HttpTransport;
use nyx_core::profile::SecretStore;
use nyx_core::sync::{TavilySearch, WebSearch};
use nyx_core::tickets::linear::LinearTracker;
use nyx_core::tickets::tracker::TicketTracker;
use secrecy::SecretString;

use crate::transport::{NetConfig, UreqTransport};

/// Real implementations of the core's network seams.
#[derive(Clone)]
pub struct LiveServices {
    /// The shared, SSRF-guarded transport. Clone the `Arc` into anything that needs HTTP.
    pub transport: Arc<dyn HttpTransport>,
    /// Embedder for indexing and search. Offline lexical hashing until replaced.
    pub embedder: Arc<dyn Embedder>,
}

impl std::fmt::Debug for LiveServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveServices")
            .field("transport", &self.transport)
            .field("embedder", &self.embedder.model())
            .finish()
    }
}

/// Default live services: a [`UreqTransport`] with [`NetConfig::default`] and the offline
/// hashing embedder.
#[must_use]
pub fn live_services() -> LiveServices {
    LiveServices::with_config(NetConfig::default())
}

impl LiveServices {
    /// Live services over a transport built from `cfg`.
    #[must_use]
    pub fn with_config(cfg: NetConfig) -> Self {
        Self::with_transport(Arc::new(UreqTransport::new(cfg)))
    }

    /// Use an existing transport (for example a `FakeTransport` in an integration test).
    #[must_use]
    pub fn with_transport(transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            transport,
            embedder: Arc::new(HashingEmbedder::default()),
        }
    }

    /// Switch to an OpenAI-compatible embeddings endpoint.
    #[must_use]
    pub fn with_http_embedder(
        mut self,
        base_url: &str,
        api_key: SecretString,
        model: &str,
    ) -> Self {
        self.embedder = Arc::new(HttpEmbedder::new(
            self.transport.clone(),
            base_url,
            api_key,
            model,
        ));
        self
    }

    /// A BYOK model provider reading its key from `secrets` on each call.
    ///
    /// # Errors
    /// [`LlmError::Config`] when `config` is invalid.
    pub fn llm(
        &self,
        config: ProviderConfig,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Arc<dyn LlmProvider>, LlmError> {
        Ok(Arc::new(HttpLlm::new(
            config,
            secrets,
            self.transport.clone(),
        )?))
    }

    /// Tavily web search; stubbed (no request) when `api_key` is `None` or blank.
    #[must_use]
    pub fn web_search(&self, api_key: Option<String>) -> Arc<dyn WebSearch> {
        Arc::new(TavilySearch::new(api_key, self.transport.clone()))
    }

    /// Linear GraphQL tracker.
    #[must_use]
    pub fn linear_tracker(&self, api_key: SecretString) -> Arc<dyn TicketTracker> {
        Arc::new(LinearTracker::new(api_key, self.transport.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nyx_core::ai::ProviderKind;
    use nyx_core::net::FakeTransport;
    use nyx_core::profile::MemorySecretStore;

    #[test]
    fn default_bundle_is_offline_for_embeddings() {
        let s = live_services();
        assert!(s.embedder.model().starts_with("nyx-hashing-"));
        assert!(format!("{s:?}").contains("UreqTransport"));
    }

    #[test]
    fn helpers_share_one_transport() {
        let fake = Arc::new(FakeTransport::new());
        let s = LiveServices::with_transport(fake.clone());
        // web search without a key never touches the network
        let hits = s.web_search(None).search("rust").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(fake.requests().len(), 0);
        // with a key, the request goes through the injected transport
        fake.push_text(
            200,
            r#"{"results":[{"title":"A","content":"c","url":"https://a"}]}"#,
        );
        let hits = s.web_search(Some("k".into())).search("rust").unwrap();
        assert_eq!(hits[0].title, "A");
        assert_eq!(fake.requests().len(), 1);

        let embed = s.with_http_embedder("https://x/v1", SecretString::from("sk".to_owned()), "m");
        fake.push_text(200, r#"{"data":[{"index":0,"embedding":[0.5,0.5]}]}"#);
        let v = embed.embedder.embed(&["a".to_owned()]).unwrap();
        assert_eq!(v, vec![vec![0.5, 0.5]]);
        assert_eq!(fake.requests()[1].url, "https://x/v1/embeddings");
    }

    #[test]
    fn llm_requires_valid_config_and_reads_keys_lazily() {
        let s = LiveServices::with_transport(Arc::new(FakeTransport::new()));
        let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
        let llm = s
            .llm(ProviderConfig::new(ProviderKind::Anthropic), secrets)
            .unwrap();
        assert_eq!(llm.name(), "anthropic");
        let _ = s.linear_tracker(SecretString::from("lin_key".to_owned()));
    }
}
