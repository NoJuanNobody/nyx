//! Typed notification events (`notification-events.ts`) and the inbox category filter.

use crate::model::string_enum;

string_enum! {
    /// Every event that can raise a notification. Wire names match the TypeScript constants.
    NotificationEvent {
        /// Drift between docs and code detected.
        DriftDetected => "drift.detected",
        /// Ticket created.
        TicketCreated => "ticket.created",
        /// Ticket updated.
        TicketUpdated => "ticket.updated",
        /// Change proposal submitted.
        ChangeProposalSubmitted => "change_proposal.submitted",
        /// Change proposal approved.
        ChangeProposalApproved => "change_proposal.approved",
        /// Change proposal rejected.
        ChangeProposalRejected => "change_proposal.rejected",
        /// Approval requested.
        ApprovalRequested => "approval.requested",
        /// Document shared.
        DocumentShared => "document.shared",
        /// Team invite.
        TeamInvite => "team.invite",
        /// Snapshot created.
        SnapshotCreated => "snapshot.created",
        /// Mentioned in a comment.
        CommentMention => "comment.mention",
    }
}

impl NotificationEvent {
    /// Category = the part before the first dot (`ticket.created` -> `ticket`).
    #[must_use]
    pub fn category(self) -> &'static str {
        self.as_str().split('.').next().unwrap_or("")
    }

    /// Parse a stored event type, `None` for unknown (forward-compatible) names.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        s.parse().ok()
    }
}

/// Inbox event-type filter, mirroring the `event_type` query parameter of the TS route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventFilter {
    /// The special `review` bucket: `approval.*` and `change_proposal.*`.
    Review,
    /// A fully qualified event type (`ticket.created`).
    Exact(String),
    /// A category prefix (`ticket` matches `ticket.*`).
    Category(String),
}

impl EventFilter {
    /// Parse the raw query value: `review`, a dotted name (exact) or a bare category.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        if raw == "review" {
            Self::Review
        } else if raw.contains('.') {
            Self::Exact(raw.to_string())
        } else {
            Self::Category(raw.to_string())
        }
    }

    /// Whether an event type passes the filter (used by tests and in-memory consumers).
    #[must_use]
    pub fn matches(&self, event_type: &str) -> bool {
        match self {
            Self::Review => {
                event_type.starts_with("approval.") || event_type.starts_with("change_proposal.")
            }
            Self::Exact(e) => event_type == e,
            Self::Category(c) => event_type
                .strip_prefix(c.as_str())
                .is_some_and(|rest| rest.starts_with('.')),
        }
    }
}
