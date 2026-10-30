//! OS keychain-backed [`SecretStore`] (macOS Keychain, Windows Credential
//! Manager, Linux kernel keyutils) via the `keyring` crate.

use secrecy::{ExposeSecret, SecretString};

use super::secrets::{SecretKey, SecretStore};
use crate::{Error, Result};

/// Default keychain service name.
pub const DEFAULT_SERVICE: &str = "dev.nyx.desktop";

/// Secret store backed by the operating system keychain.
#[derive(Debug, Clone)]
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    /// Store under [`DEFAULT_SERVICE`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_service(DEFAULT_SERVICE)
    }

    /// Store under a custom service name (useful to isolate tests).
    #[must_use]
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &SecretKey) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &key.as_path()).map_err(|e| map_err(&e))
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

fn map_err(e: &keyring::Error) -> Error {
    Error::Invalid(format!("keychain: {e}"))
}

impl SecretStore for KeychainSecretStore {
    fn set(&self, key: &SecretKey, value: SecretString) -> Result<()> {
        self.entry(key)?
            .set_password(value.expose_secret())
            .map_err(|e| map_err(&e))
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>> {
        match self.entry(key)?.get_password() {
            Ok(p) => Ok(Some(SecretString::from(p))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_err(&e)),
        }
    }

    fn delete(&self, key: &SecretKey) -> Result<bool> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(map_err(&e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::secrets::Provider;

    /// Touches the real OS keychain; run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "touches the real OS keychain"]
    fn real_keychain_roundtrip() {
        let store = KeychainSecretStore::with_service("dev.nyx.desktop.test");
        let key = SecretKey::api_key(Provider::Other("nyx-test".into()));
        store
            .set(&key, SecretString::from("value-1".to_owned()))
            .unwrap();
        assert_eq!(store.get(&key).unwrap().unwrap().expose_secret(), "value-1");
        assert!(store.delete(&key).unwrap());
        assert!(store.get(&key).unwrap().is_none());
    }
}
