//! Secret storage abstraction: BYOK model-provider keys and integration tokens.
//!
//! Secret values are wrapped in [`SecretString`], whose `Debug` output is
//! redacted, so they cannot leak through `{:?}` formatting or structured logs.
//! Values are never part of any `Serialize` type in this module.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Mutex;

use secrecy::SecretString;

use crate::{Error, Result};

/// Third-party service a secret belongs to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Provider {
    /// Anthropic model API (BYOK).
    Anthropic,
    /// `OpenAI` model API (BYOK).
    OpenAi,
    /// `OpenRouter` model API (BYOK).
    OpenRouter,
    /// GitHub integration.
    GitHub,
    /// Jira / Atlassian integration.
    Jira,
    /// Slack integration.
    Slack,
    /// Any other service, identified by a lowercase slug.
    Other(String),
}

impl Provider {
    /// Stable slug used in storage keys.
    #[must_use]
    pub fn slug(&self) -> &str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::OpenRouter => "openrouter",
            Self::GitHub => "github",
            Self::Jira => "jira",
            Self::Slack => "slack",
            Self::Other(s) => s,
        }
    }

    /// Parse a slug; unknown slugs become [`Provider::Other`].
    ///
    /// # Errors
    /// Returns [`Error::Invalid`] if the slug is empty or contains characters
    /// other than `a-z`, `0-9`, `-`, `_`.
    pub fn from_slug(slug: &str) -> Result<Self> {
        let valid = !slug.is_empty()
            && slug
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !valid {
            return Err(Error::Invalid(format!("bad provider slug: {slug:?}")));
        }
        Ok(match slug {
            "anthropic" => Self::Anthropic,
            "openai" => Self::OpenAi,
            "openrouter" => Self::OpenRouter,
            "github" => Self::GitHub,
            "jira" => Self::Jira,
            "slack" => Self::Slack,
            other => Self::Other(other.to_owned()),
        })
    }
}

/// What kind of credential a secret is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SecretKind {
    /// Bring-your-own-key model provider API key.
    ApiKey,
    /// OAuth access token (e.g. from the loopback redirect flow).
    AccessToken,
    /// OAuth refresh token.
    RefreshToken,
}

impl SecretKind {
    /// Stable slug used in storage keys.
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            Self::ApiKey => "api-key",
            Self::AccessToken => "access-token",
            Self::RefreshToken => "refresh-token",
        }
    }
}

/// Identifies one secret: provider + kind. Contains no secret material.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SecretKey {
    /// Owning service.
    pub provider: Provider,
    /// Credential type.
    pub kind: SecretKind,
}

impl SecretKey {
    /// Build a key.
    #[must_use]
    pub fn new(provider: Provider, kind: SecretKind) -> Self {
        Self { provider, kind }
    }

    /// BYOK API key for a model provider.
    #[must_use]
    pub fn api_key(provider: Provider) -> Self {
        Self::new(provider, SecretKind::ApiKey)
    }

    /// OAuth/integration access token.
    #[must_use]
    pub fn access_token(provider: Provider) -> Self {
        Self::new(provider, SecretKind::AccessToken)
    }

    /// Flat string form, e.g. `anthropic/api-key`.
    #[must_use]
    pub fn as_path(&self) -> String {
        format!("{}/{}", self.provider.slug(), self.kind.slug())
    }
}

impl fmt::Display for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_path())
    }
}

/// Backing store for secrets. Implementations must never write plaintext to disk.
pub trait SecretStore: Send + Sync + fmt::Debug {
    /// Store (or overwrite) a secret.
    ///
    /// # Errors
    /// Fails if the backend rejects the write.
    fn set(&self, key: &SecretKey, value: SecretString) -> Result<()>;

    /// Fetch a secret, or `None` if absent.
    ///
    /// # Errors
    /// Fails on backend errors (not on absence).
    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>>;

    /// Delete a secret. Returns whether something was removed.
    ///
    /// # Errors
    /// Fails on backend errors.
    fn delete(&self, key: &SecretKey) -> Result<bool>;
}

/// Non-persistent store for tests and ephemeral/headless use.
#[derive(Default)]
pub struct MemorySecretStore {
    inner: Mutex<BTreeMap<SecretKey, SecretString>>,
}

impl MemorySecretStore {
    /// Empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<SecretKey, SecretString>>> {
        self.inner
            .lock()
            .map_err(|_| Error::Invalid("secret store lock poisoned".into()))
    }
}

impl fmt::Debug for MemorySecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let n = self.inner.lock().map_or(0, |m| m.len());
        write!(
            f,
            "MemorySecretStore {{ entries: {n}, values: [REDACTED] }}"
        )
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, key: &SecretKey, value: SecretString) -> Result<()> {
        self.lock()?.insert(key.clone(), value);
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>> {
        use secrecy::ExposeSecret;
        Ok(self
            .lock()?
            .get(key)
            .map(|s| SecretString::from(s.expose_secret().to_owned())))
    }

    fn delete(&self, key: &SecretKey) -> Result<bool> {
        Ok(self.lock()?.remove(key).is_some())
    }
}

/// Mask a secret-looking string for logs: keeps nothing but its length class.
#[must_use]
pub fn redact(s: &str) -> String {
    if s.is_empty() {
        String::new()
    } else {
        "[REDACTED]".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    fn secret(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    #[test]
    fn roundtrip_and_delete() {
        let store = MemorySecretStore::new();
        let k = SecretKey::api_key(Provider::Anthropic);
        assert!(store.get(&k).unwrap().is_none());
        store.set(&k, secret("sk-ant-123")).unwrap();
        assert_eq!(
            store.get(&k).unwrap().unwrap().expose_secret(),
            "sk-ant-123"
        );
        assert!(store.delete(&k).unwrap());
        assert!(!store.delete(&k).unwrap());
    }

    #[test]
    fn debug_never_leaks_value() {
        let store = MemorySecretStore::new();
        let k = SecretKey::access_token(Provider::GitHub);
        store.set(&k, secret("ghp_supersecret")).unwrap();
        let v = store.get(&k).unwrap().unwrap();
        assert!(!format!("{v:?}").contains("supersecret"));
        assert!(!format!("{store:?}").contains("supersecret"));
        assert!(!redact("ghp_supersecret").contains("supersecret"));
    }

    #[test]
    fn key_paths_and_slugs() {
        assert_eq!(
            SecretKey::api_key(Provider::OpenAi).as_path(),
            "openai/api-key"
        );
        assert_eq!(Provider::from_slug("jira").unwrap(), Provider::Jira);
        assert_eq!(
            Provider::from_slug("linear").unwrap(),
            Provider::Other("linear".into())
        );
        assert!(Provider::from_slug("Bad Slug").is_err());
        assert!(Provider::from_slug("").is_err());
    }
}
