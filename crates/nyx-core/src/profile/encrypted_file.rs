//! Passphrase-encrypted file [`SecretStore`] for headless/CI environments
//! where no OS keychain exists. Argon2id derives a key from the passphrase;
//! `ChaCha20-Poly1305` encrypts the whole secret map. No plaintext hits disk.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::secrets::{SecretKey, SecretStore};
use crate::{Error, Result};

const VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// Encrypted-at-rest secret file.
pub struct EncryptedFileSecretStore {
    path: PathBuf,
    passphrase: SecretString,
    lock: Mutex<()>,
}

impl fmt::Debug for EncryptedFileSecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptedFileSecretStore")
            .field("path", &self.path)
            .field("passphrase", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

fn crypto(msg: &str) -> Error {
    Error::Invalid(format!("encrypted secret file: {msg}"))
}

fn derive(passphrase: &SecretString, salt: &[u8]) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.expose_secret().as_bytes(), salt, &mut out)
        .map_err(|e| crypto(&e.to_string()))?;
    Ok(out)
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|e| crypto(&e.to_string()))?;
    Ok(b)
}

impl EncryptedFileSecretStore {
    /// Open (or lazily create on first write) an encrypted store at `path`.
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, passphrase: SecretString) -> Self {
        Self {
            path: path.into(),
            passphrase,
            lock: Mutex::new(()),
        }
    }

    /// File location.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> Result<BTreeMap<String, String>> {
        let raw = match std::fs::read(&self.path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(e.into()),
        };
        let env: Envelope = serde_json::from_slice(&raw).map_err(|e| crypto(&e.to_string()))?;
        if env.version != VERSION {
            return Err(crypto("unsupported version"));
        }
        let dec = |s: &str| B64.decode(s).map_err(|e| crypto(&e.to_string()));
        let (salt, nonce, ct) = (dec(&env.salt)?, dec(&env.nonce)?, dec(&env.ciphertext)?);
        if nonce.len() != 12 {
            return Err(crypto("bad nonce"));
        }
        let mut key = derive(&self.passphrase, &salt)?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        key.zeroize();
        let mut plain = cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .map_err(|_| crypto("wrong passphrase or corrupted file"))?;
        let map = serde_json::from_slice(&plain).map_err(|e| crypto(&e.to_string()));
        plain.zeroize();
        map
    }

    fn save(&self, map: &BTreeMap<String, String>) -> Result<()> {
        let mut plain = serde_json::to_vec(map).map_err(|e| crypto(&e.to_string()))?;
        let salt = random::<16>()?;
        let nonce = random::<12>()?;
        let mut key = derive(&self.passphrase, &salt)?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        key.zeroize();
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
            .map_err(|_| crypto("encryption failed"))?;
        plain.zeroize();
        let env = Envelope {
            version: VERSION,
            salt: B64.encode(salt),
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ct),
        };
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec(&env).map_err(|e| crypto(&e.to_string()))?,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.lock.lock().map_err(|_| crypto("lock poisoned"))
    }
}

impl SecretStore for EncryptedFileSecretStore {
    fn set(&self, key: &SecretKey, value: SecretString) -> Result<()> {
        let _g = self.guard()?;
        let mut map = self.load()?;
        map.insert(key.as_path(), value.expose_secret().to_owned());
        self.save(&map)
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>> {
        let _g = self.guard()?;
        Ok(self.load()?.remove(&key.as_path()).map(SecretString::from))
    }

    fn delete(&self, key: &SecretKey) -> Result<bool> {
        let _g = self.guard()?;
        let mut map = self.load()?;
        let removed = map.remove(&key.as_path()).is_some();
        if removed {
            self.save(&map)?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::secrets::Provider;

    fn pw(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    #[test]
    fn roundtrip_no_plaintext_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        let store = EncryptedFileSecretStore::new(&path, pw("hunter2"));
        let k = SecretKey::api_key(Provider::Anthropic);
        store.set(&k, pw("sk-ant-PLAINTEXT")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("PLAINTEXT") && !raw.contains("anthropic"));
        let again = EncryptedFileSecretStore::new(&path, pw("hunter2"));
        assert_eq!(
            again.get(&k).unwrap().unwrap().expose_secret(),
            "sk-ant-PLAINTEXT"
        );
        assert!(again.delete(&k).unwrap());
        assert!(again.get(&k).unwrap().is_none());
    }

    #[test]
    fn wrong_passphrase_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        let k = SecretKey::access_token(Provider::Slack);
        EncryptedFileSecretStore::new(&path, pw("right"))
            .set(&k, pw("xoxb"))
            .unwrap();
        assert!(EncryptedFileSecretStore::new(&path, pw("wrong"))
            .get(&k)
            .is_err());
    }

    #[test]
    fn debug_redacts_passphrase() {
        let s = EncryptedFileSecretStore::new("/x", pw("topsecret"));
        assert!(!format!("{s:?}").contains("topsecret"));
    }
}
