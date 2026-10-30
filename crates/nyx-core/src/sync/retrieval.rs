//! Semantic retrieval over `doc_chunks` / `code_chunks`. Port of `retrieval.service.ts`
//! (pgvector `<=>` replaced by a brute-force cosine scan), extended with keyword and hybrid
//! ranking.
//!
//! # Ranking
//! - [`Mode::Semantic`]: cosine similarity, kept when `>= threshold` (TS default 0.3).
//! - [`Mode::Keyword`]: fraction of distinct query terms (stop words removed) present in the
//!   chunk, kept when at least one term matches.
//! - [`Mode::Hybrid`]: `w * max(cosine, 0) + (1 - w) * keyword`, kept when cosine passes the
//!   threshold or at least half of the query terms match. Chunks without a vector take part with
//!   cosine 0, so documents that were never embedded stay findable by keyword.
//!
//! Only chunks of each live document's newest embedded version are searched. Ties break on
//! `(doc_id, chunk_index)` so results are deterministic.
//!
//! # Why not FTS5
//! `bundled` rusqlite does ship FTS5, but an external-content FTS table would need triggers on
//! `doc_chunks` and a rebuild path for imported data. The keyword half is computed in the same
//! single scan instead (no second index to keep consistent). Measured cost: see the
//! `ten_thousand_chunks` test (< 200 ms in release for 10k x 128-d chunks).
//! TODO: `sqlite-vec` / FTS5 once the data size justifies an index (GH #285).

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::intake::{chunk_text, store_doc_chunks, ChunkOptions, Embeddings};
use crate::model::{Document, NewCodeChunk};
use crate::store::{ChunkRepo, SqliteChunks};

/// Turns text into vectors. Implementations: [`HashingEmbedder`] (offline), a provider-backed
/// one (TODO(AI-74 wiring): HTTP embeddings through the BYOK transport), or a test double.
pub trait Embedder: Send + Sync {
    /// Model name stored next to every vector.
    fn model(&self) -> &str;
    /// One vector per input text, same order.
    ///
    /// # Errors
    /// Provider failure.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

/// Deterministic, offline feature-hashing embedder: lowercase word unigrams hashed (FNV-1a) into
/// `dim` signed buckets and L2-normalised. Quality is lexical, not semantic, but it needs no key
/// and no network, so retrieval and drift matching work out of the box.
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

impl Embedder for HashingEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
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

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "be", "it",
    "this", "that", "with", "as", "at", "by", "from", "how", "what", "do", "does",
];

/// Lowercase alphanumeric words of length >= 2 (stop words included).
fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.chars().count() >= 2)
        .map(str::to_lowercase)
        .collect()
}

fn query_terms(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tokens(text)
        .into_iter()
        .filter(|t| !STOP_WORDS.contains(&t.as_str()) && seen.insert(t.clone()))
        .collect()
}

fn keyword_score(terms: &[String], content: &str) -> f32 {
    if terms.is_empty() {
        return 0.0;
    }
    let words: HashSet<String> = tokens(content).into_iter().collect();
    let hit = terms.iter().filter(|t| words.contains(*t)).count();
    hit as f32 / terms.len() as f32
}

/// Ranking mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Cosine only.
    Semantic,
    /// Term coverage only.
    Keyword,
    /// Weighted blend.
    Hybrid,
}

/// Retrieval parameters (defaults match the TS service: top 5, threshold 0.3).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RetrieveOptions {
    /// Number of chunks to return.
    pub top_k: usize,
    /// Minimum cosine similarity.
    pub threshold: f32,
    /// Ranking mode.
    pub mode: Mode,
    /// Weight of the cosine part in [`Mode::Hybrid`], in `[0, 1]`.
    pub semantic_weight: f32,
}

impl Default for RetrieveOptions {
    fn default() -> Self {
        Self {
            top_k: 5,
            threshold: 0.3,
            mode: Mode::Semantic,
            semantic_weight: 0.7,
        }
    }
}

/// A matching document chunk (TS `RetrievedChunk`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedChunk {
    /// Chunk text.
    pub content: String,
    /// Document.
    pub doc_id: String,
    /// Ranking score (cosine, keyword coverage or blend).
    pub score: f32,
    /// Position in the document version.
    pub chunk_index: i64,
}

