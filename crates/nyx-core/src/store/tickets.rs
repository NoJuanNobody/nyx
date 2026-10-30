//! Tickets.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::{db_err, json_col_opt};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, NewTicket, Ticket, TicketProvider, TicketStatus};

/// Ticket persistence.
pub trait TicketRepo {
    /// Create a ticket (status `open`).
    fn create(&self, new: &NewTicket) -> Result<Ticket>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<Ticket>;
    /// Find by provider-side id.
    fn find_external(&self, provider: TicketProvider, external_id: &str) -> Result<Option<Ticket>>;
    /// Tickets of a document, oldest first.
    fn list_by_document(&self, document_id: &str) -> Result<Vec<Ticket>>;
    /// Change status.
    fn set_status(&self, id: &str, status: TicketStatus) -> Result<Ticket>;
    /// Edit title/body/insights (`None` leaves a field untouched).
    fn update(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        insights: Option<&Value>,
    ) -> Result<Ticket>;
}

/// SQLite [`TicketRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteTickets<'c>(&'c Connection);

impl<'c> SqliteTickets<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        provider: r.get("provider")?,
        external_id: r.get("external_id")?,
        external_url: r.get("external_url")?,
        title: r.get("title")?,
        body: r.get("body")?,
        status: r.get("status")?,
        insights: json_col_opt(r, "claude_insights")?,
        created_by_id: r.get("created_by_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

impl TicketRepo for SqliteTickets<'_> {
    fn create(&self, new: &NewTicket) -> Result<Ticket> {
        let (id, now) = (new_id(), now_ms());
        let insights = new
            .insights
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        self.0
            .execute(
                "INSERT INTO tickets (id, document_id, provider, external_id, external_url, title, body, status, claude_insights, created_by_id, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9,?10,?10)",
                params![id, new.document_id, new.provider, new.external_id, new.external_url, new.title, new.body, insights, new.created_by_id, now],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Ticket> {
        self.0
            .query_row("SELECT * FROM tickets WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("ticket {id}")))
    }

    fn find_external(&self, provider: TicketProvider, external_id: &str) -> Result<Option<Ticket>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM tickets WHERE provider = ?1 AND external_id = ?2 ORDER BY created_at LIMIT 1",
                params![provider, external_id],
                row,
            )
            .optional()?)
    }

    fn list_by_document(&self, document_id: &str) -> Result<Vec<Ticket>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM tickets WHERE document_id = ?1 ORDER BY created_at, id")?;
        let rows = s
            .query_map([document_id], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn set_status(&self, id: &str, status: TicketStatus) -> Result<Ticket> {
        self.get(id)?;
        self.0.execute(
            "UPDATE tickets SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, now_ms()],
        )?;
        self.get(id)
    }

    fn update(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        insights: Option<&Value>,
    ) -> Result<Ticket> {
        self.get(id)?;
        let ins = insights.map(serde_json::to_string).transpose()?;
        self.0.execute(
            "UPDATE tickets SET title = COALESCE(?2, title), body = COALESCE(?3, body),
               claude_insights = COALESCE(?4, claude_insights), updated_at = ?5 WHERE id = ?1",
            params![id, title, body, ins, now_ms()],
        )?;
        self.get(id)
    }
}
