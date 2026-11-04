//! Embedding provider seam and the batching / dedupe pipeline.
//!
//! Ports `embedding.service.ts` (`OpenAI` `text-embedding-3-small`, one batched request) and the
//! batching loop of `code-embedding.service.ts` (`EMBEDDING_BATCH_SIZE = 50`).
//!
//! - [`Embedder`] is the core-wide provider trait, defined in [`crate::ai::embedder`] and
//!   re-exported here with [`HttpEmbedder`] (OpenAI-compatible `/embeddings` over the unified
//!   [`crate::net::HttpTransport`]). [`FakeEmbedder`] is deterministic (hash-derived unit
//!   vectors) with failure injection and batch recording. A real local model is out of scope.
//! - [`embed_texts`] deduplicates identical texts by SHA-256, serves repeats from the
//!   `embedding_cache` table (so re-indexing unchanged or moved code costs nothing) and sends only
//!   the remaining unique texts in batches. Each batch is cached as soon as it returns, so a
//!   failure part-way keeps the finished work.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use super::store;
pub use crate::ai::embedder::{
    build_embeddings_request, parse_embeddings_response, validate_vectors, EmbedError, Embedder,
    HttpEmbedder, DEFAULT_BATCH_SIZE, DEFAULT_EMBEDDING_MODEL,
};

/// SHA-256 hex of the text: the dedupe / cache key.
#[must_use]
pub fn content_hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

// ---------------------------------------------------------------- fake

/// Deterministic embedder for tests: the vector is derived from the SHA-256 of the text, so equal
/// texts embed equally and different texts (almost surely) differ. Records every batch.
pub struct FakeEmbedder {
    dim: usize,
    model: String,
    max_batch: usize,
    state: Mutex<FakeState>,
}

#[derive(Default)]
struct FakeState {
    batches: Vec<Vec<String>>,
    fail_next: Vec<EmbedError>,
    fail_containing: Option<(String, EmbedError)>,
}

impl fmt::Debug for FakeEmbedder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FakeEmbedder {{ dim: {} }}", self.dim)
    }
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self::new(8)
    }
}

impl FakeEmbedder {
    /// Embedder with `dim` dimensions (min 1).
    #[must_use]
    pub fn new(dim: usize) -> Self {
        Self {
            dim: dim.max(1),
            model: "fake-embed".into(),
            max_batch: DEFAULT_BATCH_SIZE,
            state: Mutex::new(FakeState::default()),
        }
    }

    /// Set the per-call batch limit.
    #[must_use]
    pub fn with_max_batch(mut self, n: usize) -> Self {
        self.max_batch = n.max(1);
        self
    }

    fn st(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The next `embed` call fails with `err` (queued FIFO, one per call).
    pub fn fail_next(&self, err: EmbedError) {
        self.st().fail_next.push(err);
    }

    /// Any batch containing a text with `needle` fails with `err` until cleared.
    pub fn fail_when_containing(&self, needle: &str, err: EmbedError) {
        self.st().fail_containing = Some((needle.to_string(), err));
    }

    /// Stop failing on `needle`.
    pub fn clear_failures(&self) {
        let mut s = self.st();
        s.fail_next.clear();
        s.fail_containing = None;
    }

    /// Texts of every successful or failed call, in order.
    #[must_use]
    pub fn batches(&self) -> Vec<Vec<String>> {
        self.st().batches.clone()
    }

    /// Total texts sent so far.
    #[must_use]
    pub fn texts_sent(&self) -> usize {
        self.st().batches.iter().map(Vec::len).sum()
    }

    /// The vector this embedder returns for `text`.
    #[must_use]
    pub fn vector_for(&self, text: &str) -> Vec<f32> {
        let digest = Sha256::digest(text.as_bytes());
        let mut v: Vec<f32> = (0..self.dim)
            .map(|i| {
                // Spread bytes over dims; re-hash when dim > 32.
                let b = if i < 32 {
                    digest[i]
                } else {
                    Sha256::digest([digest[i % 32], u8::try_from(i % 251).unwrap_or(0)])[0]
                };
                f32::from(b) / 127.5 - 1.0
            })
            .collect();
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut v {
                *x /= norm;
            }
        } else {
            v[0] = 1.0;
        }
        v
    }
}

