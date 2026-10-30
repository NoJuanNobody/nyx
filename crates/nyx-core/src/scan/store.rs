//! SQLite helpers for the scan module (tables from migration 0167): the per-file manifest used
//! for incremental re-scans, per-repo scan state, the embedding cache, and per-file chunk
//! deletion (which [`crate::store::ChunkRepo`] does not offer). Chunks themselves are written
//! through [`crate::store::ChunkRepo::insert_code_chunk`].

use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::model::{decode_embedding, encode_embedding, new_id, now_ms};

/// Run `f` inside a savepoint (rolls back on error). Composes with an outer transaction.
pub(crate) fn atomic<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let name = format!("scan_{}", new_id().replace('-', ""));
    conn.execute_batch(&format!("SAVEPOINT {name}"))?;
    match f() {
        Ok(v) => {
            conn.execute_batch(&format!("RELEASE {name}"))?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
            Err(e)
        }
    }
}

/// What was indexed for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    /// Repo-relative path.
    pub path: String,
    /// Revision token (blob sha or content hash) of the indexed content.
    pub fingerprint: String,
    /// Size in bytes at index time.
    pub size: u64,
    /// Detected language name.
    pub language: String,
    /// Number of chunks stored.
    pub chunk_count: u32,
}

/// Manifest of one repository, keyed by path.
pub fn load_manifest(
    conn: &Connection,
    team_id: &str,
    repo: &str,
) -> Result<BTreeMap<String, ManifestEntry>> {
    let mut s = conn.prepare(
        "SELECT path, fingerprint, size, language, chunk_count FROM scan_manifest
         WHERE team_id = ?1 AND repo_full_name = ?2",
    )?;
    let rows = s
        .query_map(params![team_id, repo], |r| {
            Ok(ManifestEntry {
                path: r.get(0)?,
                fingerprint: r.get(1)?,
                size: u64::try_from(r.get::<_, i64>(2)?).unwrap_or(0),
                language: r.get(3)?,
                chunk_count: u32::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().map(|e| (e.path.clone(), e)).collect())
}

/// Insert or replace a manifest row.
pub fn upsert_manifest(
    conn: &Connection,
    team_id: &str,
    repo: &str,
    e: &ManifestEntry,
) -> Result<()> {
    conn.execute(
        "INSERT INTO scan_manifest (team_id, repo_full_name, path, fingerprint, size, language, chunk_count, indexed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(team_id, repo_full_name, path) DO UPDATE SET
           fingerprint = excluded.fingerprint, size = excluded.size, language = excluded.language,
           chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at",
        params![
            team_id,
            repo,
            e.path,
            e.fingerprint,
            i64::try_from(e.size).unwrap_or(i64::MAX),
            e.language,
            i64::from(e.chunk_count),
            now_ms()
        ],
    )?;
    Ok(())
}

/// Drop a file from the manifest and delete its code chunks.
pub fn remove_file(conn: &Connection, team_id: &str, repo: &str, path: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM scan_manifest WHERE team_id = ?1 AND repo_full_name = ?2 AND path = ?3",
        params![team_id, repo, path],
    )?;
    delete_file_chunks(conn, team_id, repo, path)
}

/// Delete the code chunks of one file; returns how many were removed.
pub fn delete_file_chunks(
    conn: &Connection,
    team_id: &str,
    repo: &str,
    path: &str,
) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM code_chunks WHERE team_id = ?1 AND repo_full_name = ?2 AND file_path = ?3",
        params![team_id, repo, path],
    )?)
}

/// Forget everything known about a repository (manifest, state, chunks).
pub fn reset_repo(conn: &Connection, team_id: &str, repo: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM scan_manifest WHERE team_id = ?1 AND repo_full_name = ?2",
        params![team_id, repo],
    )?;
    conn.execute(
        "DELETE FROM scan_repo_state WHERE team_id = ?1 AND repo_full_name = ?2",
        params![team_id, repo],
    )?;
    conn.execute(
        "DELETE FROM code_chunks WHERE team_id = ?1 AND repo_full_name = ?2",
        params![team_id, repo],
    )?;
    Ok(())
}

/// Per-repository scan state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoState {
    /// Snapshot token of the last *complete* scan.
    pub head_token: Option<String>,
    /// Files indexed.
    pub file_count: u32,
    /// Chunks stored.
    pub chunk_count: u32,
    /// Unix ms of the last complete scan.
    pub last_scanned_at: i64,
}