/// Cosine similarity between a little-endian f32 blob and a query without allocating.
fn cosine_blob(blob: &[u8], q: &[f32], q_norm: f32) -> f32 {
    if blob.len() != q.len() * 4 || q_norm == 0.0 {
        return 0.0;
    }
    let (mut dot, mut nb) = (0.0_f32, 0.0_f32);
    for (c, x) in blob.chunks_exact(4).zip(q) {
        let y = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        dot += x * y;
        nb += y * y;
    }
    if nb == 0.0 {
        0.0
    } else {
        dot / (q_norm * nb.sqrt())
    }
}

struct Cand {
    score: f32,
    id: String,
    doc_id: String,
    chunk_index: i64,
    content: Option<String>,
}

/// Rank the team's document chunks against an already-embedded query. `query_vec` may be `None`
/// only for [`Mode::Keyword`].
///
/// # Errors
/// [`Error::Invalid`] when a vector is needed but missing or malformed; database errors.
pub fn search_documents(
    conn: &Connection,
    team_id: &str,
    query_text: &str,
    query_vec: Option<&[f32]>,
    opts: &RetrieveOptions,
) -> Result<Vec<RetrievedChunk>> {
    if opts.top_k == 0 {
        return Ok(Vec::new());
    }
    let need_vec = opts.mode != Mode::Keyword;
    let q: &[f32] = match (need_vec, query_vec) {
        (true, None) => return Err(Error::Invalid("query vector required for this mode".into())),
        (_, Some(v)) => {
            if v.iter().any(|x| !x.is_finite()) {
                return Err(Error::Invalid(
                    "query vector contains NaN or infinity".into(),
                ));
            }
            v
        }
        (false, None) => &[],
    };
    let q_norm = q.iter().map(|x| x * x).sum::<f32>().sqrt();
    let terms = query_terms(query_text);
    let w = opts.semantic_weight.clamp(0.0, 1.0);
    let want_content = opts.mode != Mode::Semantic;

    let sql = format!(
        "SELECT c.id, c.doc_id, c.chunk_index, c.embedding, {} FROM doc_chunks c
         JOIN documents d ON d.id = c.doc_id AND d.deleted_at IS NULL
         WHERE c.org_id = ?1
           AND c.version = (SELECT MAX(c2.version) FROM doc_chunks c2 WHERE c2.doc_id = c.doc_id)
           {}",
        if want_content { "c.content" } else { "NULL" },
        if opts.mode == Mode::Semantic {
            "AND c.embedding IS NOT NULL AND c.embedding_dim = ?2"
        } else {
            "AND ?2 >= 0"
        },
    );
    let dim = i64::try_from(q.len()).unwrap_or(i64::MAX);
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![team_id, dim])?;
    let mut cands: Vec<Cand> = Vec::new();
    while let Some(r) = rows.next()? {
        let blob: Option<Vec<u8>> = r.get(3)?;
        let content: Option<String> = r.get(4)?;
        let cos = if need_vec {
            blob.as_deref().map_or(0.0, |b| cosine_blob(b, q, q_norm))
        } else {
            0.0
        };
        let kw = match (&content, opts.mode) {
            (Some(c), Mode::Keyword | Mode::Hybrid) => keyword_score(&terms, c),
            _ => 0.0,
        };
        let (score, keep) = match opts.mode {
            Mode::Semantic => (cos, cos >= opts.threshold),
            Mode::Keyword => (kw, kw > 0.0),
            Mode::Hybrid => (
                w * cos.max(0.0) + (1.0 - w) * kw,
                cos >= opts.threshold || kw >= 0.5,
            ),
        };
        if keep {
            cands.push(Cand {
                score,
                id: r.get(0)?,
                doc_id: r.get(1)?,
                chunk_index: r.get(2)?,
                content,
            });
        }
    }
    drop(rows);
    cands.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.doc_id.cmp(&b.doc_id))
            .then(a.chunk_index.cmp(&b.chunk_index))
    });
    cands.truncate(opts.top_k);
    cands
        .into_iter()
        .map(|c| {
            let content = match c.content {
                Some(t) => t,
                None => conn.query_row(
                    "SELECT content FROM doc_chunks WHERE id = ?1",
                    [&c.id],
                    |r| r.get(0),
                )?,
            };
            Ok(RetrievedChunk {
                content,
                doc_id: c.doc_id,
                score: c.score,
                chunk_index: c.chunk_index,
            })
        })
        .collect()
}

