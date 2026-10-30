//! Authenticated encryption helpers, ported from `lib/encryption.ts` / `encryption.service.ts`.
//!
//! TS used AES-256-GCM with a key from HKDF-SHA256(secret, salt `nyx-salt`, info = purpose).
//! The Rust tree already ships `ChaCha20-Poly1305` (see `profile::EncryptedFileSecretStore`), so
//! this module uses the same AEAD and keeps the HKDF key-derivation shape and the *separate
//! `info` context per purpose* (`nyx-integration-encryption` vs `nyx-byok-encryption`).
//!
//! Wire format: `nyx1:` + base64( nonce(12) || ciphertext || tag(16) ). Fresh random nonce per
//! call. Optional associated data binds a ciphertext to its row/purpose so blobs cannot be
//! swapped between records.
//!
//! Not wire-compatible with TS blobs (different AEAD). Migrating legacy rows needs the old
//! `ENCRYPTION_SECRET` and an AES-GCM reader; deliberately out of scope (no data to migrate in
//! the local-first app; see docs/rust-core/security.md).

use std::fmt;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

const PREFIX: &str = "nyx1:";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Salt used by the TS implementation; kept so the derivation shape is identical.
const HKDF_SALT: &[u8] = b"nyx-salt";
/// Purpose label for integration tokens (TS `nyx-integration-encryption`).
pub const CONTEXT_INTEGRATION: &str = "nyx-integration-encryption";
/// Purpose label for user-supplied model keys (TS `nyx-byok-encryption`).
pub const CONTEXT_BYOK: &str = "nyx-byok-encryption";

/// A 256-bit key. Zeroised on drop; `Debug` never prints material.
pub struct EncryptionKey([u8; 32]);

impl fmt::Debug for EncryptionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EncryptionKey([REDACTED])")
    }
}

impl Drop for EncryptionKey {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

fn err(msg: &str) -> Error {
    Error::Invalid(format!("crypto: {msg}"))
}

fn hmac_sha256(key: &[u8], data: &[&[u8]]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    for d in data {
        inner.update(d);
    }
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(ih);
    outer.finalize().into()
}

/// HKDF-SHA256 (RFC 5869). `out.len()` must be <= 255 * 32.
fn hkdf_sha256(salt: &[u8], ikm: &[u8], info: &[u8], out: &mut [u8]) {
    let prk = hmac_sha256(salt, &[ikm]);
    let mut t: Vec<u8> = Vec::new();
    let mut written = 0;
    let mut counter = 1u8;
    while written < out.len() {
        let block = hmac_sha256(&prk, &[&t, info, &[counter]]);
        let n = (out.len() - written).min(32);
        out[written..written + n].copy_from_slice(&block[..n]);
        written += n;
        t = block.to_vec();
        counter += 1;
    }
}

impl EncryptionKey {
    /// Derive a key from a high-entropy secret (env/keychain value). For human passphrases use
    /// Argon2 (`profile::EncryptedFileSecretStore`) instead; HKDF is not a password hash.
    pub fn derive(secret: &[u8], context: &str) -> Result<Self> {
        if secret.len() < 16 {
            return Err(err("secret must be at least 16 bytes"));
        }
        if context.is_empty() {
            return Err(err("context must not be empty"));
        }
        let mut k = [0u8; 32];
        hkdf_sha256(HKDF_SALT, secret, context.as_bytes(), &mut k);
        Ok(Self(k))
    }

    /// Fresh random key (store it in the OS keychain).
    pub fn generate() -> Result<Self> {
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).map_err(|_| err("rng failure"))?;
        Ok(Self(k))
    }

    /// Wrap raw key bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Encrypt `plaintext`, binding `aad`. Returns the `nyx1:` envelope.
pub fn seal(key: &EncryptionKey, plaintext: &[u8], aad: &[u8]) -> Result<String> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| err("rng failure"))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key.0));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| err("encryption failed"))?;
    let mut packed = Vec::with_capacity(NONCE_LEN + ct.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ct);
    Ok(format!("{PREFIX}{}", B64.encode(packed)))
}

/// Decrypt a `nyx1:` envelope. All failures (bad prefix, truncation, wrong key/aad, tamper) yield
/// the same generic error so callers cannot build an oracle.
pub fn open(key: &EncryptionKey, envelope: &str, aad: &[u8]) -> Result<Vec<u8>> {
    let fail = || err("decryption failed");
    let body = envelope.strip_prefix(PREFIX).ok_or_else(fail)?;
    let packed = B64.decode(body).map_err(|_| fail())?;
    if packed.len() < NONCE_LEN + TAG_LEN {
        return Err(fail());
    }
    let (nonce, ct) = packed.split_at(NONCE_LEN);
    ChaCha20Poly1305::new(Key::from_slice(&key.0))
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| fail())
}