impl Embedder for FakeEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn max_batch(&self) -> usize {
        self.max_batch
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let mut s = self.st();
        s.batches.push(texts.to_vec());
        if !s.fail_next.is_empty() {
            return Err(s.fail_next.remove(0));
        }
        if let Some((needle, err)) = &s.fail_containing {
            if texts.iter().any(|t| t.contains(needle.as_str())) {
                return Err(err.clone());
            }
        }
        drop(s);
        Ok(texts.iter().map(|t| self.vector_for(t)).collect())
    }
}

// ---------------------------------------------------------------- pipeline

/// What [`embed_texts`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmbedStats {
    /// Texts asked for.
    pub requested: usize,
    /// Texts that were an exact repeat of an earlier text in the same call.
    pub deduped: usize,
    /// Unique texts served from the persistent cache.
    pub cache_hits: usize,
    /// Unique texts sent to the embedder.
    pub embedded: usize,
    /// Embedder calls made.
    pub batches: usize,
}

impl EmbedStats {
    /// Accumulate another call's stats.
    pub fn add(&mut self, o: Self) {
        self.requested += o.requested;
        self.deduped += o.deduped;
        self.cache_hits += o.cache_hits;
        self.embedded += o.embedded;
        self.batches += o.batches;
    }
}

/// Embed `texts`, returning one vector per input in order.
///
/// Identical texts are embedded once; vectors already in the `embedding_cache` for this model are
/// reused; the rest go to `embedder` in batches of `min(batch_size, embedder.max_batch())`.
/// `before_batch` is called before each embedder call with the number of texts about to be sent
/// (the metering / cancellation hook); returning an error aborts without calling the embedder
/// (finished batches stay cached).
///
/// # Errors
/// The first [`EmbedError`]; database failures surface as [`EmbedError::Permanent`].
pub fn embed_texts(
    conn: &Connection,
    embedder: &dyn Embedder,
    texts: &[String],
    batch_size: usize,
    before_batch: &mut dyn FnMut(usize) -> Result<(), EmbedError>,
) -> Result<(Vec<Vec<f32>>, EmbedStats), EmbedError> {
    let mut stats = EmbedStats {
        requested: texts.len(),
        ..EmbedStats::default()
    };
    let hashes: Vec<String> = texts.iter().map(|t| content_hash(t)).collect();
    let mut seen = HashSet::new();
    let mut unique: Vec<(&str, &String)> = Vec::new(); // (hash, text)
    for (h, t) in hashes.iter().zip(texts) {
        if seen.insert(h.as_str()) {
            unique.push((h.as_str(), t));
        } else {
            stats.deduped += 1;
        }
    }

    let model = embedder.model();
    let unique_hashes: Vec<String> = unique.iter().map(|(h, _)| (*h).to_string()).collect();
    let mut vectors: HashMap<String, Vec<f32>> = store::cache_get(conn, model, &unique_hashes)?;
    stats.cache_hits = vectors.len();

    let todo: Vec<(&str, &String)> = unique
        .into_iter()
        .filter(|(h, _)| !vectors.contains_key(*h))
        .collect();
    let size = batch_size.max(1).min(embedder.max_batch().max(1));
    for batch in todo.chunks(size) {
        let inputs: Vec<String> = batch.iter().map(|(_, t)| (*t).clone()).collect();
        before_batch(inputs.len())?;
        let got = embedder.embed(&inputs)?;
        if got.len() != inputs.len() {
            return Err(EmbedError::Permanent(format!(
                "embedder returned {} vectors for {} texts",
                got.len(),
                inputs.len()
            )));
        }
        validate_vectors(&got)?;
        stats.batches += 1;
        stats.embedded += inputs.len();
        for ((h, _), v) in batch.iter().zip(got) {
            store::cache_put(conn, model, h, &v)?;
            vectors.insert((*h).to_string(), v);
        }
    }

    let out = hashes
        .iter()
        .map(|h| {
            vectors
                .get(h)
                .cloned()
                .ok_or_else(|| EmbedError::Permanent("missing vector after embedding".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((out, stats))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn texts(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    fn noop(_: usize) -> Result<(), EmbedError> {
        Ok(())
    }

    #[test]
    fn fake_is_deterministic_and_unit_length() {
        let e = FakeEmbedder::new(40);
        let a = e.vector_for("hello");
        assert_eq!(a, e.vector_for("hello"));
        assert_ne!(a, e.vector_for("world"));
        assert_eq!(a.len(), 40);
        let n: f32 = a.iter().map(|x| x * x).sum();
        assert!((n - 1.0).abs() < 1e-4);
    }

    #[test]
    fn dedupes_within_call_and_caches_across_calls() {
        let (db, _) = store::testutil::db_with_team();
        let e = FakeEmbedder::default();
        let t = texts(&["a", "b", "a", "c", "b"]);
        let (v, s) = embed_texts(db.conn(), &e, &t, 2, &mut noop).unwrap();
        assert_eq!(v.len(), 5);
        assert_eq!(v[0], v[2]);
        assert_eq!(v[1], v[4]);
        assert_eq!(s.requested, 5);
        assert_eq!(s.deduped, 2);
        assert_eq!(s.embedded, 3);
        assert_eq!(s.batches, 2);
        assert_eq!(e.texts_sent(), 3);

        // second call: everything from cache, embedder untouched
        let (v2, s2) = embed_texts(db.conn(), &e, &texts(&["c", "a"]), 2, &mut noop).unwrap();
        assert_eq!(v2[0], v[3]);
        assert_eq!((s2.cache_hits, s2.embedded, s2.batches), (2, 0, 0));
        assert_eq!(e.texts_sent(), 3);
    }

    #[test]
    fn batches_respect_size_and_model_limit() {
        let (db, _) = store::testutil::db_with_team();
        let e = FakeEmbedder::default().with_max_batch(3);
        let t: Vec<String> = (0..7).map(|i| format!("t{i}")).collect();
        embed_texts(db.conn(), &e, &t, 50, &mut noop).unwrap();
        let sizes: Vec<usize> = e.batches().iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![3, 3, 1]);
    }

    #[test]
    fn failure_keeps_finished_batches_cached() {
        let (db, _) = store::testutil::db_with_team();
        let e = FakeEmbedder::default();
        e.fail_when_containing("t4", EmbedError::Transient("rate limited".into()));
        let t: Vec<String> = (0..6).map(|i| format!("t{i}")).collect();
        let err = embed_texts(db.conn(), &e, &t, 2, &mut noop).unwrap_err();
        assert!(err.is_transient());
        // first two batches (t0..t3) were cached
        e.clear_failures();
        let before = e.texts_sent();
        let (_, s) = embed_texts(db.conn(), &e, &t, 2, &mut noop).unwrap();
        assert_eq!(s.cache_hits, 4);
        assert_eq!(s.embedded, 2);
        assert_eq!(e.texts_sent() - before, 2);
    }

    #[test]
    fn before_batch_error_aborts_before_calling_the_embedder() {
        let (db, _) = store::testutil::db_with_team();
        let e = FakeEmbedder::default();
        let t: Vec<String> = (0..4).map(|i| format!("t{i}")).collect();
        let mut calls = 0;
        let r = embed_texts(db.conn(), &e, &t, 2, &mut |_| {
            calls += 1;
            Err(EmbedError::Permanent("out of credits".into()))
        });
        assert!(r.is_err());
        assert_eq!(calls, 1);
        assert_eq!(e.texts_sent(), 0);
    }

    #[test]
    fn wrong_vector_count_is_rejected() {
        struct Bad;
        impl Embedder for Bad {
            fn model(&self) -> &str {
                "bad"
            }
            fn embed(&self, _t: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
                Ok(vec![vec![1.0]])
            }
        }
        let (db, _) = store::testutil::db_with_team();
        let r = embed_texts(db.conn(), &Bad, &texts(&["a", "b"]), 10, &mut noop);
        assert!(matches!(r, Err(EmbedError::Permanent(_))));
    }
}
