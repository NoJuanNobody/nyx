//! Code-state snapshots attached to documents.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::db_err;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, NewSnapshot, Snapshot};

/// Snapshot persistence.
pub trait SnapshotRepo {
    /// Record a snapshot.
    fn create(&self, new: &NewSnapshot) -> Result<Snapshot>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<Snapshot>;
    /// Snapshots of a document, newest first.
    fn list(&self, document_id: &str) -> Result<Vec<Snapshot>>;
    /// Newest snapshot of a document.
    fn latest(&self, document_id: &str) -> Result<Option<Snapshot>>;
}

/// SQLite [`SnapshotRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteSnapshots<'c>(&'c Connection);

impl<'c> SqliteSnapshots<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<Snapshot> {
    Ok(Snapshot {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        integration_id: r.get("integration_id")?,
        external_ref: r.get("external_ref")?,
        content: r.get("content")?,
        captured_at: r.get("captured_at")?,
    })
}

impl SnapshotRepo for SqliteSnapshots<'_> {
    fn create(&self, new: &NewSnapshot) -> Result<Snapshot> {
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO snapshots (id, document_id, integration_id, external_ref, content, captured_at)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, new.document_id, new.integration_id, new.external_ref, new.content, now_ms()],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Snapshot> {
        self.0
            .query_row("SELECT * FROM snapshots WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("snapshot {id}")))
    }

    fn list(&self, document_id: &str) -> Result<Vec<Snapshot>> {
        let mut s = self.0.prepare(
            "SELECT * FROM snapshots WHERE document_id = ?1 ORDER BY captured_at DESC, rowid DESC",
        )?;
        let rows = s
            .query_map([document_id], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn latest(&self, document_id: &str) -> Result<Option<Snapshot>> {
        Ok(self.list(document_id)?.into_iter().next())
    }
}
