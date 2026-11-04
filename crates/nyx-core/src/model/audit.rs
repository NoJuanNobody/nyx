//! Audit log. Drizzle: `audit_trail`. The `agent_workflow` event type belonged to the removed
//! in-app agent and is not ported.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{string_enum, Id, Timestamp};

string_enum! {
    /// Audit event type. Drizzle enum `audit_event_type` minus `agent_workflow`.
    AuditEventType {
        /// Document edited.
        DocEdit => "doc_edit",
        /// Snapshot created.
        SnapshotCreated => "snapshot_created",
        /// Ticket created.
        TicketCreated => "ticket_created",
        /// Ticket updated.
        TicketUpdated => "ticket_updated",
        /// Code commit observed.
        CodeCommit => "code_commit",
        /// Change proposal created.
        ProposalCreated => "proposal_created",
        /// Change proposal approved.
        ProposalApproved => "proposal_approved",
        /// Change proposal pushed.
        ProposalPushed => "proposal_pushed",
    }
}

/// One immutable audit record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEvent {
    /// Id.
    pub id: Id,
    /// Team.
    pub team_id: Id,
    /// Event type.
    pub event_type: AuditEventType,
    /// Acting user.
    pub actor_id: Option<Id>,
    /// Related document.
    pub document_id: Option<Id>,
    /// Related snapshot.
    pub snapshot_id: Option<Id>,
    /// Related ticket.
    pub ticket_id: Option<Id>,
    /// Related commit.
    pub commit_sha: Option<String>,
    /// Causal parent event.
    pub parent_event_id: Option<Id>,
    /// Free-form metadata.
    pub metadata: Value,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Input for appending an audit event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAuditEvent {
    /// Team.
    pub team_id: Id,
    /// Event type.
    pub event_type: AuditEventType,
    /// Acting user.
    pub actor_id: Option<Id>,
    /// Related document.
    pub document_id: Option<Id>,
    /// Related snapshot.
    pub snapshot_id: Option<Id>,
    /// Related ticket.
    pub ticket_id: Option<Id>,
    /// Related commit.
    pub commit_sha: Option<String>,
    /// Causal parent event.
    pub parent_event_id: Option<Id>,
    /// Metadata.
    pub metadata: Value,
}

impl NewAuditEvent {
    /// Event with only team and type set.
    #[must_use]
    pub fn new(team_id: &str, event_type: AuditEventType) -> Self {
        Self {
            team_id: team_id.into(),
            event_type,
            actor_id: None,
            document_id: None,
            snapshot_id: None,
            ticket_id: None,
            commit_sha: None,
            parent_event_id: None,
            metadata: Value::Object(serde_json::Map::new()),
        }
    }
}
