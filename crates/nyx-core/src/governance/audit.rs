//! Audit log queries and export (`audit.service.ts`), built on [`crate::store::audit`].
//!
//! The log itself stays append-only (SQL triggers). Event kinds are those of
//! [`AuditEventType`]; `agent_workflow` belonged to the removed in-app agent and is gone.

use std::fmt::Write as _;

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{AuditEvent, AuditEventType, Id, NewAuditEvent, Timestamp};
use crate::store::{AuditRepo, SqliteAudit};

/// Maximum chain length returned by [`AuditService::trace_chain`] (TS guard against loops: it
/// stops after pushing the 51st event).
pub const MAX_TRACE: usize = 51;

/// An audit event plus the actor's display name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// The event.
    #[serde(flatten)]
    pub event: AuditEvent,
    /// Actor name from `users`, if known.
    pub actor_name: Option<String>,
}

/// Filter for [`AuditService::query`] and [`AuditService::export`]. All set fields must match.
#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
    /// Team scope.
    pub team_id: Option<Id>,
    /// Any of these event types (empty = all).
    pub event_types: Vec<AuditEventType>,
    /// Acting user.
    pub actor_id: Option<Id>,
    /// Document.
    pub document_id: Option<Id>,
    /// Ticket.
    pub ticket_id: Option<Id>,
    /// Snapshot.
    pub snapshot_id: Option<Id>,
    /// Commit sha.
    pub commit_sha: Option<String>,
    /// Inclusive lower bound on `created_at`.
    pub since: Option<Timestamp>,
    /// Inclusive upper bound on `created_at`.
    pub until: Option<Timestamp>,
    /// Case-insensitive substring searched in the metadata JSON.
    pub text: Option<String>,
    /// Maximum rows.
    pub limit: Option<u32>,
    /// Rows to skip.
    pub offset: u32,
    /// Oldest first instead of newest first.
    pub oldest_first: bool,
}

/// Export format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// Pretty-printed JSON array.
    Json,
    /// One JSON object per line.
    Jsonl,
    /// RFC 4180 CSV with a header row; spreadsheet formula prefixes are neutralised.
    Csv,
}

const SELECT: &str =
    "SELECT a.*, u.name AS actor_name FROM audit_trail a LEFT JOIN users u ON u.id = a.actor_id";

fn entry(r: &Row<'_>) -> rusqlite::Result<AuditEntry> {
    let meta: String = r.get("metadata")?;
    let metadata = serde_json::from_str(&meta).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(AuditEntry {
        event: AuditEvent {
            id: r.get("id")?,
            team_id: r.get("team_id")?,
            event_type: r.get("event_type")?,
            actor_id: r.get("actor_id")?,
            document_id: r.get("document_id")?,
            snapshot_id: r.get("snapshot_id")?,
            ticket_id: r.get("ticket_id")?,
            commit_sha: r.get("commit_sha")?,
            parent_event_id: r.get("parent_event_id")?,
            metadata,
            created_at: r.get("created_at")?,
        },
        actor_name: r.get("actor_name")?,
    })
}

/// Audit service over a connection.
#[derive(Debug, Clone, Copy)]
pub struct AuditService<'c>(&'c Connection);

