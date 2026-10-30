//! Append-only audit log (SQL triggers reject UPDATE and DELETE).

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{db_err, json_col};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, AuditEvent, NewAuditEvent};

/// Audit persistence.
pub trait AuditRepo {
    /// Append an event.
    fn append(&self, new: &NewAuditEvent) -> Result<AuditEvent>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<AuditEvent>;
    /// Newest events of a team first, at most `limit`.
    fn list_by_team(&self, team_id: &str, limit: u32) -> Result<Vec<AuditEvent>>;
    /// Newest events of a document first, at most `limit`.
    fn list_by_document(&self, document_id: &str, limit: u32) -> Result<Vec<AuditEvent>>;
}

/// SQLite [`AuditRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteAudit<'c>(&'c Connection);

impl<'c> SqliteAudit<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        event_type: r.get("event_type")?,
        actor_id: r.get("actor_id")?,
        document_id: r.get("document_id")?,
        snapshot_id: r.get("snapshot_id")?,
        ticket_id: r.get("ticket_id")?,
        commit_sha: r.get("commit_sha")?,
        parent_event_id: r.get("parent_event_id")?,
        metadata: json_col(r, "metadata")?,
        created_at: r.get("created_at")?,
    })
}

impl AuditRepo for SqliteAudit<'_> {
    fn append(&self, e: &NewAuditEvent) -> Result<AuditEvent> {
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO audit_trail (id, team_id, event_type, actor_id, document_id, snapshot_id, ticket_id, commit_sha, parent_event_id, metadata, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    id, e.team_id, e.event_type, e.actor_id, e.document_id, e.snapshot_id, e.ticket_id, e.commit_sha,
                    e.parent_event_id, serde_json::to_string(&e.metadata)?, now_ms()
                ],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<AuditEvent> {
        self.0
            .query_row("SELECT * FROM audit_trail WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("audit event {id}")))
    }

    fn list_by_team(&self, team_id: &str, limit: u32) -> Result<Vec<AuditEvent>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM audit_trail WHERE team_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2")?;
        let rows = s
            .query_map(params![team_id, limit], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn list_by_document(&self, document_id: &str, limit: u32) -> Result<Vec<AuditEvent>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM audit_trail WHERE document_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2")?;
        let rows = s
            .query_map(params![document_id, limit], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}