/// Embed `query` and return the most relevant document chunks of the team (TS `retrieveChunks`).
pub fn retrieve_chunks(
    conn: &Connection,
    embedder: &dyn Embedder,
    query: &str,
    team_id: &str,
    opts: &RetrieveOptions,
) -> Result<Vec<RetrievedChunk>> {
    let vec = if opts.mode == Mode::Keyword {
        None
    } else {
        Some(embed_one(embedder, query)?)
    };
    search_documents(conn, team_id, query, vec.as_deref(), opts)
}

fn embed_one(embedder: &dyn Embedder, text: &str) -> Result<Vec<f32>> {
    embedder
        .embed(&[text.to_owned()])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("embedder returned no vector".into()))
}

/// A matching code chunk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedCode {
    /// Repository `owner/name`.
    pub repo_full_name: String,
    /// File path.
    pub file_path: String,
    /// Chunk text.
    pub content: String,
    /// Cosine similarity.
    pub score: f32,
    /// Chunk position in the file.
    pub chunk_index: i64,
}

/// Semantic search over the team's code chunks (grounding for advisor fixes, GH #343).
pub fn retrieve_code(
    conn: &Connection,
    embedder: &dyn Embedder,
    query: &str,
    team_id: &str,
    opts: &RetrieveOptions,
) -> Result<Vec<RetrievedCode>> {
    let q = embed_one(embedder, query)?;
    Ok(SqliteChunks::new(conn)
        .search_code_chunks(team_id, &q, opts.top_k)?
        .into_iter()
        .filter(|(_, s)| *s >= opts.threshold)
        .map(|(c, score)| RetrievedCode {
            repo_full_name: c.repo_full_name,
            file_path: c.file_path,
            content: c.content,
            score,
            chunk_index: c.chunk_index,
        })
        .collect())
}

/// Chunk, embed and store one document version (replaces that version's chunks atomically when
/// called inside a transaction).
pub fn index_document(
    conn: &Connection,
    embedder: &dyn Embedder,
    doc: &Document,
    version: i64,
    options: &ChunkOptions,
) -> Result<usize> {
    let texts = chunk_text(&doc.content, options);
    let vectors = embedder.embed(&texts)?;
    let stored = store_doc_chunks(
        &SqliteChunks::new(conn),
        &doc.id,
        &doc.team_id,
        version,
        &doc.content,
        options,
        Some(Embeddings {
            model: embedder.model(),
            vectors: &vectors,
        }),
    )?;
    Ok(stored.len())
}

/// Replace the stored chunks of one repository file with freshly embedded ones.
pub fn index_code_file(
    conn: &Connection,
    embedder: &dyn Embedder,
    team_id: &str,
    repo_full_name: &str,
    file_path: &str,
    content: &str,
    commit_sha: Option<&str>,
    options: &ChunkOptions,
) -> Result<usize> {
    let texts = chunk_text(content, options);
    let vectors = embedder.embed(&texts)?;
    if vectors.len() != texts.len() {
        return Err(Error::Invalid(
            "embedder returned a wrong number of vectors".into(),
        ));
    }
    conn.execute(
        "DELETE FROM code_chunks WHERE team_id = ?1 AND repo_full_name = ?2 AND file_path = ?3",
        params![team_id, repo_full_name, file_path],
    )?;
    let repo = SqliteChunks::new(conn);
    let total = texts.len();
    for (i, (text, vec)) in texts.into_iter().zip(vectors).enumerate() {
        repo.insert_code_chunk(&NewCodeChunk {
            team_id: team_id.to_owned(),
            file_path: file_path.to_owned(),
            content: text,
            embedding: Some(vec),
            embedding_model: Some(embedder.model().to_owned()),
            repo_full_name: repo_full_name.to_owned(),
            commit_sha: commit_sha.map(str::to_owned),
            chunk_index: i64::try_from(i).unwrap_or(i64::MAX),
        })?;
    }
    Ok(total)
}