impl<'c> AuditService<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Append an event (`recordEvent`).
    pub fn record_event(&self, new: &NewAuditEvent) -> Result<AuditEvent> {
        SqliteAudit::new(self.0).append(new)
    }

    /// Events of a document, newest first, with actor names (`getTrailForDocument`).
    pub fn trail_for_document(&self, document_id: &str) -> Result<Vec<AuditEntry>> {
        self.query(&AuditFilter {
            document_id: Some(document_id.into()),
            ..AuditFilter::default()
        })
    }

    /// Walk up the `parent_event_id` chain from `event_id`, starting event first (`getTraceChain`).
    /// Stops at a missing parent or after [`MAX_TRACE`] events.
    pub fn trace_chain(&self, event_id: &str) -> Result<Vec<AuditEntry>> {
        let mut chain = Vec::new();
        let mut current = Some(event_id.to_string());
        while let Some(id) = current.take() {
            let Some(e) = self
                .0
                .query_row(&format!("{SELECT} WHERE a.id = ?1"), [&id], entry)
                .optional()?
            else {
                break;
            };
            current.clone_from(&e.event.parent_event_id);
            chain.push(e);
            if chain.len() >= MAX_TRACE {
                break;
            }
        }
        Ok(chain)
    }

    /// Latest activity of a team (`getTeamActivity`, default limit 50).
    pub fn team_activity(&self, team_id: &str, limit: Option<u32>) -> Result<Vec<AuditEntry>> {
        self.query(&AuditFilter {
            team_id: Some(team_id.into()),
            limit: Some(limit.unwrap_or(50)),
            ..AuditFilter::default()
        })
    }

    fn where_clause(f: &AuditFilter) -> (String, Vec<SqlValue>) {
        let mut sql = String::from(" WHERE 1=1");
        let mut args: Vec<SqlValue> = vec![];
        let mut eq = |col: &str, v: &Option<String>| {
            if let Some(v) = v {
                let _ = write!(sql, " AND a.{col} = ?");
                args.push(v.clone().into());
            }
        };
        eq("team_id", &f.team_id);
        eq("actor_id", &f.actor_id);
        eq("document_id", &f.document_id);
        eq("ticket_id", &f.ticket_id);
        eq("snapshot_id", &f.snapshot_id);
        eq("commit_sha", &f.commit_sha);
        if !f.event_types.is_empty() {
            let marks = vec!["?"; f.event_types.len()].join(",");
            let _ = write!(sql, " AND a.event_type IN ({marks})");
            args.extend(
                f.event_types
                    .iter()
                    .map(|t| SqlValue::from(t.as_str().to_string())),
            );
        }
        if let Some(t) = f.since {
            sql.push_str(" AND a.created_at >= ?");
            args.push(t.into());
        }
        if let Some(t) = f.until {
            sql.push_str(" AND a.created_at <= ?");
            args.push(t.into());
        }
        if let Some(text) = &f.text {
            let escaped = text
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            sql.push_str(" AND a.metadata LIKE ? ESCAPE '\\'");
            args.push(format!("%{escaped}%").into());
        }
        (sql, args)
    }

    /// Filtered query, newest first unless `oldest_first`.
    pub fn query(&self, f: &AuditFilter) -> Result<Vec<AuditEntry>> {
        let (clause, mut args) = Self::where_clause(f);
        let dir = if f.oldest_first { "ASC" } else { "DESC" };
        let mut sql = format!("{SELECT}{clause} ORDER BY a.created_at {dir}, a.rowid {dir}");
        if let Some(limit) = f.limit {
            sql.push_str(" LIMIT ? OFFSET ?");
            args.push(i64::from(limit).into());
            args.push(i64::from(f.offset).into());
        } else if f.offset > 0 {
            sql.push_str(" LIMIT -1 OFFSET ?");
            args.push(i64::from(f.offset).into());
        }
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(args), entry)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Number of rows matching the filter, ignoring limit and offset.
    pub fn count(&self, f: &AuditFilter) -> Result<u64> {
        let (clause, args) = Self::where_clause(f);
        let n: i64 = self.0.query_row(
            &format!("SELECT COUNT(*) FROM audit_trail a{clause}"),
            params_from_iter(args),
            |r| r.get(0),
        )?;
        Ok(u64::try_from(n).unwrap_or(0))
    }

    /// Export the filtered events as text.
    pub fn export(&self, f: &AuditFilter, format: ExportFormat) -> Result<String> {
        let rows = self.query(f)?;
        match format {
            ExportFormat::Json => Ok(serde_json::to_string_pretty(&rows)?),
            ExportFormat::Jsonl => rows
                .iter()
                .map(|r| serde_json::to_string(r).map_err(Error::from))
                .collect::<Result<Vec<_>>>()
                .map(|v| v.join("\n")),
            ExportFormat::Csv => to_csv(&rows),
        }
    }
}

const CSV_HEADER: &[&str] = &[
    "id",
    "team_id",
    "event_type",
    "actor_id",
    "actor_name",
    "document_id",
    "snapshot_id",
    "ticket_id",
    "commit_sha",
    "parent_event_id",
    "created_at",
    "metadata",
];

fn csv_cell(s: &str) -> String {
    // Neutralise spreadsheet formula injection from user-controlled text.
    let guarded = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn to_csv(rows: &[AuditEntry]) -> Result<String> {
    let mut out = CSV_HEADER.join(",");
    out.push_str("\r\n");
    for r in rows {
        let e = &r.event;
        let opt = |o: &Option<String>| o.as_deref().map(csv_cell).unwrap_or_default();
        let cells = [
            csv_cell(&e.id),
            csv_cell(&e.team_id),
            e.event_type.to_string(),
            opt(&e.actor_id),
            opt(&r.actor_name),
            opt(&e.document_id),
            opt(&e.snapshot_id),
            opt(&e.ticket_id),
            opt(&e.commit_sha),
            opt(&e.parent_event_id),
            e.created_at.to_string(),
            csv_cell(&serde_json::to_string(&e.metadata)?),
        ];
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells_are_quoted_and_guarded() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("=SUM(A1)"), "'=SUM(A1)");
    }
}
