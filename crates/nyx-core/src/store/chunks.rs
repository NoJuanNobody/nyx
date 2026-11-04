//! Embedding chunks (documents and code) with brute-force cosine search.
//! TODO: replace the scan with `sqlite-vec` once the extension is bundled; the schema keeps raw
//! little-endian f32 BLOBs so the migration is a pure index addition.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::db_err;
use crate::error::{Error, Result};
use crate::model::{
    cosine_similarity, decode_embedding, encode_embedding, new_id, now_ms, CodeChunk, DocChunk,
    NewCodeChunk, NewDocChunk,
};

/// Chunk persistence and search.
pub trait ChunkRepo {
    /// Replace all chunks of one document version atomically (call inside a transaction).
    fn replace_doc_chunks(
        &self,
        doc_id: &str,
        version: i64,
        chunks: &[NewDocChunk],
    ) -> Result<Vec<DocChunk>>;
    /// Chunks of a document version in `chunk_index` order.
    fn doc_chunks(&self, doc_id: &str, version: i64) -> Result<Vec<DocChunk>>;
    /// Top-`k` document chunks of a team by cosine similarity (chunks with another dimension are skipped).
    fn search_doc_chunks(
        &self,
        org_id: &str,
        query: &[f32],
        k: usize,
    ) -> Result<Vec<(DocChunk, f32)>>;
    /// Insert one code chunk.
    fn insert_code_chunk(&self, chunk: &NewCodeChunk) -> Result<CodeChunk>;
    /// Chunks of a repository in file/index order.
    fn code_chunks(&self, team_id: &str, repo_full_name: &str) -> Result<Vec<CodeChunk>>;
    /// Remove all chunks of a repository; returns the number removed.
    fn delete_code_chunks(&self, team_id: &str, repo_full_name: &str) -> Result<usize>;
    /// Top-`k` code chunks of a team by cosine similarity.
    fn search_code_chunks(
        &self,
        team_id: &str,
        query: &[f32],
        k: usize,
    ) -> Result<Vec<(CodeChunk, f32)>>;
}

/// SQLite [`ChunkRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteChunks<'c>(&'c Connection);

impl<'c> SqliteChunks<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn blob(r: &Row<'_>) -> rusqlite::Result<Option<Vec<f32>>> {
    let b: Option<Vec<u8>> = r.get("embedding")?;
    b.map(|b| {
        decode_embedding(&b).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
        })
    })
    .transpose()
}

fn doc_row(r: &Row<'_>) -> rusqlite::Result<DocChunk> {
    Ok(DocChunk {
        id: r.get("id")?,
        doc_id: r.get("doc_id")?,
        org_id: r.get("org_id")?,
        content: r.get("content")?,
        embedding: blob(r)?,
        embedding_model: r.get("embedding_model")?,
        version: r.get("version")?,
        chunk_index: r.get("chunk_index")?,
        created_at: r.get("created_at")?,
    })
}

fn code_row(r: &Row<'_>) -> rusqlite::Result<CodeChunk> {
    Ok(CodeChunk {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        file_path: r.get("file_path")?,
        content: r.get("content")?,
        embedding: blob(r)?,
        embedding_model: r.get("embedding_model")?,
        repo_full_name: r.get("repo_full_name")?,
        commit_sha: r.get("commit_sha")?,
        chunk_index: r.get("chunk_index")?,
        created_at: r.get("created_at")?,
    })
}

fn enc(e: Option<&Vec<f32>>) -> Result<(Option<Vec<u8>>, Option<i64>)> {
    match e {
        None => Ok((None, None)),
        Some(v) if v.is_empty() => Err(Error::Invalid("embedding must not be empty".into())),
        Some(v) if v.iter().any(|x| !x.is_finite()) => {
            Err(Error::Invalid("embedding contains NaN or infinity".into()))
        }
        Some(v) => Ok((
            Some(encode_embedding(v)),
            Some(i64::try_from(v.len()).unwrap_or(i64::MAX)),
        )),
    }
}

fn top_k<T>(mut scored: Vec<(T, f32)>, k: usize) -> Vec<(T, f32)> {
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
}