/// State after the last complete scan, if any.
pub fn get_repo_state(conn: &Connection, team_id: &str, repo: &str) -> Result<Option<RepoState>> {
    Ok(conn
        .query_row(
            "SELECT head_token, file_count, chunk_count, last_scanned_at FROM scan_repo_state
             WHERE team_id = ?1 AND repo_full_name = ?2",
            params![team_id, repo],
            |r| {
                Ok(RepoState {
                    head_token: r.get(0)?,
                    file_count: u32::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                    chunk_count: u32::try_from(r.get::<_, i64>(2)?).unwrap_or(0),
                    last_scanned_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}

/// Record a complete scan.
pub fn put_repo_state(
    conn: &Connection,
    team_id: &str,
    repo: &str,
    head_token: Option<&str>,
    file_count: u32,
    chunk_count: u32,
) -> Result<()> {
    conn.execute(
        "INSERT INTO scan_repo_state (team_id, repo_full_name, head_token, file_count, chunk_count, last_scanned_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(team_id, repo_full_name) DO UPDATE SET
           head_token = excluded.head_token, file_count = excluded.file_count,
           chunk_count = excluded.chunk_count, last_scanned_at = excluded.last_scanned_at",
        params![
            team_id,
            repo,
            head_token,
            i64::from(file_count),
            i64::from(chunk_count),
            now_ms()
        ],
    )?;
    Ok(())
}

/// Forget the head token so the next scan re-lists even if the snapshot is unchanged
/// (called as soon as a scan starts mutating, so an interrupted scan is never "complete").
pub fn clear_head_token(conn: &Connection, team_id: &str, repo: &str) -> Result<()> {
    conn.execute(
        "UPDATE scan_repo_state SET head_token = NULL WHERE team_id = ?1 AND repo_full_name = ?2",
        params![team_id, repo],
    )?;
    Ok(())
}

/// Cached vectors for `hashes` under `model` (missing hashes are absent from the map).
pub fn cache_get(
    conn: &Connection,
    model: &str,
    hashes: &[String],
) -> Result<HashMap<String, Vec<f32>>> {
    let mut out = HashMap::new();
    let mut s = conn.prepare_cached(
        "SELECT embedding FROM embedding_cache WHERE content_hash = ?1 AND model = ?2",
    )?;
    for h in hashes {
        let blob: Option<Vec<u8>> = s.query_row(params![h, model], |r| r.get(0)).optional()?;
        if let Some(b) = blob {
            out.insert(h.clone(), decode_embedding(&b)?);
        }
    }
    Ok(out)
}

/// Store a vector in the cache (first write wins).
pub fn cache_put(conn: &Connection, model: &str, hash: &str, v: &[f32]) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO embedding_cache (content_hash, model, dim, embedding, created_at)
         VALUES (?1,?2,?3,?4,?5)",
        params![
            hash,
            model,
            i64::try_from(v.len()).unwrap_or(i64::MAX),
            encode_embedding(v),
            now_ms()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod testutil {
    use rusqlite::Connection;

    use crate::model::NewTeam;
    use crate::store::{Db, SqliteTeams, TeamRepo};

    /// Fresh in-memory database with one team; returns `(db, team_id)`.
    pub fn db_with_team() -> (Db, String) {
        let db = Db::open_in_memory().expect("db");
        let t = SqliteTeams::new(db.conn())
            .create(&NewTeam {
                name: "T".into(),
                slug: "t".into(),
            })
            .expect("team");
        (db, t.id)
    }

    /// Count rows of a table.
    pub fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .expect("count")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn manifest_roundtrip_and_removal() {
        let (db, team) = db_with_team();
        let c = db.conn();
        let e = ManifestEntry {
            path: "a.rs".into(),
            fingerprint: "f1".into(),
            size: 10,
            language: "rust".into(),
            chunk_count: 2,
        };
        upsert_manifest(c, &team, "o/r", &e).unwrap();
        upsert_manifest(
            c,
            &team,
            "o/r",
            &ManifestEntry {
                fingerprint: "f2".into(),
                ..e.clone()
            },
        )
        .unwrap();
        let m = load_manifest(c, &team, "o/r").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["a.rs"].fingerprint, "f2");
        remove_file(c, &team, "o/r", "a.rs").unwrap();
        assert!(load_manifest(c, &team, "o/r").unwrap().is_empty());
    }

    #[test]
    fn repo_state_and_cache() {
        let (db, team) = db_with_team();
        let c = db.conn();
        assert_eq!(get_repo_state(c, &team, "o/r").unwrap(), None);
        put_repo_state(c, &team, "o/r", Some("h1"), 3, 9).unwrap();
        let s = get_repo_state(c, &team, "o/r").unwrap().unwrap();
        assert_eq!(
            (s.head_token.as_deref(), s.file_count, s.chunk_count),
            (Some("h1"), 3, 9)
        );
        clear_head_token(c, &team, "o/r").unwrap();
        assert_eq!(
            get_repo_state(c, &team, "o/r").unwrap().unwrap().head_token,
            None
        );

        cache_put(c, "m", "h", &[1.0, 2.0]).unwrap();
        cache_put(c, "m", "h", &[9.0, 9.0]).unwrap();
        let got = cache_get(c, "m", &["h".into(), "x".into()]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got["h"], vec![1.0, 2.0]);
        assert!(cache_get(c, "other", &["h".into()]).unwrap().is_empty());
    }

    #[test]
    fn atomic_rolls_back() {
        let (db, team) = db_with_team();
        let c = db.conn();
        let r: Result<()> = atomic(c, || {
            put_repo_state(c, &team, "o/r", None, 1, 1)?;
            Err(crate::Error::Invalid("boom".into()))
        });
        assert!(r.is_err());
        assert_eq!(count(c, "scan_repo_state"), 0);
    }
}
