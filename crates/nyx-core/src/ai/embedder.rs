//! The one [`Embedder`] trait of the core, with its offline and HTTP implementations.
//!
//! - [`Embedder`]: turns text into vectors. Used by `scan` (code indexing) and `sync` (document
//!   retrieval, drift matching). Failures are [`EmbedError`], split into transient (retry later)
//!   and permanent.
//! - [`HashingEmbedder`]: deterministic, offline feature-hashing embedder. Lexical, not semantic,
//!   but needs no key and no network, so retrieval works out of the box and tests are stable.
//! - [`HttpEmbedder`]: OpenAI-compatible `/embeddings` endpoint over the unified
//!   [`crate::net::HttpTransport`]. [`build_embeddings_request`] and
//!   [`parse_embeddings_response`] are pure and covered by fixtures in `src/ai/fixtures/`; the
//!   only I/O is the injected transport.
//!
//! `scan::embed` adds the batching / dedupe / cache pipeline ([`crate::scan::embed_texts`]) and
//! the scripted `FakeEmbedder` on top of this trait.

use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

use crate::error::Error;
use crate::net::{HttpMethod, HttpRequest, HttpTransport, NetError};

/// Default OpenAI-compatible embedding model (1536 dimensions, as in the TS).
pub const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
/// Texts per embedding request (TS `EMBEDDING_BATCH_SIZE`).
pub const DEFAULT_BATCH_SIZE: usize = 50;

/// Embedding failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EmbedError {
    /// Worth retrying later: rate limit, 5xx, network.
    #[error("transient embedding failure: {0}")]
    Transient(String),
    /// Retrying will not help: bad key, malformed response, wrong shape.
    #[error("embedding failure: {0}")]
    Permanent(String),
}

impl EmbedError {
    /// True when a retry may succeed.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Transient(_))
    }
}

impl From<EmbedError> for Error {
    fn from(e: EmbedError) -> Self {
        Self::Invalid(e.to_string())
    }
}

impl From<Error> for EmbedError {
    fn from(e: Error) -> Self {
        Self::Permanent(e.to_string())
    }
}

/// Turns text into vectors.
pub trait Embedder: Send + Sync {
    /// Model name recorded with every stored vector.
    fn model(&self) -> &str;
    /// Largest batch the provider accepts per call.
    fn max_batch(&self) -> usize {
        DEFAULT_BATCH_SIZE
    }
    /// One vector per input, same order.
    ///
    /// # Errors
    /// [`EmbedError`].
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError>;
}

// ---------------------------------------------------------------- hashing (offline)

/// Deterministic, offline feature-hashing embedder: lowercase word unigrams hashed (FNV-1a) into
/// `dim` signed buckets and L2-normalised.
#[derive(Debug, Clone)]
pub struct HashingEmbedder {
    dim: usize,
    model: String,
}

impl HashingEmbedder {
    /// New embedder; `dim` is clamped to at least 8.
    #[must_use]
    pub fn new(dim: usize) -> Self {
        let dim = dim.max(8);
        Self {
            dim,
            model: format!("nyx-hashing-{dim}"),
        }
    }
}

impl Default for HashingEmbedder {
    fn default() -> Self {
        Self::new(256)
    }
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Lowercase alphanumeric words of length >= 2 (stop words included).
pub(crate) fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.chars().count() >= 2)
        .map(str::to_lowercase)
        .collect()
}

impl Embedder for HashingEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(texts
            .iter()
            .map(|t| {
                let mut v = vec![0.0_f32; self.dim];
                for tok in tokens(t) {
                    let h = fnv1a(&tok);
                    let idx = usize::try_from(h % self.dim as u64).unwrap_or(0);
                    v[idx] += if (h >> 63) & 1 == 0 { 1.0 } else { -1.0 };
                }
                let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if n > 0.0 {
                    for x in &mut v {
                        *x /= n;
                    }
                }
                v
            })
            .collect())
    }
}

// ---------------------------------------------------------------- OpenAI-compatible HTTP

/// Build the `/v1/embeddings` request (pure).
#[must_use]
pub fn build_embeddings_request(
    base_url: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> HttpRequest {
    HttpRequest::new(
        HttpMethod::Post,
        format!("{}/embeddings", base_url.trim_end_matches('/')),
    )
    .header("authorization", format!("Bearer {api_key}"))
    .json(&json!({"model": model, "input": texts}))
    .with_timeout(60)
}

/// Parse an embeddings response: `data[].{index, embedding}`, returned in input order (the TS
/// sorted by `index`). Validates the count and a uniform finite dimension.
///
/// # Errors
/// [`EmbedError::Permanent`] when the body is not a well-formed embeddings response.
pub fn parse_embeddings_response(body: &str, expected: usize) -> Result<Vec<Vec<f32>>, EmbedError> {
    let bad = |m: &str| EmbedError::Permanent(format!("unreadable embeddings response: {m}"));
    let v: Value = serde_json::from_str(body).map_err(|e| bad(&e.to_string()))?;
    let data = v
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("missing `data`"))?;
    let mut rows: Vec<(u64, Vec<f32>)> = Vec::with_capacity(data.len());
    for (pos, item) in data.iter().enumerate() {
        let idx = item
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(pos as u64);
        let emb = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("missing `embedding`"))?;
        let vec: Option<Vec<f32>> = emb.iter().map(|n| n.as_f64().map(|f| f as f32)).collect();
        let vec = vec.ok_or_else(|| bad("non-numeric embedding"))?;
        rows.push((idx, vec));
    }
    rows.sort_by_key(|(i, _)| *i);
    if rows.len() != expected {
        return Err(bad(&format!(
            "expected {expected} vectors, got {}",
            rows.len()
        )));
    }
    let out: Vec<Vec<f32>> = rows.into_iter().map(|(_, v)| v).collect();
    validate_vectors(&out)?;
    Ok(out)
}

