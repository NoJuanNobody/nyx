//! Documents and their immutable version history.
//!
//! Semantics: a document's `content` is its head. Every content change goes through
//! [`DocumentRepo::save_content`], which appends version `n+1` and updates the head in the same
//! statement group (call inside [`Db::transaction`](super::Db::transaction) for atomicity). Versions
//! are never edited (a trigger enforces it); restoring an old version appends a new one.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::db_err;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Document, DocumentVersion, NewDocument};

/// Document persistence.
pub trait DocumentRepo {
    /// Create a document and its version 1.
    fn create(&self, new: &NewDocument) -> Result<Document>;
    /// Fetch by id, including soft-deleted documents.
    fn get(&self, id: &str) -> Result<Document>;
    /// Live (not soft-deleted) documents of a team, by path then title.
    fn list_live(&self, team_id: &str) -> Result<Vec<Document>>;
    /// Live documents of a team in a stage.
    fn list_by_stage(&self, team_id: &str, stage: &str) -> Result<Vec<Document>>;
    /// Rename and/or move a document.
    fn update_meta(&self, id: &str, title: Option<&str>, path: Option<&str>) -> Result<Document>;
    /// Set or clear stage and lifecycle.
    fn set_stage(
        &self,
        id: &str,
        stage: Option<&str>,
        lifecycle_id: Option<&str>,
    ) -> Result<Document>;
    /// Replace the head content, appending a new version. Saving identical content is a no-op that
    /// returns the latest version. Fails with [`Error::Conflict`] on a soft-deleted document.
    fn save_content(
        &self,
        id: &str,
        content: &str,
        message: Option<&str>,
        author_id: &str,
    ) -> Result<DocumentVersion>;
    /// Soft-delete. Returns false if already deleted.
    fn soft_delete(&self, id: &str) -> Result<bool>;
    /// Undo a soft-delete. Returns false if the document was live.
    fn restore(&self, id: &str) -> Result<bool>;
    /// Versions of a document, oldest first.
    fn versions(&self, document_id: &str) -> Result<Vec<DocumentVersion>>;
    /// Version by number.
    fn version(&self, document_id: &str, version: i64) -> Result<DocumentVersion>;
    /// Version by id.
    fn version_by_id(&self, version_id: &str) -> Result<DocumentVersion>;
    /// Latest version.
    fn latest_version(&self, document_id: &str) -> Result<DocumentVersion>;
    /// Make an old version's content the head again by appending a new version.
    fn restore_version(
        &self,
        document_id: &str,
        version: i64,
        author_id: &str,
    ) -> Result<DocumentVersion>;
}

/// SQLite [`DocumentRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteDocuments<'c>(&'c Connection);

impl<'c> SqliteDocuments<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    fn insert_version(
        &self,
        doc: &str,
        content: &str,
        message: Option<&str>,
        author: &str,
    ) -> Result<DocumentVersion> {
        let id = new_id();
        let next: i64 = self.0.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM document_versions WHERE document_id=?1",
            [doc],
            |r| r.get(0),
        )?;
        self.0
            .execute(
                "INSERT INTO document_versions (id, document_id, version, content, message, created_by_id, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![id, doc, next, content, message, author, now_ms()],
            )
            .map_err(db_err)?;
        self.version_by_id(&id)
    }
}

fn doc_row(r: &Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: r.get("id")?,
        title: r.get("title")?,
        content: r.get("content")?,
        path: r.get("path")?,
        team_id: r.get("team_id")?,
        created_by_id: r.get("created_by_id")?,
        stage: r.get("stage")?,
        lifecycle_id: r.get("lifecycle_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        deleted_at: r.get("deleted_at")?,
    })
}

pub(crate) fn version_row(r: &Row<'_>) -> rusqlite::Result<DocumentVersion> {
    Ok(DocumentVersion {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        version: r.get("version")?,
        content: r.get("content")?,
        message: r.get("message")?,
        created_by_id: r.get("created_by_id")?,
        created_at: r.get("created_at")?,
    })
}

