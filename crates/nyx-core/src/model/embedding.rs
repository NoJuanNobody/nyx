//! Embedding metadata and chunks. Drizzle: `doc_chunks`, `code_chunks` (pgvector `vector(1536)`).
//! Vectors are stored as little-endian `f32` BLOBs with explicit dimension and model name, so any
//! embedding provider works; similarity is brute force today (see `docs/rust-core-data-model.md`).

use serde::{Deserialize, Serialize};

use super::{Id, Timestamp};
use crate::error::{Error, Result};

/// Encode a vector as little-endian f32 bytes.
#[must_use]
pub fn encode_embedding(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// Decode little-endian f32 bytes.
pub fn decode_embedding(b: &[u8]) -> Result<Vec<f32>> {
    if b.len() % 4 != 0 {
        return Err(Error::Invalid(
            "embedding blob length is not a multiple of 4".into(),
        ));
    }
    Ok(b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Cosine similarity in `[-1, 1]`; 0 for mismatched lengths or zero vectors.
#[must_use]
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0_f32, 0.0_f32, 0.0_f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// An embedded chunk of a document version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocChunk {
    /// Id.
    pub id: Id,
    /// Document.
    pub doc_id: Id,
    /// Team (Drizzle: `org_id`).
    pub org_id: Id,
    /// Chunk text.
    pub content: String,
    /// Embedding vector, if computed.
    pub embedding: Option<Vec<f32>>,
    /// Model that produced the embedding.
    pub embedding_model: Option<String>,
    /// Document version the chunk belongs to.
    pub version: i64,
    /// Position within the version.
    pub chunk_index: i64,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Input for storing a document chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDocChunk {
    /// Document.
    pub doc_id: Id,
    /// Team.
    pub org_id: Id,
    /// Chunk text.
    pub content: String,
    /// Embedding vector.
    pub embedding: Option<Vec<f32>>,
    /// Embedding model name.
    pub embedding_model: Option<String>,
    /// Document version.
    pub version: i64,
    /// Chunk position.
    pub chunk_index: i64,
}

/// An embedded chunk of a connected repository file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeChunk {
    /// Id.
    pub id: Id,
    /// Team.
    pub team_id: Id,
    /// File path.
    pub file_path: String,
    /// Chunk text.
    pub content: String,
    /// Embedding vector.
    pub embedding: Option<Vec<f32>>,
    /// Embedding model.
    pub embedding_model: Option<String>,
    /// `owner/repo`.
    pub repo_full_name: String,
    /// Commit.
    pub commit_sha: Option<String>,
    /// Chunk position.
    pub chunk_index: i64,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Input for storing a code chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCodeChunk {
    /// Team.
    pub team_id: Id,
    /// File path.
    pub file_path: String,
    /// Chunk text.
    pub content: String,
    /// Embedding vector.
    pub embedding: Option<Vec<f32>>,
    /// Embedding model.
    pub embedding_model: Option<String>,
    /// `owner/repo`.
    pub repo_full_name: String,
    /// Commit.
    pub commit_sha: Option<String>,
    /// Chunk position.
    pub chunk_index: i64,
}