/// Verify a hex HMAC-SHA256 signature (optionally `sha256=`-prefixed, GitHub style) in constant
/// time. Port of the always-on webhook signature check (#260); any inbound callback the app ever
/// accepts must pass through this.
#[must_use]
pub fn verify_hmac_sha256_hex(secret: &[u8], payload: &[u8], signature: &str) -> bool {
    let sig = signature
        .trim()
        .strip_prefix("sha256=")
        .unwrap_or_else(|| signature.trim());
    let Ok(given) = hex::decode(sig) else {
        return false;
    };
    let expected = hmac_sha256(secret, &[payload]);
    if given.len() != expected.len() {
        return false;
    }
    given
        .iter()
        .zip(expected.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// [`seal`] for UTF-8 strings.
pub fn seal_str(key: &EncryptionKey, plaintext: &str, aad: &str) -> Result<String> {
    seal(key, plaintext.as_bytes(), aad.as_bytes())
}

/// [`open`] for UTF-8 strings.
pub fn open_str(key: &EncryptionKey, envelope: &str, aad: &str) -> Result<String> {
    String::from_utf8(open(key, envelope, aad.as_bytes())?).map_err(|_| err("decryption failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(ctx: &str) -> EncryptionKey {
        EncryptionKey::derive(b"0123456789abcdef0123", ctx).unwrap()
    }

    #[test]
    fn hkdf_rfc5869_case_1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let mut okm = [0u8; 42];
        hkdf_sha256(&salt, &ikm, &info, &mut okm);
        assert_eq!(
            hex::encode(okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn hmac_rfc4231_case_2_and_verify() {
        let sig = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        let data = b"what do ya want for nothing?";
        assert_eq!(hex::encode(hmac_sha256(b"Jefe", &[data])), sig);
        assert!(verify_hmac_sha256_hex(b"Jefe", data, sig));
        assert!(verify_hmac_sha256_hex(
            b"Jefe",
            data,
            &format!("sha256={sig}")
        ));
        assert!(!verify_hmac_sha256_hex(b"Jefe", b"tampered", sig));
        assert!(!verify_hmac_sha256_hex(b"other", data, sig));
        assert!(!verify_hmac_sha256_hex(b"Jefe", data, "zz"));
        assert!(!verify_hmac_sha256_hex(b"Jefe", data, ""));
        assert!(!verify_hmac_sha256_hex(b"Jefe", data, &sig[..62]));
    }

    #[test]
    fn roundtrip_and_fresh_nonce() {
        let k = key(CONTEXT_BYOK);
        let a = seal_str(&k, "sk-ant-test-value", "row:1").unwrap();
        let b = seal_str(&k, "sk-ant-test-value", "row:1").unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("nyx1:"));
        assert!(!a.contains("sk-ant"));
        assert_eq!(open_str(&k, &a, "row:1").unwrap(), "sk-ant-test-value");
        assert_eq!(
            open_str(&k, &seal_str(&k, "", "").unwrap(), "").unwrap(),
            ""
        );
    }

    #[test]
    fn wrong_key_context_aad_and_tamper_fail() {
        let k = key(CONTEXT_BYOK);
        let env = seal_str(&k, "secret", "row:1").unwrap();
        assert!(open_str(&key(CONTEXT_INTEGRATION), &env, "row:1").is_err());
        assert!(open_str(
            &EncryptionKey::derive(b"another-secret-value-xx", CONTEXT_BYOK).unwrap(),
            &env,
            "row:1"
        )
        .is_err());
        assert!(open_str(&k, &env, "row:2").is_err());

        let mut raw = B64.decode(env.strip_prefix("nyx1:").unwrap()).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(open(&k, &format!("nyx1:{}", B64.encode(&raw)), b"row:1").is_err());
        raw[last] ^= 1;
        raw[0] ^= 1; // nonce
        assert!(open(&k, &format!("nyx1:{}", B64.encode(&raw)), b"row:1").is_err());
    }

    #[test]
    fn malformed_envelopes() {
        let k = key("c");
        for bad in [
            "",
            "nyx1:",
            "nyx1:AAAA",
            "v2:AAAA",
            "nyx1:!!!!",
            "plain text",
        ] {
            let e = open(&k, bad, b"").unwrap_err().to_string();
            assert_eq!(e, "invalid input: crypto: decryption failed", "{bad}");
        }
    }

    #[test]
    fn derive_validations_and_debug() {
        assert!(EncryptionKey::derive(b"short", "c").is_err());
        assert!(EncryptionKey::derive(b"0123456789abcdef", "").is_err());
        assert!(!format!("{:?}", key("c")).contains('0'));
        let g1 = EncryptionKey::generate().unwrap();
        let g2 = EncryptionKey::generate().unwrap();
        assert_ne!(g1.0, g2.0);
        let env = seal(&g1, b"x", b"").unwrap();
        assert!(open(&g2, &env, b"").is_err());
    }
}