#[cfg(test)]
#[allow(clippy::cast_possible_wrap, clippy::default_trait_access)]
mod tests {
    use super::*;
    use crate::model::{NewDocument, NewTeam, NewUser, UserRole};
    use crate::store::{
        Db, DocumentRepo, SqliteDocuments, SqliteTeams, SqliteUsers, TeamRepo, UserRepo,
    };

    struct Env {
        db: Db,
        team: String,
        user: String,
    }

    fn env() -> Env {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let u = SqliteUsers::new(c)
            .create(&NewUser {
                email: "a@x.io".into(),
                name: "A".into(),
                avatar_url: None,
            })
            .unwrap();
        let teams = SqliteTeams::new(c);
        let t = teams
            .create(&NewTeam {
                name: "T".into(),
                slug: "t".into(),
            })
            .unwrap();
        teams.add_member(&t.id, &u.id, UserRole::Owner).unwrap();
        Env {
            team: t.id,
            user: u.id,
            db,
        }
    }

    fn doc(e: &Env, title: &str) -> Document {
        SqliteDocuments::new(e.db.conn())
            .create(&NewDocument {
                title: title.into(),
                content: format!("# {title}"),
                path: String::new(),
                team_id: e.team.clone(),
                created_by_id: e.user.clone(),
                stage: None,
                lifecycle_id: None,
            })
            .unwrap()
    }

    fn chunk(e: &Env, d: &Document, version: i64, idx: i64, text: &str, v: Option<Vec<f32>>) {
        let (blob, dim) = match &v {
            Some(v) => (
                Some(crate::model::encode_embedding(v)),
                Some(v.len() as i64),
            ),
            None => (None, None),
        };
        e.db.conn()
            .execute(
                "INSERT INTO doc_chunks (id, doc_id, org_id, content, embedding, embedding_dim, embedding_model, version, chunk_index, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,'fixed',?7,?8,0)",
                params![crate::model::new_id(), d.id, e.team, text, blob, dim, version, idx],
            )
            .unwrap();
    }

