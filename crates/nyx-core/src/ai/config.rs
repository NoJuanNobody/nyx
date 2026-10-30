//! BYOK provider configuration, key management and provider selection.
//!
//! Ports `routes/ai-keys.ts` (store / rotate / delete / status) and the provider switch from
//! `lib/llm.ts`, minus anything team- or platform-key related: Nyx never ships a hosted key.
//!
//! A [`ProviderConfig`] holds only non-secret settings. The API key lives in a
//! [`SecretStore`] under the key returned by [`ProviderConfig::secret_key`]; nothing in this
//! module formats, serialises or logs key material (the only place a key is ever read back is
//! [`KeyStatus::of`], which keeps just the last four characters, as the TS `keySuffix` did).

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

use super::provider::LlmError;
use crate::profile::{Provider, SecretKey, SecretStore};
use crate::{Error, Result};

/// Which wire format a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    /// Anthropic Messages API.
    Anthropic,
    /// OpenAI-compatible Chat Completions API.
    OpenAi,
}

/// Supported model providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderKind {
    /// Anthropic (direct).
    #[serde(rename = "anthropic")]
    Anthropic,
    /// `OpenAI` (direct).
    #[serde(rename = "openai")]
    OpenAi,
    /// `OpenRouter` (OpenAI-compatible aggregator).
    #[serde(rename = "openrouter")]
    OpenRouter,
    /// Local Ollama server (no key).
    #[serde(rename = "ollama")]
    Ollama,
    /// Any other OpenAI-compatible endpoint; requires an explicit `base_url`.
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
}

impl ProviderKind {
    /// Every kind, in preference order for automatic selection.
    pub const ALL: &'static [Self] = &[
        Self::Anthropic,
        Self::OpenRouter,
        Self::OpenAi,
        Self::Ollama,
        Self::OpenAiCompatible,
    ];

    /// Stable slug (matches the `ai_provider_configs.kind` column and secret paths).
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::OpenRouter => "openrouter",
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }

    /// Parse a slug.
    ///
    /// # Errors
    /// [`Error::Invalid`] for unknown providers.
    pub fn from_slug(s: &str) -> Result<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|k| k.slug() == s)
            .ok_or_else(|| Error::Invalid(format!("unknown model provider: {s:?}")))
    }

    /// Wire format.
    #[must_use]
    pub fn wire(self) -> Wire {
        match self {
            Self::Anthropic => Wire::Anthropic,
            _ => Wire::OpenAi,
        }
    }

    /// Does this provider need an API key?
    #[must_use]
    pub fn requires_key(self) -> bool {
        !matches!(self, Self::Ollama)
    }

    /// Default endpoint root (`None` when the user must supply one).
    #[must_use]
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("https://api.anthropic.com"),
            Self::OpenAi => Some("https://api.openai.com/v1"),
            Self::OpenRouter => Some("https://openrouter.ai/api/v1"),
            Self::Ollama => Some("http://localhost:11434/v1"),
            Self::OpenAiCompatible => None,
        }
    }

    /// Default "smart" model (port of `resolveDefaultModel`).
    #[must_use]
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-4-6",
            Self::OpenRouter => "anthropic/claude-sonnet-4",
            Self::OpenAi | Self::OpenAiCompatible => "gpt-4o",
            Self::Ollama => "llama3.1",
        }
    }

    /// Default fast/cheap model (port of `resolveFastModel`).
    #[must_use]
    pub fn default_fast_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-haiku-4-5-20251001",
            Self::OpenRouter => "anthropic/claude-haiku-4-5",
            Self::OpenAi | Self::OpenAiCompatible => "gpt-4o-mini",
            Self::Ollama => "llama3.1",
        }
    }

    /// The [`SecretStore`] provider namespace for this kind's API key.
    ///
    /// # Errors
    /// Only if the slug is not a valid secret slug (cannot happen for built-in kinds).
    pub fn secret_provider(self) -> Result<Provider> {
        Provider::from_slug(self.slug())
    }
}

/// The two models every feature uses: a smart default and a fast/cheap one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPair {
    /// Quality-sensitive calls.
    pub default: String,
    /// Frequent, cheap calls.
    pub fast: String,
}