/// [`Embedder`] for an OpenAI-compatible embeddings endpoint over an injected transport.
/// The key is held as a secret and never printed.
pub struct HttpEmbedder {
    transport: Arc<dyn HttpTransport>,
    base_url: String,
    api_key: SecretString,
    model: String,
}

impl HttpEmbedder {
    /// `base_url` like `https://api.openai.com/v1`.
    #[must_use]
    pub fn new(
        transport: Arc<dyn HttpTransport>,
        base_url: &str,
        api_key: SecretString,
        model: &str,
    ) -> Self {
        Self {
            transport,
            base_url: base_url.to_string(),
            api_key,
            model: model.to_string(),
        }
    }
}

impl Embedder for HttpEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn max_batch(&self) -> usize {
        // OpenAI accepts up to 2048 inputs; keep the TS batch size to bound payloads.
        DEFAULT_BATCH_SIZE
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let req = build_embeddings_request(
            &self.base_url,
            self.api_key.expose_secret(),
            &self.model,
            texts,
        );
        let resp = self.transport.send(&req).map_err(|e| match e {
            NetError::Transport(m) => EmbedError::Transient(m),
            other => EmbedError::Permanent(other.to_string()),
        })?;
        if !resp.is_success() {
            let snippet: String = resp.text().chars().take(200).collect();
            let msg = format!("HTTP {}: {snippet}", resp.status);
            return Err(if resp.status == 429 || resp.status >= 500 {
                EmbedError::Transient(msg)
            } else {
                EmbedError::Permanent(msg)
            });
        }
        parse_embeddings_response(&resp.text(), texts.len())
    }
}

/// Reject ragged, empty or non-finite vectors.
///
/// # Errors
/// [`EmbedError::Permanent`].
pub fn validate_vectors(v: &[Vec<f32>]) -> Result<(), EmbedError> {
    let dim = v.first().map_or(0, Vec::len);
    if v.iter().any(|x| x.len() != dim || x.is_empty()) {
        return Err(EmbedError::Permanent(
            "embeddings have inconsistent or zero dimension".into(),
        ));
    }
    if v.iter().flatten().any(|x| !x.is_finite()) {
        return Err(EmbedError::Permanent(
            "embedding contains NaN or infinity".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::net::FakeTransport;

    const OK: &str = include_str!("fixtures/embeddings_ok.json");
    const RAGGED: &str = include_str!("fixtures/embeddings_ragged.json");
    const ERR: &str = include_str!("fixtures/embeddings_error.json");

    fn texts(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn hashing_is_deterministic_unit_length_and_lexical() {
        let e = HashingEmbedder::new(64);
        let v = e
            .embed(&texts(&[
                "the parser reads tokens",
                "the parser reads tokens",
                "zebra",
            ]))
            .unwrap();
        assert_eq!(v[0], v[1]);
        assert_ne!(v[0], v[2]);
        let n: f32 = v[0].iter().map(|x| x * x).sum();
        assert!((n - 1.0).abs() < 1e-4);
        assert_eq!(e.model(), "nyx-hashing-64");
        assert_eq!(
            HashingEmbedder::new(1).embed(&texts(&["x"])).unwrap()[0].len(),
            8
        );
    }

    #[test]
    fn request_is_openai_shaped_and_redacted() {
        let r = build_embeddings_request("https://x/v1/", "k", "m", &texts(&["a"]));
        assert_eq!(r.url, "https://x/v1/embeddings");
        assert_eq!(r.method, HttpMethod::Post);
        assert_eq!(r.header_value("authorization"), Some("Bearer k"));
        assert_eq!(r.timeout_secs, Some(60));
        let body: Value = serde_json::from_slice(r.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["model"], "m");
        assert_eq!(body["input"][0], "a");
        assert!(!format!("{r:?}").contains("Bearer k"));
    }

    #[test]
    fn response_fixtures_parse_in_index_order_and_reject_bad_shapes() {
        let v = parse_embeddings_response(OK, 2).unwrap();
        assert_eq!(v, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        assert!(parse_embeddings_response(OK, 3).is_err());
        assert!(parse_embeddings_response("nope", 1).is_err());
        assert!(parse_embeddings_response(RAGGED, 2).is_err());
        assert!(parse_embeddings_response(ERR, 1).is_err());
    }

    #[test]
    fn http_embedder_classifies_errors() {
        let t = Arc::new(FakeTransport::new());
        t.push_text(200, r#"{"data":[{"index":0,"embedding":[0.5,0.5]}]}"#);
        t.push_text(429, "slow down");
        t.push_text(401, ERR);
        t.push_error("connection reset");
        let e = HttpEmbedder::new(
            t.clone(),
            "https://x/v1",
            SecretString::from("sk".to_string()),
            "m",
        );
        assert_eq!(e.embed(&texts(&["a"])).unwrap(), vec![vec![0.5, 0.5]]);
        assert!(e.embed(&texts(&["a"])).unwrap_err().is_transient());
        assert!(!e.embed(&texts(&["a"])).unwrap_err().is_transient());
        assert!(e.embed(&texts(&["a"])).unwrap_err().is_transient());
        assert_eq!(e.embed(&[]).unwrap(), Vec::<Vec<f32>>::new());
        assert_eq!(t.requests().len(), 4);
    }
}