    #[test]
    fn semantic_ranking_with_fixed_vectors() {
        let e = env();
        let d = doc(&e, "Spec");
        chunk(&e, &d, 1, 0, "exact", Some(vec![1.0, 0.0, 0.0]));
        chunk(&e, &d, 1, 1, "close", Some(vec![0.9, 0.3, 0.0]));
        chunk(&e, &d, 1, 2, "orthogonal", Some(vec![0.0, 1.0, 0.0]));
        chunk(&e, &d, 1, 3, "opposite", Some(vec![-1.0, 0.0, 0.0]));
        chunk(&e, &d, 1, 4, "wrong dimension", Some(vec![1.0, 0.0]));
        chunk(&e, &d, 1, 5, "no vector", None);

        let opts = RetrieveOptions {
            top_k: 10,
            threshold: 0.3,
            ..Default::default()
        };
        let r = search_documents(e.db.conn(), &e.team, "q", Some(&[1.0, 0.0, 0.0]), &opts).unwrap();
        let order: Vec<_> = r.iter().map(|c| c.content.as_str()).collect();
        assert_eq!(order, ["exact", "close"]);
        assert!((r[0].score - 1.0).abs() < 1e-6);
        assert!(r[1].score > 0.9 && r[1].score < 1.0);

        // top_k and threshold 0 (orthogonal included, opposite excluded as negative).
        let opts = RetrieveOptions {
            top_k: 2,
            threshold: -1.0,
            ..opts
        };
        let r = search_documents(e.db.conn(), &e.team, "q", Some(&[1.0, 0.0, 0.0]), &opts).unwrap();
        assert_eq!(r.len(), 2);
        let none = RetrieveOptions { top_k: 0, ..opts };
        assert!(
            search_documents(e.db.conn(), &e.team, "q", Some(&[1.0, 0.0, 0.0]), &none)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn ties_break_deterministically_and_teams_are_isolated() {
        let e = env();
        let d = doc(&e, "Spec");
        chunk(&e, &d, 1, 2, "second", Some(vec![1.0, 0.0]));
        chunk(&e, &d, 1, 1, "first", Some(vec![1.0, 0.0]));
        let opts = RetrieveOptions {
            top_k: 5,
            threshold: 0.0,
            ..Default::default()
        };
        let r = search_documents(e.db.conn(), &e.team, "q", Some(&[1.0, 0.0]), &opts).unwrap();
        assert_eq!(r.iter().map(|c| c.chunk_index).collect::<Vec<_>>(), [1, 2]);
        assert!(
            search_documents(e.db.conn(), "other-team", "q", Some(&[1.0, 0.0]), &opts)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn only_latest_version_and_live_documents_are_searched() {
        let e = env();
        let d = doc(&e, "Spec");
        chunk(&e, &d, 1, 0, "old version", Some(vec![1.0, 0.0]));
        chunk(&e, &d, 2, 0, "new version", Some(vec![0.8, 0.6]));
        let gone = doc(&e, "Gone");
        chunk(&e, &gone, 1, 0, "deleted doc", Some(vec![1.0, 0.0]));
        SqliteDocuments::new(e.db.conn())
            .soft_delete(&gone.id)
            .unwrap();
        let opts = RetrieveOptions {
            top_k: 10,
            threshold: 0.0,
            ..Default::default()
        };
        let r = search_documents(e.db.conn(), &e.team, "q", Some(&[1.0, 0.0]), &opts).unwrap();
        assert_eq!(
            r.iter().map(|c| c.content.as_str()).collect::<Vec<_>>(),
            ["new version"]
        );
    }

    #[test]
    fn keyword_and_hybrid_modes() {
        let e = env();
        let d = doc(&e, "Spec");
        chunk(
            &e,
            &d,
            1,
            0,
            "Webhook signature verification uses HMAC",
            Some(vec![0.0, 1.0]),
        );
        chunk(&e, &d, 1, 1, "Unrelated billing text", Some(vec![1.0, 0.0]));
        chunk(&e, &d, 1, 2, "HMAC without embeddings", None);

        let kw = RetrieveOptions {
            top_k: 5,
            mode: Mode::Keyword,
            ..Default::default()
        };
        let r = search_documents(
            e.db.conn(),
            &e.team,
            "how does webhook HMAC verification work",
            None,
            &kw,
        )
        .unwrap();
        // terms: webhook, hmac, verification, work -> chunk0 hits 3/4, chunk2 hits 1/4.
        assert_eq!(r.iter().map(|c| c.chunk_index).collect::<Vec<_>>(), [0, 2]);
        assert!((r[0].score - 0.75).abs() < 1e-6);

        // Vector points at the billing chunk, words point at the webhook chunk: the blend decides.
        let hy = RetrieveOptions {
            top_k: 5,
            mode: Mode::Hybrid,
            threshold: 0.3,
            semantic_weight: 0.3,
        };
        let r = search_documents(
            e.db.conn(),
            &e.team,
            "webhook hmac verification",
            Some(&[1.0, 0.0]),
            &hy,
        )
        .unwrap();
        assert_eq!(
            r[0].chunk_index, 0,
            "keyword-heavy blend prefers the webhook chunk: {r:?}"
        );
        assert!(
            r.iter().any(|c| c.chunk_index == 1),
            "cosine-passing chunk is kept"
        );
        let hy_sem = RetrieveOptions {
            semantic_weight: 1.0,
            ..hy
        };
        let r = search_documents(
            e.db.conn(),
            &e.team,
            "webhook hmac verification",
            Some(&[1.0, 0.0]),
            &hy_sem,
        )
        .unwrap();
        assert_eq!(r[0].chunk_index, 1);

        assert!(matches!(
            search_documents(e.db.conn(), &e.team, "q", None, &hy),
            Err(Error::Invalid(_))
        ));
        assert!(search_documents(e.db.conn(), &e.team, "q", Some(&[f32::NAN]), &hy).is_err());
    }

    #[test]
    fn hashing_embedder_roundtrip_finds_the_right_document() {
        let e = env();
        let emb = HashingEmbedder::new(128);
        let a = doc(&e, "Auth");
        let b = doc(&e, "Billing");
        let mut a2 = a.clone();
        a2.content = "OAuth login tokens refresh session expiry for users".into();
        let mut b2 = b.clone();
        b2.content = "Invoice payment currency ledger credits balance".into();
        let opts = ChunkOptions::default();
        assert_eq!(index_document(e.db.conn(), &emb, &a2, 1, &opts).unwrap(), 1);
        index_document(e.db.conn(), &emb, &b2, 1, &opts).unwrap();
        let o = RetrieveOptions {
            top_k: 1,
            threshold: 0.1,
            ..Default::default()
        };
        let r = retrieve_chunks(e.db.conn(), &emb, "refresh login token", &e.team, &o).unwrap();
        assert_eq!(r[0].doc_id, a.id);
        let r = retrieve_chunks(e.db.conn(), &emb, "ledger balance", &e.team, &o).unwrap();
        assert_eq!(r[0].doc_id, b.id);
        assert_eq!(
            emb.embed(&["same".into()]).unwrap(),
            emb.embed(&["same".into()]).unwrap()
        );
    }

    #[test]
    fn code_index_replaces_per_file_and_retrieves() {
        let e = env();
        let emb = HashingEmbedder::new(128);
        let o = ChunkOptions::default();
        index_code_file(
            e.db.conn(),
            &emb,
            &e.team,
            "o/r",
            "src/a.rs",
            "fn refresh_token() {}",
            Some("c1"),
            &o,
        )
        .unwrap();
        index_code_file(
            e.db.conn(),
            &emb,
            &e.team,
            "o/r",
            "src/b.rs",
            "fn ledger_balance() {}",
            Some("c1"),
            &o,
        )
        .unwrap();
        index_code_file(
            e.db.conn(),
            &emb,
            &e.team,
            "o/r",
            "src/a.rs",
            "fn refresh_token_v2() {}",
            Some("c2"),
            &o,
        )
        .unwrap();
        let all = SqliteChunks::new(e.db.conn())
            .code_chunks(&e.team, "o/r")
            .unwrap();
        assert_eq!(all.len(), 2);
        let opts = RetrieveOptions {
            top_k: 1,
            threshold: 0.0,
            ..Default::default()
        };
        let r = retrieve_code(e.db.conn(), &emb, "ledger_balance", &e.team, &opts).unwrap();
        assert_eq!(r[0].file_path, "src/b.rs");
    }

    #[test]
    fn ten_thousand_chunks_search_is_fast() {
        let mut e = env();
        let d = doc(&e, "Big");
        let dim = 128_usize;
        let (team, doc_id) = (e.team.clone(), d.id.clone());
        e.db.transaction(|c| {
            let mut ins = c.prepare(
                "INSERT INTO doc_chunks (id, doc_id, org_id, content, embedding, embedding_dim, embedding_model, version, chunk_index, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,'m',1,?7,0)",
            )?;
            let mut state: u32 = 12345;
            for i in 0..10_000_i64 {
                let v: Vec<f32> = (0..dim)
                    .map(|_| {
                        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        (state >> 8) as f32 / 16_777_216.0 - 0.5
                    })
                    .collect();
                ins.execute(params![
                    format!("c{i}"), doc_id, team, format!("chunk {i}"),
                    crate::model::encode_embedding(&v), dim as i64, i
                ])?;
            }
            Ok(())
        })
        .unwrap();
        let q: Vec<f32> = (0..dim).map(|i| (i as f32).sin()).collect();
        let opts = RetrieveOptions {
            top_k: 10,
            threshold: -1.0,
            ..Default::default()
        };
        let t = std::time::Instant::now();
        let r = search_documents(e.db.conn(), &e.team, "q", Some(&q), &opts).unwrap();
        let ms = t.elapsed().as_millis();
        assert_eq!(r.len(), 10);
        assert!(r.windows(2).all(|w| w[0].score >= w[1].score));
        if !cfg!(debug_assertions) {
            assert!(ms < 200, "search over 10k chunks took {ms} ms");
        }
    }
}