/// Non-secret provider settings. Safe to log, store and send to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Provider.
    pub kind: ProviderKind,
    /// Default model slug.
    pub model: String,
    /// Fast model slug; falls back to the provider default when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_model: Option<String>,
    /// Endpoint override (self-hosted gateways, non-default Ollama port).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl ProviderConfig {
    /// Config with provider-default models.
    #[must_use]
    pub fn new(kind: ProviderKind) -> Self {
        Self {
            kind,
            model: kind.default_model().to_owned(),
            fast_model: None,
            base_url: None,
        }
    }

    /// Check the settings are usable.
    ///
    /// # Errors
    /// [`Error::Invalid`] for an empty model, a non-http(s) `base_url`, or a missing
    /// `base_url` on [`ProviderKind::OpenAiCompatible`].
    pub fn validate(&self) -> Result<()> {
        if self.model.trim().is_empty() {
            return Err(Error::Invalid("model must not be empty".into()));
        }
        if let Some(u) = &self.base_url {
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err(Error::Invalid(
                    "base_url must start with http:// or https://".into(),
                ));
            }
        }
        if self.effective_base_url().is_none() {
            return Err(Error::Invalid(format!(
                "provider `{}` requires a base_url",
                self.kind.slug()
            )));
        }
        Ok(())
    }

    /// Endpoint root: the override, else the provider default.
    #[must_use]
    pub fn effective_base_url(&self) -> Option<String> {
        self.base_url
            .clone()
            .or_else(|| self.kind.default_base_url().map(str::to_owned))
    }

    /// Resolved default/fast model pair.
    #[must_use]
    pub fn models(&self) -> ModelPair {
        ModelPair {
            default: self.model.clone(),
            fast: self
                .fast_model
                .clone()
                .unwrap_or_else(|| self.kind.default_fast_model().to_owned()),
        }
    }

    /// Reference to this provider's API key in the [`SecretStore`]; `None` for keyless kinds.
    ///
    /// # Errors
    /// Only on an invalid secret slug (cannot happen for built-in kinds).
    pub fn secret_key(&self) -> Result<Option<SecretKey>> {
        if self.kind.requires_key() {
            Ok(Some(SecretKey::api_key(self.kind.secret_provider()?)))
        } else {
            Ok(None)
        }
    }

    /// Is this provider ready to use (keyless, or a key is stored)?
    ///
    /// # Errors
    /// Secret-store backend failure.
    pub fn is_usable(&self, secrets: &dyn SecretStore) -> Result<bool> {
        match self.secret_key()? {
            None => Ok(true),
            Some(k) => Ok(secrets.get(&k)?.is_some()),
        }
    }
}

/// Pick the provider to use for a call.
///
/// * `active = Some(kind)`: that provider's config must exist and be usable, otherwise an error.
///   There is deliberately **no silent fallback** to another vendor: switching providers would
///   send the user's documents somewhere they did not choose.
/// * `active = None`: the first usable config in [`ProviderKind::ALL`] preference order.
///
/// # Errors
/// [`LlmError::NoKey`] when the chosen provider has no key, [`LlmError::Config`] when nothing
/// is configured or usable.
pub fn select_provider<'a>(
    configs: &'a [ProviderConfig],
    active: Option<ProviderKind>,
    secrets: &dyn SecretStore,
) -> std::result::Result<&'a ProviderConfig, LlmError> {
    let usable = |c: &ProviderConfig| {
        c.is_usable(secrets)
            .map_err(|e| LlmError::Config(e.to_string()))
    };
    if let Some(kind) = active {
        let cfg = configs.iter().find(|c| c.kind == kind).ok_or_else(|| {
            LlmError::Config(format!("provider `{}` is not configured", kind.slug()))
        })?;
        return if usable(cfg)? {
            Ok(cfg)
        } else {
            Err(LlmError::NoKey(kind.slug().to_owned()))
        };
    }
    for kind in ProviderKind::ALL {
        if let Some(cfg) = configs.iter().find(|c| c.kind == *kind) {
            if usable(cfg)? {
                return Ok(cfg);
            }
        }
    }
    Err(LlmError::Config(
        "no usable model provider: add an API key or configure a local provider".into(),
    ))
}