impl DocumentRepo for SqliteDocuments<'_> {
    fn create(&self, new: &NewDocument) -> Result<Document> {
        if new.title.trim().is_empty() {
            return Err(Error::Invalid("title is required".into()));
        }
        let (id, now) = (new_id(), now_ms());
        let path = if new.path.is_empty() {
            "/"
        } else {
            new.path.as_str()
        };
        self.0
            .execute(
                "INSERT INTO documents (id, title, content, path, team_id, created_by_id, stage, lifecycle_id, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
                params![id, new.title, new.content, path, new.team_id, new.created_by_id, new.stage, new.lifecycle_id, now],
            )
            .map_err(db_err)?;
        self.insert_version(
            &id,
            &new.content,
            Some("Initial version"),
            &new.created_by_id,
        )?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Document> {
        self.0
            .query_row("SELECT * FROM documents WHERE id = ?1", [id], doc_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("document {id}")))
    }

    fn list_live(&self, team_id: &str) -> Result<Vec<Document>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM documents WHERE team_id = ?1 AND deleted_at IS NULL ORDER BY path, title, id")?;
        let rows = s
            .query_map([team_id], doc_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn list_by_stage(&self, team_id: &str, stage: &str) -> Result<Vec<Document>> {
        let mut s = self.0.prepare(
            "SELECT * FROM documents WHERE team_id = ?1 AND stage = ?2 AND deleted_at IS NULL ORDER BY path, title, id",
        )?;
        let rows = s
            .query_map([team_id, stage], doc_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn update_meta(&self, id: &str, title: Option<&str>, path: Option<&str>) -> Result<Document> {
        self.get(id)?;
        if title.is_some_and(|t| t.trim().is_empty()) {
            return Err(Error::Invalid("title must not be empty".into()));
        }
        self.0.execute(
            "UPDATE documents SET title = COALESCE(?2, title), path = COALESCE(?3, path), updated_at = ?4 WHERE id = ?1",
            params![id, title, path, now_ms()],
        )?;
        self.get(id)
    }

    fn set_stage(
        &self,
        id: &str,
        stage: Option<&str>,
        lifecycle_id: Option<&str>,
    ) -> Result<Document> {
        self.get(id)?;
        self.0
            .execute(
                "UPDATE documents SET stage = ?2, lifecycle_id = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, stage, lifecycle_id, now_ms()],
            )
            .map_err(db_err)?;
        self.get(id)
    }

    fn save_content(
        &self,
        id: &str,
        content: &str,
        message: Option<&str>,
        author_id: &str,
    ) -> Result<DocumentVersion> {
        let doc = self.get(id)?;
        if doc.deleted_at.is_some() {
            return Err(Error::Conflict(format!("document {id} is deleted")));
        }
        let latest = self.latest_version(id)?;
        if latest.content == content && doc.content == content {
            return Ok(latest);
        }
        let v = self.insert_version(id, content, message, author_id)?;
        self.0.execute(
            "UPDATE documents SET content = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, content, now_ms()],
        )?;
        Ok(v)
    }

    fn soft_delete(&self, id: &str) -> Result<bool> {
        self.get(id)?;
        let n = self
            .0
            .execute("UPDATE documents SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL", params![id, now_ms()])?;
        Ok(n > 0)
    }

    fn restore(&self, id: &str) -> Result<bool> {
        self.get(id)?;
        let n = self
            .0
            .execute("UPDATE documents SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NOT NULL", params![id, now_ms()])?;
        Ok(n > 0)
    }

    fn versions(&self, document_id: &str) -> Result<Vec<DocumentVersion>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM document_versions WHERE document_id = ?1 ORDER BY version")?;
        let rows = s
            .query_map([document_id], version_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn version(&self, document_id: &str, version: i64) -> Result<DocumentVersion> {
        self.0
            .query_row(
                "SELECT * FROM document_versions WHERE document_id = ?1 AND version = ?2",
                params![document_id, version],
                version_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("version {version} of document {document_id}")))
    }

    fn version_by_id(&self, version_id: &str) -> Result<DocumentVersion> {
        self.0
            .query_row(
                "SELECT * FROM document_versions WHERE id = ?1",
                [version_id],
                version_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("version {version_id}")))
    }

    fn latest_version(&self, document_id: &str) -> Result<DocumentVersion> {
        self.0
            .query_row(
                "SELECT * FROM document_versions WHERE document_id = ?1 ORDER BY version DESC LIMIT 1",
                [document_id],
                version_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("versions of document {document_id}")))
    }

    fn restore_version(
        &self,
        document_id: &str,
        version: i64,
        author_id: &str,
    ) -> Result<DocumentVersion> {
        let old = self.version(document_id, version)?;
        let msg = format!("Restore version {version}");
        self.save_content(document_id, &old.content, Some(&msg), author_id)
    }
}
