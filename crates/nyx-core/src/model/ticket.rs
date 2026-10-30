//! Tickets mirrored from external trackers. Drizzle: `tickets`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{string_enum, Id, Timestamp};

string_enum! {
    /// Tracker provider. Drizzle enum `ticket_provider`.
    TicketProvider {
        /// GitHub issues.
        Github => "github",
        /// Jira.
        Jira => "jira",
        /// GitLab.
        Gitlab => "gitlab",
        /// Bitbucket.
        Bitbucket => "bitbucket",
    }
}

string_enum! {
    /// Ticket status. Drizzle enum `ticket_status`.
    TicketStatus {
        /// Open (default).
        Open => "open",
        /// In progress.
        InProgress => "in_progress",
        /// Closed.
        Closed => "closed",
    }
}

/// A ticket linked to a document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ticket {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// Provider.
    pub provider: TicketProvider,
    /// Provider-side id.
    pub external_id: String,
    /// Provider-side URL.
    pub external_url: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Status.
    pub status: TicketStatus,
    /// Free-form JSON insights (Drizzle: `claude_insights`).
    pub insights: Option<Value>,
    /// Creator.
    pub created_by_id: Id,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last update time.
    pub updated_at: Timestamp,
}

/// Input for creating a ticket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTicket {
    /// Document.
    pub document_id: Id,
    /// Provider.
    pub provider: TicketProvider,
    /// Provider-side id.
    pub external_id: String,
    /// Provider-side URL.
    pub external_url: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Insights.
    pub insights: Option<Value>,
    /// Creator.
    pub created_by_id: Id,
}