/// Normalise a model slug to the namespace of `kind` (issues #448 / #471: slug migrations).
///
/// * Direct Anthropic wants bare dashed slugs: `anthropic/claude-sonnet-4.5` becomes
///   `claude-sonnet-4-5`.
/// * `OpenRouter` wants `vendor/model`: bare `claude-*` gets `anthropic/`, bare `gpt-*` / `o1` /
///   `o3` get `openai/`.
/// * Everything else is returned unchanged.
///
/// Heuristic by design: unknown slugs are never rewritten.
#[must_use]
pub fn normalize_model_slug(kind: ProviderKind, slug: &str) -> String {
    let slug = slug.trim();
    match kind {
        ProviderKind::Anthropic => {
            let bare = slug.strip_prefix("anthropic/").unwrap_or(slug);
            if bare.starts_with("claude") {
                bare.replace('.', "-")
            } else {
                bare.to_owned()
            }
        }
        ProviderKind::OpenRouter if !slug.contains('/') => {
            if slug.starts_with("claude") {
                format!("anthropic/{slug}")
            } else if slug.starts_with("gpt-") || slug.starts_with("o1") || slug.starts_with("o3") {
                format!("openai/{slug}")
            } else {
                slug.to_owned()
            }
        }
        _ => slug.to_owned(),
    }
}

/// What the UI may know about a stored key: never the key itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyStatus {
    /// Provider.
    pub provider: ProviderKind,
    /// Is a key stored (always `true` for keyless providers).
    pub configured: bool,
    /// Last four characters of the key, for recognition in a settings screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_suffix: Option<String>,
}

/// Last four characters (fewer for very short input).
fn suffix4(s: &str) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(4)).collect()
}

impl KeyStatus {
    /// Look up the status of `kind`'s key.
    ///
    /// # Errors
    /// Secret-store backend failure.
    pub fn of(kind: ProviderKind, secrets: &dyn SecretStore) -> Result<Self> {
        let cfg = ProviderConfig::new(kind);
        let Some(key) = cfg.secret_key()? else {
            return Ok(Self {
                provider: kind,
                configured: true,
                key_suffix: None,
            });
        };
        let suffix = secrets.get(&key)?.map(|s| suffix4(s.expose_secret()));
        Ok(Self {
            provider: kind,
            configured: suffix.is_some(),
            key_suffix: suffix,
        })
    }
}

/// BYOK key lifecycle over a [`SecretStore`] (port of the `ai-key` routes).
#[derive(Debug, Clone, Copy)]
pub struct ByokKeys<'a> {
    secrets: &'a dyn SecretStore,
}

impl<'a> ByokKeys<'a> {
    /// Wrap a secret store.
    #[must_use]
    pub fn new(secrets: &'a dyn SecretStore) -> Self {
        Self { secrets }
    }

    fn key_for(kind: ProviderKind) -> Result<SecretKey> {
        ProviderConfig::new(kind).secret_key()?.ok_or_else(|| {
            Error::Invalid(format!(
                "provider `{}` does not use an API key",
                kind.slug()
            ))
        })
    }

    fn clean(api_key: &str) -> Result<SecretString> {
        let k = api_key.trim();
        if k.is_empty() {
            return Err(Error::Invalid("apiKey is required".into()));
        }
        Ok(SecretString::from(k.to_owned()))
    }

    /// Store a new key (`POST /ai-key`).
    ///
    /// # Errors
    /// [`Error::Invalid`] for an empty key or keyless provider; [`Error::Conflict`] if a key
    /// already exists (use [`ByokKeys::rotate`]).
    pub fn add(&self, kind: ProviderKind, api_key: &str) -> Result<KeyStatus> {
        let key = Self::key_for(kind)?;
        let value = Self::clean(api_key)?;
        if self.secrets.get(&key)?.is_some() {
            return Err(Error::Conflict(
                "A key for this provider already exists. Use rotate to replace it.".into(),
            ));
        }
        self.secrets.set(&key, value)?;
        KeyStatus::of(kind, self.secrets)
    }

    /// Replace an existing key (`PUT /ai-key`).
    ///
    /// # Errors
    /// [`Error::NotFound`] if there is no key to rotate; [`Error::Invalid`] for an empty key.
    pub fn rotate(&self, kind: ProviderKind, api_key: &str) -> Result<KeyStatus> {
        let key = Self::key_for(kind)?;
        let value = Self::clean(api_key)?;
        if self.secrets.get(&key)?.is_none() {
            return Err(Error::NotFound("No active key found to rotate".into()));
        }
        self.secrets.set(&key, value)?;
        KeyStatus::of(kind, self.secrets)
    }