impl ChunkRepo for SqliteChunks<'_> {
    fn replace_doc_chunks(
        &self,
        doc_id: &str,
        version: i64,
        chunks: &[NewDocChunk],
    ) -> Result<Vec<DocChunk>> {
        self.0.execute(
            "DELETE FROM doc_chunks WHERE doc_id = ?1 AND version = ?2",
            params![doc_id, version],
        )?;
        for c in chunks {
            if c.doc_id != doc_id || c.version != version {
                return Err(Error::Invalid(
                    "chunk does not belong to the replaced document version".into(),
                ));
            }
            let (b, dim) = enc(c.embedding.as_ref())?;
            self.0
                .execute(
                    "INSERT INTO doc_chunks (id, doc_id, org_id, content, embedding, embedding_dim, embedding_model, version, chunk_index, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![new_id(), c.doc_id, c.org_id, c.content, b, dim, c.embedding_model, c.version, c.chunk_index, now_ms()],
                )
                .map_err(db_err)?;
        }
        self.doc_chunks(doc_id, version)
    }

    fn doc_chunks(&self, doc_id: &str, version: i64) -> Result<Vec<DocChunk>> {
        let mut s = self.0.prepare(
            "SELECT * FROM doc_chunks WHERE doc_id = ?1 AND version = ?2 ORDER BY chunk_index",
        )?;
        let rows = s
            .query_map(params![doc_id, version], doc_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn search_doc_chunks(
        &self,
        org_id: &str,
        query: &[f32],
        k: usize,
    ) -> Result<Vec<(DocChunk, f32)>> {
        let mut s = self.0.prepare(
            "SELECT * FROM doc_chunks WHERE org_id = ?1 AND embedding IS NOT NULL AND embedding_dim = ?2",
        )?;
        let dim = i64::try_from(query.len()).unwrap_or(i64::MAX);
        let all: Vec<DocChunk> = s
            .query_map(params![org_id, dim], doc_row)?
            .collect::<std::result::Result<_, _>>()?;
        let scored = all
            .into_iter()
            .map(|c| {
                let sim = c
                    .embedding
                    .as_deref()
                    .map_or(0.0, |e| cosine_similarity(e, query));
                (c, sim)
            })
            .collect();
        Ok(top_k(scored, k))
    }

    fn insert_code_chunk(&self, c: &NewCodeChunk) -> Result<CodeChunk> {
        let (b, dim) = enc(c.embedding.as_ref())?;
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO code_chunks (id, team_id, file_path, content, embedding, embedding_dim, embedding_model, repo_full_name, commit_sha, chunk_index, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![id, c.team_id, c.file_path, c.content, b, dim, c.embedding_model, c.repo_full_name, c.commit_sha, c.chunk_index, now_ms()],
            )
            .map_err(db_err)?;
        self.0
            .query_row("SELECT * FROM code_chunks WHERE id = ?1", [&id], code_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("code chunk {id}")))
    }

    fn code_chunks(&self, team_id: &str, repo_full_name: &str) -> Result<Vec<CodeChunk>> {
        let mut s = self.0.prepare(
            "SELECT * FROM code_chunks WHERE team_id = ?1 AND repo_full_name = ?2 ORDER BY file_path, chunk_index",
        )?;
        let rows = s
            .query_map([team_id, repo_full_name], code_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn delete_code_chunks(&self, team_id: &str, repo_full_name: &str) -> Result<usize> {
        Ok(self.0.execute(
            "DELETE FROM code_chunks WHERE team_id = ?1 AND repo_full_name = ?2",
            [team_id, repo_full_name],
        )?)
    }

    fn search_code_chunks(
        &self,
        team_id: &str,
        query: &[f32],
        k: usize,
    ) -> Result<Vec<(CodeChunk, f32)>> {
        let mut s = self.0.prepare(
            "SELECT * FROM code_chunks WHERE team_id = ?1 AND embedding IS NOT NULL AND embedding_dim = ?2",
        )?;
        let dim = i64::try_from(query.len()).unwrap_or(i64::MAX);
        let all: Vec<CodeChunk> = s
            .query_map(params![team_id, dim], code_row)?
            .collect::<std::result::Result<_, _>>()?;
        let scored = all
            .into_iter()
            .map(|c| {
                let sim = c
                    .embedding
                    .as_deref()
                    .map_or(0.0, |e| cosine_similarity(e, query));
                (c, sim)
            })
            .collect();
        Ok(top_k(scored, k))
    }
}
