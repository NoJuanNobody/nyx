//! Local single-user profile and secret storage. Replaces hosted (Clerk) auth.
//!
//! The profile (id, display name, creation time) is plain JSON in the OS
//! app-data directory. Anything sensitive (BYOK model keys, integration
//! tokens) goes through a [`SecretStore`]: the OS keychain by default,
//! an encrypted file for headless/CI. See `docs/auth-local-profile.md`.

mod encrypted_file;
mod keychain;
mod secrets;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub use encrypted_file::EncryptedFileSecretStore;
pub use keychain::{KeychainSecretStore, DEFAULT_SERVICE};
pub use secrets::{redact, MemorySecretStore, Provider, SecretKey, SecretKind, SecretStore};

use crate::{Error, Result};

const PROFILE_FILE: &str = "profile.json";

/// The single local user. Contains no secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Random 128-bit hex id, stable for the life of the profile.
    pub id: String,
    /// Name shown in the UI.
    pub display_name: String,
    /// Creation time, RFC 3339 (UTC).
    pub created_at: String,
    /// Clerk user id this profile was migrated from, if any (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_clerk_id: Option<String>,
}

impl Profile {
    /// Create a fresh profile.
    ///
    /// # Errors
    /// Fails on an empty name or if the OS RNG/clock is unavailable.
    pub fn new(display_name: &str) -> Result<Self> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(Error::Invalid("display name must not be empty".into()));
        }
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).map_err(|e| Error::Invalid(e.to_string()))?;
        let id = b.iter().fold(String::with_capacity(32), |mut s, x| {
            let _ = write!(s, "{x:02x}");
            s
        });
        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        Ok(Self {
            id,
            display_name: display_name.to_owned(),
            created_at,
            legacy_clerk_id: None,
        })
    }

    /// Create a profile from a legacy Clerk user (name only; email is dropped).
    ///
    /// # Errors
    /// Same as [`Profile::new`].
    pub fn from_legacy_clerk(clerk_id: &str, name: &str) -> Result<Self> {
        let mut p = Self::new(name)?;
        p.legacy_clerk_id = Some(clerk_id.to_owned());
        Ok(p)
    }
}

/// Reads/writes the profile JSON in a directory.
#[derive(Debug, Clone)]
pub struct ProfileStore {
    dir: PathBuf,
}

impl ProfileStore {
    /// Use an explicit directory (tests, portable installs).
    #[must_use]
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Use the OS app-data directory (e.g. `~/Library/Application Support/Nyx`).
    ///
    /// # Errors
    /// Fails if no home directory can be determined.
    pub fn default_location() -> Result<Self> {
        let dirs = ProjectDirs::from("dev", "nyx", "Nyx")
            .ok_or_else(|| Error::Invalid("cannot determine app data directory".into()))?;
        Ok(Self::at(dirs.data_dir()))
    }

    /// Directory holding the profile.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self) -> PathBuf {
        self.dir.join(PROFILE_FILE)
    }

    /// Load the profile, if one exists.
    ///
    /// # Errors
    /// Fails on I/O errors or a corrupt file.
    pub fn load(&self) -> Result<Option<Profile>> {
        match std::fs::read(self.file()) {
            Ok(raw) => serde_json::from_slice(&raw)
                .map(Some)
                .map_err(|e| Error::Invalid(format!("corrupt profile: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Persist the profile atomically.
    ///
    /// # Errors
    /// Fails on I/O errors.
    pub fn save(&self, profile: &Profile) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join("profile.json.tmp");
        let json = serde_json::to_vec_pretty(profile).map_err(|e| Error::Invalid(e.to_string()))?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, self.file())?;
        Ok(())
    }

    /// Load the existing profile or create one with `display_name`.
    ///
    /// # Errors
    /// Fails on I/O errors, a corrupt file, or an invalid name.
    pub fn load_or_create(&self, display_name: &str) -> Result<Profile> {
        if let Some(p) = self.load()? {
            return Ok(p);
        }
        let p = Profile::new(display_name)?;
        self.save(&p)?;
        Ok(p)
    }
}

/// Convenience facade over a [`SecretStore`] for the common BYOK/token flows.
#[derive(Debug)]
pub struct Secrets<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> Secrets<S> {
    /// Wrap a store.
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// Save a BYOK model-provider API key.
    ///
    /// # Errors
    /// Backend failure.
    pub fn set_api_key(&self, provider: Provider, key: secrecy::SecretString) -> Result<()> {
        self.store.set(&SecretKey::api_key(provider), key)
    }

    /// Fetch a BYOK model-provider API key.
    ///
    /// # Errors
    /// Backend failure.
    pub fn api_key(&self, provider: Provider) -> Result<Option<secrecy::SecretString>> {
        self.store.get(&SecretKey::api_key(provider))
    }

    /// Save an integration access token (GitHub, Jira, Slack, ...).
    ///
    /// # Errors
    /// Backend failure.
    pub fn set_token(&self, provider: Provider, token: secrecy::SecretString) -> Result<()> {
        self.store.set(&SecretKey::access_token(provider), token)
    }

    /// Fetch an integration access token.
    ///
    /// # Errors
    /// Backend failure.
    pub fn token(&self, provider: Provider) -> Result<Option<secrecy::SecretString>> {
        self.store.get(&SecretKey::access_token(provider))
    }

    /// Remove every credential held for `provider`; returns how many were removed.
    ///
    /// # Errors
    /// Backend failure.
    pub fn forget_provider(&self, provider: &Provider) -> Result<usize> {
        let mut n = 0;
        for kind in [
            SecretKind::ApiKey,
            SecretKind::AccessToken,
            SecretKind::RefreshToken,
        ] {
            if self.store.delete(&SecretKey::new(provider.clone(), kind))? {
                n += 1;
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::{ExposeSecret, SecretString};

    #[test]
    fn profile_create_load_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::at(dir.path().join("nested"));
        assert!(store.load().unwrap().is_none());
        let p = store.load_or_create("  Ada ").unwrap();
        assert_eq!(p.display_name, "Ada");
        assert_eq!(p.id.len(), 32);
        assert!(p.created_at.ends_with('Z'));
        // second call returns the same profile, ignoring the new name
        assert_eq!(store.load_or_create("Bob").unwrap(), p);
    }

    #[test]
    fn rejects_empty_name_and_corrupt_file() {
        assert!(Profile::new("   ").is_err());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PROFILE_FILE), b"{nope").unwrap();
        assert!(ProfileStore::at(dir.path()).load().is_err());
    }

    #[test]
    fn legacy_clerk_id_recorded_and_no_email() {
        let p = Profile::from_legacy_clerk("user_123", "Ada").unwrap();
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("user_123"));
        assert!(!json.contains('@'));
    }

    #[test]
    fn secrets_facade_with_memory_store() {
        let s = Secrets::new(MemorySecretStore::new());
        s.set_api_key(Provider::Anthropic, SecretString::from("k1".to_owned()))
            .unwrap();
        s.set_token(Provider::Anthropic, SecretString::from("t1".to_owned()))
            .unwrap();
        assert_eq!(
            s.api_key(Provider::Anthropic)
                .unwrap()
                .unwrap()
                .expose_secret(),
            "k1"
        );
        assert!(s.token(Provider::GitHub).unwrap().is_none());
        assert_eq!(s.forget_provider(&Provider::Anthropic).unwrap(), 2);
        assert!(s.api_key(Provider::Anthropic).unwrap().is_none());
    }
}