    /// Delete a key (`DELETE /ai-key`).
    ///
    /// # Errors
    /// [`Error::NotFound`] if there was no key.
    pub fn remove(&self, kind: ProviderKind) -> Result<()> {
        let key = Self::key_for(kind)?;
        if self.secrets.delete(&key)? {
            Ok(())
        } else {
            Err(Error::NotFound("No active key found".into()))
        }
    }

    /// Key status (`GET /ai-key`).
    ///
    /// # Errors
    /// Secret-store backend failure.
    pub fn status(&self, kind: ProviderKind) -> Result<KeyStatus> {
        KeyStatus::of(kind, self.secrets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::MemorySecretStore;

    fn store_with(kind: ProviderKind, key: &str) -> MemorySecretStore {
        let s = MemorySecretStore::new();
        ByokKeys::new(&s).add(kind, key).unwrap();
        s
    }

    #[test]
    fn slugs_roundtrip() {
        for k in ProviderKind::ALL {
            assert_eq!(ProviderKind::from_slug(k.slug()).unwrap(), *k);
            let j = serde_json::to_string(k).unwrap();
            assert_eq!(j, format!("\"{}\"", k.slug()));
        }
        assert!(ProviderKind::from_slug("bard").is_err());
    }

    #[test]
    fn defaults_per_provider() {
        let c = ProviderConfig::new(ProviderKind::OpenRouter);
        assert_eq!(c.models().default, "anthropic/claude-sonnet-4");
        assert_eq!(c.models().fast, "anthropic/claude-haiku-4-5");
        assert_eq!(ProviderKind::Anthropic.wire(), Wire::Anthropic);
        assert_eq!(ProviderKind::Ollama.wire(), Wire::OpenAi);
        assert!(!ProviderKind::Ollama.requires_key());
        let mut c = ProviderConfig::new(ProviderKind::Anthropic);
        c.fast_model = Some("custom-fast".into());
        assert_eq!(c.models().fast, "custom-fast");
    }

    #[test]
    fn validation() {
        assert!(ProviderConfig::new(ProviderKind::OpenAi).validate().is_ok());
        let mut c = ProviderConfig::new(ProviderKind::OpenAiCompatible);
        assert!(c.validate().is_err(), "needs base_url");
        c.base_url = Some("http://localhost:8080/v1".into());
        assert!(c.validate().is_ok());
        c.base_url = Some("ftp://x".into());
        assert!(c.validate().is_err());
        c.base_url = None;
        c.model = "  ".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn config_debug_and_json_hold_no_key() {
        let s = store_with(ProviderKind::Anthropic, "sk-ant-TOPSECRET9999");
        let c = ProviderConfig::new(ProviderKind::Anthropic);
        assert!(!format!("{c:?}").contains("TOPSECRET"));
        assert!(!serde_json::to_string(&c).unwrap().contains("TOPSECRET"));
        assert!(!format!("{s:?}").contains("TOPSECRET"));
        assert_eq!(
            c.secret_key().unwrap().unwrap().as_path(),
            "anthropic/api-key"
        );
        assert!(ProviderConfig::new(ProviderKind::Ollama)
            .secret_key()
            .unwrap()
            .is_none());
    }

    #[test]
    fn key_lifecycle_matches_ts_routes() {
        let s = MemorySecretStore::new();
        let keys = ByokKeys::new(&s);
        assert!(!keys.status(ProviderKind::OpenAi).unwrap().configured);
        assert!(matches!(
            keys.rotate(ProviderKind::OpenAi, "k"),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            keys.remove(ProviderKind::OpenAi),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            keys.add(ProviderKind::OpenAi, "   "),
            Err(Error::Invalid(_))
        ));

        let st = keys.add(ProviderKind::OpenAi, "sk-abcdefgh1234").unwrap();
        assert!(st.configured);
        assert_eq!(st.key_suffix.as_deref(), Some("1234"));
        assert!(matches!(
            keys.add(ProviderKind::OpenAi, "x"),
            Err(Error::Conflict(_))
        ));

        let st = keys.rotate(ProviderKind::OpenAi, "sk-zzzz9876").unwrap();
        assert_eq!(st.key_suffix.as_deref(), Some("9876"));
        keys.remove(ProviderKind::OpenAi).unwrap();
        assert!(!keys.status(ProviderKind::OpenAi).unwrap().configured);
        // Ollama has no key to manage but always reports configured.
        assert!(matches!(
            keys.add(ProviderKind::Ollama, "x"),
            Err(Error::Invalid(_))
        ));
        assert!(keys.status(ProviderKind::Ollama).unwrap().configured);
    }

    #[test]
    fn status_json_has_suffix_only() {
        let s = store_with(ProviderKind::Anthropic, "sk-ant-TOPSECRET9999");
        let st = ByokKeys::new(&s).status(ProviderKind::Anthropic).unwrap();
        let j = serde_json::to_string(&st).unwrap();
        assert!(j.contains("9999"));
        assert!(!j.contains("TOPSECRET"));
        assert_eq!(suffix4("ab"), "ab");
    }

    #[test]
    fn selection_prefers_active_and_never_falls_back_silently() {
        let s = MemorySecretStore::new();
        ByokKeys::new(&s)
            .add(ProviderKind::OpenRouter, "or-key")
            .unwrap();
        let configs = vec![
            ProviderConfig::new(ProviderKind::Anthropic),
            ProviderConfig::new(ProviderKind::OpenRouter),
            ProviderConfig::new(ProviderKind::Ollama),
        ];
        // Auto: Anthropic has no key, OpenRouter does.
        assert_eq!(
            select_provider(&configs, None, &s).unwrap().kind,
            ProviderKind::OpenRouter
        );
        // Explicit active without key is an error, not a fallback.
        assert_eq!(
            select_provider(&configs, Some(ProviderKind::Anthropic), &s),
            Err(LlmError::NoKey("anthropic".into()))
        );
        // Explicit active that works.
        assert_eq!(
            select_provider(&configs, Some(ProviderKind::Ollama), &s)
                .unwrap()
                .kind,
            ProviderKind::Ollama
        );
        // Explicit but unconfigured.
        assert!(matches!(
            select_provider(&configs, Some(ProviderKind::OpenAi), &s),
            Err(LlmError::Config(_))
        ));
    }

    #[test]
    fn selection_with_nothing_usable() {
        let s = MemorySecretStore::new();
        let configs = vec![ProviderConfig::new(ProviderKind::Anthropic)];
        assert!(matches!(
            select_provider(&configs, None, &s),
            Err(LlmError::Config(_))
        ));
        assert!(matches!(
            select_provider(&[], None, &s),
            Err(LlmError::Config(_))
        ));
    }

    #[test]
    fn auto_selection_order_is_anthropic_first() {
        let s = MemorySecretStore::new();
        let keys = ByokKeys::new(&s);
        keys.add(ProviderKind::OpenAi, "a").unwrap();
        keys.add(ProviderKind::Anthropic, "b").unwrap();
        let configs = vec![
            ProviderConfig::new(ProviderKind::OpenAi),
            ProviderConfig::new(ProviderKind::Anthropic),
        ];
        assert_eq!(
            select_provider(&configs, None, &s).unwrap().kind,
            ProviderKind::Anthropic
        );
    }

    #[test]
    fn slug_normalisation() {
        use ProviderKind::{Anthropic, Ollama, OpenRouter};
        assert_eq!(
            normalize_model_slug(Anthropic, "anthropic/claude-sonnet-4.5"),
            "claude-sonnet-4-5"
        );
        assert_eq!(
            normalize_model_slug(Anthropic, "claude-haiku-4-5-20251001"),
            "claude-haiku-4-5-20251001"
        );
        assert_eq!(
            normalize_model_slug(OpenRouter, "claude-sonnet-4"),
            "anthropic/claude-sonnet-4"
        );
        assert_eq!(normalize_model_slug(OpenRouter, "gpt-4o"), "openai/gpt-4o");
        assert_eq!(
            normalize_model_slug(OpenRouter, "google/gemini-2.0-flash-001"),
            "google/gemini-2.0-flash-001"
        );
        assert_eq!(normalize_model_slug(OpenRouter, "mystery"), "mystery");
        assert_eq!(normalize_model_slug(Ollama, " llama3.1 "), "llama3.1");
    }
}
