//! [`HttpLlm`]: a real [`LlmProvider`] built from a [`ProviderConfig`], a [`SecretStore`] and an
//! [`HttpTransport`]. All logic is request building and response parsing from [`super::wire`];
//! the only I/O is the injected transport.

use std::fmt;
use std::sync::Arc;

use secrecy::ExposeSecret;

use super::config::{ProviderConfig, ProviderKind, Wire};
use super::provider::{LlmError, LlmProvider, LlmRequest, LlmResponse};
use super::transport::HttpTransport;
use super::wire;
use crate::profile::SecretStore;

/// Attribution headers recommended by `OpenRouter`.
fn openrouter_headers() -> Vec<(String, String)> {
    vec![
        (
            "HTTP-Referer".into(),
            "https://github.com/NoJuanNobody/nyx".into(),
        ),
        ("X-Title".into(), "Nyx".into()),
    ]
}

/// Provider backed by an HTTP API.
pub struct HttpLlm {
    config: ProviderConfig,
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
}

impl fmt::Debug for HttpLlm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpLlm")
            .field("config", &self.config)
            .field("key", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl HttpLlm {
    /// Build a provider. The key is read from `secrets` lazily on each call, so rotating or
    /// deleting it takes effect immediately (no client cache to invalidate).
    ///
    /// # Errors
    /// [`LlmError::Config`] if the config fails validation.
    pub fn new(
        config: ProviderConfig,
        secrets: Arc<dyn SecretStore>,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self, LlmError> {
        config
            .validate()
            .map_err(|e| LlmError::Config(e.to_string()))?;
        Ok(Self {
            config,
            secrets,
            transport,
        })
    }

    /// The (non-secret) configuration.
    #[must_use]
    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    /// Build the HTTP request for `request` without sending it. Exposed for tests and dry runs;
    /// the result's `Debug` output redacts the credential header.
    ///
    /// # Errors
    /// [`LlmError::NoKey`] if a required key is missing.
    pub fn build_http_request(
        &self,
        request: &LlmRequest,
    ) -> Result<super::transport::HttpRequest, LlmError> {
        let kind = self.config.kind;
        let base = self
            .config
            .effective_base_url()
            .ok_or_else(|| LlmError::Config("missing base_url".into()))?;
        let secret = match self
            .config
            .secret_key()
            .map_err(|e| LlmError::Config(e.to_string()))?
        {
            Some(k) => Some(
                self.secrets
                    .get(&k)
                    .map_err(|e| LlmError::Config(e.to_string()))?
                    .ok_or_else(|| LlmError::NoKey(kind.slug().to_owned()))?,
            ),
            None => None,
        };
        match kind.wire() {
            Wire::Anthropic => {
                let key = secret
                    .as_ref()
                    .ok_or_else(|| LlmError::NoKey(kind.slug().to_owned()))?;
                wire::anthropic_http_request(&base, key.expose_secret(), request)
            }
            Wire::OpenAi => {
                let extra = if kind == ProviderKind::OpenRouter {
                    openrouter_headers()
                } else {
                    Vec::new()
                };
                wire::openai_http_request(
                    &base,
                    secret.as_ref().map(ExposeSecret::expose_secret),
                    &extra,
                    request,
                )
            }
        }
    }
}

impl LlmProvider for HttpLlm {
    fn name(&self) -> &str {
        self.config.kind.slug()
    }

    fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError> {
        let http = self.build_http_request(request)?;
        let resp = self.transport.send(&http)?;
        match self.config.kind.wire() {
            Wire::Anthropic => wire::parse_anthropic_response(resp.status, &resp.body),
            Wire::OpenAi => wire::parse_openai_response(resp.status, &resp.body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::config::ByokKeys;
    use crate::ai::transport::FakeTransport;
    use crate::profile::MemorySecretStore;

    fn setup(kind: ProviderKind, key: Option<&str>) -> (HttpLlm, Arc<FakeTransport>) {
        let secrets = Arc::new(MemorySecretStore::new());
        if let Some(k) = key {
            ByokKeys::new(secrets.as_ref()).add(kind, k).unwrap();
        }
        let t = Arc::new(FakeTransport::new());
        let llm = HttpLlm::new(ProviderConfig::new(kind), secrets, t.clone()).unwrap();
        (llm, t)
    }

    fn req() -> LlmRequest {
        LlmRequest::simple("m", "sys", "hello", 100)
    }

    #[test]
    fn anthropic_roundtrip_through_fake_transport() {
        let (llm, t) = setup(ProviderKind::Anthropic, Some("sk-ant-SECRET"));
        t.push(200, r#"{"model":"claude","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#);
        let r = llm.complete(&req()).unwrap();
        assert_eq!(r.text, "pong");
        let sent = t.requests();
        assert_eq!(sent[0].header("x-api-key"), Some("sk-ant-SECRET"));
        assert_eq!(sent[0].url, "https://api.anthropic.com/v1/messages");
        assert!(!format!("{:?}", sent[0]).contains("SECRET"));
        assert!(!format!("{llm:?}").contains("SECRET"));
    }

    #[test]
    fn openrouter_sends_bearer_and_attribution() {
        let (llm, t) = setup(ProviderKind::OpenRouter, Some("sk-or-1"));
        t.push(
            200,
            r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#,
        );
        assert_eq!(llm.complete(&req()).unwrap().text, "ok");
        let sent = &t.requests()[0];
        assert_eq!(sent.header("authorization"), Some("Bearer sk-or-1"));
        assert_eq!(sent.header("x-title"), Some("Nyx"));
        assert_eq!(sent.url, "https://openrouter.ai/api/v1/chat/completions");
    }

    #[test]
    fn ollama_needs_no_key() {
        let (llm, t) = setup(ProviderKind::Ollama, None);
        t.push(
            200,
            r#"{"choices":[{"message":{"content":"local"},"finish_reason":"stop"}]}"#,
        );
        assert_eq!(llm.complete(&req()).unwrap().text, "local");
        assert!(t.requests()[0].header("authorization").is_none());
    }

    #[test]
    fn missing_key_fails_before_any_request() {
        let (llm, t) = setup(ProviderKind::OpenAi, None);
        assert_eq!(llm.complete(&req()), Err(LlmError::NoKey("openai".into())));
        assert!(t.requests().is_empty());
    }

    #[test]
    fn http_and_transport_errors_surface() {
        let (llm, t) = setup(ProviderKind::OpenAi, Some("k"));
        t.push(401, r#"{"error":{"message":"bad key"}}"#);
        t.push_error("timeout");
        assert!(matches!(
            llm.complete(&req()),
            Err(LlmError::Http { status: 401, .. })
        ));
        assert_eq!(
            llm.complete(&req()),
            Err(LlmError::Transport("timeout".into()))
        );
    }

    #[test]
    fn rotation_takes_effect_immediately() {
        let secrets = Arc::new(MemorySecretStore::new());
        let keys = ByokKeys::new(secrets.as_ref());
        keys.add(ProviderKind::OpenAi, "old").unwrap();
        let t = Arc::new(FakeTransport::new());
        let llm = HttpLlm::new(
            ProviderConfig::new(ProviderKind::OpenAi),
            secrets.clone(),
            t.clone(),
        )
        .unwrap();
        keys.rotate(ProviderKind::OpenAi, "new").unwrap();
        t.push(200, r#"{"choices":[{"message":{"content":"x"}}]}"#);
        llm.complete(&req()).unwrap();
        assert_eq!(t.requests()[0].header("authorization"), Some("Bearer new"));
    }

    #[test]
    fn invalid_config_rejected() {
        let cfg = ProviderConfig::new(ProviderKind::OpenAiCompatible);
        let r = HttpLlm::new(
            cfg,
            Arc::new(MemorySecretStore::new()),
            Arc::new(FakeTransport::new()),
        );
        assert!(matches!(r, Err(LlmError::Config(_))));
    }
}
